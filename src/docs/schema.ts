/**
 * Docs DB schema + open/close helpers.
 *
 * Backed by `better-sqlite3` directly (no Drizzle per Wave 2 D7). The
 * schema covers:
 *
 *   - `classes` — one row per Godot class (FK target for `members`).
 *   - `members` — unified table for methods / properties / signals /
 *     constants / annotations (single `kind` column, DESIGN.md L290).
 *   - `tutorials` — one row per RST chunk, with the embedding BLOB.
 *   - `classes_fts`, `members_fts`, `tutorials_fts` — FTS5 virtual
 *     tables; the docs-tools subsystem (#14-19) queries these.
 *   - `meta` — single-row table for the manifest fields documented in
 *     DESIGN.md L293.
 *
 * No WAL mode (DESIGN.md Wave 2 D6: bundled DB is read-only
 * post-ingestion). Read connections open with `PRAGMA query_only = 1`
 * as defense-in-depth.
 *
 * The `sqlite-vec` virtual table is **not** created here — the column
 * is a plain BLOB so the schema works without the extension loaded.
 * #14-19's search layer materializes the `vec0(embedding float[384])`
 * virtual table on first connect (after `sqlite_vec.load(db)`); the
 * accelerator is read-only and rebuildable from the BLOB column.
 */

import type Database from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";

/**
 * The bumpable schema version stamped into `meta.schema_version`. Must
 * stay in sync with `version-manager.ts` `DOCS_SCHEMA_VERSION` so a
 * cache invalidation triggered by a schema change is visible from both
 * sides.
 */
export const SCHEMA_VERSION = 1;

/**
 * The schema as ordered DDL parts. Exported so callers can introspect
 * (the build script logs which statement was running on failure) and
 * so tests can assert non-emptiness without coupling to specific SQL.
 */
export const SCHEMA_SQL_PARTS: readonly string[] = [
  // classes — base table for class metadata.
  `CREATE TABLE classes (
     name TEXT PRIMARY KEY,
     inherits TEXT,  -- immediate parent only; walk via recursive CTE.
     brief TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     version TEXT
   ) STRICT`,

  // members — unified table with a kind discriminator.
  `CREATE TABLE members (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     class_name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('method','property','signal','constant','annotation')),
     name TEXT NOT NULL,
     signature TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     FOREIGN KEY (class_name) REFERENCES classes(name) ON DELETE CASCADE
   ) STRICT`,

  // Index for the common "list members of class X" query path.
  `CREATE INDEX idx_members_class_kind ON members (class_name, kind)`,

  // tutorials — one row per RST chunk. Embedding is a raw BLOB of
  // 384 float32 = 1536 bytes; #14-19 attaches a sqlite-vec virtual
  // table over this column.
  `CREATE TABLE tutorials (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     page_path TEXT NOT NULL,
     chunk_index INTEGER NOT NULL,
     heading_path TEXT NOT NULL DEFAULT '',
     content TEXT NOT NULL,
     embedding BLOB,
     UNIQUE (page_path, chunk_index)
   ) STRICT`,

  `CREATE INDEX idx_tutorials_page ON tutorials (page_path)`,

  // meta — single-row table (CHECK constraint binds the PK to 1).
  `CREATE TABLE meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     godot_version TEXT NOT NULL,
     godot_docs_branch TEXT NOT NULL,
     schema_version INTEGER NOT NULL,
     indexed_at TEXT NOT NULL,
     class_count INTEGER NOT NULL,
     tutorial_count INTEGER NOT NULL,
     ingest_warnings TEXT NOT NULL DEFAULT '[]',
     embedding_model_id TEXT NOT NULL,
     ingestion_source_sha TEXT NOT NULL DEFAULT '',
     ingestion_duration_ms INTEGER NOT NULL,
     tarball_sha256 TEXT NOT NULL DEFAULT '',
     docs_tarball_sha256 TEXT NOT NULL DEFAULT ''
   ) STRICT`,

  // FTS5 virtual tables. Tokenizer choice per DESIGN.md L311: unicode61
  // with tokenchars=_ so `add_child` stays one token in class/member
  // queries. Tutorials use the default tokenizer.
  `CREATE VIRTUAL TABLE classes_fts USING fts5 (
     name, brief, content='classes', content_rowid='rowid',
     tokenize="unicode61 tokenchars '_'"
   )`,
  `CREATE VIRTUAL TABLE members_fts USING fts5 (
     name, signature, description, content='members', content_rowid='id',
     tokenize="unicode61 tokenchars '_'"
   )`,
  `CREATE VIRTUAL TABLE tutorials_fts USING fts5 (
     heading_path, content, content='tutorials', content_rowid='id'
   )`,

  // Triggers to keep FTS5 in sync with the content tables. (Not all
  // FTS5 setups need triggers — but external-content tables do.)
  `CREATE TRIGGER classes_ai AFTER INSERT ON classes BEGIN
     INSERT INTO classes_fts (rowid, name, brief) VALUES (new.rowid, new.name, new.brief);
   END`,
  `CREATE TRIGGER members_ai AFTER INSERT ON members BEGIN
     INSERT INTO members_fts (rowid, name, signature, description) VALUES (new.id, new.name, new.signature, new.description);
   END`,
  `CREATE TRIGGER tutorials_ai AFTER INSERT ON tutorials BEGIN
     INSERT INTO tutorials_fts (rowid, heading_path, content) VALUES (new.id, new.heading_path, new.content);
   END`,
];

