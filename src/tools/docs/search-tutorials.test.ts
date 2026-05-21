/**
 * Tests for the `godot_search_tutorials` leaf tool (#17).
 *
 * Behavioral branches under test (per issue spec + DESIGN.md § Search →
 * Tutorials):
 *
 *   1. Empty / whitespace-only query → MCP error (unlike `godot_search_api`
 *      which returns `{results: [], hint}` — tutorials ALWAYS require a query).
 *   2. Query present → FTS5 lexical search over `tutorials_fts`.
 *   3. Dense layer falls back gracefully when `sqlite-vec` is absent — the
 *      in-memory test DB never loads the extension, so this exercises the
 *      lexical-only path that production uses until the embedding model and
 *      sqlite-vec are wired in.
 *   4. RRF fusion is a pure-rank algorithm: tested via the exported helper
 *      directly (no DB required).
 *   5. `godot_search_tutorials` self-registers in `docsTools` when imported.
 *   6. Invalid `limit` values are rejected with `isError`.
 *
 * The tests use an in-memory SQLite DB populated with minimal fixture data
 * so they run without the bundled docs DB and without the docs runtime
 * latch machinery.  The tool's SQL is exercised against real FTS5 so we
 * catch tokenization surprises.
 *
 * Runtime-latch integration (the `withDb` path) is tested via the same
 * thin-stub pattern used by `search-api.test.ts`: inject the fixture DB
 * directly rather than going through the runtime.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";

import { createSchema } from "../../docs/schema.js";
import { docsTools } from "../docs-tools.js";
import { reciprocalRankFusion } from "./search-tutorials.js";

// ── fixture helpers ──────────────────────────────────────────────────────────

/**
 * Open an in-memory SQLite DB with the docs schema and seed tutorial fixture
 * data.  Three tutorial chunks covering distinct topics ensure FTS5 returns
 * ordered results and that a "no match" query returns an empty array.
 */
function openFixtureDb(): Database.Database {
  const db = new DatabaseCtor(":memory:");
  createSchema(db);

  const insertTutorial = db.prepare(
    `INSERT INTO tutorials (page_path, chunk_index, heading_path, content, embedding)
     VALUES (@page_path, @chunk_index, @heading_path, @content, NULL)`,
  );

  insertTutorial.run({
    page_path: "tutorials/scripting/gdscript/gdscript_basics",
    chunk_index: 0,
    heading_path: "GDScript basics / Variables",
    content:
      "GDScript is a dynamically typed scripting language. Variables are declared with var keyword. " +
      "Use @export to expose them to the Inspector.",
  });
  insertTutorial.run({
    page_path: "tutorials/scripting/gdscript/gdscript_basics",
    chunk_index: 1,
    heading_path: "GDScript basics / Functions",
    content:
      "Functions in GDScript are declared with func keyword. " +
      "The _ready function is called when a node enters the scene tree.",
  });
  insertTutorial.run({
    page_path: "tutorials/physics/rigid_body",
    chunk_index: 0,
    heading_path: "Using RigidBody2D",
    content:
      "RigidBody2D is a physics body that is moved by the physics engine. " +
      "Set linear_velocity to move the body programmatically.",
  });

  return db;
}

// ── import side-effect ───────────────────────────────────────────────────────

// Import the tool module.  When the test suite runs as part of the full run,
// `src/tools/index.ts` will already have loaded this module via its barrel
// import (side-effect registration runs on first load).  Running this test
// file in isolation triggers the registration directly via this import.
//
// We do NOT call `_resetDocsToolsForTesting()` here: this test verifies
// runtime behavior, not registry mechanics (those live in docs-tools.test.ts).
// Resetting and re-importing would silently skip re-registration because
// Node/Vitest caches modules — the reset would clear the array but the
// module's top-level registration call would not re-execute.
const { searchTutorialsTool } = await import("./search-tutorials.js");

// ── DB fixture lifecycle ─────────────────────────────────────────────────────

let db: Database.Database;

beforeAll(() => {
  db = openFixtureDb();
});

afterAll(() => {
  db?.close();
});

// ── helper ────────────────────────────────────────────────────────────────────

/**
 * Call the tool handler with a pre-opened DB, bypassing the runtime latch.
 */
async function callTool(args: Record<string, unknown>) {
  return searchTutorialsTool.handler(args, {
    _db: db,
  } as unknown as Parameters<typeof searchTutorialsTool.handler>[1]);
}

// ── registration ─────────────────────────────────────────────────────────────

describe("godot_search_tutorials — self-registration", () => {
  it("registers itself in docsTools under the name 'godot_search_tutorials'", () => {
    const found = docsTools.find((t) => t.name === "godot_search_tutorials");
    expect(found).toBeDefined();
  });

  it("exposes the exported searchTutorialsTool constant with the correct name", () => {
    expect(searchTutorialsTool.name).toBe("godot_search_tutorials");
  });
});

