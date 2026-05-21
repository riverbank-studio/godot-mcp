/**
 * Tests for the docs runtime bootstrap.
 *
 * The bootstrap is the function `src/shared/server.ts` calls during
 * startup to take the parsed env config + a fresh docs runtime and
 * either (a) open the appropriate DB and `initialize()` the runtime
 * or (b) `fail()` it with a precise diagnostic.
 *
 * Phase 1 of #7 ships the "open the appropriate DB" path for the
 * bundled and override sources, and the cache-hit fast path for an
 * explicit `X.Y` whose DB already exists on disk. Cache misses and
 * `latest`-resolution are left to a separate runtime-fetcher PR; the
 * bootstrap fails the runtime with a clear "not yet implemented in
 * v1.0 infra" message that points to the relevant DESIGN.md section.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapDocsRuntime } from "./bootstrap.js";
import { createDocsRuntime, type DocsRuntime } from "./runtime.js";
import { createSchema, openWritable } from "./schema.js";

/**
 * Mint a minimally-valid docs DB so the bootstrap's
 * "open the file and verify it parses" path has something real to
 * open. Returns the file path; the caller is responsible for cleanup
 * (the test's `afterEach` removes the tmp dir).
 */
function writeFixtureDb(dir: string, name = "fixture.db"): string {
  const p = path.join(dir, name);
  const db = openWritable(p);
  createSchema(db);
  db.close();
  return p;
}

let tmpRoot: string;
let runtime: DocsRuntime;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-docs-bootstrap-"));
});

afterEach(() => {
  runtime?.dispose();
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe("bootstrapDocsRuntime — override path", () => {
  it("opens the override DB when GODOT_DOCS_DB_PATH points to a valid file", async () => {
    const dbPath = writeFixtureDb(tmpRoot);
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: dbPath,
      docsVersion: undefined,
    });

    const s = runtime.state();
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.source).toBe("override");
      expect(s.path).toBe(dbPath);
    }
  });

  it("fails the runtime when GODOT_DOCS_DB_PATH points to a nonexistent file", async () => {
    const missing = path.join(tmpRoot, "nope.db");
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: missing,
      docsVersion: undefined,
    });

    const s = runtime.state();
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      expect(s.error.message).toMatch(/GODOT_DOCS_DB_PATH/);
    }
  });
});

describe("bootstrapDocsRuntime — bundled path", () => {
  it("fails with a clear message when the bundled DB is missing (no data/docs-stable.db in checkout)", async () => {
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: undefined,
      docsVersion: undefined,
      // Pin the bundled-resolver to a path we control so the test is
      // hermetic — without this it would resolve to the actual
      // `data/docs-stable.db` and pass or fail based on dev environment.
      bundledPathOverride: path.join(tmpRoot, "missing.db"),
    });

    const s = runtime.state();
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      expect(s.error.message).toMatch(/bundled docs DB/i);
    }
  });

  it("opens the bundled DB when GODOT_DOCS_VERSION is unset and the file exists", async () => {
    const dbPath = writeFixtureDb(tmpRoot);
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: undefined,
      docsVersion: undefined,
      bundledPathOverride: dbPath,
    });

    const s = runtime.state();
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.source).toBe("bundled");
      expect(s.path).toBe(dbPath);
    }
  });
});

describe("bootstrapDocsRuntime — explicit version + cache hit", () => {
  it("opens the cached DB when the version-specific cache file exists", async () => {
    const dbPath = writeFixtureDb(tmpRoot, "docs-4.5-v1.db");
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: undefined,
      docsVersion: "4.5",
      cachePathOverride: dbPath,
    });

    const s = runtime.state();
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.source).toBe("cache");
      expect(s.path).toBe(dbPath);
    }
  });

  it("fails the runtime on cache miss (runtime fetcher not part of #7 infra)", async () => {
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: undefined,
      docsVersion: "4.5",
      cachePathOverride: path.join(tmpRoot, "missing-cache.db"),
    });

    const s = runtime.state();
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      // The message should name the missing path and explain the gap
      // (runtime-fetch ingestion lives in a separate PR).
      expect(s.error.message).toMatch(/cache/i);
    }
  });
});

describe("bootstrapDocsRuntime — version parse errors", () => {
  it("fails the runtime when GODOT_DOCS_VERSION is malformed (e.g. 4.5.1)", async () => {
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: undefined,
      docsVersion: "4.5.1",
    });

    const s = runtime.state();
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      expect(s.error.message).toMatch(/GODOT_DOCS_VERSION/);
    }
  });

  it("fails with a runtime-not-implemented message for GODOT_DOCS_VERSION=latest (Phase 1 scope)", async () => {
    runtime = createDocsRuntime();

    bootstrapDocsRuntime(runtime, {
      offline: false,
      docsDbPath: undefined,
      docsVersion: "latest",
    });

    const s = runtime.state();
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      expect(s.error.message).toMatch(/latest/i);
    }
  });
});
