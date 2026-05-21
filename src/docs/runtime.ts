/**
 * Docs runtime singleton — owns the read-only DB handle and the
 * `InitLatch<Database>` that gates docs tool handlers during init.
 *
 * DESIGN.md § Concurrency model L327–335:
 *
 *   - Docs tool handlers (and only docs tool handlers) `await` the latch
 *     before querying.
 *   - Editor and LSP handlers are NOT blocked by docs init.
 *   - There is no "indexing in progress" response shape — tool calls
 *     block on the latch until ready or until the latch fails.
 *
 * DESIGN.md § Cross-subsystem independence L215–217:
 *
 *   - Docs cold-startup failure → server crashes (docs is core value).
 *   - Docs runtime-refetch failure → mark docs unavailable, return MCP
 *     error from docs tools, keep server up.
 *
 * The runtime exposes:
 *
 *   - `state()` — sync introspection for `godot_docs_info` (#19) and for
 *     tests.
 *   - `initialize(init)` — happy path, called once by the server during
 *     startup after the ingestion / DB-open completes.
 *   - `fail(error)` — failure path, called by the server (or by a
 *     runtime-refetch) when docs cannot be served.
 *   - `getDb()` — what tool handlers `await`. Resolves to the DB on
 *     ready, rejects on failed.
 *   - `withDb(body)` — convenience for the common handler pattern:
 *     await the latch, run a body that returns `ToolResponse`, convert a
 *     latch rejection into a docs MCP error response.
 *   - `describeSource()` — what `godot_docs_info` reports for the
 *     `source` field (DESIGN.md L84).
 *   - `reset()` / `dispose()` — lifecycle for runtime-refetch retry and
 *     test teardown.
 *
 * Why factory not class
 * ---------------------
 *
 * The latch primitive is factory-built (see `shared/latch.ts` rationale)
 * so consumers can't accidentally subclass and break invariants. The
 * runtime follows the same convention for consistency. A single
 * module-level `docsRuntime` singleton holds the live instance, created
 * lazily on first import — tests can construct disposable instances via
 * `createDocsRuntime()`.
 */

import type Database from "better-sqlite3";

import { createInitLatch, type InitLatch } from "../shared/latch.js";

import { docsErrorResponse } from "./responses.js";
import type { ToolResponse } from "../shared/types.js";

/**
 * The classification of where the docs DB came from. Surfaced verbatim
 * in `godot_docs_info`'s response (#19) so the user can tell whether
 * they're working off the bundled DB or a freshly-ingested cache.
 *
 *   - `"bundled"` → the in-package `data/docs-stable.db`.
 *   - `"cache"`   → a `$XDG_CACHE_HOME/godot-mcp/docs/...` cache file
 *     produced by the runtime ingestion pipeline.
 *   - `"override"` → `GODOT_DOCS_DB_PATH` env var pointed at a path.
 */
export type DocsSourceKind = "bundled" | "cache" | "override";

/**
 * Payload the server hands to {@link DocsRuntime.initialize} once the
 * DB is open. `db` is a live read-only `better-sqlite3` handle.
 */
export interface DocsRuntimeInit {
  db: Database.Database;
  source: DocsSourceKind;
  /** Resolved absolute filesystem path of the loaded DB. */
  path: string;
}

/**
 * Synchronous-introspectable state of the runtime. Mirrors
 * `LatchState<Database>` plus the source descriptor for the ready case
 * so `godot_docs_info` can resolve everything from one call.
 */
export type DocsRuntimeState =
  | { kind: "pending" }
  | { kind: "ready"; source: DocsSourceKind; path: string }
  | { kind: "failed"; error: Error };

/**
 * The docs runtime API. See module docstring for lifecycle semantics.
 */
export interface DocsRuntime {
  state(): DocsRuntimeState;
  /**
   * Transition `pending` → `ready`. Throws if already settled — call
   * `reset()` first to re-init.
   */
  initialize(init: DocsRuntimeInit): void;
  /**
   * Transition `pending` → `failed`. Throws if already settled.
   */
  fail(error: Error): void;
  /**
   * Resolve to the live DB handle once ready. Rejects with the original
   * error once failed.
   */
  getDb(): Promise<Database.Database>;
  /**
   * Convenience wrapper for tool handlers. Awaits the latch, runs `body`
   * with the DB, and converts any latch rejection into a docs MCP error
   * response (so a docs-unavailable state surfaces as `isError: true`
   * content rather than a thrown exception).
   */
  withDb(
    body: (db: Database.Database) => Promise<ToolResponse>,
  ): Promise<ToolResponse>;
  /**
   * Return the source descriptor for {@link DocsRuntime.state} === ready.
   * Throws when called against a non-ready runtime — `godot_docs_info`
   * is expected to call this only after `await getDb()` resolves.
   */
  describeSource(): { source: DocsSourceKind; path: string };
  /**
   * Clear settled state. Any in-flight `getDb()` promises reject with
   * `LatchResetError`; the runtime returns to `pending`.
   */
  reset(): void;
  /**
   * Close the DB and transition to a terminal failed state. Idempotent.
   */
  dispose(): void;
}

