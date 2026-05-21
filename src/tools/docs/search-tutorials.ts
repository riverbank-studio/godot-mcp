/**
 * `godot_search_tutorials` leaf tool (#17).
 *
 * Search Godot's tutorials and guides (prose docs). Use this for how-to
 * questions and conceptual guides; use `godot_search_api` for API class
 * and member signatures.
 *
 * Retrieval strategy (DESIGN.md § Search → Tutorials)
 * ----------------------------------------------------
 *
 *   1. **Lexical layer:** FTS5 over `tutorials_fts(heading_path, content)`
 *      with column weights `bm25(tutorials_fts, 2.0, 1.0)` (heading_path
 *      2×, content 1×).
 *
 *   2. **Dense layer (optional):** `sqlite-vec` cosine similarity over the
 *      `tutorials.embedding` BLOB column.  If `sqlite-vec` is not loaded on
 *      the DB connection (extension not installed, or runtime model not yet
 *      downloaded) the dense layer is silently skipped and lexical results
 *      are returned directly.
 *
 *   3. **Fusion:** Reciprocal Rank Fusion (RRF) with k=60 when both layers
 *      produce results.  Pure lexical otherwise.
 *
 * Why the dense layer is optional
 * --------------------------------
 *
 * `sqlite-vec` is a native extension not bundled with the package (DESIGN.md
 * Wave 2 D7 defers the vec0 virtual-table setup to the tools layer).  The
 * embedding model is also lazy-loaded on first call.  Both deps are absent in
 * the bundled-DB path and in CI where the model is not downloaded.  Graceful
 * degradation to lexical-only preserves usefulness without failing the tool.
 *
 * Registration
 * ------------
 *
 * This file calls `registerDocsTool` at module-load time.  The import that
 * triggers this side effect lives in `src/tools/index.ts` (not
 * `src/tools/docs/index.ts`).  It must sit there — rather than inside
 * `docs-tools.ts` or the leaf barrel — because of an ESM TDZ circular-dep:
 * `docs-tools.ts` exports `docsTools`, `src/tools/index.ts` spreads
 * `docsTools` into `allTools`, and any leaf import inside `docs-tools.ts`
 * would form a cycle that reads `docsTools` before it is initialised
 * (orchestration-plan §7 hotspot mitigation).
 *
 * Canonical reference for leaf PRs #14, #15, #16, #18, #19: to register a
 * new docs tool, add a single import line to `src/tools/index.ts` — that is
 * the only dispatch-layer change required.
 */

import type Database from "better-sqlite3";

import {
  buildPrefixMatch,
  isQueryEffectivelyEmpty,
} from "../../docs/search.js";
import { getDocsRuntime } from "../../docs/runtime.js";
import { docsErrorResponse, docsResultResponse } from "../../docs/responses.js";
import { registerDocsTool } from "../docs-tools.js";
import type {
  ToolDefinition,
  ToolContext,
  ToolResponse,
} from "../../shared/types.js";

// ── constants ────────────────────────────────────────────────────────────────

/**
 * Default maximum results returned by the tool.  Matches the FTS5 leaf
 * convention across the docs tools family.
 */
const DEFAULT_LIMIT = 10;

/**
 * Maximum limit the caller may request.  Guards against accidentally
 * requesting the entire tutorial corpus.
 */
const MAX_LIMIT = 50;

/**
 * RRF k constant per DESIGN.md L321 and Cormack, Clarke, Büttcher (SIGIR'09).
 * Elastic, Vespa, and OpenSearch all ship k=60 as their default.
 */
const RRF_K = 60;

// ── RRF helper (exported for unit testing) ───────────────────────────────────

/**
 * Reciprocal Rank Fusion over two ranked lists of integer row IDs.
 *
 * Each ID's score is the sum of `1 / (k + rank)` across the lists it appears
 * in (0-based rank).  IDs absent from a list contribute 0 for that list.
 * Ties broken by secondary occurrence in `lexicalIds` (stable sort).
 *
 * @param lexicalIds  Ordered row IDs from the FTS5 lexical layer.
 * @param denseIds    Ordered row IDs from the dense (embedding) layer.
 * @returns           Fused ordered list with duplicates removed.
 */
