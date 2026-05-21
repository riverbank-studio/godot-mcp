/**
 * `godot_get_class` — look up a specific Godot class by name.
 *
 * Issue #15 spec summary
 * ----------------------
 *
 *   - Exact lookup by `class_name` (TEXT, required).
 *   - Optional `include` array restricts the returned sections to any
 *     subset of: methods | properties | signals | constants | description |
 *     inheritance. Omitting `include` returns all sections.
 *   - Case-insensitive match: if the supplied name differs only in case
 *     from the stored canonical name, return `isError: true` with a
 *     "did you mean `Node`?" hint and the canonical name in `suggestions`.
 *   - Class not found: `isError: true` with a `suggestions` array built
 *     from a cheap FTS5 prefix search over `classes_fts`.
 *   - `inherits` is walked via a recursive CTE so `inheritance_chain`
 *     lists the full ancestor path from the class up to the root.
 *
 * Disambiguation (DESIGN.md § Tool descriptions)
 * -----------------------------------------------
 *
 *   - `godot_search_api` — find by query; this tool looks up by exact name.
 *   - `godot_find_member` — exact details on one member; this tool explores
 *     the full class record.
 *   - `godot_find_definition` — find a symbol the agent wrote; this tool
 *     looks up a built-in Godot type.
 */

import type Database from "better-sqlite3";

import { getDocsRuntime } from "../../docs/runtime.js";
import {
  docsNotFoundResponse,
  docsResultResponse,
} from "../../docs/responses.js";
import { registerDocsTool } from "../docs-tools.js";
import type { ToolDefinition, ToolResponse } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Include-set helpers
// ---------------------------------------------------------------------------

/** The valid section keys accepted in the `include` parameter. */
type IncludeKey =
  | "methods"
  | "properties"
  | "signals"
  | "constants"
  | "description"
  | "inheritance";

const ALL_INCLUDE_KEYS: ReadonlySet<IncludeKey> = new Set([
  "methods",
  "properties",
  "signals",
  "constants",
  "description",
  "inheritance",
]);

/** Normalize and validate the raw `include` value from the MCP args. */
function resolveIncludeSet(raw: unknown): ReadonlySet<IncludeKey> {
  if (!Array.isArray(raw) || raw.length === 0) return ALL_INCLUDE_KEYS;
  const out = new Set<IncludeKey>();
  for (const item of raw) {
    if (typeof item === "string" && ALL_INCLUDE_KEYS.has(item as IncludeKey)) {
      out.add(item as IncludeKey);
    }
  }
  return out.size > 0 ? out : ALL_INCLUDE_KEYS;
}

// ---------------------------------------------------------------------------
// Row types (narrowed from better-sqlite3's `unknown` returns)
// ---------------------------------------------------------------------------

interface ClassRow {
  name: string;
  inherits: string | null;
  brief: string;
  description: string;
  version: string | null;
}

interface MemberRow {
  kind: string;
  name: string;
  signature: string;
  description: string;
}

interface InheritanceRow {
  name: string;
}

// ---------------------------------------------------------------------------
// Core handler logic
// ---------------------------------------------------------------------------

/**
 * Fetch the FTS5 suggestions for a not-found class name. Returns at most
 * five similar class names by BM25 rank using a prefix match over
 * `classes_fts`.
 *
 * The query is intentionally lightweight — this runs on the error path so
 * latency is less critical than on the happy path.
 */
function fetchSuggestions(db: Database.Database, name: string): string[] {
  // Escape the name for FTS5: wrap in double-quoted literal, double any
  // embedded quotes, and append a prefix wildcard.
  const escaped = `"${name.replace(/"/g, '""')}" *`;
  const rows = db
    .prepare(
      `SELECT c.name
         FROM classes_fts f
         JOIN classes c ON c.rowid = f.rowid
        WHERE classes_fts MATCH ?
        ORDER BY bm25(classes_fts)
        LIMIT 5`,
    )
    .all(escaped) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Walk the inheritance chain from `startName` to the root using a
 * recursive CTE. Returns the chain in order from `startName` to root.
 */
function walkInheritanceChain(
  db: Database.Database,
  startName: string,
): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE chain(name, inherits, depth) AS (
         SELECT name, inherits, 0 FROM classes WHERE name = ?
         UNION ALL
         SELECT c.name, c.inherits, chain.depth + 1
           FROM classes c
           JOIN chain ON c.name = chain.inherits
       )
       SELECT name FROM chain ORDER BY depth`,
    )
    .all(startName) as InheritanceRow[];
  return rows.map((r) => r.name);
}

/**
 * Perform the exact-match lookup, returning the `ClassRow` or `null`.
 * Also performs a case-insensitive fallback when no exact row exists, so
 * the caller can return a "did you mean?" hint.
 */
function lookupClass(
  db: Database.Database,
  className: string,
): { exact: ClassRow | null; caseMatch: ClassRow | null } {
  const exact = db
    .prepare(
      `SELECT name, inherits, brief, description, version
         FROM classes WHERE name = ?`,
    )
    .get(className) as ClassRow | undefined;

  if (exact) return { exact, caseMatch: null };

  // Case-insensitive fallback (NOCASE affinity in SQLite).
  const caseMatch = db
    .prepare(
      `SELECT name, inherits, brief, description, version
         FROM classes WHERE name = ? COLLATE NOCASE`,
    )
    .get(className) as ClassRow | undefined;

  return { exact: null, caseMatch: caseMatch ?? null };
}

/**
 * Fetch all members of a class filtered by kind(s). Used for the
 * include-filtered response.
 */
function fetchMembers(
  db: Database.Database,
  className: string,
  kinds: string[],
): MemberRow[] {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT kind, name, signature, description
         FROM members
        WHERE class_name = ?
          AND kind IN (${placeholders})
        ORDER BY kind, name`,
    )
    .all(className, ...kinds) as MemberRow[];
}

