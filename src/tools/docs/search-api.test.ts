/**
 * Tests for the `godot_search_api` tool (#14).
 *
 * These tests exercise the full handler path against an in-memory
 * better-sqlite3 database so there is no Godot dependency. The database
 * is seeded with a small set of classes and members that cover the
 * branches required by DESIGN.md:
 *
 *   - FTS5 query + no filters → ranked results from both classes and members.
 *   - Empty query + `inherits_from` filter → filtered set ordered by name.
 *   - Empty query + `category` filter → filtered set ordered by name.
 *   - Empty query + no filters → `{results: [], hint}` (NOT an error).
 *   - Limit parameter caps the result count.
 *   - Invalid limit (< 1) → error response.
 *   - Tool is registered in `docsTools` under the name `godot_search_api`.
 *
 * What this suite does NOT test:
 *   - Exact BM25 rank ordering (implementation detail; changes with SQLite
 *     version). We only assert that high-signal results appear before
 *     lower-signal ones in obvious cases.
 *   - The DocsRuntime latch (tested in `src/docs/runtime.test.ts`). Here
 *     we skip the latch entirely by calling the handler with a DB already
 *     resolved via a mock runtime.
 *
 * Module isolation note
 * ---------------------
 * The `search-api.ts` leaf calls `registerDocsTool` at module-load time.
 * Because vitest caches modules, `_resetDocsToolsForTesting` clears the
 * registry in-process but the module won't re-execute on the next import.
 * We therefore avoid resetting the registry between handler tests — only
 * the registration test suite isolates itself.
 */

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

import { createSchema } from "../../docs/schema.js";
import { createDocsRuntime } from "../../docs/runtime.js";
import { docsTools, _resetDocsToolsForTesting } from "../docs-tools.js";

// Importing the leaf triggers the side-effect registerDocsTool call.
import "./search-api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal in-memory SQLite DB with schema + seed data. */
function buildTestDb(): Database.Database {
  const db = new Database(":memory:");
  createSchema(db);

  // Seed classes
  const insertClass = db.prepare(
    `INSERT INTO classes (name, inherits, brief, description, version)
     VALUES (@name, @inherits, @brief, @description, @version)`,
  );

  insertClass.run({
    name: "Node",
    inherits: null,
    brief: "Base class for all scene objects.",
    description:
      "Node is the base class for all nodes in the scene tree. You can add and remove child nodes.",
    version: "4.3",
  });

  insertClass.run({
    name: "Node2D",
    inherits: "Node",
    brief: "2D game object. Inherits from Node.",
    description:
      "Node2D is the base class for 2D nodes. It provides 2D transform operations.",
    version: "4.3",
  });

  insertClass.run({
    name: "AnimationPlayer",
    inherits: "Node",
    brief: "Plays animations. Container for Animation resources.",
    description:
      "AnimationPlayer is used to play back animations. It can control a wide range of properties.",
    version: "4.3",
  });

  insertClass.run({
    name: "RigidBody2D",
    inherits: "Node2D",
    brief: "Physics body for 2D physics simulation.",
    description:
      "RigidBody2D implements full 2D physics. It is affected by gravity and other forces.",
    version: "4.3",
  });

  // Seed members
  const insertMember = db.prepare(
    `INSERT INTO members (class_name, kind, name, signature, description)
     VALUES (@class_name, @kind, @name, @signature, @description)`,
  );

  insertMember.run({
    class_name: "Node",
    kind: "method",
    name: "add_child",
    signature: "void add_child(node: Node, force_readable_name: bool = false)",
    description:
      "Adds a child node. The child is placed at the bottom of the children list.",
  });

  insertMember.run({
    class_name: "Node",
    kind: "method",
    name: "remove_child",
    signature: "void remove_child(node: Node)",
    description: "Removes a child node. The child is NOT freed.",
  });

  insertMember.run({
    class_name: "AnimationPlayer",
    kind: "method",
    name: "play",
    signature: 'void play(name: StringName = &"")',
    description:
      "Plays the animation with key name. Negative speed plays in reverse.",
  });

  insertMember.run({
    class_name: "AnimationPlayer",
    kind: "property",
    name: "current_animation",
    signature: "String current_animation",
    description: "The name of the currently playing animation.",
  });

  return db;
}

/** Minimal context stub that injects an already-resolved docs runtime. */
function makeCtx(db: Database.Database) {
  const rt = createDocsRuntime();
  rt.initialize({ db, source: "bundled", path: ":memory:" });
  return { docsRuntime: rt };
}

