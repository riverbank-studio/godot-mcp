/**
 * Tests for the `godot_docs_info` tool.
 *
 * Issue #19 — meta tool that returns information about the docs DB currently
 * loaded (version, source, indexed_at, class count, tutorial count, etc.).
 *
 * Testing strategy
 * ----------------
 *
 * The tool delegates to the docs runtime singleton, so the tests construct
 * disposable `DocsRuntime` instances (via `createDocsRuntime`) and inject
 * them via the `_setDocsRuntimeForTesting` escape hatch rather than
 * exercising the process-level singleton directly.
 *
 * The barrel registration (`docsTools`) is exercised through the direct
 * import at the top of this file. We do NOT reset the registry between tests
 * to avoid unregistering the tool before the handler tests run.
 */

import { afterEach, describe, it, expect } from "vitest";

import { createDocsRuntime, type DocsRuntime } from "../../docs/runtime.js";
import { writeMeta, createSchema } from "../../docs/schema.js";
import DatabaseCtor from "better-sqlite3";

import { docsTools } from "../docs-tools.js";

// Import the leaf file for its side-effect (registers the tool into docsTools).
import { _setDocsRuntimeForTesting } from "./docs-info.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal stub ToolContext — docs_info doesn't use ctx at all. */
const stubCtx = {} as Parameters<(typeof docsTools)[number]["handler"]>[1];

/**
 * Build an in-memory SQLite DB with schema + a populated meta row so the
 * handler has real data to return.
 */
function makeSeedDb() {
  const db = new DatabaseCtor(":memory:");
  createSchema(db);
  writeMeta(db, {
    godot_version: "4.3",
    godot_docs_branch: "stable",
    schema_version: 1,
    indexed_at: "2024-01-15T10:00:00.000Z",
    class_count: 500,
    tutorial_count: 120,
    ingest_warnings: "[]",
    embedding_model_id: "nomic-embed-text-v1.5",
    ingestion_source_sha: "abc123",
    ingestion_duration_ms: 4200,
    tarball_sha256: "deadbeef",
    docs_tarball_sha256: "cafebabe",
  });
  return db;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: find the registered handler for godot_docs_info.
// ──────────────────────────────────────────────────────────────────────────────

function getHandler(): (typeof docsTools)[number]["handler"] {
  const def = docsTools.find((t) => t.name === "godot_docs_info");
  if (!def) throw new Error("godot_docs_info not registered");
  return def.handler;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("godot_docs_info — tool registration", () => {
  it("registers exactly one tool named godot_docs_info", () => {
    const names = docsTools.map((t) => t.name);
    expect(names.filter((n) => n === "godot_docs_info")).toHaveLength(1);
  });

  it("tool has no required parameters (zero-arg tool)", () => {
    const def = docsTools.find((t) => t.name === "godot_docs_info");
    expect(def?.inputSchema.required ?? []).toHaveLength(0);
  });
});

describe("godot_docs_info — ready runtime", () => {
  let rt: DocsRuntime;
  let restore: () => void;

  afterEach(() => {
    restore?.();
    rt?.dispose();
  });

  it("returns meta fields as a JSON object when runtime is ready", async () => {
    const db = makeSeedDb();
    rt = createDocsRuntime();
    rt.initialize({ db, source: "bundled", path: "/data/docs-stable.db" });
    restore = _setDocsRuntimeForTesting(rt);

    const handler = getHandler();
    const result = await handler({}, stubCtx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.godot_version).toBe("4.3");
    expect(payload.godot_docs_branch).toBe("stable");
    expect(payload.schema_version).toBe(1);
    expect(payload.indexed_at).toBe("2024-01-15T10:00:00.000Z");
    expect(payload.class_count).toBe(500);
    expect(payload.tutorial_count).toBe(120);
    expect(payload.ingest_warnings).toEqual([]);
    expect(payload.source).toBe("bundled");
  });

  it("includes source and path fields from the runtime", async () => {
    const db = makeSeedDb();
    rt = createDocsRuntime();
    rt.initialize({
      db,
      source: "cache",
      path: "/home/user/.cache/godot-mcp/docs.db",
    });
    restore = _setDocsRuntimeForTesting(rt);

    const handler = getHandler();
    const result = await handler({}, stubCtx);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.source).toBe("cache");
    expect(payload.path).toBe("/home/user/.cache/godot-mcp/docs.db");
  });

  it("parses ingest_warnings JSON array from the DB string column", async () => {
    const db = new DatabaseCtor(":memory:");
    createSchema(db);
    writeMeta(db, {
      godot_version: "4.3",
      godot_docs_branch: "stable",
      schema_version: 1,
      indexed_at: "2024-01-15T10:00:00.000Z",
      class_count: 10,
      tutorial_count: 5,
      ingest_warnings: '["warn1","warn2"]',
      embedding_model_id: "nomic-embed-text-v1.5",
      ingestion_source_sha: "",
      ingestion_duration_ms: 1000,
      tarball_sha256: "",
      docs_tarball_sha256: "",
    });

    rt = createDocsRuntime();
    rt.initialize({ db, source: "bundled", path: "/data/docs.db" });
    restore = _setDocsRuntimeForTesting(rt);

    const handler = getHandler();
    const result = await handler({}, stubCtx);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ingest_warnings).toEqual(["warn1", "warn2"]);
  });
});

describe("godot_docs_info — failed runtime", () => {
  let rt: DocsRuntime;
  let restore: () => void;

  afterEach(() => {
    restore?.();
    rt?.dispose();
  });

  it("returns an isError response when the runtime has failed", async () => {
    rt = createDocsRuntime();
    rt.fail(new Error("docs DB not found: /missing.db"));
    restore = _setDocsRuntimeForTesting(rt);

    const handler = getHandler();
    const result = await handler({}, stubCtx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unavailable/i);
  });
});
