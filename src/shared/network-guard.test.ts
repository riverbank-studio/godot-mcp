/**
 * Tests for the network-guard.
 *
 * Mirrors PR #55's test file so when the two branches merge, the union of
 * behavior holds. Verifies:
 *   - assertOnlineAllowed throws OfflineModeError in offline mode with the
 *     operation name in the message.
 *   - assertOnlineAllowed is a no-op when online.
 *   - resolveDocsDbPath classification: override / bundled / resolve-required.
 *   - resolveDocsDbPath throws OfflineModeError on offline+latest+no override.
 */

import { describe, it, expect } from "vitest";

import {
  assertOnlineAllowed,
  resolveDocsDbPath,
  OfflineModeError,
  type NetworkOperation,
} from "./network-guard.js";

describe("assertOnlineAllowed", () => {
  it("is a no-op when offline=false", () => {
    expect(() =>
      assertOnlineAllowed({ offline: false }, "github-tags-api"),
    ).not.toThrow();
  });

  const ops: NetworkOperation[] = [
    "github-tags-api",
    "codeload-engine-tarball-fetch",
    "codeload-docs-tarball-fetch",
    "model-download",
  ];

  it.each(ops)("throws OfflineModeError in offline mode for %s", (op) => {
    const err = (() => {
      try {
        assertOnlineAllowed({ offline: true }, op);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfflineModeError);
    expect((err as Error).message).toContain(op);
    expect((err as Error).message).toContain("GODOT_MCP_OFFLINE");
  });
});

describe("resolveDocsDbPath", () => {
  it("returns kind=override when GODOT_DOCS_DB_PATH is set, even in offline+latest", () => {
    expect(
      resolveDocsDbPath({
        offline: true,
        docsVersion: "latest",
        docsDbPath: "/path/to/pre-built.db",
      }),
    ).toEqual({ kind: "override", path: "/path/to/pre-built.db" });
  });

  it("returns kind=bundled when version is unset/stable and no override", () => {
    expect(resolveDocsDbPath({ offline: false })).toEqual({ kind: "bundled" });
    expect(
      resolveDocsDbPath({ offline: false, docsVersion: "stable" }),
    ).toEqual({
      kind: "bundled",
    });
  });

  it("returns kind=resolve-required for X.Y or latest when online", () => {
    expect(resolveDocsDbPath({ offline: false, docsVersion: "4.5" })).toEqual({
      kind: "resolve-required",
    });
    expect(
      resolveDocsDbPath({ offline: false, docsVersion: "latest" }),
    ).toEqual({
      kind: "resolve-required",
    });
  });

  it("throws OfflineModeError on offline+latest+no override", () => {
    expect(() =>
      resolveDocsDbPath({ offline: true, docsVersion: "latest" }),
    ).toThrow(OfflineModeError);
  });

  it("returns kind=resolve-required for offline+X.Y (cache may hit; only the fetch is gated)", () => {
    expect(resolveDocsDbPath({ offline: true, docsVersion: "4.5" })).toEqual({
      kind: "resolve-required",
    });
  });
});
