/**
 * Tests for the `godot_find_member` docs-tool leaf.
 *
 * Strategy: exercise the exported `handleFindMember` function directly,
 * wiring a fresh in-memory SQLite DB each time via `createDocsRuntime()`.
 * The module-level `registerDocsTool` side effect runs once at import time;
 * we also confirm the tool appears in `docsTools` before any reset.
 *
 * Covers:
 *   - Tool registration (name, required input-schema fields, godot_ prefix)
 *   - Exact member lookup (class + name + kind)
 *   - kind omitted → array return (all matching kinds)
 *   - Cross-kind collision → multiple results
 *   - Member not found → MCP error, optional suggestions JSON block
 *   - Class not found → MCP error
 *   - Class case-mismatch → "did you mean" hint in error
 *   - Invalid `kind` value → MCP error
 *   - Missing required args (class, name) → MCP error
 *   - Docs runtime in failed state → MCP error
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";

import { createSchema } from "../../docs/schema.js";
import {
  _resetDocsRuntimeForTesting,
  getDocsRuntime,
} from "../../docs/runtime.js";
import { docsTools } from "../docs-tools.js";

// Side-effect import: registers `godot_find_member` into docsTools[].
// Runs exactly once per test process; subsequent imports hit the module cache.
import { handleFindMember } from "./find-member.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minimal stub ToolContext — docs tools don't touch Godot-path / process APIs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubCtx = {} as any;

/**
 * Open an in-memory SQLite DB, apply the docs schema, and insert a minimal
 * set of rows for testing.
 */
function openSeededDb(): Database.Database {
  const db = new DatabaseCtor(":memory:");
  createSchema(db);

  db.prepare(
    `INSERT INTO classes (name, inherits, brief, description, version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("Node", null, "Base class for all scene objects.", "", "4.5");

  db.prepare(
    `INSERT INTO classes (name, inherits, brief, description, version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("Node2D", "Node", "A 2D game object.", "", "4.5");

  const ins = db.prepare(
    `INSERT INTO members (class_name, kind, name, signature, description)
     VALUES (@class_name, @kind, @name, @signature, @description)`,
  );

  ins.run({
    class_name: "Node",
    kind: "method",
    name: "add_child",
    signature: "void add_child(node: Node, force_readable_name: bool = false)",
    description: "Adds a child node.",
  });

  ins.run({
    class_name: "Node",
    kind: "method",
    name: "get_name",
    signature: "StringName get_name()",
    description: "Returns the node name.",
  });

  ins.run({
    class_name: "Node",
    kind: "signal",
    name: "ready",
    signature: "ready()",
    description: "Emitted when the node is ready.",
  });

  // property that shares a name with the method in the cross-kind collision test
  ins.run({
    class_name: "Node",
    kind: "property",
    name: "name",
    signature: "StringName name",
    description: "The name of the node.",
  });

  ins.run({
    class_name: "Node2D",
    kind: "property",
    name: "position",
    signature: "Vector2 position",
    description: "The position of the node.",
  });

  return db;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  // Each test gets a fresh in-memory DB and a fresh runtime singleton.
  _resetDocsRuntimeForTesting();
  db = openSeededDb();
  getDocsRuntime().initialize({ db, source: "bundled", path: ":memory:" });
});

afterEach(() => {
  _resetDocsRuntimeForTesting();
  if (db.open) db.close();
});

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("godot_find_member registration", () => {
  it("registers a tool named 'godot_find_member' with the godot_ prefix", () => {
    // docsTools[] was populated by the module-level import above. After
    // _resetDocsToolsForTesting it would be empty, but we deliberately do
    // NOT reset it here so the registration snapshot remains intact.
    const tool = docsTools.find((t) => t.name === "godot_find_member");
    expect(tool).toBeDefined();
    expect(tool!.name).toMatch(/^godot_/);
  });

  it("requires 'class' and 'name' in inputSchema", () => {
    const tool = docsTools.find((t) => t.name === "godot_find_member");
    expect(tool!.inputSchema.required).toContain("class");
    expect(tool!.inputSchema.required).toContain("name");
  });

  it("does not require 'kind' in inputSchema", () => {
    const tool = docsTools.find((t) => t.name === "godot_find_member");
    expect(tool!.inputSchema.required ?? []).not.toContain("kind");
  });
});

// ---------------------------------------------------------------------------
// happy-path: single result
// ---------------------------------------------------------------------------

describe("godot_find_member happy path", () => {
  it("returns an array with one match when class + name + kind resolve exactly", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "add_child", kind: "method" },
      stubCtx,
    );

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      class_name: "Node",
      kind: "method",
      name: "add_child",
    });
  });

  it("includes description and signature in the returned member", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "add_child", kind: "method" },
      stubCtx,
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload[0].description).toBe("Adds a child node.");
    expect(payload[0].signature).toContain("add_child");
  });

  it("returns a single match without kind filter when the name is unambiguous", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "get_name" },
      stubCtx,
    );

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0].kind).toBe("method");
  });
});

