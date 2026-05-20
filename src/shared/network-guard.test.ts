/**
 * Tests for the single network-allowed checkpoint that all future runtime
 * fetches (GitHub Tags API, codeload tarball, HuggingFace model download)
 * must funnel through.
 *
 * The guard is intentionally trivial — its value is in being the one place
 * that every fetch site has to call, so adding `GODOT_MCP_OFFLINE` support
 * to a new caller is a one-line change and impossible to forget at review
 * time (a fetch that bypasses the guard is the bug, not a missing env-var
 * check).
 */

import { describe, it, expect } from "vitest";
import {
  assertOnlineAllowed,
  resolveDocsDbPath,
  OfflineModeError,
} from "./network-guard.js";

describe("assertOnlineAllowed", () => {
  it("is a no-op when offline=false", () => {
    expect(() =>
      assertOnlineAllowed({ offline: false }, "github-tags-api"),
    ).not.toThrow();
  });

  it("throws OfflineModeError when offline=true", () => {
    expect(() =>
      assertOnlineAllowed({ offline: true }, "github-tags-api"),
    ).toThrow(OfflineModeError);
  });

  it("error message names the blocked operation so logs identify the call site", () => {
    try {
      assertOnlineAllowed({ offline: true }, "codeload-tarball-fetch");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OfflineModeError);
      expect((e as Error).message).toMatch(/codeload-tarball-fetch/);
      expect((e as Error).message).toMatch(/GODOT_MCP_OFFLINE/);
    }
  });

  it("error message mentions the relevant env-var escape hatches", () => {
    try {
      assertOnlineAllowed({ offline: true }, "model-download");
    } catch (e) {
      const msg = (e as Error).message;
      // Users hitting this need to know which override to set.
      expect(msg).toMatch(/GODOT_MCP_MODEL_PATH|GODOT_DOCS_DB_PATH/);
    }
  });
});

describe("resolveDocsDbPath", () => {
  it("returns the override path when GODOT_DOCS_DB_PATH is set", () => {
    const result = resolveDocsDbPath({
      offline: false,
      docsDbPath: "/some/pre-built.db",
    });
    expect(result).toEqual({ kind: "override", path: "/some/pre-built.db" });
  });

  it("returns kind=bundled when no override and version is unset", () => {
    const result = resolveDocsDbPath({ offline: false });
    expect(result.kind).toBe("bundled");
  });

  it("returns kind=bundled when version is 'stable' (the bundled DB)", () => {
    const result = resolveDocsDbPath({
      offline: false,
      docsVersion: "stable",
    });
    expect(result.kind).toBe("bundled");
  });

  it("returns kind=resolve-required for explicit X.Y when not offline", () => {
    // Ingestion pipeline (#6) will own the actual cache+fetch logic; this
    // helper just classifies what the caller should do.
    const result = resolveDocsDbPath({ offline: false, docsVersion: "4.5" });
    expect(result.kind).toBe("resolve-required");
  });

  it("returns kind=resolve-required for 'latest' when not offline", () => {
    const result = resolveDocsDbPath({
      offline: false,
      docsVersion: "latest",
    });
    expect(result.kind).toBe("resolve-required");
  });

  it("offline + override path → kind=override (override wins over offline)", () => {
    // The override is the supported air-gap escape hatch; offline should not
    // block it.
    const result = resolveDocsDbPath({
      offline: true,
      docsDbPath: "/airgap/docs.db",
      docsVersion: "latest",
    });
    expect(result).toEqual({ kind: "override", path: "/airgap/docs.db" });
  });

  it("offline + no override + version=stable → kind=bundled (no fetch needed)", () => {
    const result = resolveDocsDbPath({
      offline: true,
      docsVersion: "stable",
    });
    expect(result.kind).toBe("bundled");
  });

  it("offline + no override + version=latest → throws OfflineModeError", () => {
    // Parallels the parse-time check; defensive in case env parse is skipped
    // (e.g. callers that synthesize a config directly).
    expect(() =>
      resolveDocsDbPath({ offline: true, docsVersion: "latest" }),
    ).toThrow(OfflineModeError);
  });

  it("offline + no override + version=X.Y → returns kind=resolve-required (cache may hit)", () => {
    // The fetch is what's forbidden, not the cache lookup. If the cache hits,
    // ingestion never calls the guard; if it misses, ingestion calls
    // assertOnlineAllowed and *that* throws.
    const result = resolveDocsDbPath({ offline: true, docsVersion: "4.5" });
    expect(result.kind).toBe("resolve-required");
  });
});
