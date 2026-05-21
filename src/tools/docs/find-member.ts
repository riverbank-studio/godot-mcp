/**
 * `godot_find_member` — Look up a method, property, signal, constant, or
 * annotation on a Godot class by name.
 *
 * DESIGN.md § Tool surface → Documentation tools (#3):
 *
 *   - Required: `class`, `name`
 *   - Optional: `kind` (`method | property | signal | constant | annotation`)
 *   - When `kind` is omitted, returns **all** matching members across every
 *     kind (cross-kind name collisions are allowed by the schema).
 *   - Class not found / case mismatch → MCP error with suggestions.
 *   - Member not found → MCP error with suggestions from a cheap FTS5 scan.
 *
 * Registration follows the Wave 4 side-effect pattern: importing this file
 * calls `registerDocsTool` at module load time. The barrel at
 * `src/tools/docs/index.ts` must import this file to surface the tool.
 */

import type Database from "better-sqlite3";

import type { MemberKind } from "../../docs/class-xml.js";
import {
  docsNotFoundResponse,
  docsErrorResponse,
  docsResultResponse,
} from "../../docs/responses.js";
import { getDocsRuntime } from "../../docs/runtime.js";
import { registerDocsTool } from "../docs-tools.js";
import type { ToolContext, ToolResponse } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid values for the `kind` parameter. */
const VALID_KINDS: readonly MemberKind[] = [
  "method",
  "property",
  "signal",
  "constant",
  "annotation",
];

/** Maximum number of FTS5 / LIKE suggestions to return on a not-found error. */
const MAX_SUGGESTIONS = 5;

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

/**
 * Canonical member row shape returned to the caller. The `id` column is
 * omitted — it's an internal surrogate key with no meaning to the agent.
 */
interface MemberRow {
  class_name: string;
  kind: MemberKind;
  name: string;
  signature: string;
  description: string;
}

/**
 * Look up the canonical class name for the given input. Returns:
 *   - `{ found: true, canonical }` when the class exists (case-exact or
 *     after a case-insensitive match that the caller normalises).
 *   - `{ found: false, didYouMean }` when a case-insensitive hit exists but
 *     the exact-case lookup missed.
 *   - `{ found: false, didYouMean: undefined }` when no class matches at all.
 */
function resolveClassName(
  db: Database.Database,
  rawName: string,
): { found: true; canonical: string } | { found: false; didYouMean?: string } {
  // Exact-case lookup first (primary key, index scan).
  const exact = db
    .prepare(`SELECT name FROM classes WHERE name = ?`)
    .get(rawName) as { name: string } | undefined;

  if (exact) {
    return { found: true, canonical: exact.name };
  }

  // Case-insensitive fallback.
  const ci = db
    .prepare(`SELECT name FROM classes WHERE name = ? COLLATE NOCASE LIMIT 1`)
    .get(rawName) as { name: string } | undefined;

  if (ci) {
    return { found: false, didYouMean: ci.name };
  }

  return { found: false };
}

/**
 * Fetch member suggestions for a "member not found" error. Uses FTS5 prefix
 * search over the `name` column of `members_fts` scoped to the resolved class,
 * falling back to a plain LIKE when FTS returns nothing.
 */
function fetchMemberSuggestions(
  db: Database.Database,
  className: string,
  memberName: string,
): string[] {
  // Build a safe FTS5 token by stripping non-word chars so malformed member
  // names don't produce invalid MATCH expressions.
  const safeToken = memberName.replace(/[^A-Za-z0-9_]/g, "");
  if (safeToken.length > 0) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT m.name
           FROM members_fts
           JOIN members m ON members_fts.rowid = m.id
           WHERE members_fts.name MATCH ?
             AND m.class_name = ?
           LIMIT ?`,
        )
        .all(
          `"${safeToken.replace(/"/g, '""')}" *`,
          className,
          MAX_SUGGESTIONS,
        ) as { name: string }[];
      if (ftsRows.length > 0) {
        return ftsRows.map((r) => r.name);
      }
    } catch {
      // FTS5 parse errors are non-fatal; fall through to LIKE.
    }
  }

  // LIKE fallback for very short / symbol-only names.
  const likeRows = db
    .prepare(
      `SELECT name FROM members
       WHERE class_name = ?
         AND name LIKE ? ESCAPE '\\'
       LIMIT ?`,
    )
    .all(
      className,
      `%${memberName.replace(/[%_\\]/g, "\\$&")}%`,
      MAX_SUGGESTIONS,
    ) as { name: string }[];

  return likeRows.map((r) => r.name);
}

/**
 * Core DB query: fetch members matching `className` + `memberName` + optional
 * `kind`. Returns the raw rows.
 */
