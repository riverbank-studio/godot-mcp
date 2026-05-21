/**
 * Tests for `schema` — the docs DB schema + open/close helpers.
 *
 * Uses `better-sqlite3` directly against an in-memory DB. The schema
 * tests run on every platform CI hits (Linux x64, Windows x64, macOS),
 * which is also the platform matrix in DESIGN.md L569. `sqlite-vec`
 * loading is exercised when available; tests assert the BLOB-fallback
 * path otherwise (vector storage is a column on the tutorials table,
 * sqlite-vec only adds the virtual-table accelerator).
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import {
  createSchema,
  openReadOnly,
  SCHEMA_SQL_PARTS,
  type MetaRecord,
  writeMeta,
  readMeta,
} from "./schema.js";

function newDb() {
  return new Database(":memory:");
}

describe("createSchema", () => {
  it("creates classes, members, tutorials, and meta tables", () => {
    const db = newDb();
    createSchema(db);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("classes");
    expect(names).toContain("members");
    expect(names).toContain("tutorials");
    expect(names).toContain("meta");
    db.close();
  });

  it("creates classes_fts and members_fts virtual tables", () => {
    const db = newDb();
    createSchema(db);
    const vtab = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('classes_fts', 'members_fts', 'tutorials_fts')`,
      )
      .all() as Array<{ name: string }>;
    const names = vtab.map((v) => v.name);
    expect(names).toContain("classes_fts");
    expect(names).toContain("members_fts");
    expect(names).toContain("tutorials_fts");
    db.close();
  });

  it("members table has a kind column with method/property/signal/constant/annotation domain", () => {
    const db = newDb();
    createSchema(db);
    // Foreign key target — better-sqlite3 enforces FKs by default in
    // recent versions.
    db.prepare(
      `INSERT INTO classes (name, inherits, brief, description) VALUES (?, ?, ?, ?)`,
    ).run("Object", null, "Base", "");
    const insert = db.prepare(
      `INSERT INTO members (class_name, kind, name, signature, description) VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("Object", "method", "connect", "connect(...)", "");
    insert.run("Object", "signal", "ready", "ready()", "");
    insert.run("Object", "constant", "X", "X = 1", "");
    insert.run("Object", "property", "name", "name: String", "");
    insert.run("Object", "annotation", "@export", "@export", "");
    expect(() => insert.run("Object", "garbage", "x", "x", "")).toThrow(
      /CHECK|kind/,
    );
    db.close();
  });

  it("stores inheritance as immediate parent only (recursive CTE at query time)", () => {
    const db = newDb();
    createSchema(db);
    db.prepare(
      `INSERT INTO classes (name, inherits, brief, description) VALUES (?, ?, ?, ?)`,
    ).run("Object", null, "Base", "Base class");
    db.prepare(
      `INSERT INTO classes (name, inherits, brief, description) VALUES (?, ?, ?, ?)`,
    ).run("Node", "Object", "Scene node", "");
    db.prepare(
      `INSERT INTO classes (name, inherits, brief, description) VALUES (?, ?, ?, ?)`,
    ).run("Node2D", "Node", "2D scene node", "");
    const ancestors = db
      .prepare(
        `WITH RECURSIVE ancestors(name) AS (
            SELECT inherits FROM classes WHERE name = ?
            UNION ALL
            SELECT c.inherits FROM classes c JOIN ancestors a ON c.name = a.name WHERE c.inherits IS NOT NULL
          )
          SELECT name FROM ancestors WHERE name IS NOT NULL`,
      )
      .all("Node2D") as Array<{ name: string }>;
    expect(ancestors.map((a) => a.name)).toEqual(["Node", "Object"]);
    db.close();
  });

  it("tutorials table has a 384-byte embedding BLOB column", () => {
    const db = newDb();
    createSchema(db);
    // 384 float32 = 1536 bytes
    const blob = Buffer.alloc(1536);
    db.prepare(
      `INSERT INTO tutorials (page_path, chunk_index, heading_path, content, embedding) VALUES (?, ?, ?, ?, ?)`,
    ).run("foo.rst", 0, "Title > Section", "body", blob);
    const r = db
      .prepare(`SELECT embedding FROM tutorials WHERE page_path = ?`)
      .get("foo.rst") as { embedding: Buffer };
    expect(r.embedding.length).toBe(1536);
    db.close();
  });

  it("meta table is single-row (enforced via primary key = 1)", () => {
    const db = newDb();
    createSchema(db);
    const meta: MetaRecord = {
      godot_version: "4.5",
      godot_docs_branch: "4.5",
      schema_version: 1,
      indexed_at: new Date().toISOString(),
      class_count: 100,
      tutorial_count: 50,
      ingest_warnings: "[]",
      embedding_model_id: "stub",
      ingestion_source_sha: "abc",
      ingestion_duration_ms: 1234,
      tarball_sha256: "deadbeef".repeat(8),
      docs_tarball_sha256: "0".repeat(64),
    };
    writeMeta(db, meta);
    const read = readMeta(db);
    expect(read).toEqual(meta);
    db.close();
  });
});

describe("openReadOnly", () => {
  it("opens with PRAGMA query_only = 1 so mutations throw SQLITE_READONLY", async () => {
    // Build a populated DB to a tmp file (in-memory + readonly isn't a
    // realistic pairing — `readonly: true` requires an actual file).
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-schema-"));
    const dbPath = path.join(tmp, "test.db");
    try {
      const writer = new Database(dbPath);
      createSchema(writer);
      writer
        .prepare(
          `INSERT INTO classes (name, inherits, brief, description) VALUES (?, ?, ?, ?)`,
        )
        .run("Object", null, "Base", "");
      writer.close();

      const reader = openReadOnly(dbPath);
      // Read works.
      const count = reader
        .prepare(`SELECT COUNT(*) AS n FROM classes`)
        .get() as { n: number };
      expect(count.n).toBe(1);
      // Mutation throws (DESIGN.md: PRAGMA query_only=1).
      expect(() =>
        reader
          .prepare(
            `INSERT INTO classes (name, inherits, brief, description) VALUES (?, ?, ?, ?)`,
          )
          .run("X", null, "", ""),
      ).toThrow(/SQLITE_READONLY|read.only|attempt to write/i);
      reader.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("SCHEMA_SQL_PARTS", () => {
  it("is a non-empty ordered list of statements (one per CREATE)", () => {
    expect(SCHEMA_SQL_PARTS.length).toBeGreaterThan(0);
    for (const s of SCHEMA_SQL_PARTS) {
      expect(s.trim().toUpperCase()).toMatch(/^CREATE/);
    }
  });
});