/**
 * Build the structured result payload from the class row and include set.
 */
async function buildClassPayload(
  db: Database.Database,
  row: ClassRow,
  include: ReadonlySet<IncludeKey>,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    name: row.name,
    brief: row.brief,
    version: row.version,
  };

  if (include.has("description")) {
    payload.description = row.description;
  }

  if (include.has("inheritance")) {
    payload.inherits = row.inherits;
    payload.inheritance_chain = walkInheritanceChain(db, row.name);
  }

  // Collect which member kinds to fetch.
  const kindMap: Record<IncludeKey, string | null> = {
    methods: "method",
    properties: "property",
    signals: "signal",
    constants: "constant",
    description: null,
    inheritance: null,
  };

  const kindsNeeded: string[] = [];
  for (const key of include) {
    const k = kindMap[key];
    if (k !== null) kindsNeeded.push(k);
  }

  if (kindsNeeded.length > 0) {
    const allMembers = fetchMembers(db, row.name, kindsNeeded);

    for (const key of include) {
      const kind = kindMap[key];
      if (kind === null) continue;
      payload[key] = allMembers
        .filter((m) => m.kind === kind)
        .map(({ name, signature, description }) => ({
          name,
          signature,
          description,
        }));
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * MCP tool handler for `godot_get_class`.
 */
async function handleGetClass(
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any
       -- MCP args arrive as JSON-shaped unknown; we narrow manually. */
  rawArgs: any,
): Promise<ToolResponse> {
  const className: unknown = rawArgs?.class_name;
  if (typeof className !== "string" || className.trim() === "") {
    return {
      content: [
        {
          type: "text",
          text: "`class_name` is required and must be a non-empty string.",
        },
      ],
      isError: true,
    };
  }

  const include = resolveIncludeSet(rawArgs?.include);

  return getDocsRuntime().withDb(async (db) => {
    const { exact, caseMatch } = lookupClass(db, className);

    if (exact) {
      const payload = await buildClassPayload(db, exact, include);
      return docsResultResponse(payload);
    }

    if (caseMatch) {
      // Case mismatch — tell the caller the canonical name.
      return docsNotFoundResponse(
        `Class '${className}' not found. Class names are case-sensitive in Godot.`,
        [caseMatch.name],
        { didYouMean: caseMatch.name },
      );
    }

    // Completely absent — run FTS5 suggestions.
    const suggestions = fetchSuggestions(db, className);
    return docsNotFoundResponse(
      `Class '${className}' not found in the Godot API reference.`,
      suggestions,
    );
  });
}

// ---------------------------------------------------------------------------
// Tool definition + registration
// ---------------------------------------------------------------------------

const getClassTool: ToolDefinition = {
  name: "godot_get_class",
  description:
    "Look up a Godot Engine class by name and return its full structured record. " +
    "Use this tool when you know the exact class name and want to explore it (methods, properties, signals, constants, description, or inheritance). " +
    "Prefer `godot_search_api` when you need to find a class by query rather than exact name. " +
    "Prefer `godot_find_member` when you need exact details on a single member rather than the full class. " +
    "Prefer `godot_find_definition` when you want to find a symbol in the user's GDScript rather than a built-in Godot type.",
  inputSchema: {
    type: "object",
    properties: {
      class_name: {
        type: "string",
        description:
          "The Godot class name to look up. Case-sensitive — `Node` not `node`. " +
          "On a case mismatch the tool returns an error with the canonical name in a 'did you mean?' hint.",
      },
      include: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "methods",
            "properties",
            "signals",
            "constants",
            "description",
            "inheritance",
          ],
        },
        description:
          "Optional subset of sections to include in the response. " +
          "Omit or pass an empty array to receive all sections. " +
          "Valid values: methods, properties, signals, constants, description, inheritance.",
      },
    },
    required: ["class_name"],
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handler: (args, _ctx) => handleGetClass(args),
};

registerDocsTool(getClassTool);
