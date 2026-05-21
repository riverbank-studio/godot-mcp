/**
 * `godot_docs_info` tool — issue #19.
 *
 * Meta tool: returns information about the documentation database currently
 * loaded (Godot version, source kind, indexed_at, class/tutorial counts,
 * ingestion warnings, embedding model, and source SHAs).
 *
 * Per DESIGN.md §Documentation tools: "Get information about the documentation
 * currently loaded." Blocks on the docs latch until ready; no "indexing in
 * progress" intermediate shape exists.
 *
 * Response shape
 * --------------
 *
 * On success, a single JSON text block containing:
 *
 *   {
 *     godot_version:        string,
 *     godot_docs_branch:    string,
 *     schema_version:       number,
 *     indexed_at:           string (ISO 8601 UTC),
 *     class_count:          number,
 *     tutorial_count:       number,
 *     ingest_warnings:      string[],
 *     embedding_model_id:   string,
 *     ingestion_source_sha: string,
 *     ingestion_duration_ms: number,
 *     tarball_sha256:       string,
 *     docs_tarball_sha256:  string,
 *     source:               "bundled" | "cache" | "override",
 *     path:                 string,
 *   }
 *
 * `ingest_warnings` is parsed from the JSON-string column so callers receive
 * a native array rather than a double-encoded string.
 *
 * On docs-unavailable, an `isError: true` response from `withDb`.
 *
 * Testing
 * -------
 *
 * Tests in `docs-info.test.ts` inject a disposable runtime via
 * `_setDocsRuntimeForTesting`. Production code uses the process-level
 * singleton from `getDocsRuntime()`.
 */

import type Database from "better-sqlite3";

import { readMeta } from "../../docs/schema.js";
import { getDocsRuntime, type DocsRuntime } from "../../docs/runtime.js";
import { docsErrorResponse, docsResultResponse } from "../../docs/responses.js";
import type { ToolResponse } from "../../shared/types.js";

import { registerDocsTool } from "../docs-tools.js";

// ──────────────────────────────────────────────────────────────────────────────
// Test seam
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The runtime instance used by the handler. Tests swap this via
 * `_setDocsRuntimeForTesting`; production always resolves to the process
 * singleton.
 */
let _runtimeOverride: DocsRuntime | null = null;

/**
 * Test-only: replace the docs runtime used by this module's handler and
 * return a restore callback. Call the restore callback in `afterEach` to
 * remove the override.
 *
 * ```ts
 * const restore = _setDocsRuntimeForTesting(myRuntime);
 * afterEach(restore);
 * ```
 */
export function _setDocsRuntimeForTesting(rt: DocsRuntime): () => void {
  _runtimeOverride = rt;
  return () => {
    _runtimeOverride = null;
  };
}

/** Return the runtime in use — override in tests, singleton in production. */
function activeRuntime(): DocsRuntime {
  return _runtimeOverride ?? getDocsRuntime();
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Handle the `godot_docs_info` tool invocation. Awaits the docs latch, reads
 * the `meta` table, and returns the merged payload.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function handleDocsInfo(_args: unknown): Promise<ToolResponse> {
  const rt = activeRuntime();

  return rt.withDb(async (db: Database.Database) => {
    const meta = readMeta(db);

    if (meta === null) {
      return docsErrorResponse(
        "Docs DB is open but the meta table is empty — the database may be corrupt or improperly initialized.",
        [
          "Delete the cached DB and let the server reingest (remove $XDG_CACHE_HOME/godot-mcp/docs/)",
          "Or set GODOT_DOCS_DB_PATH to a correctly-initialized database",
        ],
      );
    }

    // Parse the JSON-string column so callers receive a native array.
    let ingestWarnings: string[];
    try {
      const parsed = JSON.parse(meta.ingest_warnings);
      ingestWarnings = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      ingestWarnings = [];
    }

    const { source, path } = rt.describeSource();

    return docsResultResponse({
      godot_version: meta.godot_version,
      godot_docs_branch: meta.godot_docs_branch,
      schema_version: meta.schema_version,
      indexed_at: meta.indexed_at,
      class_count: meta.class_count,
      tutorial_count: meta.tutorial_count,
      ingest_warnings: ingestWarnings,
      embedding_model_id: meta.embedding_model_id,
      ingestion_source_sha: meta.ingestion_source_sha,
      ingestion_duration_ms: meta.ingestion_duration_ms,
      tarball_sha256: meta.tarball_sha256,
      docs_tarball_sha256: meta.docs_tarball_sha256,
      source,
      path,
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Registration (side-effect on import)
// ──────────────────────────────────────────────────────────────────────────────

registerDocsTool({
  name: "godot_docs_info",
  description:
    "Get information about the Godot documentation database currently loaded — version, source (bundled/cache/override), indexed_at timestamp, class count, tutorial count, ingestion warnings, and embedding model id. " +
    "Use this to verify which docs version is active or to diagnose a docs-subsystem problem. " +
    "Prefer godot_get_class or godot_search_api to look up a specific class or API member.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: handleDocsInfo,
});
