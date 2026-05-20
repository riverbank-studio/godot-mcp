// Tests for the SHA-256 tarball integrity helper.
//
// Three behaviors under test, mirroring the acceptance criteria of #47:
//   1. When the manifest has an entry for the tag, mismatch is a hard failure
//      (IntegrityError with code TARBALL_SHA_MISMATCH and exitCode 2).
//   2. When the manifest has no entry (e.g. `latest` / runtime fetch), the
//      helper returns the observed SHA so the caller can record it in the
//      DB's `meta.tarball_sha256` field — no throw.
//   3. GODOT_DOCS_TARBALL_HASH_OVERRIDE replaces the manifest's expected hash
//      for one ingestion run.
//
// Plus structural checks on the in-repo manifest itself: it parses, every
// entry matches the schema's hash format, every recorded branch follows the
// 'X.Y' shape, and at least one current stable version is pinned.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  verifyTarballSha,
  loadHashManifest,
  resolveDefaultManifestPath,
  IntegrityError,
  type HashManifest,
} from "./integrity.js";

/** Absolute path to repo root, derived from this test file's location. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Absolute path to the committed manifest. */
const MANIFEST_PATH = join(REPO_ROOT, "data", "godot-release-hashes.json");

/**
 * Compute the SHA-256 of a Buffer in `sha256:<hex>` form, matching the
 * manifest's wire format.
 */
