/**
 * Tests for the docs runtime singleton.
 *
 * DESIGN.md § Concurrency model:
 *   - Tool handlers `await` the latch before querying; init failure on
 *     cold-startup crashes the server, but runtime-refetch failure
 *     leaves the latch in `failed` so tool calls error and editor/LSP
 *     tools keep working.
 *
 * The runtime owns the DB handle + latch. This file exercises the
 * lifecycle: init success → handlers see the DB; init failure →
 * handlers see a docs-tools error; reset → next call re-initializes.
 */

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  createDocsRuntime,
  type DocsRuntime,
  type DocsRuntimeInit,
} from "./runtime.js";

// Minimal stub DB — we only need an object identity, not real SQLite,
// because the runtime's contract is "hand back what init resolved with."
const stubDb = { close: vi.fn() } as unknown as DocsRuntimeInit["db"];

function makeRuntime(): DocsRuntime {
  return createDocsRuntime();
}

describe("createDocsRuntime — initial state", () => {
  it("starts in 'pending' so handlers know to await", () => {
    const rt = makeRuntime();
    expect(rt.state().kind).toBe("pending");
  });
});

describe("createDocsRuntime — happy path", () => {
  let rt: DocsRuntime;
  afterEach(() => {
    rt?.dispose();
  });

  it("init(success) → state() === ready and getDb() resolves to the DB", async () => {
    rt = makeRuntime();
    rt.initialize({
      db: stubDb,
      source: "bundled",
      path: "/data/docs-stable.db",
    });
    expect(rt.state().kind).toBe("ready");
    await expect(rt.getDb()).resolves.toBe(stubDb);
  });

  it("describeSource() returns the docs source metadata for godot_docs_info", () => {
    rt = makeRuntime();
    rt.initialize({
      db: stubDb,
      source: "bundled",
      path: "/data/docs-stable.db",
    });
    expect(rt.describeSource()).toEqual({
      source: "bundled",
      path: "/data/docs-stable.db",
    });
  });
});

describe("createDocsRuntime — failure path", () => {
  let rt: DocsRuntime;
  afterEach(() => {
    rt?.dispose();
  });

  it("fail(reason) → state() === failed and getDb() rejects with the original error", async () => {
    rt = makeRuntime();
    const err = new Error("docs ingestion failed");
    rt.fail(err);
    expect(rt.state().kind).toBe("failed");
    await expect(rt.getDb()).rejects.toThrow("docs ingestion failed");
  });

  it("describeSource() throws when the runtime never initialized successfully", () => {
    rt = makeRuntime();
    rt.fail(new Error("nope"));
    expect(() => rt.describeSource()).toThrow(/not.*initialize/i);
  });
});

describe("createDocsRuntime — reset semantics", () => {
  let rt: DocsRuntime;
  afterEach(() => {
    rt?.dispose();
  });

  it("reset() lets a previously-failed runtime be re-initialized (runtime-refetch retry)", async () => {
    rt = makeRuntime();
    rt.fail(new Error("transient"));
    rt.reset();
    expect(rt.state().kind).toBe("pending");
    rt.initialize({
      db: stubDb,
      source: "cache",
      path: "/cache/docs-4.5-v1.db",
    });
    await expect(rt.getDb()).resolves.toBe(stubDb);
  });

  it("dispose() closes the underlying DB and transitions to failed", () => {
    rt = makeRuntime();
    rt.initialize({
      db: stubDb,
      source: "bundled",
      path: "/data/docs-stable.db",
    });
    rt.dispose();
    expect(rt.state().kind).toBe("failed");
    // dispose is idempotent — second call is a no-op.
    expect(() => rt.dispose()).not.toThrow();
  });
});

describe("withDocsDb helper", () => {
  let rt: DocsRuntime;
  afterEach(() => {
    rt?.dispose();
  });

  it("invokes the body with the resolved DB on success", async () => {
    rt = makeRuntime();
    rt.initialize({
      db: stubDb,
      source: "bundled",
      path: "/data/docs-stable.db",
    });
    const r = await rt.withDb(async (db) => {
      expect(db).toBe(stubDb);
      return { content: [{ type: "text", text: "ran" }] };
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("ran");
  });

  it("converts a latch failure into a docs MCP error response", async () => {
    rt = makeRuntime();
    rt.fail(new Error("docs unavailable"));
    const r = await rt.withDb(async () => ({
      content: [{ type: "text", text: "should not run" }],
    }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/docs.*unavailable/i);
  });
});
