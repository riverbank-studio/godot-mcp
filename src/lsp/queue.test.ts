/**
 * Tests for the 2-priority LSP request queue.
 *
 * Asserts the Wave 2 D27 contract:
 *   - Interactive lane jumps ahead of background lane.
 *   - Within a lane, FIFO.
 *   - Preemption rule: a pending background-lane request is preempted only
 *     if the interactive-lane queue depth was 0 when the background
 *     request started; otherwise the interactive request waits its turn.
 *   - Per-request timeout default + override.
 *   - Method-name → lane routing.
 */

import { describe, expect, it } from "vitest";

import {
  BACKGROUND_METHODS,
  INTERACTIVE_METHODS,
  laneFor,
  LspRequestQueue,
  RequestTimeoutError,
} from "./queue.js";

/**
 * Hand-rolled deferred helper. Returns the promise and the resolver in one
 * shot so test bodies can sequence things deterministically without
 * resorting to `setTimeout(0)` micro-task gymnastics.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("laneFor", () => {
  it("routes the documented background-lane methods to `background`", () => {
    for (const m of BACKGROUND_METHODS) {
      expect(laneFor(m)).toBe("background");
    }
  });

  it("routes the documented interactive-lane methods to `interactive`", () => {
    for (const m of INTERACTIVE_METHODS) {
      expect(laneFor(m)).toBe("interactive");
    }
  });

  it("defaults unknown methods to the interactive lane", () => {
    expect(laneFor("textDocument/definition")).toBe("interactive");
    expect(laneFor("textDocument/completion")).toBe("interactive");
    expect(laneFor("unknown/whatever")).toBe("interactive");
  });
});

describe("LspRequestQueue", () => {
  describe("FIFO within a lane", () => {
    it("interactive tasks run in submission order", async () => {
      const q = new LspRequestQueue(1_000);
      const order: number[] = [];
      const d1 = deferred<void>();
      const d2 = deferred<void>();

      const p1 = q.enqueue({ method: "textDocument/hover" }, async () => {
        await d1.promise;
        order.push(1);
        return 1;
      });
      const p2 = q.enqueue({ method: "textDocument/hover" }, async () => {
        await d2.promise;
        order.push(2);
        return 2;
      });

      d1.resolve();
      d2.resolve();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(order).toEqual([1, 2]);
      expect([r1, r2]).toEqual([1, 2]);
    });
  });

  describe("interactive jumps the background queue", () => {
    it("interactive runs before pending background when both are queued", async () => {
      const q = new LspRequestQueue(1_000);
      const order: string[] = [];

      const blocker = deferred<void>();
      // Block the queue with an in-flight interactive task so subsequent
      // enqueues sit in the pending FIFOs.
      const blockerP = q.enqueue(
        { method: "textDocument/hover", lane: "interactive" },
        async () => {
          await blocker.promise;
          order.push("blocker");
          return "blocker";
        },
      );

      const bgP = q.enqueue(
        { method: "textDocument/references", lane: "background" },
        async () => {
          order.push("background");
          return "bg";
        },
      );
      const intP = q.enqueue(
        { method: "textDocument/signatureHelp", lane: "interactive" },
        async () => {
          order.push("interactive");
          return "int";
        },
      );

      blocker.resolve();
      await Promise.all([blockerP, bgP, intP]);
      // Order must be: blocker → interactive → background.
      expect(order).toEqual(["blocker", "interactive", "background"]);
    });
  });

  describe("preemption rule (Wave 2 D27)", () => {
    it("a background task in flight is NOT cancelled mid-execution by an interactive arrival", async () => {
      // The spec is "preempted only if the interactive-lane queue depth was
      // 0 when the background request started; otherwise the interactive
      // request waits its turn." In-flight serialization holds either way;
      // preemption means "next on dequeue", not "cancel running thunk."
      const q = new LspRequestQueue(1_000);
      const order: string[] = [];
      const bgGate = deferred<void>();

      const bgP = q.enqueue(
        { method: "textDocument/references", lane: "background" },
        async () => {
          await bgGate.promise;
          order.push("background");
          return "bg";
        },
      );
      // Interactive arrives while background is mid-flight.
      const intP = q.enqueue(
        { method: "textDocument/hover", lane: "interactive" },
        async () => {
          order.push("interactive");
          return "int";
        },
      );

      // Let the background task complete.
      bgGate.resolve();
      await Promise.all([bgP, intP]);
      expect(order).toEqual(["background", "interactive"]);
    });
  });

  describe("per-request timeout", () => {
    it("rejects with RequestTimeoutError when the task overruns the override timeout", async () => {
      const q = new LspRequestQueue(10_000);
      const start = Date.now();
      const p = q.enqueue(
        { method: "textDocument/hover", timeoutMs: 10 },
        () =>
          new Promise(() => {
            // never resolves
          }),
      );
      await expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
      expect(Date.now() - start).toBeLessThan(2_000);
    });

    it("uses the default timeout when no override is given", async () => {
      const q = new LspRequestQueue(15);
      const p = q.enqueue(
        { method: "textDocument/hover" },
        () => new Promise(() => {}),
      );
      await expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    });

    it("does not time out a task that resolves in time", async () => {
      const q = new LspRequestQueue(500);
      const p = q.enqueue({ method: "textDocument/hover" }, async () => 42);
      await expect(p).resolves.toBe(42);
    });

    it("includes the method name in the timeout error", async () => {
      const q = new LspRequestQueue(10_000);
      const p = q.enqueue(
        { method: "textDocument/references", timeoutMs: 5 },
        () => new Promise(() => {}),
      );
      try {
        await p;
        expect.fail("expected throw");
      } catch (err) {
        const e = err as RequestTimeoutError;
        expect(e.method).toBe("textDocument/references");
        expect(e.timeoutMs).toBe(5);
      }
    });
  });

  describe("error propagation", () => {
    it("rejects the caller with the task's own error", async () => {
      const q = new LspRequestQueue(1_000);
      const err = new Error("boom");
      const p = q.enqueue({ method: "textDocument/hover" }, async () => {
        throw err;
      });
      await expect(p).rejects.toBe(err);
    });

    it("queue keeps running after a task throws", async () => {
      const q = new LspRequestQueue(1_000);
      const p1 = q.enqueue({ method: "textDocument/hover" }, async () => {
        throw new Error("first fails");
      });
      const p2 = q.enqueue({ method: "textDocument/hover" }, async () => 7);
      await expect(p1).rejects.toThrow("first fails");
      await expect(p2).resolves.toBe(7);
    });
  });

  describe("depth introspection", () => {
    it("reports the in-flight + pending lane counts", async () => {
      const q = new LspRequestQueue(1_000);
      const blocker = deferred<void>();
      const blockerP = q.enqueue({ method: "textDocument/hover" }, async () => {
        await blocker.promise;
      });
      const bgP = q.enqueue(
        { method: "textDocument/references" },
        async () => {},
      );

      // After yielding once, the first task is in flight and the second is
      // sitting in the pending FIFO.
      await Promise.resolve();
      const d = q.depth();
      expect(d.running).toBe(true);
      // Either lane can hold pending tasks depending on lane routing.
      expect(d.interactive + d.background).toBe(1);

      blocker.resolve();
      await Promise.all([blockerP, bgP]);
      expect(q.depth()).toEqual({
        interactive: 0,
        background: 0,
        running: false,
      });
    });
  });
});
