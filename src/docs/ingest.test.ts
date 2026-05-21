/**
 * Tests for `ingest` — the pipeline orchestrator.
 *
 * Strategy: mock every external concern (network fetch, manifest source,
 * embedder) so the pipeline can be exercised hermetically. Real network
 * + embedding integration is exercised by the build script
 * (`npm run build:docs`) and CI, not by these unit tests.
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  fetchAndParseVersion,
  resolveDocsBranchForTag,
  buildTarballUrl,
} from "./ingest.js";
import { createStubEmbedder } from "./embed.js";
import { type HashManifest } from "./integrity.js";

/**
 * Build a minimal fake "godot" tarball as a Buffer. We don't need a real
 * tar layout — the fetcher returns whatever bytes; the parser is
 * stubbed via `parseClassXmlFn`. Bytes shape just needs the SHA to be
 * deterministic.
 */
function fakeTarBytes(label: string): Buffer {
  return Buffer.from(`fake-tar:${label}`, "utf8");
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

describe("buildTarballUrl", () => {
  it("builds the engine codeload URL", () => {
    expect(buildTarballUrl({ asset: "engine", tag: "4.5-stable" })).toBe(
      "https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/4.5-stable",
    );
  });

  it("builds the docs codeload URL for a branch", () => {
    expect(buildTarballUrl({ asset: "docs", branch: "4.5" })).toBe(
      "https://codeload.github.com/godotengine/godot-docs/tar.gz/refs/heads/4.5",
    );
  });

  it("builds the docs codeload URL for the stable fallback", () => {
    expect(buildTarballUrl({ asset: "docs", branch: "stable" })).toBe(
      "https://codeload.github.com/godotengine/godot-docs/tar.gz/refs/heads/stable",
    );
  });
});

describe("resolveDocsBranchForTag", () => {
  it("strips the -stable suffix to get the branch", () => {
    expect(resolveDocsBranchForTag("4.5-stable")).toBe("4.5");
    expect(resolveDocsBranchForTag("4.6-stable")).toBe("4.6");
  });
});

describe("fetchAndParseVersion — happy path", () => {
  it("runs the full pipeline against fake fetchers and writes a valid DB", async () => {
    const engineBytes = fakeTarBytes("godot-4.5-stable");
    const docsBytes = fakeTarBytes("godot-docs-4.5");
    const manifest: HashManifest = {
      tags: {
        "4.5-stable": {
          engine: { sha256: sha256(engineBytes) },
          docs: { sha256: sha256(docsBytes) },
        },
      },
    };
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      const report = await fetchAndParseVersion(
        { kind: "explicit", major: 4, minor: 5 },
        outputPath,
        {
          manifest,
          fetcher: vi.fn(async ({ asset }) => {
            if (asset === "engine") return engineBytes;
            return docsBytes;
          }),
          extractClasses: vi.fn(async () => [
            {
              filename: "Object.xml",
              xml: `<?xml version="1.0"?><class name="Object" inherits="" version="4.5"><brief_description>Base.</brief_description><description>Base.</description></class>`,
            },
            // Add 499 more so the structural-validation threshold (>= 500) passes.
            ...Array.from({ length: 499 }, (_, i) => ({
              filename: `C${i}.xml`,
              xml: `<?xml version="1.0"?><class name="C${i}" inherits="Object" version="4.5"><brief_description>x</brief_description><description>x</description></class>`,
            })),
          ]),
          extractTutorials: vi.fn(async () => [
            {
              pagePath: "tutorials/foo.rst",
              title: "Foo",
              content: [
                { kind: "h1" as const, text: "Foo" },
                { kind: "paragraph" as const, text: "Body." },
              ],
            },
          ]),
          embedder: createStubEmbedder(),
          failureThresholdPercent: 5,
        },
      );

      expect(report.classes.parsed).toBeGreaterThanOrEqual(500);
      expect(report.classes.failed).toBe(0);
      expect(report.tutorials.parsed).toBe(1);
      expect(report.tarballSha256).toBe(sha256(engineBytes));
      expect(report.docsTarballSha256).toBe(sha256(docsBytes));
      expect(fs.existsSync(outputPath)).toBe(true);
      // No -wal / -shm siblings (DESIGN.md Wave 2 D6).
      expect(fs.existsSync(outputPath + "-wal")).toBe(false);
      expect(fs.existsSync(outputPath + "-shm")).toBe(false);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

describe("fetchAndParseVersion — failure modes", () => {
  it("fails when fewer than 500 class XML files are present", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      await expect(
        fetchAndParseVersion(
          { kind: "explicit", major: 4, minor: 5 },
          outputPath,
          {
            manifest: { tags: {} },
            fetcher: async () => Buffer.from("x"),
            extractClasses: async () => [
              {
                filename: "Object.xml",
                xml: `<?xml version="1.0"?><class name="Object" inherits=""><brief_description/></class>`,
              },
            ],
            extractTutorials: async () => [],
            embedder: createStubEmbedder(),
            failureThresholdPercent: 5,
          },
        ),
      ).rejects.toThrow(/500|class.*count|structural/i);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it("counts per-file parse failures against the threshold", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      // Mix of valid + invalid XML; 10% failure rate exceeds threshold=5.
      const valid = Array.from({ length: 450 }, (_, i) => ({
        filename: `Valid${i}.xml`,
        xml: `<?xml version="1.0"?><class name="V${i}" inherits=""><brief_description/></class>`,
      }));
      const invalid = Array.from({ length: 50 }, (_, i) => ({
        filename: `Bad${i}.xml`,
        xml: `<not-a-class />`,
      }));
      await expect(
        fetchAndParseVersion(
          { kind: "explicit", major: 4, minor: 5 },
          outputPath,
          {
            manifest: { tags: {} },
            fetcher: async () => Buffer.from("x"),
            extractClasses: async () => [...valid, ...invalid],
            extractTutorials: async () => [],
            embedder: createStubEmbedder(),
            failureThresholdPercent: 5, // 50/500 = 10% > 5%
          },
        ),
      ).rejects.toThrow(/threshold|failure rate/i);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it("succeeds when failure rate is at or below the threshold", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      const valid = Array.from({ length: 490 }, (_, i) => ({
        filename: `V${i}.xml`,
        xml: `<?xml version="1.0"?><class name="V${i}" inherits=""><brief_description/></class>`,
      }));
      const invalid = Array.from({ length: 10 }, (_, i) => ({
        filename: `Bad${i}.xml`,
        xml: `<not-a-class />`,
      }));
      const report = await fetchAndParseVersion(
        { kind: "explicit", major: 4, minor: 5 },
        outputPath,
        {
          manifest: { tags: {} },
          fetcher: async () => Buffer.from("x"),
          extractClasses: async () => [...valid, ...invalid],
          extractTutorials: async () => [],
          embedder: createStubEmbedder(),
          failureThresholdPercent: 5, // 10/500 = 2% <= 5%
        },
      );
      expect(report.classes.parsed).toBe(490);
      expect(report.classes.failed).toBe(10);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it("CI strict mode (threshold=0) fails on any per-file failure", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      const valid = Array.from({ length: 499 }, (_, i) => ({
        filename: `V${i}.xml`,
        xml: `<?xml version="1.0"?><class name="V${i}" inherits=""><brief_description/></class>`,
      }));
      const invalid = [{ filename: "Bad.xml", xml: `<not-a-class />` }];
      await expect(
        fetchAndParseVersion(
          { kind: "explicit", major: 4, minor: 5 },
          outputPath,
          {
            manifest: { tags: {} },
            fetcher: async () => Buffer.from("x"),
            extractClasses: async () => [...valid, ...invalid],
            extractTutorials: async () => [],
            embedder: createStubEmbedder(),
            failureThresholdPercent: 0,
          },
        ),
      ).rejects.toThrow(/threshold|failure/i);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

describe("fetchAndParseVersion — SHA verification", () => {
  it("throws IntegrityError on a manifest mismatch (pinned)", async () => {
    const engineBytes = fakeTarBytes("godot-4.5-stable");
    const manifest: HashManifest = {
      tags: {
        "4.5-stable": {
          engine: { sha256: "0".repeat(64) }, // intentionally wrong
        },
      },
    };
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      await expect(
        fetchAndParseVersion(
          { kind: "explicit", major: 4, minor: 5 },
          outputPath,
          {
            manifest,
            fetcher: async () => engineBytes,
            extractClasses: async () =>
              Array.from({ length: 500 }, (_, i) => ({
                filename: `C${i}.xml`,
                xml: `<?xml version="1.0"?><class name="C${i}" inherits=""><brief_description/></class>`,
              })),
            extractTutorials: async () => [],
            embedder: createStubEmbedder(),
            failureThresholdPercent: 5,
          },
        ),
      ).rejects.toThrow(/SHA-256 mismatch|IntegrityError/);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it("records the observed SHA when the manifest has no entry (unpinned)", async () => {
    const engineBytes = fakeTarBytes("godot-4.99-stable");
    const docsBytes = fakeTarBytes("docs-4.99");
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      const report = await fetchAndParseVersion(
        { kind: "explicit", major: 4, minor: 99 },
        outputPath,
        {
          manifest: { tags: {} },
          fetcher: vi.fn(async ({ asset }) => {
            if (asset === "engine") return engineBytes;
            return docsBytes;
          }),
          extractClasses: async () =>
            Array.from({ length: 500 }, (_, i) => ({
              filename: `C${i}.xml`,
              xml: `<?xml version="1.0"?><class name="C${i}" inherits=""><brief_description/></class>`,
            })),
          extractTutorials: async () => [],
          embedder: createStubEmbedder(),
          failureThresholdPercent: 5,
        },
      );
      expect(report.tarballSha256).toBe(sha256(engineBytes));
      expect(report.docsTarballSha256).toBe(sha256(docsBytes));
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

describe("fetchAndParseVersion — atomic write", () => {
  it("renames .tmp → final path at the end", async () => {
    const engineBytes = fakeTarBytes("e");
    const docsBytes = fakeTarBytes("d");
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
    const outputPath = path.join(tmpdir, "out.db");
    try {
      const fetcher = vi.fn(async ({ asset }: { asset: string }) =>
        asset === "engine" ? engineBytes : docsBytes,
      );
      await fetchAndParseVersion(
        { kind: "explicit", major: 4, minor: 5 },
        outputPath,
        {
          manifest: { tags: {} },
          fetcher,
          extractClasses: async () =>
            Array.from({ length: 500 }, (_, i) => ({
              filename: `C${i}.xml`,
              xml: `<?xml version="1.0"?><class name="C${i}" inherits=""><brief_description/></class>`,
            })),
          extractTutorials: async () => [],
          embedder: createStubEmbedder(),
          failureThresholdPercent: 5,
        },
      );
      expect(fs.existsSync(outputPath)).toBe(true);
      // .tmp file should be gone after rename.
      expect(fs.existsSync(outputPath + ".tmp")).toBe(false);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});
