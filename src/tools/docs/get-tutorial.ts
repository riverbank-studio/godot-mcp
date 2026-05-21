/**
 * `godot_get_tutorial` leaf tool (#18).
 *
 * Fetches the full content of a Godot tutorial page by its path as returned
 * by `godot_search_tutorials`. All chunks for the page are assembled in
 * chunk_index order and returned as a structured payload.
 *
 * Behavior (DESIGN.md § Documentation tools #5 and issue #18):
 *   - `path` comes from a prior `godot_search_tutorials` result.
 *   - Tutorial not found → MCP error with `suggestions` array (cheap FTS5
 *     near-match over heading_path).
 *   - Missing `path` argument → MCP error.
 *   - Docs runtime unavailable → MCP error via `runtime.withDb`.
 *
 * Wire payload on success:
 * ```json
 * {
 *   "path": "tutorials/3d/using_gridmaps.rst",
 *   "chunks": [
 *     { "chunk_index": 0, "heading_path": "Using GridMaps", "content": "..." },
 *     { "chunk_index": 1, "heading_path": "Using GridMaps / Step 2", "content": "..." }
 *   ]
 * }
 * ```
 */

import type Database from "better-sqlite3";

import { getDocsRuntime } from "../../docs/runtime.js";
import {
  docsNotFoundResponse,
  docsResultResponse,
  docsErrorResponse,
} from "../../docs/responses.js";
import { registerDocsTool } from "../docs-tools.js";
import type { ToolResponse } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

/** One row from the `tutorials` table, excluding the embedding BLOB. */
interface TutorialChunkRow {
  chunk_index: number;
  heading_path: string;
  content: string;
}

/**
 * Fetch all chunks for `pagePath` ordered by `chunk_index`.
 * Returns an empty array when the path is not present in the DB.
 */
function fetchChunks(
  db: Database.Database,
  pagePath: string,
): TutorialChunkRow[] {
  return db
    .prepare(
      `SELECT chunk_index, heading_path, content
         FROM tutorials
        WHERE page_path = ?
        ORDER BY chunk_index ASC`,
    )
    .all(pagePath) as TutorialChunkRow[];
}

/**
 * Return up to `limit` page paths whose heading_path or content FTS5-matches
 * the given path string. Used to populate the `suggestions` array in not-found
 * responses.
 *
 * The query uses the last path segment (basename) as the search probe — it
 * provides more signal than the full path and avoids FTS5 operator collisions
 * from `/` characters.
 */
function fetchSuggestions(
  db: Database.Database,
  pagePath: string,
  limit = 5,
): string[] {
  // Extract the last segment (e.g. "using_gridmaps.rst" from a full path).
  const segment = pagePath.split("/").pop() ?? pagePath;
  // Strip file extension for a cleaner FTS5 probe.
  const probe = segment.replace(/\.[^.]+$/, "").replace(/_/g, " ");

  if (!probe.trim()) return [];

  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT t.page_path
           FROM tutorials_fts
           JOIN tutorials t ON tutorials_fts.rowid = t.id
          WHERE tutorials_fts MATCH ?
          LIMIT ?`,
      )
      .all(`${probe}*`, limit) as Array<{ page_path: string }>;
    return rows.map((r) => r.page_path);
  } catch {
    // FTS5 MATCH can throw on degenerate probes; return empty suggestions
    // rather than surface an error.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core handler logic — runs inside `withDb` so the runtime-unavailable case
 * is handled by the caller.
 */
async function handleGetTutorial(
  db: Database.Database,
  pagePath: string,
): Promise<ToolResponse> {
  const chunks = fetchChunks(db, pagePath);

  if (chunks.length === 0) {
    const suggestions = fetchSuggestions(db, pagePath);
    return docsNotFoundResponse(
      `Tutorial not found: "${pagePath}". Use godot_search_tutorials to discover valid paths.`,
      suggestions,
    );
  }

  return docsResultResponse({ path: pagePath, chunks });
}

// ---------------------------------------------------------------------------
// Test back-door
// ---------------------------------------------------------------------------

/**
 * Test-only entry point that calls the handler body directly against the
 * process-wide docs runtime. Follows the `_` prefix convention for
 * test back-doors used elsewhere in this repo (see `_resetDocsRuntimeForTesting`).
 *
 * Tests should set up the runtime (e.g. `getDocsRuntime().initialize(...)`)
 * before calling this.
 */
export async function _handleGetTutorialForTesting(
  pagePath: string,
): Promise<ToolResponse> {
  return getDocsRuntime().withDb((db) => handleGetTutorial(db, pagePath));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerDocsTool({
  name: "godot_get_tutorial",
  description:
    "Fetch the full content of a Godot tutorial by its path — use this after `godot_search_tutorials` returns a path, not for discovery. " +
    "Use `godot_search_tutorials` first to discover relevant tutorial paths, then call this tool to read the content.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Tutorial path as returned in `godot_search_tutorials` results. Example: `tutorials/3d/using_gridmaps.rst`.",
      },
    },
    required: ["path"],
  },
  async handler(args) {
    const { path: pagePath } = args as { path?: string };

    if (!pagePath || typeof pagePath !== "string" || !pagePath.trim()) {
      return docsErrorResponse(
        "Missing required argument: `path`. Pass the tutorial path returned by `godot_search_tutorials`.",
      );
    }

    return getDocsRuntime().withDb((db) =>
      handleGetTutorial(db, pagePath.trim()),
    );
  },
});
