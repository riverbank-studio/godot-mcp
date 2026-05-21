/**
 * Unit tests for `godot_get_class` — the leaf docs tool that looks up a
 * single Godot class by name.
 *
 * Test strategy
 * -------------
 *
 * The tool uses `getDocsRuntime().withDb(...)` to get a SQLite handle.
 * Tests reset the process-wide singleton via `_resetDocsRuntimeForTesting`
 * before each test, then call `getDocsRuntime().initialize(...)` with an
 * in-memory DB so the queries exercise real SQLite behaviour without
 * touching the filesystem.
 *
 * Each `describe` block covers one behaviour branch from the issue spec
 * (#15) and DESIGN.md:
 *
 *   1. Registration: the leaf registers itself as "godot_get_class".
 *   2. Happy path — exact name match, all fields returned.
 *   3. `include` subset selection (methods, properties, signals, constants,
 *      description, inheritance).
 *   4. Case-insensitive lookup with "did you mean?" suggestion.
 *   5. Class not found with FTS5 suggestions array.
 *   6. Docs runtime unavailable (latch failed).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";

import {
  getDocsRuntime,
  _resetDocsRuntimeForTesting,
} from "../../docs/runtime.js";
import { createSchema } from "../../docs/schema.js";
import { docsTools } from "../docs-tools.js";

// Side-effect import to register the tool. Must come after docs-tools.ts
// so docsTools array is initialized before registerDocsTool runs.
import "./get-class.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a populated in-memory DB for tests. */
function buildTestDb(): Database.Database {
  const db = new DatabaseCtor(":memory:");
  createSchema(db);

  // Insert two classes.
  db.prepare(
    `INSERT INTO classes (name, inherits, brief, description, version)
     VALUES (@name, @inherits, @brief, @description, @version)`,
  ).run({
    name: "Node",
    inherits: "Object",
    brief: "Base class for all scene objects.",
    description:
      "Nodes are Godot's building blocks. They can be assigned as the child of another node, resulting in a tree arrangement.",
    version: "4.3",
  });

  db.prepare(
    `INSERT INTO classes (name, inherits, brief, description, version)
     VALUES (@name, @inherits, @brief, @description, @version)`,
  ).run({
    name: "Object",
    inherits: null,
    brief: "Base class for all other classes.",
    description:
      "Every class which is not a built-in type inherits from this class.",
    version: "4.3",
  });

  // Insert members for Node.
  const insertMember = db.prepare(
    `INSERT INTO members (class_name, kind, name, signature, description)
     VALUES (@class_name, @kind, @name, @signature, @description)`,
  );

  insertMember.run({
    class_name: "Node",
    kind: "method",
    name: "add_child",
    signature:
      "void add_child(node: Node, force_readable_name: bool = false, internal: InternalMode = 0)",
    description: "Adds a child node.",
  });

  insertMember.run({
    class_name: "Node",
    kind: "method",
    name: "get_child",
    signature: "Node get_child(idx: int, include_internal: bool = false)",
    description: "Returns a child node by its index.",
  });

  insertMember.run({
    class_name: "Node",
    kind: "property",
    name: "name",
    signature: "StringName name",
    description: "The name of this node.",
  });

  insertMember.run({
    class_name: "Node",
    kind: "signal",
    name: "child_entered_tree",
    signature: "child_entered_tree(node: Node)",
    description: "Emitted when a child node enters the scene tree.",
  });

  insertMember.run({
    class_name: "Node",
    kind: "constant",
    name: "NOTIFICATION_READY",
    signature: "const NOTIFICATION_READY = 13",
    description: "Notification received when the node is ready.",
  });

  return db;
}

/** Find the registered godot_get_class handler. */
function getHandler(): ToolDefinition["handler"] {
  const def = docsTools.find((t) => t.name === "godot_get_class");
  if (!def) throw new Error("godot_get_class not registered");
  return def.handler;
}

import type { ToolDefinition } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDb: Database.Database;

beforeEach(() => {
  // Drop and recreate the process-wide docs runtime singleton so each test
  // starts with a fresh pending runtime.
  _resetDocsRuntimeForTesting();
  testDb = buildTestDb();
  getDocsRuntime().initialize({
    db: testDb,
    source: "bundled",
    path: ":memory:",
  });
});

afterEach(() => {
  _resetDocsRuntimeForTesting();
  if (testDb.open) {
    testDb.close();
  }
});

