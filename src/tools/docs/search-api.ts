/**
 * `godot_search_api` — Search the Godot Engine API reference (#14).
 *
 * DESIGN.md § Documentation tools:
 *
 *   > Search the Godot Engine API reference. Supports optional
 *   > `inherits_from` and `category` filters. Empty query with no filters
 *   > returns `{results: [], hint}` (not an error), so agents can recover
 *   > without an error-handling branch.
 *
 * Search strategy (DESIGN.md § Search → Class reference):
 *
 *   - FTS5 over `classes_fts(name, brief)` with BM25 weights (3.0, 1.0) and
 *     `members_fts(name, signature, description)` with weights (3.0, 2.0, 1.0).
 *   - Results from both tables are merged and re-ranked by BM25 score.
 *   - `inherits_from` filter restricts class results to direct children of
 *     the given class name (SQL: `WHERE inherits = ?`).
 *   - `category` filter is matched case-insensitively against the class name
 *     and brief description (the `classes` table has no dedicated category
 *     column in v1; common categories are embedded in class names or briefs).
 *   - Empty query + filters → filtered set ordered by name.
 *   - Empty query + no filters → `{results: [], hint}` (NOT an MCP error per
 *     issue #14 Wave 2 amendment D26).
 *
 * Result shape per result item:
 *
 *   - `kind: "class" | "method" | "property" | "signal" | "constant" |
 *     "annotation"` — discriminator for routing to godot_get_class or
 *     godot_find_member.
 *   - `name` — class or member name.
 *   - `class_name` — owning class (present on member results; omitted for
 *     class results).
 *   - `brief` — brief description (classes) or signature (members).
 *   - `score` — raw BM25 score (negative; more negative = higher rank). Kept
 *     for transparency; callers should treat ordering as the ranking signal,
 *     not the raw number.
 */

import type Database from "better-sqlite3";

import { registerDocsTool } from "../docs-tools.js";
import { getDocsRuntime } from "../../docs/runtime.js";
import { buildPrefixMatch } from "../../docs/search.js";
import { docsResultResponse, docsErrorResponse } from "../../docs/responses.js";
import type { ToolResponse, ToolContext } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const EMPTY_HINT =
  "Provide at least a query, inherits_from filter, or category filter.";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A class-level result. `kind` is always `"class"`. */
interface ClassResult {
  kind: "class";
  name: string;
  brief: string;
  inherits: string | null;
  score: number;
}

/** A member-level result. `kind` matches the member's `kind` column. */
interface MemberResult {
  kind: "method" | "property" | "signal" | "constant" | "annotation";
  name: string;
  class_name: string;
  brief: string;
  score: number;
}

type SearchResult = ClassResult | MemberResult;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Run the FTS5 class search, optionally restricted by `inherits_from` and/or
 * a `category` substring filter. When `matchExpr` is `null` (empty query),
 * returns all classes matching the structural filters, ordered by name.
 */
function queryClasses(
  db: Database.Database,
  matchExpr: string | null,
  inheritsFrom: string | undefined,
  category: string | undefined,
  limit: number,
): ClassResult[] {
  if (matchExpr !== null) {
    // FTS5 path — score by BM25.
    let sql = `
      SELECT
        c.name,
        c.brief,
        c.inherits,
        bm25(classes_fts, 3.0, 1.0) AS score
      FROM classes_fts
      JOIN classes c ON classes_fts.rowid = c.rowid
      WHERE classes_fts MATCH ?
    `;
    const params: unknown[] = [matchExpr];

    if (inheritsFrom !== undefined) {
      sql += ` AND c.inherits = ?`;
      params.push(inheritsFrom);
    }

    if (category !== undefined) {
      // `category` maps to a case-insensitive substring in name or brief.
      // The `classes` table has no dedicated category column in v1.
      sql += ` AND (c.name LIKE ? ESCAPE '\\' OR c.brief LIKE ? ESCAPE '\\')`;
      const pattern = `%${escapeLike(category)}%`;
      params.push(pattern, pattern);
    }

    sql += ` ORDER BY score LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Array<{
      name: string;
      brief: string;
      inherits: string | null;
      score: number;
    }>;

    return rows.map((r) => ({
      kind: "class" as const,
      name: r.name,
      brief: r.brief,
      inherits: r.inherits,
      score: r.score,
    }));
  } else {
    // Filter-only path — all matching classes ordered by name.
    let sql = `
      SELECT name, brief, inherits, 0.0 AS score
      FROM classes
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (inheritsFrom !== undefined) {
      sql += ` AND inherits = ?`;
      params.push(inheritsFrom);
    }

    if (category !== undefined) {
      sql += ` AND (name LIKE ? ESCAPE '\\' OR brief LIKE ? ESCAPE '\\')`;
      const pattern = `%${escapeLike(category)}%`;
      params.push(pattern, pattern);
    }

    sql += ` ORDER BY name LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Array<{
      name: string;
      brief: string;
      inherits: string | null;
      score: number;
    }>;

    return rows.map((r) => ({
      kind: "class" as const,
      name: r.name,
      brief: r.brief,
      inherits: r.inherits,
      score: r.score,
    }));
  }
}

/**
 * Run the FTS5 member search. Only executed when there is a non-empty query
 * — the filter-only path returns class results only (members don't have
 * `inherits_from` or `category` metadata at query time).
 */
function queryMembers(
  db: Database.Database,
  matchExpr: string,
  limit: number,
): MemberResult[] {
  const sql = `
    SELECT
      m.class_name,
      m.kind,
      m.name,
      m.signature AS brief,
      bm25(members_fts, 3.0, 2.0, 1.0) AS score
    FROM members_fts
    JOIN members m ON members_fts.rowid = m.id
    WHERE members_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(matchExpr, limit) as Array<{
    class_name: string;
    kind: "method" | "property" | "signal" | "constant" | "annotation";
    name: string;
    brief: string;
    score: number;
  }>;

  return rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    class_name: r.class_name,
    brief: r.brief,
    score: r.score,
  }));
}