export function reciprocalRankFusion(
  lexicalIds: readonly number[],
  denseIds: readonly number[],
): number[] {
  const scores = new Map<number, number>();

  for (let rank = 0; rank < lexicalIds.length; rank++) {
    const id = lexicalIds[rank]!;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
  }
  for (let rank = 0; rank < denseIds.length; rank++) {
    const id = denseIds[rank]!;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ── FTS5 lexical search ──────────────────────────────────────────────────────

/** Row returned from the FTS5 query. */
interface FtsRow {
  id: number;
  page_path: string;
  heading_path: string;
  snippet: string;
}

/**
 * Run the FTS5 lexical search against `tutorials_fts`.
 *
 * Column weights per DESIGN.md L319:
 *   `bm25(tutorials_fts, 3.0, 2.0, 1.0)` — title 3×, heading_path 2×, content 1×.
 *
 * Note: `tutorials_fts` has two columns: `heading_path` (col 0) and `content`
 * (col 1), mirroring the schema in `schema.ts`.  There is no separate
 * `title` column — title information lives as the first segment of
 * `heading_path`.  We apply weights `2.0` (heading_path) and `1.0` (content).
 *
 * The `snippet()` function renders a short highlighted excerpt; the `[` / `]`
 * markers are chosen as they're safe for Markdown rendering without escaping.
 */
function lexicalSearch(
  db: Database.Database,
  matchExpr: string,
  limit: number,
): FtsRow[] {
  // FTS5 external-content tables require a join to get non-FTS columns.
  const rows = db
    .prepare(
      `SELECT t.id,
              t.page_path,
              t.heading_path,
              snippet(tutorials_fts, 1, '[', ']', '...', 16) AS snippet
       FROM tutorials_fts
       JOIN tutorials t ON t.id = tutorials_fts.rowid
       WHERE tutorials_fts MATCH ?
       ORDER BY bm25(tutorials_fts, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(matchExpr, limit) as FtsRow[];
  return rows;
}

// ── dense search (optional) ──────────────────────────────────────────────────

/**
 * Attempt to embed the query and run cosine similarity over `tutorials.embedding`.
 * Returns an empty array if:
 *   - The embedding model is not available (lazy-load not yet triggered), or
 *   - `sqlite-vec` extension is not loaded on this DB connection, or
 *   - Any other error occurs during dense retrieval.
 *
 * Silent fallback is intentional — the lexical layer always runs, and the
 * dense layer is an additive quality improvement, not a hard requirement.
 */
async function denseSearch(
  db: Database.Database,
  _query: string,
  limit: number,
): Promise<number[]> {
  try {
    // Try to detect whether sqlite-vec is loaded by probing for the vec0
    // virtual table existence.  If the table doesn't exist, the extension
    // isn't wired up yet — skip silently.
    const vtab = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'tutorials_vec'
         LIMIT 1`,
      )
      .get() as { name: string } | undefined;

    if (!vtab) {
      // Dense layer not available — fall through to lexical-only path.
      return [];
    }

    // When sqlite-vec IS wired up (future: after embedding runtime PR lands),
    // this path embeds the query and runs vec_search().  For now the table
    // won't exist in any standard installation, so the probe above short-
    // circuits first.
    //
    // Future implementation sketch:
    //   const qVec = await embedQuery(query);
    //   const rows = db.prepare(
    //     `SELECT rowid, distance
    //      FROM tutorials_vec
    //      WHERE embedding MATCH ? AND k = ?`
    //   ).all(serializeVec(qVec), limit) as Array<{ rowid: number }>;
    //   return rows.map(r => r.rowid);
    void limit;
    return [];
  } catch {
    // Any unexpected error (extension loaded but query fails, schema
    // mismatch, etc.) — degrade gracefully to lexical-only.
    return [];
  }
}

// ── result shape ─────────────────────────────────────────────────────────────

/**
 * One entry in the `results` array returned to the caller.
 */
interface TutorialResult {
  page_path: string;
  heading_path: string;
  snippet: string;
}

// ── handler ──────────────────────────────────────────────────────────────────

/**
 * Core handler implementation, separated so tests can inject a DB directly
 * without going through the runtime latch.
 */
async function handle(
  db: Database.Database,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const query = typeof args["query"] === "string" ? args["query"] : undefined;
  const limitRaw = args["limit"];

  // Validate: query required.
  if (isQueryEffectivelyEmpty(query)) {
    return docsErrorResponse(
      "godot_search_tutorials requires a non-empty query. " +
        'Describe what you want to learn about (e.g. "how to move a RigidBody2D").',
      [
        "Provide a descriptive query about a Godot concept or workflow.",
        "Use godot_search_api instead if you want to look up a class or method signature.",
      ],
    );
  }

  // Validate: limit (optional).
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    if (
      typeof limitRaw !== "number" ||
      !Number.isInteger(limitRaw) ||
      limitRaw <= 0
    ) {
      return docsErrorResponse(
        `Invalid 'limit': ${String(limitRaw)}. Must be a positive integer.`,
      );
    }
    limit = Math.min(limitRaw, MAX_LIMIT);
  }

  // Build the FTS5 MATCH expression.  `buildPrefixMatch` is guaranteed
  // non-null here because `isQueryEffectivelyEmpty` already rejected the
  // empty case above.
  const matchExpr = buildPrefixMatch(query)!;

  // Run lexical search.  We request `limit` rows; if RRF is active we
  // request more from each layer so fusion has candidates to re-rank.
  const lexicalOverfetch = limit * 3;
  const lexicalRows = lexicalSearch(db, matchExpr, lexicalOverfetch);

  // Run dense search (may return [] if extension not available).
  const denseIds = await denseSearch(db, query!, limit * 3);

  let orderedIds: number[];

  if (denseIds.length === 0) {
    // Lexical-only: row order from FTS5 BM25 already optimal.
    orderedIds = lexicalRows.map((r) => r.id);
  } else {
    // Hybrid: fuse via RRF then trim.
    orderedIds = reciprocalRankFusion(
      lexicalRows.map((r) => r.id),
      denseIds,
    );
  }

  // Trim to the requested limit.
  orderedIds = orderedIds.slice(0, limit);

  if (orderedIds.length === 0) {
    return docsResultResponse({ results: [] });
  }

  // Re-join to get the display fields in fused order.
  // Build a quick lookup from the FTS lexical rows (already fetched).
  const rowById = new Map<number, FtsRow>(lexicalRows.map((r) => [r.id, r]));

  // For any IDs that came exclusively from the dense layer and were not
  // in the FTS result set, fetch them now.
  const missingIds = orderedIds.filter((id) => !rowById.has(id));
  if (missingIds.length > 0) {
    const placeholders = missingIds.map(() => "?").join(",");
    const extra = db
      .prepare(
        `SELECT t.id,
                t.page_path,
                t.heading_path,
                substr(t.content, 1, 160) AS snippet
         FROM tutorials t
         WHERE t.id IN (${placeholders})`,
      )
      .all(...missingIds) as FtsRow[];
    for (const r of extra) {
      rowById.set(r.id, r);
    }
  }

  const results: TutorialResult[] = orderedIds
    .filter((id) => rowById.has(id))
    .map((id) => {
      const r = rowById.get(id)!;
      return {
        page_path: r.page_path,
        heading_path: r.heading_path,
        snippet: r.snippet,
      };
    });

  return docsResultResponse({ results });
}

