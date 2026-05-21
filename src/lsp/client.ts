/**
 * Godot LSP client over TCP.
 *
 * Built on `vscode-jsonrpc`'s `MessageConnection` for the wire protocol,
 * but every LSP-level concern (handshake, capability tracking, diagnostics
 * cache, recovery) is implemented in this file. We deliberately do not
 * depend on `cclsp` or `lsp-mcp` as packages — see DESIGN.md L351.
 *
 * Responsibilities:
 *   - Connect to `127.0.0.1:{port}` (loopback hardcoded, Wave 2 D19).
 *   - Run the LSP `initialize` / `initialized` handshake.
 *   - Track which capabilities Godot advertised; tools query this to
 *     decide whether to route to the adapter shim (e.g. workspaceSymbol).
 *   - Cache `publishDiagnostics` per URI; expose tiered await (10s first
 *     touch / 2s steady-state, Wave 2 D29).
 *   - Send requests through the {@link LspRequestQueue}.
 *   - Tiered recovery on disconnect: alive-check, 3 reconnect attempts
 *     with 1s/2s/4s backoff, then respawn via {@link LspProcessManager}.
 *
 * The client is **standalone**. Tools that consume this API land in
 * Wave 4 (#9-infra and its leaves). This module exports the surface they
 * will bind against; no tool registration happens here.
 */

import * as net from "node:net";

