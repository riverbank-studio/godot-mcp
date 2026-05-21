/**
 * Tests for `godot_get_tutorial` (#18).
 *
 * Strategy: create an in-memory SQLite DB seeded with tutorial rows, wire a
 * DocsRuntime against it, and call the handler exported directly from the
 * module (not discovered via the registry after a reset) — no MCP transport,
 * no network.
 *
 * Coverage:
 *   - Happy path: page_path present in DB → returns all chunks assembled in
 *     chunk_index order with heading_path and content.
 *   - Not found: path not in DB → `isError: true` with a human-readable
 *     message containing "not found".
 *   - Docs unavailable: runtime in failed state → `isError: true` with
 *     "unavailable" message.
 *   - Missing arg: no `path` argument → `isError: true` with "path" in msg.
 *   - Registration: `godot_get_tutorial` appears in `docsTools` at import time.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import {
  _resetDocsRuntimeForTesting,
  getDocsRuntime,
} from "../../docs/runtime.js";
import { docsTools } from "../docs-tools.js";
import type { ToolContext, ToolResponse } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Import the leaf so its registration side-effect fires.
// This also gives us the handler under test without going through the registry.
// ---------------------------------------------------------------------------
import { _handleGetTutorialForTesting } from "./get-tutorial.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal in-memory SQLite DB with the tutorials table + FTS5. */
function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE tutorials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading_path TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      embedding BLOB,
      UNIQUE (page_path, chunk_index)
    ) STRICT
  `);

  db.exec(`
    CREATE VIRTUAL TABLE tutorials_fts USING fts5 (
      heading_path, content, content='tutorials', content_rowid='id'
    )
  `);

  db.exec(`
    CREATE TRIGGER tutorials_ai AFTER INSERT ON tutorials BEGIN
      INSERT INTO tutorials_fts (rowid, heading_path, content)
        VALUES (new.id, new.heading_path, new.content);
    END
  `);

  return db;
}

/** Insert one tutorial chunk. */
function insertChunk(
  db: Database.Database,
  pagePath: string,
  chunkIndex: number,
  headingPath: string,
  content: string,
): void {
  db.prepare(
    `INSERT INTO tutorials (page_path, chunk_index, heading_path, content)
     VALUES (?, ?, ?, ?)`,
  ).run(pagePath, chunkIndex, headingPath, content);
}

/** Minimal ToolContext stub — docs tools do not use ctx fields. */
const stubCtx = {} as ToolContext;

// ---------------------------------------------------------------------------
// Registration test
// ---------------------------------------------------------------------------

describe("godot_get_tutorial registration", () => {
  it("registers godot_get_tutorial in docsTools on import", () => {
    const names = docsTools.map((t) => t.name);
    expect(names).toContain("godot_get_tutorial");
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour
// ---------------------------------------------------------------------------

describe("godot_get_tutorial handler", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
  });

  afterEach(() => {
    _resetDocsRuntimeForTesting();
    db.close();
  });

  it("returns assembled tutorial content in chunk_index order for a known path", async () => {
    const PATH = "tutorials/3d/using_gridmaps.rst";
    // Insert out-of-order to verify sorting.
    insertChunk(db, PATH, 1, "Using GridMaps / Step 2", "Step 2 content here.");
    insertChunk(db, PATH, 0, "Using GridMaps", "Introduction content here.");

    _resetDocsRuntimeForTesting();
    getDocsRuntime().initialize({ db, source: "bundled", path: ":memory:" });

    const response = await _handleGetTutorialForTesting(PATH);

    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0].text) as {
      path: string;
      chunks: Array<{
        chunk_index: number;
        heading_path: string;
        content: string;
      }>;
    };
    expect(payload.path).toBe(PATH);
    expect(payload.chunks).toHaveLength(2);
    expect(payload.chunks[0].chunk_index).toBe(0);
    expect(payload.chunks[0].content).toBe("Introduction content here.");
    expect(payload.chunks[1].chunk_index).toBe(1);
    expect(payload.chunks[1].content).toBe("Step 2 content here.");
  });

  it("returns isError when path is not found", async () => {
    insertChunk(
      db,
      "tutorials/3d/using_gridmaps.rst",
      0,
      "GridMaps",
      "content",
    );

    _resetDocsRuntimeForTesting();
    getDocsRuntime().initialize({ db, source: "bundled", path: ":memory:" });

    const response = await _handleGetTutorialForTesting(
      "tutorials/3d/not_exist.rst",
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/not found/i);
  });

  it("returns isError when the docs runtime has failed", async () => {
    _resetDocsRuntimeForTesting();
    getDocsRuntime().fail(new Error("db file missing"));

    const response = await _handleGetTutorialForTesting("tutorials/foo.rst");

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/unavailable/i);
  });

  it("returns isError when path argument is missing", async () => {
    _resetDocsRuntimeForTesting();
    getDocsRuntime().initialize({ db, source: "bundled", path: ":memory:" });

    // Call the registered tool handler with no path to test validation.
    const def = docsTools.find((t) => t.name === "godot_get_tutorial");
    expect(def).toBeDefined();
    const response = (await def!.handler({}, stubCtx)) as ToolResponse;

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/path/i);
  });

  it("returns isError when path argument is an empty string", async () => {
    _resetDocsRuntimeForTesting();
    getDocsRuntime().initialize({ db, source: "bundled", path: ":memory:" });

    const def = docsTools.find((t) => t.name === "godot_get_tutorial");
    expect(def).toBeDefined();
    const response = (await def!.handler(
      { path: "  " },
      stubCtx,
    )) as ToolResponse;

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/path/i);
  });
});