function queryMembers(
  db: Database.Database,
  className: string,
  memberName: string,
  kind: MemberKind | undefined,
): MemberRow[] {
  if (kind !== undefined) {
    return db
      .prepare(
        `SELECT class_name, kind, name, signature, description
         FROM members
         WHERE class_name = ?
           AND name = ?
           AND kind = ?`,
      )
      .all(className, memberName, kind) as MemberRow[];
  }

  return db
    .prepare(
      `SELECT class_name, kind, name, signature, description
       FROM members
       WHERE class_name = ?
         AND name = ?`,
    )
    .all(className, memberName) as MemberRow[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Exported for test access. The MCP dispatcher calls this via the
 * `ToolDefinition.handler` wrapper, but tests can call it directly with a
 * pre-wired runtime.
 *
 * `ctx` is accepted to conform to `ToolDefinition.handler`'s signature but is
 * not used — this tool queries the global docs runtime singleton, which is
 * independent of the per-call Godot-path context.
 */
export async function handleFindMember(
  rawArgs: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ctx: ToolContext,
): Promise<ToolResponse> {
  // ---- argument normalisation -------------------------------------------
  // Accept both camelCase (`className`) and plain (`class`) to match the
  // dual-key convention documented in CLAUDE.md § Parameter naming.
  const className =
    (rawArgs["class"] as string | undefined) ??
    (rawArgs["className"] as string | undefined);

  const memberName =
    (rawArgs["name"] as string | undefined) ??
    (rawArgs["memberName"] as string | undefined);

  const kindRaw = rawArgs["kind"] as string | undefined;

  if (!className || className.trim() === "") {
    return docsErrorResponse("Missing required argument: `class`", [
      "Provide the Godot class name, e.g. { class: 'Node', name: 'add_child' }",
    ]);
  }

  if (!memberName || memberName.trim() === "") {
    return docsErrorResponse("Missing required argument: `name`", [
      "Provide the member name to look up, e.g. { class: 'Node', name: 'add_child' }",
    ]);
  }

  let kind: MemberKind | undefined;
  if (kindRaw !== undefined) {
    if (!(VALID_KINDS as readonly string[]).includes(kindRaw)) {
      return docsErrorResponse(
        `Invalid \`kind\` value: '${kindRaw}'. Must be one of: ${VALID_KINDS.join(", ")}`,
        [
          "Omit `kind` to search across all member types",
          `Valid kinds: ${VALID_KINDS.join(", ")}`,
        ],
      );
    }
    kind = kindRaw as MemberKind;
  }

  // ---- delegate to the docs runtime ------------------------------------
  return getDocsRuntime().withDb(async (db) => {
    // 1. Resolve class name (exact then case-insensitive).
    const classResult = resolveClassName(db, className.trim());

    if (!classResult.found) {
      // Gather class-level FTS suggestions for the error response.
      const classSuggestions = (() => {
        const safeToken = className.trim().replace(/[^A-Za-z0-9_]/g, "");
        if (safeToken.length === 0) return [];
        try {
          const rows = db
            .prepare(
              `SELECT name FROM classes_fts
               WHERE classes_fts.name MATCH ?
               LIMIT ?`,
            )
            .all(`"${safeToken.replace(/"/g, '""')}" *`, MAX_SUGGESTIONS) as {
            name: string;
          }[];
          return rows.map((r) => r.name);
        } catch {
          return [];
        }
      })();

      if (classResult.didYouMean) {
        return docsNotFoundResponse(
          `Class '${className}' not found.`,
          classSuggestions,
          { didYouMean: classResult.didYouMean },
        );
      }

      return docsNotFoundResponse(
        `Class '${className}' not found.`,
        classSuggestions,
      );
    }

    const canonical = classResult.canonical;

    // 2. Query members.
    const rows = queryMembers(db, canonical, memberName.trim(), kind);

    if (rows.length > 0) {
      return docsResultResponse(rows);
    }

    // 3. Member not found — gather suggestions and return MCP error.
    const suggestions = fetchMemberSuggestions(
      db,
      canonical,
      memberName.trim(),
    );
    const kindLabel = kind ? ` (kind: ${kind})` : "";

    return docsNotFoundResponse(
      `Member '${memberName}'${kindLabel} not found on class '${canonical}'.`,
      suggestions,
    );
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerDocsTool({
  name: "godot_find_member",
  description:
    "Look up a specific method, property, signal, constant, or annotation on a Godot Engine class. " +
    "Use this when you already know the class and need exact details on one member — " +
    "prefer this over godot_get_class when you don't need the full class record. " +
    "Returns an array of matches; when `kind` is omitted, cross-kind name collisions return all hits. " +
    "On a miss, returns an MCP error with a `suggestions` array of similar member names.",
  inputSchema: {
    type: "object",
    properties: {
      class: {
        type: "string",
        description:
          "The Godot class name to search within (e.g. 'Node', 'Node2D').",
      },
      name: {
        type: "string",
        description:
          "The member name to look up (e.g. 'add_child', 'position').",
      },
      kind: {
        type: "string",
        enum: [...VALID_KINDS],
        description:
          "Optional kind filter. When omitted, all kinds are searched and all " +
          "matching members are returned (cross-kind collisions return multiple hits).",
      },
    },
    required: ["class", "name"],
  },
  handler: (args: Record<string, unknown>, ctx: ToolContext) =>
    handleFindMember(args, ctx),
});