function sha256Of(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/** Eight bytes is enough to produce a deterministic hash for tests. */
const FAKE_TARBALL = Buffer.from("fake-tarball-bytes");
const FAKE_TARBALL_SHA = sha256Of(FAKE_TARBALL);

describe("loadHashManifest", () => {
  it("parses the committed manifest and exposes per-tag entries", () => {
    const manifest = loadHashManifest(MANIFEST_PATH);
    expect(manifest.versions).toBeTypeOf("object");
    // At least one currently-supported stable tag must be pinned.
    expect(Object.keys(manifest.versions).length).toBeGreaterThan(0);
  });

  it("rejects a manifest path that does not exist", () => {
    expect(() => loadHashManifest("/nonexistent/path/manifest.json")).toThrow(
      IntegrityError,
    );
  });

  it("rejects an entry whose hash does not match sha256:<64-hex>", () => {
    // Inline malformed manifest via a Buffer-backed loader path. We use the
    // file-based loader's parsed output, so test the validator via a crafted
    // object: loadHashManifest is just JSON.parse + validate, so passing a
    // bogus shape through the same validator surface guards the contract.
    // We do this by writing a tmp file.
    const tmp = join(tmpdir(), `godot-mcp-bad-manifest-${process.pid}.json`);
    writeFileSync(
      tmp,
      JSON.stringify({
        "4.5-stable": {
          godot: "not-a-sha",
          "godot-docs-branch": "4.5",
          "godot-docs": "sha256:" + "0".repeat(64),
        },
      }),
    );
    try {
      expect(() => loadHashManifest(tmp)).toThrow(IntegrityError);
    } finally {
      unlinkSync(tmp);
    }
  });
});

describe("verifyTarballSha — manifest entry present (pinned)", () => {
  /** Manifest fixture with a single pinned tag, using FAKE_TARBALL_SHA. */
  const manifest: HashManifest = {
    versions: {
      "4.5-stable": {
        godot: FAKE_TARBALL_SHA,
        "godot-docs-branch": "4.5",
        "godot-docs": FAKE_TARBALL_SHA,
      },
    },
  };

  it("returns the observed SHA when bytes match the pinned value", () => {
    const result = verifyTarballSha({
      tarball: FAKE_TARBALL,
      tag: "4.5-stable",
      asset: "godot",
      manifest,
    });
    expect(result.observed).toBe(FAKE_TARBALL_SHA);
    expect(result.pinned).toBe(FAKE_TARBALL_SHA);
    expect(result.source).toBe("manifest");
  });

  it("throws IntegrityError(TARBALL_SHA_MISMATCH, exitCode 2) on mismatch", () => {
    const otherBytes = Buffer.from("different-bytes");
    let caught: unknown;
    try {
      verifyTarballSha({
        tarball: otherBytes,
        tag: "4.5-stable",
        asset: "godot",
        manifest,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntegrityError);
    const err = caught as IntegrityError;
    expect(err.code).toBe("TARBALL_SHA_MISMATCH");
    expect(err.exitCode).toBe(2);
    expect(err.tag).toBe("4.5-stable");
    expect(err.asset).toBe("godot");
    expect(err.expected).toBe(FAKE_TARBALL_SHA);
    expect(err.observed).toBe(sha256Of(otherBytes));
  });

  it("verifies the godot-docs asset separately from godot", () => {
    const result = verifyTarballSha({
      tarball: FAKE_TARBALL,
      tag: "4.5-stable",
      asset: "godot-docs",
      manifest,
    });
    expect(result.source).toBe("manifest");
  });
});

describe("verifyTarballSha — manifest entry missing (unpinned)", () => {
  const emptyManifest: HashManifest = { versions: {} };

  it("returns the observed SHA without throwing (latest / runtime path)", () => {
    const result = verifyTarballSha({
      tarball: FAKE_TARBALL,
      tag: "5.0-stable",
      asset: "godot",
      manifest: emptyManifest,
    });
    expect(result.observed).toBe(FAKE_TARBALL_SHA);
    expect(result.pinned).toBeUndefined();
    expect(result.source).toBe("unpinned");
  });

  it("returns observed SHA for a known tag when only the other asset is queried with no matching key", () => {
    // Edge: a manifest could have a tag entry but the docs-branch key absent.
    // verifyTarballSha treats a missing per-asset key as unpinned (not error).
    const partial: HashManifest = {
      versions: {
        "4.5-stable": {
          godot: FAKE_TARBALL_SHA,
          // Intentionally no `godot-docs` / `godot-docs-branch`.
        } as HashManifest["versions"][string],
      },
    };
    const result = verifyTarballSha({
      tarball: FAKE_TARBALL,
      tag: "4.5-stable",
      asset: "godot-docs",
      manifest: partial,
    });
    expect(result.source).toBe("unpinned");
  });
});

describe("verifyTarballSha — GODOT_DOCS_TARBALL_HASH_OVERRIDE", () => {
  const ORIGINAL_ENV = process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE;

  beforeEach(() => {
    delete process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE;
    } else {
      process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE = ORIGINAL_ENV;
    }
  });

  it("replaces the manifest's expected SHA with the env value", () => {
    // Manifest says X; override says match-FAKE. Pass FAKE bytes; should pass.
    const manifest: HashManifest = {
      versions: {
        "4.5-stable": {
          godot: "sha256:" + "0".repeat(64), // wrong hash on purpose
          "godot-docs-branch": "4.5",
          "godot-docs": "sha256:" + "0".repeat(64),
        },
      },
    };
    process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE = `godot=${FAKE_TARBALL_SHA},godot-docs=${FAKE_TARBALL_SHA}`;
    const result = verifyTarballSha({
      tarball: FAKE_TARBALL,
      tag: "4.5-stable",
      asset: "godot",
      manifest,
    });
    expect(result.source).toBe("env-override");
    expect(result.pinned).toBe(FAKE_TARBALL_SHA);
  });

  it("still fails hard when override is set but observed SHA does not match override", () => {
    process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE = `godot=sha256:${"f".repeat(64)}`;
    const manifest: HashManifest = { versions: {} };
    expect(() =>
      verifyTarballSha({
        tarball: FAKE_TARBALL,
        tag: "4.5-stable",
        asset: "godot",
        manifest,
      }),
    ).toThrow(IntegrityError);
  });

  it("ignores entries for other assets in the override list", () => {
    process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE = `godot-docs=${FAKE_TARBALL_SHA}`;
    const manifest: HashManifest = { versions: {} };
    // Asset 'godot' has no override and no manifest entry → unpinned.
    const result = verifyTarballSha({
      tarball: FAKE_TARBALL,
      tag: "4.5-stable",
      asset: "godot",
      manifest,
    });
    expect(result.source).toBe("unpinned");
  });

  it("rejects a malformed override string with IntegrityError", () => {
    process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE = "this-is-not-valid";
    const manifest: HashManifest = { versions: {} };
    expect(() =>
      verifyTarballSha({
        tarball: FAKE_TARBALL,
        tag: "4.5-stable",
        asset: "godot",
        manifest,
      }),
    ).toThrow(IntegrityError);
  });
});

describe("committed manifest in data/godot-release-hashes.json", () => {
  it("has at least the current stable version pinned", () => {
    const manifest = loadHashManifest(MANIFEST_PATH);
    // Wave 2 design fixed 'stable' === 4.5 baseline. At least one of the
    // recent stable tags must be present so #6 (ingest) has something to
    // verify against on the bundled-DB build.
    const tags = Object.keys(manifest.versions);
    const hasRecentStable = tags.some((t) => /^4\.[5-9]-stable$/.test(t));
    expect(hasRecentStable).toBe(true);
  });

  it("every entry has well-formed sha256 strings and a non-empty docs branch", () => {
    const manifest = loadHashManifest(MANIFEST_PATH);
    const shaPattern = /^sha256:[0-9a-f]{64}$/;
    for (const [tag, entry] of Object.entries(manifest.versions)) {
      expect(shaPattern.test(entry["godot"]), tag).toBe(true);
      expect(shaPattern.test(entry["godot-docs"]), tag).toBe(true);
      expect(entry["godot-docs-branch"].length).toBeGreaterThan(0);
    }
  });

  it("docs-branch is always 'X.Y' (a branch in godot-docs, not a tag in godot)", () => {
    const manifest = loadHashManifest(MANIFEST_PATH);
    for (const [tag, entry] of Object.entries(manifest.versions)) {
      expect(/^\d+\.\d+$/.test(entry["godot-docs-branch"]), tag).toBe(true);
    }
  });
});

describe("readme / discoverability", () => {
  it("manifest schema file exists alongside the manifest", () => {
    const schemaPath = join(
      REPO_ROOT,
      "data",
      "godot-release-hashes.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      $schema: string;
      title: string;
    };
    expect(schema.$schema).toMatch(/json-schema\.org/);
    expect(schema.title).toMatch(/Godot release hash manifest/i);
  });
});

describe("resolveDefaultManifestPath", () => {
  it("resolves to a real file under the source tree's data/ directory", () => {
    const resolved = resolveDefaultManifestPath();
    expect(resolved.endsWith("godot-release-hashes.json")).toBe(true);
    // The returned path must be loadable by loadHashManifest without error.
    const manifest = loadHashManifest(resolved);
    expect(Object.keys(manifest.versions).length).toBeGreaterThan(0);
  });
});