// ---------------------------------------------------------------------------
// Thin context stub (the handler only uses docsRuntime, not ctx)
// ---------------------------------------------------------------------------
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const stubCtx = {} as any;

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers exactly one tool named godot_get_class", () => {
    const matches = docsTools.filter((t) => t.name === "godot_get_class");
    expect(matches).toHaveLength(1);
  });

  it("has an inputSchema with required class_name", () => {
    const def = docsTools.find((t) => t.name === "godot_get_class")!;
    expect(def.inputSchema.required).toContain("class_name");
  });

  it("description first sentence disambiguates: contains 'look up' and 'by name'", () => {
    const def = docsTools.find((t) => t.name === "godot_get_class")!;
    const first = def.description.split(".")[0].toLowerCase();
    // Must convey "look up by name" per DESIGN.md disambiguation matrix.
    expect(first).toMatch(/look up/);
    expect(first).toMatch(/by name/);
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path — exact match
// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("returns full class record for an exact match", async () => {
    const result = await getHandler()({ class_name: "Node" }, stubCtx);

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);

    expect(payload.name).toBe("Node");
    expect(payload.inherits).toBe("Object");
    expect(payload.brief).toContain("scene objects");
    expect(payload.description).toBeTruthy();
    expect(payload.version).toBe("4.3");
  });

  it("includes methods in the default full response", async () => {
    const result = await getHandler()({ class_name: "Node" }, stubCtx);
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.methods)).toBe(true);
    expect(payload.methods.length).toBeGreaterThanOrEqual(1);
    expect(payload.methods[0]).toHaveProperty("name");
    expect(payload.methods[0]).toHaveProperty("signature");
  });

  it("includes properties, signals, and constants", async () => {
    const result = await getHandler()({ class_name: "Node" }, stubCtx);
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.properties)).toBe(true);
    expect(Array.isArray(payload.signals)).toBe(true);
    expect(Array.isArray(payload.constants)).toBe(true);
  });

  it("returns isError for missing class_name argument", async () => {
    const result = await getHandler()({}, stubCtx);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. `include` subset selection
// ---------------------------------------------------------------------------

describe("include parameter", () => {
  it("returns only methods when include=['methods']", async () => {
    const result = await getHandler()(
      { class_name: "Node", include: ["methods"] },
      stubCtx,
    );
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.methods)).toBe(true);
    expect(payload.properties).toBeUndefined();
    expect(payload.signals).toBeUndefined();
    expect(payload.constants).toBeUndefined();
  });

  it("returns only properties when include=['properties']", async () => {
    const result = await getHandler()(
      { class_name: "Node", include: ["properties"] },
      stubCtx,
    );
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.properties)).toBe(true);
    expect(payload.methods).toBeUndefined();
  });

  it("returns only description when include=['description']", async () => {
    const result = await getHandler()(
      { class_name: "Node", include: ["description"] },
      stubCtx,
    );
    const payload = JSON.parse(result.content[0].text);

    expect(payload.description).toBeTruthy();
    expect(payload.methods).toBeUndefined();
    expect(payload.properties).toBeUndefined();
  });

  it("returns only inheritance when include=['inheritance']", async () => {
    const result = await getHandler()(
      { class_name: "Node", include: ["inheritance"] },
      stubCtx,
    );
    const payload = JSON.parse(result.content[0].text);

    expect(payload.inherits).toBeDefined();
    // inheritance_chain walks via recursive CTE — should include at least
    // the class itself and its parent.
    expect(Array.isArray(payload.inheritance_chain)).toBe(true);
    expect(payload.inheritance_chain).toContain("Node");
    expect(payload.methods).toBeUndefined();
  });

  it("combines multiple include values", async () => {
    const result = await getHandler()(
      { class_name: "Node", include: ["methods", "signals"] },
      stubCtx,
    );
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.methods)).toBe(true);
    expect(Array.isArray(payload.signals)).toBe(true);
    expect(payload.properties).toBeUndefined();
    expect(payload.constants).toBeUndefined();
  });

  it("returns all sections when include is empty array", async () => {
    const result = await getHandler()(
      { class_name: "Node", include: [] },
      stubCtx,
    );
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.methods)).toBe(true);
    expect(Array.isArray(payload.properties)).toBe(true);
    expect(Array.isArray(payload.signals)).toBe(true);
    expect(Array.isArray(payload.constants)).toBe(true);
    expect(payload.description).toBeTruthy();
    expect(Array.isArray(payload.inheritance_chain)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Case-insensitive lookup with "did you mean?" suggestion
// ---------------------------------------------------------------------------

describe("case mismatch", () => {
  it("returns isError with didYouMean hint for wrong-case input", async () => {
    const result = await getHandler()({ class_name: "node" }, stubCtx);

    expect(result.isError).toBe(true);
    const texts = result.content.map((c) => c.text);
    const combined = texts.join(" ");
    // Must include "did you mean `Node`?" hint
    expect(combined).toMatch(/did you mean `Node`/);
  });
});

// ---------------------------------------------------------------------------
// 5. Class not found — suggestions
// ---------------------------------------------------------------------------

describe("class not found", () => {
  it("returns isError when class does not exist", async () => {
    const result = await getHandler()(
      { class_name: "CompletelyMadeUpClass" },
      stubCtx,
    );

    expect(result.isError).toBe(true);
  });

  it("response contains suggestions array from FTS5 for partial matches", async () => {
    // "Nod" should FTS5-prefix-match "Node"
    const result = await getHandler()({ class_name: "Nod" }, stubCtx);

    expect(result.isError).toBe(true);
    // Find a JSON block with suggestions
    const jsonBlock = result.content.find(
      (c) => c.text.startsWith("{") && c.text.includes("suggestions"),
    );
    expect(jsonBlock).toBeDefined();
    const parsed = JSON.parse(jsonBlock!.text);
    expect(Array.isArray(parsed.suggestions)).toBe(true);
    expect(parsed.suggestions).toContain("Node");
  });
});

// ---------------------------------------------------------------------------
// 6. Docs runtime unavailable
// ---------------------------------------------------------------------------

describe("runtime unavailable", () => {
  it("returns isError when the docs runtime has failed", async () => {
    // Override: reset and fail the runtime.
    _resetDocsRuntimeForTesting();
    getDocsRuntime().fail(new Error("DB unavailable for test"));

    const result = await getHandler()({ class_name: "Node" }, stubCtx);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/unavailable/i);
  });
});