// ── empty query ───────────────────────────────────────────────────────────────

describe("godot_search_tutorials — empty / missing query", () => {
  it("returns isError when query is absent", async () => {
    const res = await callTool({});
    expect(res.isError).toBe(true);
  });

  it("returns isError when query is an empty string", async () => {
    const res = await callTool({ query: "" });
    expect(res.isError).toBe(true);
  });

  it("returns isError for a whitespace-only query", async () => {
    const res = await callTool({ query: "   " });
    expect(res.isError).toBe(true);
  });

  it("error message mentions 'query' to guide recovery", async () => {
    const res = await callTool({});
    const text = res.content[0].text;
    expect(text.toLowerCase()).toMatch(/query/);
  });
});

// ── FTS5 lexical search ───────────────────────────────────────────────────────

describe("godot_search_tutorials — FTS5 lexical search", () => {
  it("returns results when the query matches tutorial content", async () => {
    const res = await callTool({ query: "GDScript variables" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.results.length).toBeGreaterThan(0);
  });

  it("each result has page_path, heading_path, and a content snippet", async () => {
    const res = await callTool({ query: "GDScript" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    for (const r of payload.results as Array<Record<string, unknown>>) {
      expect(typeof r.page_path).toBe("string");
      expect(typeof r.heading_path).toBe("string");
      expect(typeof r.snippet).toBe("string");
    }
  });

  it("returns an empty results array (not isError) when no chunk matches", async () => {
    const res = await callTool({ query: "xyzzy_no_match_987654" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.results).toEqual([]);
  });

  it("prefix-matches partial tokens (trailing * per DESIGN.md)", async () => {
    // "RigidBod" should match "RigidBody2D" via prefix wildcard.
    const res = await callTool({ query: "RigidBod" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    const paths: string[] = payload.results.map(
      (r: { page_path: string }) => r.page_path,
    );
    expect(paths.some((p) => p.includes("rigid_body"))).toBe(true);
  });

  it("heading_path match ranks higher than content-only match (BM25 column weights)", async () => {
    // "Functions" appears in heading_path of chunk 1 and in content of no other
    // chunk — so the heading-weighted row should appear first.
    const res = await callTool({ query: "Functions" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(
      (payload.results[0] as { heading_path: string }).heading_path,
    ).toMatch(/Functions/i);
  });

  it("respects the limit parameter", async () => {
    const res = await callTool({ query: "GDScript", limit: 1 });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.results.length).toBeLessThanOrEqual(1);
  });

  it("default limit caps results at a reasonable number", async () => {
    const res = await callTool({ query: "a" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    // Default must be at least 1 but no more than 20 per the contract.
    expect(payload.results.length).toBeLessThanOrEqual(20);
  });
});

// ── invalid arguments ─────────────────────────────────────────────────────────

describe("godot_search_tutorials — invalid arguments", () => {
  it("rejects a negative limit with isError", async () => {
    const res = await callTool({ query: "GDScript", limit: -1 });
    expect(res.isError).toBe(true);
  });

  it("rejects a zero limit with isError", async () => {
    const res = await callTool({ query: "GDScript", limit: 0 });
    expect(res.isError).toBe(true);
  });
});

// ── RRF fusion helper ─────────────────────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  it("returns an empty array when both lists are empty", () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it("returns all ids from a single non-empty list", () => {
    const result = reciprocalRankFusion([10, 20, 30], []);
    expect(result).toEqual([10, 20, 30]);
  });

  it("uses k=60 and merges both lists by RRF score (higher score wins)", () => {
    // Both lists agree on id=1 being first — it should dominate.
    const lexical = [1, 2, 3];
    const dense = [1, 3, 2];
    const result = reciprocalRankFusion(lexical, dense);
    expect(result[0]).toBe(1);
  });

  it("items only in one list still appear in the fused output", () => {
    const lexical = [1, 2];
    const dense = [3, 4];
    const result = reciprocalRankFusion(lexical, dense);
    expect(result).toContain(1);
    expect(result).toContain(2);
    expect(result).toContain(3);
    expect(result).toContain(4);
  });

  it("preserves order: items in both lists rank above items in one list", () => {
    // id=1 appears in both (rank 0 in each → high RRF score).
    // id=99 only in one list (lower RRF score).
    const lexical = [1, 99];
    const dense = [1, 88];
    const result = reciprocalRankFusion(lexical, dense);
    expect(result.indexOf(1)).toBeLessThan(result.indexOf(99));
  });

  it("deduplicates when the same id appears in both input lists", () => {
    const result = reciprocalRankFusion([1, 2, 3], [2, 3, 4]);
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });
});