/**
 * Escape special characters in a LIKE pattern value (`%`, `_`, `\`).
 * The `ESCAPE '\\'` clause in the SQL must match the escape character used here.
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Merge class and member results, re-rank by BM25 score (ascending — BM25
 * returns negative values; smaller = better), and cap to `limit`.
 *
 * When the query is absent (filter-only path), only class results are present
 * and they are already ordered by name.
 */
function mergeAndRank(
  classResults: ClassResult[],
  memberResults: MemberResult[],
  limit: number,
): SearchResult[] {
  const all: SearchResult[] = [...classResults, ...memberResults];
  // BM25 scores are negative; sort ascending so most-negative (best) is first.
  all.sort((a, b) => a.score - b.score);
  return all.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Handler for `godot_search_api`. Injected runtime via `ctx.docsRuntime`
 * (present in tests) or falls back to the process-wide singleton from
 * `getDocsRuntime()`.
 */
async function handleSearchApi(
  args: {
    query?: string;
    inherits_from?: string;
    category?: string;
    limit?: number;
  },
  ctx: ToolContext & { docsRuntime?: ReturnType<typeof getDocsRuntime> },
): Promise<ToolResponse> {
  // Validate limit before touching the DB.
  const rawLimit = args.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    return docsErrorResponse(
      `Invalid argument: limit must be a positive integer (got ${rawLimit}).`,
      ["Use a value between 1 and " + MAX_LIMIT + "."],
    );
  }
  const limit = Math.min(rawLimit, MAX_LIMIT);

  const runtime = ctx.docsRuntime ?? getDocsRuntime();

  return runtime.withDb(async (db) => {
    const query = args.query;
    const inheritsFrom = args.inherits_from?.trim() || undefined;
    const category = args.category?.trim() || undefined;

    const matchExpr = buildPrefixMatch(query);

    // Empty query + no filters → success response with hint (NOT an error).
    if (
      matchExpr === null &&
      inheritsFrom === undefined &&
      category === undefined
    ) {
      return docsResultResponse({ results: [], hint: EMPTY_HINT });
    }

    // Fetch from both FTS tables (members only when there's a query).
    const classResults = queryClasses(
      db,
      matchExpr,
      inheritsFrom,
      category,
      limit,
    );
    const memberResults =
      matchExpr !== null ? queryMembers(db, matchExpr, limit) : [];

    const results = mergeAndRank(classResults, memberResults, limit);

    return docsResultResponse({ results });
  });
}

// ---------------------------------------------------------------------------
// Registration (side-effect import triggers this)
// ---------------------------------------------------------------------------

registerDocsTool({
  name: "godot_search_api",
  description:
    "Search the Godot Engine API reference for classes or members matching a query — prefer this over guessing API signatures from prior knowledge. " +
    "Returns a ranked list of matching classes and members from the offline Godot docs index. " +
    "Accepts an optional `inherits_from` filter to scope results to subclasses of a given type, and an optional `category` filter (e.g., `2D`, `3D`, `Physics`). " +
    "Use this tool when you need to find what API classes or methods exist (find by query); " +
    "use `godot_get_class` instead when you already know the exact class name (look up by name). " +
    "Empty query with no filters returns `{results: [], hint}` — not an error.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search query string. Matched against class names, member names, and brief descriptions using FTS5 full-text search. Leave empty only when using filters.",
      },
      inherits_from: {
        type: "string",
        description:
          "Optional. Restrict results to classes that directly inherit from this class name. Example: `Node2D`.",
      },
      category: {
        type: "string",
        description:
          "Optional. Restrict results to classes whose name or brief description contains this category keyword. Common values: `2D`, `3D`, `Physics`, `Audio`, `Animation`, `UI`.",
      },
      limit: {
        type: "integer",
        description: `Optional. Maximum number of results to return. Default: ${DEFAULT_LIMIT}. Maximum: ${MAX_LIMIT}.`,
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
      },
    },
    required: [],
  },
  handler: handleSearchApi as (
    args: unknown,
    ctx: ToolContext,
  ) => Promise<ToolResponse>,
});