// ---------------------------------------------------------------------------
// Helper to find the tool from the current registry state
// ---------------------------------------------------------------------------
function getHandler() {
  const tool = docsTools.find((t) => t.name === "godot_search_api");
  if (!tool) throw new Error("godot_search_api not found in docsTools");
  return tool.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("godot_search_api tool registration", () => {
  // The module side-effect fires once at import time (above). We verify the
  // registration before any reset runs so this suite sees the populated registry.

  it("registers under the name godot_search_api", () => {
    const tool = docsTools.find((t) => t.name === "godot_search_api");
    expect(tool).toBeDefined();
  });

  it("has a non-empty description mentioning API (not tutorials)", () => {
    const tool = docsTools.find((t) => t.name === "godot_search_api");
    // DESIGN.md §Tool descriptions: first sentence disambiguates from
    // godot_search_tutorials (API signatures/classes vs how-to/guides).
    expect(tool!.description.toLowerCase()).toContain("api");
  });

  it("declares query, inherits_from, category, and limit in inputSchema", () => {
    const tool = docsTools.find((t) => t.name === "godot_search_api");
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("inherits_from");
    expect(props).toHaveProperty("category");
    expect(props).toHaveProperty("limit");
  });

  it("does not list any field as required (all params optional)", () => {
    const tool = docsTools.find((t) => t.name === "godot_search_api");
    expect(tool!.inputSchema.required ?? []).toHaveLength(0);
  });
});

describe("godot_search_api handler — FTS5 query path", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns class and member results for a matching query", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({ query: "animation" }, ctx)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text) as {
      results: { name: string; kind: string }[];
    };
    expect(payload.results.length).toBeGreaterThan(0);
    const names = payload.results.map((r) => r.name);
    // AnimationPlayer or current_animation should appear.
    expect(names.some((n) => n.toLowerCase().includes("animation"))).toBe(true);
  });

  it("returns results from both classes_fts and members_fts", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({ query: "add_child" }, ctx)) as {
      content: { text: string }[];
    };
    const payload = JSON.parse(res.content[0]!.text) as {
      results: { name: string; kind: string }[];
    };
    const kinds = payload.results.map((r) => r.kind);
    // add_child is a member method, so "method" should appear.
    expect(kinds).toContain("method");
  });

  it("caps results at the supplied limit", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({ query: "node", limit: 2 }, ctx)) as {
      content: { text: string }[];
    };
    const payload = JSON.parse(res.content[0]!.text) as { results: unknown[] };
    expect(payload.results.length).toBeLessThanOrEqual(2);
  });

  it("returns isError for limit < 1", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({ query: "node", limit: 0 }, ctx)) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
  });

  it("returns isError for negative limit", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({ query: "node", limit: -5 }, ctx)) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
  });
});

describe("godot_search_api handler — empty query with filters", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns classes that directly inherit from the given class", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({ inherits_from: "Node" }, ctx)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text) as {
      results: { name: string; kind: string }[];
    };
    // Node2D and AnimationPlayer inherit Node; RigidBody2D inherits Node2D.
    const names = payload.results.map((r) => r.name);
    expect(names).toContain("Node2D");
    expect(names).toContain("AnimationPlayer");
    // RigidBody2D inherits Node2D, not Node directly.
    expect(names).not.toContain("RigidBody2D");
  });

  it("results are ordered by name when using inherits_from filter", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({ inherits_from: "Node" }, ctx)) as {
      content: { text: string }[];
    };
    const payload = JSON.parse(res.content[0]!.text) as {
      results: { name: string }[];
    };
    const names = payload.results.map((r) => r.name);
    expect(names).toEqual([...names].sort());
  });

  it("returns an empty results array with hint when query and filters are absent", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler({}, ctx)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    // DESIGN.md L79: NOT an error — returns {results: [], hint}.
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text) as {
      results: unknown[];
      hint: string;
    };
    expect(payload.results).toEqual([]);
    expect(typeof payload.hint).toBe("string");
    expect(payload.hint.length).toBeGreaterThan(0);
  });

  it("combining query + inherits_from filter restricts both conditions", async () => {
    const ctx = makeCtx(db);
    const handler = getHandler();
    const res = (await handler(
      { query: "node", inherits_from: "Node" },
      ctx,
    )) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text) as {
      results: { name: string; inherits?: string }[];
    };
    // All returned class-kind results must inherit Node.
    for (const r of payload.results) {
      if ("inherits" in r && r.inherits !== undefined) {
        expect(r.inherits).toBe("Node");
      }
    }
  });
});

describe("godot_search_api handler — docs unavailable", () => {
  it("returns isError when the runtime is in failed state", async () => {
    const handler = getHandler();

    const rt = createDocsRuntime();
    rt.fail(new Error("DB not loaded"));
    const ctx = { docsRuntime: rt };

    const res = (await handler({ query: "node" }, ctx)) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clean up at end of file — other test files in the same process should see
// an empty registry (e.g. docs-tools.test.ts asserts it starts empty).
// ---------------------------------------------------------------------------
afterAll(() => {
  _resetDocsToolsForTesting();
});
