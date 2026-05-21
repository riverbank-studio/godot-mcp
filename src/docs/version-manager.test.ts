/**
 * Tests for `version-manager` — parsing, validation, and DB-path resolution
 * for `GODOT_DOCS_VERSION`.
 *
 * Coverage anchors (issue #6 acceptance):
 *   - Accepts `stable`, `latest`, `X.Y` (e.g. `4.5`).
 *   - Rejects patch (`4.5.1`), pre-release (`4.5-beta1`), `<4.0`.
 *   - Bundled path for `stable`, cache path for explicit versions.
 *   - Compose with `GODOT_DOCS_DB_PATH` override (delegates to network-guard).
 *
 * No network in these tests: `latest` resolution is exercised via injected
 * fetcher (the GitHub Tags API I/O lives behind `LatestResolver`).
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

import {
  VersionParseError,
  parseDocsVersion,
  resolveCacheDbPath,
  resolveCacheBaseDir,
  resolveBundledDbPath,
  pickLatestStableTag,
  resolveDocsSource,
  DOCS_SCHEMA_VERSION,
} from "./version-manager.js";

describe("parseDocsVersion", () => {
  it("returns 'stable' kind for unset / empty / 'stable'", () => {
    expect(parseDocsVersion(undefined)).toEqual({ kind: "stable" });
    expect(parseDocsVersion("")).toEqual({ kind: "stable" });
    expect(parseDocsVersion("   ")).toEqual({ kind: "stable" });
    expect(parseDocsVersion("stable")).toEqual({ kind: "stable" });
    expect(parseDocsVersion("STABLE")).toEqual({ kind: "stable" });
  });

  it("returns 'latest' kind for 'latest' (case-insensitive)", () => {
    expect(parseDocsVersion("latest")).toEqual({ kind: "latest" });
    expect(parseDocsVersion("LATEST")).toEqual({ kind: "latest" });
    expect(parseDocsVersion("  latest  ")).toEqual({ kind: "latest" });
  });

  it("accepts X.Y form for X >= 4", () => {
    expect(parseDocsVersion("4.0")).toEqual({
      kind: "explicit",
      major: 4,
      minor: 0,
    });
    expect(parseDocsVersion("4.5")).toEqual({
      kind: "explicit",
      major: 4,
      minor: 5,
    });
    expect(parseDocsVersion("4.10")).toEqual({
      kind: "explicit",
      major: 4,
      minor: 10,
    });
    expect(parseDocsVersion("5.0")).toEqual({
      kind: "explicit",
      major: 5,
      minor: 0,
    });
  });

  it("rejects X.Y for X < 4 (Godot 3.x not supported in v1)", () => {
    expect(() => parseDocsVersion("3.5")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("3.5")).toThrow(/3\.5/);
    expect(() => parseDocsVersion("3.5")).toThrow(/Godot 3\.x not supported/);
    expect(() => parseDocsVersion("0.1")).toThrow(VersionParseError);
  });

  it("rejects patch versions (X.Y.Z)", () => {
    expect(() => parseDocsVersion("4.5.1")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("4.5.1")).toThrow(/patch/i);
  });

  it("rejects pre-release suffixes", () => {
    expect(() => parseDocsVersion("4.5-beta1")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("4.5-rc1")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("4.5-stable")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("4.5-stable")).toThrow(/pre-release|suffix/i);
  });

  it("rejects garbage", () => {
    expect(() => parseDocsVersion("v4.5")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("4")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("4.")).toThrow(VersionParseError);
    expect(() => parseDocsVersion(".5")).toThrow(VersionParseError);
    expect(() => parseDocsVersion("forty-five")).toThrow(VersionParseError);
  });

  it("rejects whitespace-internal", () => {
    // External whitespace is trimmed; internal whitespace is rejected.
    expect(() => parseDocsVersion("4 . 5")).toThrow(VersionParseError);
  });
});

describe("DOCS_SCHEMA_VERSION", () => {
  it("is a positive integer (used in cache filenames)", () => {
    expect(Number.isInteger(DOCS_SCHEMA_VERSION)).toBe(true);
    expect(DOCS_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe("resolveCacheBaseDir", () => {
  it("uses XDG_CACHE_HOME on Linux", () => {
    const result = resolveCacheBaseDir({
      platform: "linux",
      env: { XDG_CACHE_HOME: "/var/cache" },
      homedir: "/home/u",
    });
    expect(result).toBe(path.join("/var/cache", "godot-mcp", "docs"));
  });

  it("falls back to ~/.cache on Linux when XDG_CACHE_HOME is unset", () => {
    const result = resolveCacheBaseDir({
      platform: "linux",
      env: {},
      homedir: "/home/u",
    });
    expect(result).toBe(path.join("/home/u", ".cache", "godot-mcp", "docs"));
  });

  it("falls back to ~/.cache on Linux when XDG_CACHE_HOME is empty/whitespace", () => {
    expect(
      resolveCacheBaseDir({
        platform: "linux",
        env: { XDG_CACHE_HOME: "" },
        homedir: "/home/u",
      }),
    ).toBe(path.join("/home/u", ".cache", "godot-mcp", "docs"));
    expect(
      resolveCacheBaseDir({
        platform: "linux",
        env: { XDG_CACHE_HOME: "   " },
        homedir: "/home/u",
      }),
    ).toBe(path.join("/home/u", ".cache", "godot-mcp", "docs"));
  });

  it("uses ~/Library/Caches on macOS", () => {
    const result = resolveCacheBaseDir({
      platform: "darwin",
      env: {},
      homedir: "/Users/u",
    });
    expect(result).toBe(
      path.join("/Users/u", "Library", "Caches", "godot-mcp", "docs"),
    );
  });

  it("uses LOCALAPPDATA on Windows", () => {
    const result = resolveCacheBaseDir({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      homedir: "C:\\Users\\u",
    });
    expect(result).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "godot-mcp", "docs"),
    );
  });

  it("falls back to ~/AppData/Local on Windows when LOCALAPPDATA is unset", () => {
    const result = resolveCacheBaseDir({
      platform: "win32",
      env: {},
      homedir: "C:\\Users\\u",
    });
    expect(result).toBe(
      path.join("C:\\Users\\u", "AppData", "Local", "godot-mcp", "docs"),
    );
  });
});

describe("resolveCacheDbPath", () => {
  it("builds docs-{version}-v{schema}.db filenames", () => {
    const baseDir = resolveCacheBaseDir({
      platform: os.platform(),
      env: process.env,
      homedir: os.homedir(),
    });
    const file = resolveCacheDbPath({
      kind: "explicit",
      major: 4,
      minor: 5,
    });
    expect(path.basename(file)).toBe(`docs-4.5-v${DOCS_SCHEMA_VERSION}.db`);
    expect(file.startsWith(baseDir)).toBe(true);
  });

  it("supports a 'latest' kind once it has been resolved to a concrete version", () => {
    const file = resolveCacheDbPath({
      kind: "explicit",
      major: 4,
      minor: 6,
    });
    expect(path.basename(file)).toBe(`docs-4.6-v${DOCS_SCHEMA_VERSION}.db`);
  });
});

describe("resolveBundledDbPath", () => {
  it("returns a path ending with data/docs-stable.db", () => {
    const p = resolveBundledDbPath();
    // Platform-independent assertion — only check the trailing segments.
    expect(p.endsWith(path.join("data", "docs-stable.db"))).toBe(true);
  });
});

describe("pickLatestStableTag", () => {
  it("returns the highest semver among *-stable tags", () => {
    const tags = [
      { name: "4.0-stable" },
      { name: "4.5-stable" },
      { name: "4.4.1-stable" }, // patch — discarded
      { name: "4.5-beta1" }, // pre-release — discarded
      { name: "4.6-stable" },
      { name: "3.5-stable" }, // pre-4.0 — discarded
      { name: "not-a-tag" },
    ];
    expect(pickLatestStableTag(tags)).toBe("4.6-stable");
  });

  it("returns null when no usable tags exist", () => {
    expect(pickLatestStableTag([])).toBeNull();
    expect(
      pickLatestStableTag([{ name: "3.5-stable" }, { name: "4.5-beta1" }]),
    ).toBeNull();
  });

  it("handles X.Y.Z-stable form by treating it as a patch (discarded)", () => {
    // "4.5.1-stable" is a patch release; we do not support patches in v1.
    expect(
      pickLatestStableTag([
        { name: "4.5-stable" },
        { name: "4.5.1-stable" },
        { name: "4.6-stable" },
      ]),
    ).toBe("4.6-stable");
  });

  it("breaks ties by minor when major is equal", () => {
    expect(
      pickLatestStableTag([
        { name: "4.10-stable" },
        { name: "4.5-stable" },
        { name: "4.2-stable" },
      ]),
    ).toBe("4.10-stable"); // numeric, not lexical
  });
});

describe("resolveDocsSource", () => {
  it("returns bundled for stable kind", () => {
    const r = resolveDocsSource(
      { kind: "stable" },
      { offline: false, dbPathOverride: undefined },
    );
    expect(r.kind).toBe("bundled");
  });

  it("returns override when GODOT_DOCS_DB_PATH is set, regardless of version", () => {
    const r = resolveDocsSource(
      { kind: "latest" },
      {
        offline: true,
        dbPathOverride: "/abs/custom.db",
      },
    );
    expect(r).toEqual({ kind: "override", path: "/abs/custom.db" });
  });

  it("returns explicit-cache for X.Y kinds", () => {
    const r = resolveDocsSource(
      { kind: "explicit", major: 4, minor: 5 },
      { offline: false, dbPathOverride: undefined },
    );
    expect(r.kind).toBe("explicit-cache");
    if (r.kind === "explicit-cache") {
      expect(path.basename(r.cachePath)).toBe(
        `docs-4.5-v${DOCS_SCHEMA_VERSION}.db`,
      );
      expect(r.version).toEqual({ kind: "explicit", major: 4, minor: 5 });
    }
  });

  it("returns latest-resolve for latest kind when online", () => {
    const r = resolveDocsSource(
      { kind: "latest" },
      { offline: false, dbPathOverride: undefined },
    );
    expect(r.kind).toBe("latest-resolve");
  });
});