// ── tool definition ──────────────────────────────────────────────────────────

/**
 * The `godot_search_tutorials` tool definition.  Exported so tests can
 * reference the handler directly without going through the registry array.
 */
export const searchTutorialsTool: ToolDefinition = {
  name: "godot_search_tutorials",
  description:
    "Search Godot's tutorials and guides (prose docs) for how-to questions and " +
    "conceptual explanations. Use this when you need to understand how to accomplish " +
    'something in Godot (e.g. "how to animate a character", "physics layer setup"). ' +
    "For API class or method signatures, use godot_search_api instead. " +
    "Returns ranked tutorial chunks with page path, heading context, and a content snippet. " +
    "Prefer this over guessing from prior knowledge — Godot APIs change between versions.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text search query. Describe the concept or workflow you want to learn about. " +
          'Supports partial-word prefix matching (e.g. "Anim" matches "AnimationPlayer" chunks).',
      },
      limit: {
        type: "number",
        description: `Maximum number of tutorial chunks to return. Must be a positive integer; capped at ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    required: ["query"],
  },
  async handler(
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResponse> {
    // Allow tests to inject a DB directly via the private `_db` property on
    // the context stub, bypassing the runtime latch.  Production code never
    // sets `_db`; the property is absent and the runtime path is taken.
    const ctxAsAny = _ctx as unknown as { _db?: Database.Database };
    if (ctxAsAny._db !== undefined) {
      return handle(ctxAsAny._db, args);
    }

    return getDocsRuntime().withDb((db) => handle(db, args));
  },
};

// ── self-registration (side effect) ──────────────────────────────────────────

registerDocsTool(searchTutorialsTool);