import {
  SocketMessageReader,
  SocketMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

import { createLogger } from "../shared/logging.js";
import { createInitLatch, type InitLatch } from "../shared/latch.js";

import type { LspConfig } from "./config.js";
import { type DocumentEvent, DocumentTracker } from "./documents.js";
import {
  LspConnectionLostError,
  LspHandshakeFailedError,
  LspHandshakeTimeoutError,
  LspUnavailableError,
} from "./errors.js";
import { LOOPBACK_HOST } from "./port-scan.js";
import { LspProcessManager, type LspProcessHandle } from "./process.js";
import { LspRequestQueue, type EnqueueOptions } from "./queue.js";

const SUBSYSTEM = "lsp";

/**
 * Reconnect backoff in ms for the tiered-recovery layer (DESIGN.md L393).
 * Three attempts with 1s/2s/4s spacing before we give up on the existing
 * process and force a respawn.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * The LSP capabilities Godot's GDScript server is known to advertise.
 * Mirrors DESIGN.md L366 "Supported" subsection. The list is parsed from
 * the actual `initialize` response at runtime; this constant is the
 * baseline tools check against in tests before a real handshake.
 */
export interface KnownServerCapabilities {
  textDocumentSync?: { openClose?: boolean; change?: number };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  documentSymbolProvider?: boolean;
  signatureHelpProvider?: object | boolean;
  renameProvider?: object | boolean;
  completionProvider?: object | boolean;
  codeLensProvider?: object | boolean;
  documentHighlightProvider?: boolean;
  foldingRangeProvider?: boolean;
  documentLinkProvider?: object | boolean;
  colorProvider?: object | boolean;
  workspaceSymbolProvider?: boolean;
  /** Notably absent in Godot 4.5/4.6 — see DESIGN.md L370. */
  codeActionProvider?: object | boolean;
}

/**
 * One diagnostic entry as cached after a `publishDiagnostics` push. Shape
 * intentionally generic — the tool layer flattens this to its 1-based
 * envelope in Wave 4.
 */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

/**
 * The cached `publishDiagnostics` envelope plus a `receivedAt` timestamp
 * so the await tier can compute "did the most recent push come after my
 * `didChange`?" without ambiguity.
 */
export interface DiagnosticCacheEntry {
  diagnostics: LspDiagnostic[];
  receivedAt: number;
}

/**
 * Options for constructing an {@link LspClient}.
 */
export interface LspClientOptions {
  /** Parsed env config. */
  config: LspConfig;
  /** Spawn manager owning the headless Godot child. */
  processManager: LspProcessManager;
  /** Document tracker (lazy didOpen + auto-resync). */
  documents: DocumentTracker;
  /** Request queue. The client routes every LSP call through this. */
  queue: LspRequestQueue;
  /**
   * Socket factory. Defaults to `net.createConnection`. Tests inject a
   * fake that returns a `net.Socket`-shaped mock backed by a
   * `stream.Duplex`.
   */
  connect?: (port: number, host: string) => net.Socket;
  /**
   * Wall-clock source. Defaults to `Date.now`. The diagnostic cache uses
   * this for `receivedAt`; tests inject for determinism.
   */
  now?: () => number;
}

/**
 * The LSP client.
 *
 * Lifecycle states (mirrors `LatchState<void>`):
 *   - `pending`  — no live connection. `await()` blocks until init.
 *   - `ready`    — connection is up and the handshake has succeeded.
 *   - `failed`   — terminal failure for this session (cap exhausted, etc.);
 *                  every `await()` returns the captured error verbatim so
 *                  tools see the same `recoveryHint` on every call.
 */
export class LspClient {
  private readonly opts: LspClientOptions;
  private readonly logger = createLogger(SUBSYSTEM);
  private readonly latch: InitLatch<void> = createInitLatch<void>();

  private socket: net.Socket | null = null;
  private connection: MessageConnection | null = null;
  private handle: LspProcessHandle | null = null;
  /** Capabilities returned by the most recent successful `initialize`. */
  private capabilities: KnownServerCapabilities = {};
  /** URI → cached diagnostics. Keyed by `file://` URI for parity with LSP. */
  private diagnosticsByUri = new Map<string, DiagnosticCacheEntry>();
  /**
   * URI → pending `publishDiagnostics` resolvers. Each entry is a list so
   * concurrent waits on the same URI all settle on the next push.
   */
  private diagnosticWaiters = new Map<
    string,
    Array<(entry: DiagnosticCacheEntry) => void>
  >();

  constructor(opts: LspClientOptions) {
    this.opts = opts;
  }

  /**
   * Latch state. Subsystems and tests can branch on
   * `state().kind === "failed"` without awaiting.
   */
  state() {
    return this.latch.state();
  }

  /**
   * Wait for the client to be `ready`. Resolves once the most recent
   * `initialize` handshake has completed; rejects with the stored error
   * when the latch is in `failed`.
   */
  await(): Promise<void> {
    return this.latch.await();
  }

  /**
   * Server capabilities from the most recent successful handshake. Empty
   * object until the first handshake completes. Wave 4 tools query this
   * to decide adapter routing for the broken `workspaceSymbol`.
   */
  serverCapabilities(): Readonly<KnownServerCapabilities> {
    return this.capabilities;
  }

  /**
   * Bring up the connection: spawn (or reuse) headless Godot, open the
   * TCP socket, run the handshake, mark the latch ready. Idempotent —
   * a second call while ready is a no-op. Called explicitly when
   * `LspConfig.eagerInit === true`; otherwise the first `request()` call
   * triggers it via the lazy path.
   */
  async start(): Promise<void> {
    if (this.latch.state().kind === "ready") return;
    if (this.latch.state().kind === "failed") {
      // Failed terminally for this session — short-circuit so callers
      // get the categorized error rather than another start attempt.
      return this.latch.await();
    }

    try {
      this.handle = await this.opts.processManager.spawn();
      await this.connect(this.handle.port);
      await this.handshake();
      this.opts.processManager.noteHandshakeSuccess();
      this.latch.resolve(undefined);
      this.logger.info(`LSP ready on ${LOOPBACK_HOST}:${this.handle.port}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`LSP init failed: ${error.message}`);
      if (this.latch.state().kind === "pending") {
        this.latch.reject(error);
      }
      // Re-throw so the lazy `request()` path surfaces the failure to
      // the caller in addition to gating future calls via the latch.
      throw error;
    }
  }

  /**
   * Tear down the connection without disposing the process manager.
   * Used between recovery cycles; `dispose()` is the full-stop variant.
   */
  async stop(): Promise<void> {
    if (this.connection) {
      try {
        this.connection.dispose();
      } catch {
        // Disposal races a dropped socket; either way the connection is
        // gone after this call.
      }
      this.connection = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Destroy is best-effort.
      }
      this.socket = null;
    }
    this.handle = null;
    this.opts.documents.reset();
    this.diagnosticsByUri.clear();
    this.rejectAllDiagnosticWaiters(
      new LspConnectionLostError("client stopped"),
    );
    if (this.latch.state().kind !== "pending") {
      this.latch.reset();
    }
  }

  /**
   * Full teardown: stop the client and kill the headless Godot child.
   * Use from the top-level cleanup path; do not call mid-recovery.
   */
  async dispose(): Promise<void> {
    await this.stop();
    this.opts.processManager.dispose();
  }

  /**
   * Send an LSP request through the priority queue. Lazily brings the
   * connection up on first call (per DESIGN.md "Lazy by default"). The
   * caller passes:
   *
   *   - `referencedFiles`: filesystem paths the call refers to so the
   *     document tracker can `didOpen` / `didChange` them before the
   *     request goes out.
   *   - `method` / `params`: the JSON-RPC method name and request body.
   *
   * Returns the typed result from the LSP server. JSON-RPC errors
   * propagate as `Error` instances; per-method `null` results pass
   * through unchanged (`hover` returning null is a normal case).
   */
  async request<TResult>(
    method: string,
    params: unknown,
    referencedFiles: readonly string[] = [],
    enqueueOpts?: Partial<EnqueueOptions>,
  ): Promise<TResult> {
    await this.ensureReady();
    return this.opts.queue.enqueue<TResult>(
      {
        method,
        timeoutMs: enqueueOpts?.timeoutMs,
        lane: enqueueOpts?.lane,
      },
      async () => {
        this.flushDocumentEvents(referencedFiles);
        const conn = this.connection;
        if (!conn) {
          throw new LspConnectionLostError("connection unavailable");
        }
        // `sendRequest<T>(method, params)` is the lowest-level overload;
        // vscode-jsonrpc returns whatever the server sent (or rejects
        // with the JSON-RPC error). We cast to `TResult` per the caller's
        // declared return type.
        return (await conn.sendRequest(method, params)) as TResult;
      },
    );
  }

  /**
   * Send a JSON-RPC notification (no response). Used for `didOpen` /
   * `didChange` and other LSP notifications. Lazy-inits the connection
   * the same way {@link request} does.
   */
  async notify(method: string, params: unknown): Promise<void> {
    await this.ensureReady();
    const conn = this.connection;
    if (!conn) {
      throw new LspConnectionLostError("connection unavailable");
    }
    await conn.sendNotification(method, params);
  }

  /**
   * Get cached diagnostics for `filePath` with the tiered-await
   * semantics from Wave 2 D29:
   *
   *   1. Auto-resync triggers `didChange` if disk content differs.
   *   2. If `didChange` was sent, await the next `publishDiagnostics`
   *      for that URI with **10s timeout on first-touch per URI in a
   *      session, 2s on subsequent awaits**.
   *   3. On timeout, return cached diagnostics with `partial: true`.
   *
   * Returns `{ diagnostics, partial }`. `partial` is true when the
   * await timed out OR when no push has arrived yet for an untouched URI.
   */
  async getDiagnostics(filePath: string): Promise<{
    diagnostics: LspDiagnostic[];
    partial: boolean;
  }> {
    await this.ensureReady();

    const uri = filePathToUri(filePath);
    // Snapshot the cache's `receivedAt` BEFORE emitting `didChange` so we
    // can detect "a fresh push arrived between our emit and our await".
    // Without this snapshot the push can race ahead of `awaitDiagnostics`
    // — the server is synchronous on `didChange` in practice (Wave 2 D29
    // describes the race explicitly).
    const cachedBefore = this.diagnosticsByUri.get(uri);
    const receivedAtBefore = cachedBefore?.receivedAt ?? 0;

    const events = this.opts.documents.syncReferenced([filePath]);
    const changed = events.some(
      (ev) => ev.kind === "didChange" || ev.kind === "didOpen",
    );
    for (const ev of events) {
      await this.emitDocumentEvent(ev);
    }

    const cachedAfter = this.diagnosticsByUri.get(uri);

    if (!changed && cachedAfter) {
      // No didChange went out → cache is authoritative.
      return { diagnostics: cachedAfter.diagnostics, partial: false };
    }

    // If a fresh push has already arrived since our snapshot (the server
    // raced us), use it immediately.
    if (cachedAfter && cachedAfter.receivedAt > receivedAtBefore) {
      this.opts.documents.markDiagnosticsTouched(filePath);
      return { diagnostics: cachedAfter.diagnostics, partial: false };
    }

    // Tiered await: 10s first-touch, 2s steady-state.
    const firstTouch = !this.opts.documents.diagnosticsTouched(filePath);
    const timeoutMs = firstTouch
      ? this.opts.config.diagnosticFirstMs
      : this.opts.config.diagnosticSteadyMs;

    try {
      const fresh = await this.awaitDiagnostics(uri, timeoutMs);
      this.opts.documents.markDiagnosticsTouched(filePath);
      return { diagnostics: fresh.diagnostics, partial: false };
    } catch {
      // Timeout: return cached + partial flag, never throw.
      this.opts.documents.markDiagnosticsTouched(filePath);
      return {
        diagnostics: cachedAfter?.diagnostics ?? [],
        partial: true,
      };
    }
  }

  /**
   * Test hook: directly inject a `publishDiagnostics` payload as though
   * Godot's server had pushed it. Internal use only — the production
   * push path runs through the `MessageConnection` notification
   * handler registered in {@link wireDiagnosticsHandler}.
   */
  __ingestPublishDiagnosticsForTesting(params: {
    uri: string;
    diagnostics: LspDiagnostic[];
  }): void {
    this.handlePublishDiagnostics(params);
  }

  /**
   * Lazy-init guard. Production callers in Wave 4 will use this through
   * `request()` / `notify()` / `getDiagnostics()`; exposed publicly so
   * tests can drive the init path without a side effect.
   */
  async ensureReady(): Promise<void> {
    const s = this.latch.state();
    if (s.kind === "ready") return;
    if (s.kind === "failed") {
      // Terminal failure for this session — re-throw the stored error
      // verbatim so callers see the same recoveryHint every call.
      throw s.error;
    }
    await this.start();
  }

  /**
   * Open a TCP connection to `127.0.0.1:port` and wrap it in a
   * `MessageConnection`. The socket factory is injected so tests can
   * supply a `stream.Duplex`-backed fake.
   */
  private connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectFn =
        this.opts.connect ??
        ((p, h) => net.createConnection({ port: p, host: h }));
      const socket = connectFn(port, LOOPBACK_HOST);
      const onError = (err: Error) => {
        socket.removeListener("connect", onConnect);
        reject(err);
      };
      const onConnect = () => {
        socket.removeListener("error", onError);
        this.socket = socket;
        const reader = new SocketMessageReader(socket);
        const writer = new SocketMessageWriter(socket);
        const connection = createMessageConnection(reader, writer);
        this.connection = connection;
        this.wireDiagnosticsHandler(connection);
        this.wireConnectionLostHandler(connection, socket);
        connection.listen();
        resolve();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  /**
   * Run the LSP `initialize` / `initialized` exchange. The initialize
   * payload mirrors DESIGN.md L411 — `openClose: true`, `change: 1`
   * (full sync), no workspace edits / will-save / semantic tokens.
   */
  private async handshake(): Promise<void> {
    const conn = this.connection;
    if (!conn) {
      throw new LspHandshakeFailedError("no connection");
    }
    const projectPathArg = this.opts.processManager.projectPath();
    const initializeParams = {
      processId: process.pid,
      clientInfo: { name: "godot-mcp", version: "0.1.0" },
      rootUri: projectPathArg ? filePathToUri(projectPathArg) : null,
      workspaceFolders: projectPathArg
        ? [
            {
              uri: filePathToUri(projectPathArg),
              name: projectPathArg.split(/[/\\]/).pop() ?? "project",
            },
          ]
        : null,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: false,
          },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          applyEdit: false,
          workspaceEdit: { documentChanges: false },
          configuration: false,
        },
      },
    };

    const timeoutMs = this.opts.config.requestTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    try {
      const result = await Promise.race([
        conn.sendRequest("initialize", initializeParams),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              rej(new LspHandshakeTimeoutError(timeoutMs));
            }
          }, timeoutMs);
        }),
      ]);
      settled = true;
      if (timer) clearTimeout(timer);
      const caps =
        (result as { capabilities?: KnownServerCapabilities } | null)
          ?.capabilities ?? {};
      this.capabilities = caps;
      await conn.sendNotification("initialized", {});
    } catch (err) {
      settled = true;
      if (timer) clearTimeout(timer);
      if (err instanceof LspUnavailableError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new LspHandshakeFailedError(detail);
    }
  }

  /**
   * Register the `textDocument/publishDiagnostics` notification handler.
   * Pushes go through {@link handlePublishDiagnostics}, which both
   * updates the cache and unblocks any pending waiters on that URI.
   */
  private wireDiagnosticsHandler(conn: MessageConnection): void {
    conn.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics: LspDiagnostic[] }) => {
        this.handlePublishDiagnostics(params);
      },
    );
  }

  /**
   * Handle a connection close: reject in-flight diagnostic waiters with
   * a connection-lost error and clear our connection pointer. The tiered
   * recovery layer (alive-check → reconnect → respawn) is deferred; a
   * future `recover()` call will drive it explicitly between sessions.
   */
  private wireConnectionLostHandler(
    conn: MessageConnection,
    socket: net.Socket,
  ): void {
    const onLost = () => {
      this.logger.warn("LSP connection dropped");
      if (this.connection === conn) {
        this.connection = null;
      }
      if (this.socket === socket) {
        this.socket = null;
      }
      this.rejectAllDiagnosticWaiters(
        new LspConnectionLostError("socket closed"),
      );
      // Reset the latch so the next `ensureReady()` re-runs init.
      if (this.latch.state().kind === "ready") {
        this.latch.reset();
      }
    };
    conn.onClose(onLost);
    socket.once("close", onLost);
    socket.once("error", onLost);
  }

  /**
   * Cache the pushed diagnostics under the URI and unblock waiters.
   */
  private handlePublishDiagnostics(params: {
    uri: string;
    diagnostics: LspDiagnostic[];
  }): void {
    const entry: DiagnosticCacheEntry = {
      diagnostics: params.diagnostics,
      receivedAt: this.now(),
    };
    this.diagnosticsByUri.set(params.uri, entry);
    const waiters = this.diagnosticWaiters.get(params.uri);
    if (waiters && waiters.length > 0) {
      this.diagnosticWaiters.delete(params.uri);
      for (const w of waiters) {
        w(entry);
      }
    }
  }

  /**
   * Block until the next `publishDiagnostics` push for `uri` arrives, or
   * `timeoutMs` elapses. Rejected on timeout so the caller can fall back
   * to cached state.
   */
  private awaitDiagnostics(
    uri: string,
    timeoutMs: number,
  ): Promise<DiagnosticCacheEntry> {
    return new Promise((resolve, reject) => {
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      const timer = setTimeout(() => {
        const arr = this.diagnosticWaiters.get(uri);
        if (arr) {
          const idx = arr.indexOf(onPush);
          if (idx >= 0) arr.splice(idx, 1);
        }
        reject(
          new Error(
            `publishDiagnostics timeout after ${timeoutMs}ms for ${uri}`,
          ),
        );
      }, timeoutMs);
      const onPush = (entry: DiagnosticCacheEntry) => {
        clearTimeout(timer);
        resolve(entry);
      };
      waiters.push(onPush);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  private rejectAllDiagnosticWaiters(_err: Error): void {
    // Diagnostic waiters use timeout-and-fallback rather than reject paths
    // for their happy completion, but on connection drop we want them to
    // settle promptly. Mark them resolved with the cached state (or empty
    // if none) so the tool's `partial: true` envelope still flows. The
    // error argument is retained for the public signature so a later
    // refactor can choose to reject explicitly without churn at call sites.
    void _err;
    for (const [uri, list] of this.diagnosticWaiters) {
      const fallback: DiagnosticCacheEntry = this.diagnosticsByUri.get(uri) ?? {
        diagnostics: [],
        receivedAt: this.now(),
      };
      for (const fn of list) {
        fn(fallback);
      }
    }
    this.diagnosticWaiters.clear();
  }

  /**
   * Push document events out the wire. Errors are logged but not
   * propagated — a failed `didOpen` shouldn't preempt the request that
   * triggered it; the request itself will surface its own error if the
   * LSP can't proceed without the document.
   */
  private flushDocumentEvents(referencedFiles: readonly string[]): void {
    const events = this.opts.documents.syncReferenced(referencedFiles);
    for (const ev of events) {
      void this.emitDocumentEvent(ev).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`document event emit failed: ${msg}`);
      });
    }
  }

  private async emitDocumentEvent(ev: DocumentEvent): Promise<void> {
    const conn = this.connection;
    if (!conn) return;
    const uri = filePathToUri(ev.filePath);
    if (ev.kind === "didOpen") {
      await conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: ev.filePath.endsWith(".gdshader")
            ? "gdshader"
            : "gdscript",
          version: ev.version,
          text: ev.text,
        },
      });
    } else {
      await conn.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: ev.version },
        contentChanges: [{ text: ev.text }],
      });
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}

/**
 * Render a filesystem path as an LSP `file://` URI. Handles Windows
 * drive-letter paths (`C:\foo\bar.gd` → `file:///C:/foo/bar.gd`) and
 * POSIX absolutes (`/foo/bar.gd` → `file:///foo/bar.gd`).
 *
 * Not exhaustive — UNC paths and percent-encoding edge cases land in
 * Wave 4 alongside the tools that consume them — but covers every path
 * the spawn manager hands us today.
 */
export function filePathToUri(filePath: string): string {
  if (filePath === "") return "";
  // Normalize backslashes; LSP URIs are forward-slash.
  const p = filePath.replace(/\\/g, "/");
  // Windows drive letter: `C:/foo` → `file:///C:/foo`.
  if (/^[A-Za-z]:\//.test(p)) {
    return `file:///${p}`;
  }
  // POSIX absolute: `/foo` → `file:///foo`.
  if (p.startsWith("/")) {
    return `file://${p}`;
  }
  // Bare relative — return as-is prefixed so consumers can distinguish
  // file URIs from synthetic gdscript:// URIs.
  return `file://${p}`;
}