/**
 * Build a fresh docs runtime in `pending` state. Used by the server
 * (one instance per process) and by tests (disposable instances).
 */
export function createDocsRuntime(): DocsRuntime {
  const latch: InitLatch<Database.Database> = createInitLatch();
  // `sourceInfo` mirrors the `init.source` / `init.path` so
  // `describeSource()` is sync — the latch only carries the DB handle.
  let sourceInfo: { source: DocsSourceKind; path: string } | null = null;
  let disposed = false;

  const rt: DocsRuntime = {
    state() {
      const s = latch.state();
      switch (s.kind) {
        case "pending":
          return { kind: "pending" };
        case "ready":
          // sourceInfo must be set whenever the latch is ready; defensive
          // assertion for the case where someone bypasses initialize().
          if (!sourceInfo) {
            return {
              kind: "failed",
              error: new Error(
                "docs runtime: latch ready but source info is unset (initialize() bypass?)",
              ),
            };
          }
          return {
            kind: "ready",
            source: sourceInfo.source,
            path: sourceInfo.path,
          };
        case "failed":
          return { kind: "failed", error: s.error };
      }
    },

    initialize(init: DocsRuntimeInit) {
      sourceInfo = { source: init.source, path: init.path };
      latch.resolve(init.db);
    },

    fail(error: Error) {
      sourceInfo = null;
      latch.reject(error);
    },

    getDb() {
      return latch.await();
    },

    async withDb(body) {
      let db: Database.Database;
      try {
        db = await latch.await();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return docsErrorResponse(`Docs subsystem unavailable: ${msg}`, [
          "Check GODOT_DOCS_VERSION and that the docs DB was loaded at startup",
          "Use godot_docs_info to inspect the docs runtime state",
        ]);
      }
      return body(db);
    },

    describeSource() {
      if (!sourceInfo) {
        throw new Error(
          "docs runtime: describeSource() called against a runtime that has not initialized successfully (state is pending or failed)",
        );
      }
      return { source: sourceInfo.source, path: sourceInfo.path };
    },

    reset() {
      sourceInfo = null;
      latch.reset();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // Snapshot the DB out of the latch before transitioning so close()
      // runs even when the consumer never awaited.
      const s = latch.state();
      if (s.kind === "ready") {
        try {
          s.value.close();
        } catch {
          // Best-effort; better-sqlite3 throws if already closed.
        }
      }
      // Force failed state so subsequent getDb() calls reject rather
      // than hang.
      if (s.kind === "pending") {
        latch.reject(new Error("docs runtime disposed"));
      } else if (s.kind === "ready") {
        latch.reset();
        latch.reject(new Error("docs runtime disposed"));
      }
      sourceInfo = null;
    },
  };

  return rt;
}

/**
 * Process-wide singleton. The server initializes this once during
 * startup; tools import the same module and call `getDocsRuntime()`.
 *
 * Lazy-initialized so importing this module from a test doesn't create
 * a runtime the test then has to clean up — tests use
 * {@link createDocsRuntime} directly.
 */
let _singleton: DocsRuntime | null = null;

/**
 * Return the process-wide docs runtime, creating it on first call.
 * Server startup wires `initialize()` / `fail()` against this same
 * instance; tool handlers call `withDb()` / `getDb()` against it.
 */
export function getDocsRuntime(): DocsRuntime {
  if (_singleton === null) {
    _singleton = createDocsRuntime();
  }
  return _singleton;
}

/**
 * Test-only: drop the process-wide singleton so a subsequent
 * `getDocsRuntime()` returns a fresh instance. Production code should
 * never call this — the singleton is intentionally process-scoped.
 */
export function _resetDocsRuntimeForTesting(): void {
  if (_singleton !== null) {
    _singleton.dispose();
    _singleton = null;
  }
}