// ---------------------------------------------------------------------------
// cross-kind collision
// ---------------------------------------------------------------------------

describe("godot_find_member cross-kind collision", () => {
  it("returns all matching members when name exists in multiple kinds", async () => {
    // Seed a method 'ready' alongside the already-seeded signal 'ready'.
    db.prepare(
      `INSERT INTO members (class_name, kind, name, signature, description)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("Node", "method", "ready", "void ready()", "Called when ready.");

    const result = await handleFindMember(
      { class: "Node", name: "ready" },
      stubCtx,
    );

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.length).toBeGreaterThanOrEqual(2);
    const kinds = (payload as Array<{ kind: string }>).map((m) => m.kind);
    expect(kinds).toContain("signal");
    expect(kinds).toContain("method");
  });
});

// ---------------------------------------------------------------------------
// not found
// ---------------------------------------------------------------------------

describe("godot_find_member not found", () => {
  it("returns isError: true when the member does not exist on the class", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "nonexistent_xyz" },
      stubCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it("includes an optional suggestions JSON block on miss", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "nonexistent_xyz" },
      stubCtx,
    );

    // If suggestions are present they must parse as { suggestions: [] }.
    const jsonBlock = result.content.find((c) => c.text.startsWith("{"));
    if (jsonBlock) {
      const parsed = JSON.parse(jsonBlock.text);
      expect(Array.isArray(parsed.suggestions)).toBe(true);
    }
    // No JSON block is also valid (empty suggestion list → block omitted).
  });

  it("mentions the class name in the not-found message", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "nonexistent_xyz" },
      stubCtx,
    );
    expect(result.content[0].text).toContain("Node");
  });

  it("mentions the kind when kind was specified", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "nonexistent_xyz", kind: "method" },
      stubCtx,
    );
    expect(result.content[0].text).toContain("method");
  });
});

// ---------------------------------------------------------------------------
// class not found
// ---------------------------------------------------------------------------

describe("godot_find_member class not found", () => {
  it("returns MCP error when class does not exist in the DB", async () => {
    const result = await handleFindMember(
      { class: "CompletelyMadeUpClass", name: "something" },
      stubCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it("returns a did-you-mean hint when only the case is wrong", async () => {
    const result = await handleFindMember(
      { class: "node", name: "add_child" }, // lowercase 'n'
      stubCtx,
    );

    expect(result.isError).toBe(true);
    const allText = result.content.map((c) => c.text).join("\n");
    expect(allText).toMatch(/did you mean/i);
    expect(allText).toContain("Node");
  });
});

// ---------------------------------------------------------------------------
// kind validation
// ---------------------------------------------------------------------------

describe("godot_find_member kind validation", () => {
  it("returns MCP error for an unrecognized kind value", async () => {
    const result = await handleFindMember(
      { class: "Node", name: "add_child", kind: "banana" },
      stubCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid/i);
  });

  it("accepts all five valid kind values without error", async () => {
    const validKinds = [
      "method",
      "property",
      "signal",
      "constant",
      "annotation",
    ] as const;

    for (const k of validKinds) {
      const result = await handleFindMember(
        { class: "Node", name: "whatever_kind_test", kind: k },
        stubCtx,
      );
      // Not found is acceptable; what matters is it's not an "invalid kind" error.
      if (result.isError) {
        expect(result.content[0].text).not.toMatch(/invalid.*kind/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// missing required args
// ---------------------------------------------------------------------------

describe("godot_find_member missing args", () => {
  it("returns MCP error when `class` is missing", async () => {
    const result = await handleFindMember({ name: "add_child" }, stubCtx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/class/i);
  });

  it("returns MCP error when `name` is missing", async () => {
    const result = await handleFindMember({ class: "Node" }, stubCtx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/name/i);
  });

  it("returns MCP error when both are missing", async () => {
    const result = await handleFindMember({}, stubCtx);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// docs runtime unavailable
// ---------------------------------------------------------------------------

describe("godot_find_member docs unavailable", () => {
  it("returns MCP error when the runtime is in failed state", async () => {
    _resetDocsRuntimeForTesting();
    getDocsRuntime().fail(new Error("test-induced failure"));

    const result = await handleFindMember(
      { class: "Node", name: "add_child" },
      stubCtx,
    );

    expect(result.isError).toBe(true);
  });
});
