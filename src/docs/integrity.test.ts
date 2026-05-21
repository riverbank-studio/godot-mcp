/**
 * Tests for `integrity` — SHA-256 verification against the
 * `data/godot-release-hashes.json` manifest (DESIGN.md Wave 2 D14).
 *
 * Notes
 * -----
 * #47 ships a parallel `src/docs/integrity.ts` that supersedes this when
 * it lands; this file's exports are scoped to what #6 needs (verify +
 * record), and the public function names match so the call site in
 * `ingest.ts` is import-only-changed at rebase time.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";

import {
  IntegrityError,
  computeSha256,
  verifyTarballSha,
  loadHashManifest,
  type HashManifest,
} from "./integrity.js";

const SAMPLE_TARBALL = Buffer.from("hello world", "utf8");
const SAMPLE_SHA = crypto
  .createHash("sha256")
  .update(SAMPLE_TARBALL)
  .digest("hex");

describe("computeSha256", () => {
  it("returns a 64-char lowercase hex digest for a buffer", () => {
    const digest = computeSha256(SAMPLE_TARBALL);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(SAMPLE_SHA);
  });

  it("is identity-stable across repeated calls", () => {
    expect(computeSha256(SAMPLE_TARBALL)).toBe(computeSha256(SAMPLE_TARBALL));
  });
});

describe("verifyTarballSha — manifest hit", () => {
  it("passes when the actual SHA matches the pinned entry", () => {
    const manifest: HashManifest = {
      tags: {
        "4.5-stable": {
          engine: { sha256: SAMPLE_SHA },
          docs: { sha256: "deadbeef".repeat(8) },
        },
      },
    };
    const result = verifyTarballSha(SAMPLE_TARBALL, {
      manifest,
      tag: "4.5-stable",
      asset: "engine",
    });
    expect(result).toEqual({
      verified: true,
      sha256: SAMPLE_SHA,
      pinned: true,
    });
  });

  it("throws IntegrityError when the actual SHA differs from the pin", () => {
    const manifest: HashManifest = {
      tags: {
        "4.5-stable": {
          engine: { sha256: "0".repeat(64) },
          docs: { sha256: "deadbeef".repeat(8) },
        },
      },
    };
    expect(() =>
      verifyTarballSha(SAMPLE_TARBALL, {
        manifest,
        tag: "4.5-stable",
        asset: "engine",
      }),
    ).toThrow(IntegrityError);
    expect(() =>
      verifyTarballSha(SAMPLE_TARBALL, {
        manifest,
        tag: "4.5-stable",
        asset: "engine",
      }),
    ).toThrow(/sha256 mismatch|SHA-256 mismatch/i);
  });

  it("includes the tag, asset, expected, and actual in the error message", () => {
    const manifest: HashManifest = {
      tags: {
        "4.5-stable": {
          engine: { sha256: "0".repeat(64) },
          docs: { sha256: "deadbeef".repeat(8) },
        },
      },
    };
    try {
      verifyTarballSha(SAMPLE_TARBALL, {
        manifest,
        tag: "4.5-stable",
        asset: "engine",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      const msg = (err as Error).message;
      expect(msg).toContain("4.5-stable");
      expect(msg).toContain("engine");
      expect(msg).toContain(SAMPLE_SHA);
      expect(msg).toContain("0".repeat(64));
    }
  });
});

describe("verifyTarballSha — no manifest entry", () => {
  it("returns verified=false, pinned=false (observed-record path)", () => {
    const manifest: HashManifest = { tags: {} };
    const result = verifyTarballSha(SAMPLE_TARBALL, {
      manifest,
      tag: "4.99-stable",
      asset: "engine",
    });
    expect(result).toEqual({
      verified: false,
      sha256: SAMPLE_SHA,
      pinned: false,
    });
  });

  it("treats partial manifest (no `asset` entry for the tag) as unpinned", () => {
    const manifest: HashManifest = {
      tags: {
        "4.5-stable": {
          engine: { sha256: SAMPLE_SHA },
        },
      },
    };
    const result = verifyTarballSha(SAMPLE_TARBALL, {
      manifest,
      tag: "4.5-stable",
      asset: "docs",
    });
    expect(result.pinned).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.sha256).toBe(SAMPLE_SHA);
  });
});

describe("loadHashManifest", () => {
  it("returns an empty-tags manifest when override JSON is empty", () => {
    const manifest = loadHashManifest({ rawJson: '{"tags": {}}' });
    expect(manifest).toEqual({ tags: {} });
  });

  it("parses a well-formed manifest with multiple tags", () => {
    const manifest = loadHashManifest({
      rawJson: JSON.stringify({
        tags: {
          "4.5-stable": {
            engine: { sha256: "a".repeat(64) },
            docs: { sha256: "b".repeat(64) },
          },
          "4.6-stable": {
            engine: { sha256: "c".repeat(64) },
            docs: { sha256: "d".repeat(64) },
          },
        },
      }),
    });
    expect(Object.keys(manifest.tags)).toEqual(["4.5-stable", "4.6-stable"]);
  });

  it("throws on missing top-level `tags` field", () => {
    expect(() => loadHashManifest({ rawJson: "{}" })).toThrow(/tags/);
  });

  it("throws on non-JSON input", () => {
    expect(() => loadHashManifest({ rawJson: "not json" })).toThrow();
  });

  it("throws on a tag value with a malformed sha256 (wrong length)", () => {
    expect(() =>
      loadHashManifest({
        rawJson: JSON.stringify({
          tags: { "4.5-stable": { engine: { sha256: "short" } } },
        }),
      }),
    ).toThrow(/sha256|hex/i);
  });
});
