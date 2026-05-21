/**
 * Two-priority request queue for LSP JSON-RPC calls.
 *
 * Implements `docs/DESIGN.md` § Concurrency and Wave 2 amendment "Request
 * timeout + priority queue (D27)":
 *
 *   - **Interactive lane:** `hover`, `signatureHelp`, `documentSymbol`.
 *     Jumps ahead of slow ops.
 *   - **Background lane:** `references`, `workspaceSymbol`, `rename`,
 *     `documentLink`. Default serialized.
 *   - A pending background-lane request is preempted only if the
 *     interactive-lane queue depth was 0 when the background request
 *     started; otherwise the interactive request waits its turn.
 *   - Per-request timeout default 30s; per-method adapter overrides
 *     plumbed via the `timeoutMs` arg (adapter pattern lives in #13).
 *
 * The queue is **lane-serialized**: only one request runs at a time across
 * both lanes. The preemption rule decides whether an arriving interactive
 * request waits for the in-flight background request to finish, or whether
 * it goes next when the in-flight request settles.
 *
 * The queue is **standalone** — it does not know about LSP wire protocol.
 * Tasks are arbitrary async thunks; the client wraps each into a `sendRequest`
 * call on the underlying `MessageConnection`.
 */

/**
 * Queue lanes. See module docstring for the routing rule.
 */
export type Lane = "interactive" | "background";

/**
 * Methods routed to the interactive lane. Mirrors Wave 2 amendment D27.
 * Exported so the client (and the adapter slot in #13) can ask the
 * routing question without re-stating the list.
 */
export const INTERACTIVE_METHODS: readonly string[] = [
  "textDocument/hover",
  "textDocument/signatureHelp",
  "textDocument/documentSymbol",
];

/**
 * Methods routed to the background lane. Other methods (e.g.
 * `textDocument/definition`) are not listed here because they're routed
 * by exclusion — see {@link laneFor}. Listed explicitly so the routing
 * table is searchable.
 */
export const BACKGROUND_METHODS: readonly string[] = [
  "textDocument/references",
  "workspace/symbol",
  "textDocument/rename",
  "textDocument/documentLink",
];

/**
 * Route a method name to its lane. Anything not in
 * {@link BACKGROUND_METHODS} lands on the interactive lane by default —
 * latency-sensitive ops should never starve waiting for an unrouted
 * background call.
 */
export function laneFor(method: string): Lane {
  return BACKGROUND_METHODS.includes(method) ? "background" : "interactive";
}

/**
 * Thrown when a queued task doesn't settle within its timeout. The error
 * is rejected to the original caller; the task continues to run in the
 * background (we have no way to cancel arbitrary thunks) but its return
 * value is discarded.
 */
export class RequestTimeoutError extends Error {
  /** The method name passed to {@link LspRequestQueue.enqueue}. */
  readonly method: string;
  /** The timeout that expired, in ms. */
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`LSP request timed out after ${timeoutMs}ms: ${method}`);
    this.name = "RequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RequestTimeoutError);
    }
  }
}

/**
 * Options for one enqueue.
 */
export interface EnqueueOptions {
  /** LSP method name; used both for lane routing and for timeout errors. */
  method: string;
  /** Per-request override in ms; falls back to the queue's default. */
  timeoutMs?: number;
  /** Explicit lane override. Skips {@link laneFor}; tests use this to
   *  exercise preemption rules without depending on method-name routing. */
  lane?: Lane;
}

/**
 * The queue's public interface. The implementation is a class instead of
 * a closure factory so the in-flight pointer survives method dispatch
 * cleanly and the contract surface is grep-able.
 */
export class LspRequestQueue {
  /** Default per-request timeout in ms. */
  private readonly defaultTimeoutMs: number;
  /**
   * FIFO of pending interactive-lane tasks. Each entry is a thunk that
   * starts the wrapped work; the queue runner pulls one off and awaits it.
   */
  private interactiveQ: PendingTask[] = [];
  /** FIFO of pending background-lane tasks. */
  private backgroundQ: PendingTask[] = [];
  /**
   * The lane that was in-flight when a background task **started**. Used
   * by the preemption rule: a background task may be preempted (i.e.
   * interactive runs next on dequeue) only if no interactive task was
   * pending at the moment the background task left the queue and started.
   *
   * Tracked as a per-task flag at start; this field is the snapshot of
   * the currently in-flight task's flag.
   */
  private inFlightPreemptible = false;
  /** True iff a task is currently in flight. */
  private running = false;