/**
 * Create the schema in `db`. Wraps the DDL in a transaction so partial
 * failures don't leave the DB half-initialized.
 */
export function createSchema(db: Database.Database): void {
  const txn = db.transaction(() => {
    for (const stmt of SCHEMA_SQL_PARTS) {
      db.exec(stmt);
    }
  });
  txn();
}

/**
 * `meta` table row shape. Field names map verbatim to columns so the
 * caller's record literal doubles as the INSERT/SELECT row.
 */
export interface MetaRecord {
  godot_version: string;
  godot_docs_branch: string;
  schema_version: number;
  indexed_at: string;
  class_count: number;
  tutorial_count: number;
  /** JSON-encoded array of warning strings. */
  ingest_warnings: string;
  embedding_model_id: string;
  ingestion_source_sha: string;
  ingestion_duration_ms: number;
  tarball_sha256: string;
  docs_tarball_sha256: string;
}

/**
 * Upsert the single meta row. (Single-row invariant is enforced by the
 * schema's `CHECK (id = 1)` constraint.)
 */
export function writeMeta(db: Database.Database, meta: MetaRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO meta (
       id,
       godot_version, godot_docs_branch, schema_version, indexed_at,
       class_count, tutorial_count, ingest_warnings,
       embedding_model_id, ingestion_source_sha, ingestion_duration_ms,
       tarball_sha256, docs_tarball_sha256
     ) VALUES (
       1,
       @godot_version, @godot_docs_branch, @schema_version, @indexed_at,
       @class_count, @tutorial_count, @ingest_warnings,
       @embedding_model_id, @ingestion_source_sha, @ingestion_duration_ms,
       @tarball_sha256, @docs_tarball_sha256
     )`,
  ).run(meta);
}

/**
 * Read the single meta row. Returns `null` for an unpopulated DB so
 * callers can distinguish "no meta yet" from a malformed row.
 */
export function readMeta(db: Database.Database): MetaRecord | null {
  const row = db
    .prepare(
      `SELECT godot_version, godot_docs_branch, schema_version, indexed_at,
              class_count, tutorial_count, ingest_warnings,
              embedding_model_id, ingestion_source_sha, ingestion_duration_ms,
              tarball_sha256, docs_tarball_sha256
       FROM meta WHERE id = 1`,
    )
    .get() as MetaRecord | undefined;
  return row ?? null;
}

/**
 * Open a docs DB in **read-only** mode. Applies
 * `PRAGMA query_only = 1` so even a programmer mistake (e.g. running a
 * UPDATE against the read handle) surfaces as `SQLITE_READONLY` rather
 * than silently mutating the bundled DB.
 *
 * Throws if the file doesn't exist or isn't a valid SQLite DB.
 */
export function openReadOnly(dbPath: string): Database.Database {
  const db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
  // Defense in depth — better-sqlite3 honors `readonly: true` at the
  // OS level, but query_only also covers cases where the file's
  // permissions allow writes (developer mistake).
  db.pragma("query_only = 1");
  return db;
}

/**
 * Open a docs DB in read-write mode for the ingest pipeline. Returns a
 * fresh DB with `journal_mode = MEMORY` (no `-wal`/`-shm` siblings) and
 * `synchronous = NORMAL` for build speed; the atomic rename at the end
 * of ingestion handles durability.
 *
 * The caller is responsible for `db.close()`.
 */
export function openWritable(dbPath: string): Database.Database {
  const db = new DatabaseCtor(dbPath);
  // No WAL — DESIGN.md Wave 2 D6: bundled DB is read-only post-ingestion.
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = NORMAL");
  return db;
}