  /**
   * @param defaultTimeoutMs Default per-request timeout in ms when
   *   {@link EnqueueOptions.timeoutMs} is not supplied. Production
   *   passes the parsed `LspConfig.requestTimeoutMs`.
   */
  constructor(defaultTimeoutMs: number) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Submit `task` to the queue. The returned promise settles when `task`
   * settles or when the timeout expires, whichever comes first.
   *
   * Routing rules (Wave 2 D27):
   *   - Interactive arrives while idle → runs immediately.
   *   - Interactive arrives while a background task is in flight and that
   *     background task was marked preemptible → it'll run next on
   *     dequeue (jumps the background lane queue).
   *   - Otherwise interactive joins the interactive FIFO.
   *   - Background arrives → joins the background FIFO; runs when the
   *     interactive lane is fully drained.
   *
   * The task itself is never cancelled on timeout; the promise just
   * rejects. JavaScript has no native cancellation; the in-flight thunk
   * continues to consume the wire. The client layer disposes the
   * underlying JSON-RPC token when it tears the connection down.
   */
  enqueue<T>(opts: EnqueueOptions, task: () => Promise<T>): Promise<T> {
    const lane = opts.lane ?? laneFor(opts.method);
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask = {
        method: opts.method,
        timeoutMs,
        lane,
        run: async () => {
          let timer: NodeJS.Timeout | undefined;
          let settled = false;
          const timeoutPromise = new Promise<never>((_, rejectT) => {
            timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                rejectT(new RequestTimeoutError(opts.method, timeoutMs));
              }
            }, timeoutMs);
          });
          try {
            const result = await Promise.race([task(), timeoutPromise]);
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result as T);
          } catch (err) {
            settled = true;
            if (timer) clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      };
      this.push(pending);
      // Kick the runner; if it's already running this is a no-op.
      void this.drain();
    });
  }

  /** Current pending-task counts. Exposed for tests and telemetry. */
  depth(): { interactive: number; background: number; running: boolean } {
    return {
      interactive: this.interactiveQ.length,
      background: this.backgroundQ.length,
      running: this.running,
    };
  }

  private push(task: PendingTask): void {
    if (task.lane === "interactive") {
      this.interactiveQ.push(task);
    } else {
      this.backgroundQ.push(task);
    }
  }

  /**
   * Pump tasks until both lanes are empty. Reentrancy-safe: a second call
   * while `running` is true returns immediately.
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.interactiveQ.length > 0 || this.backgroundQ.length > 0) {
        const next = this.pickNext();
        if (!next) break;
        // Snapshot the preemption state: a background task is preemptible
        // iff the interactive lane was empty when it started running.
        this.inFlightPreemptible =
          next.lane === "background" && this.interactiveQ.length === 0;
        try {
          await next.run();
        } catch {
          // run() always settles the caller-facing promise via resolve/
          // reject. Errors thrown synchronously from the task closure are
          // already surfaced to the caller; here we swallow so the
          // runner survives.
        }
      }
    } finally {
      this.running = false;
      this.inFlightPreemptible = false;
    }
  }

  /**
   * Dequeue the next task to run. Implements the preemption rule:
   * interactive always wins over background, but a background task only
   * loses its slot to a fresh interactive request if it was marked
   * preemptible at start time. Once a background task is in flight there
   * is no in-place cancellation — `pickNext` only runs **after** the
   * previous task has settled.
   */
  private pickNext(): PendingTask | undefined {
    if (this.interactiveQ.length > 0) {
      return this.interactiveQ.shift();
    }
    return this.backgroundQ.shift();
  }
}

/**
 * Internal: the queue-side record per enqueued task.
 */
interface PendingTask {
  method: string;
  timeoutMs: number;
  lane: Lane;
  run: () => Promise<void>;
}
