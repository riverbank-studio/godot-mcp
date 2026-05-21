/**
 * Tests for the RST parser used by the default tutorial extractor.
 *
 * Network-fetcher + tarball extractors are tested via integration in
 * the build script; here we focus on the small RST-parsing surface
 * because that's where Godot-docs-shape assumptions are encoded.
 *
 * The offline-mode guard at the real network call site
 * (`fetchTarballWithRetry`) is also covered here — without an offline
 * check at this layer, `GODOT_MCP_OFFLINE=1` combined with an explicit
 * `GODOT_DOCS_VERSION=X.Y` leaks past the parse-time guard in
 * `parseSharedEnv` (which only catches offline+latest).
 */

import { describe, it, expect } from "vitest";

import { fetchTarballWithRetry, parseRstPage } from "./ingest-defaults.js";
import { OfflineModeError } from "../shared/network-guard.js";

describe("parseRstPage — headings", () => {
  it("treats === underline as H1 and uses it for the title", () => {
    const r = parseRstPage(
      "x.rst",
      `My Page
======

Intro paragraph.`,
    );
    expect(r.title).toBe("My Page");
    expect(r.content[0]).toEqual({ kind: "h1", text: "My Page" });
  });

  it("treats --- underline as H2", () => {
    const r = parseRstPage(
      "x.rst",
      `Title
=====

Section
-------

Body.`,
    );
    const h2 = r.content.find((b) => b.kind === "h2");
    expect(h2).toBeDefined();
    expect(h2).toEqual({ kind: "h2", text: "Section" });
  });

  it("treats ^^^ underline as H3", () => {
    const r = parseRstPage(
      "x.rst",
      `Title
=====

Section
-------

Sub
^^^

Body.`,
    );
    const h3 = r.content.find((b) => b.kind === "h3");
    expect(h3).toEqual({ kind: "h3", text: "Sub" });
  });
});

describe("parseRstPage — code blocks", () => {
  it("parses a code-block directive with language and indented body", () => {
    const rst = `Title
=====

.. code-block:: gdscript

    func foo():
        print("hi")

More text.`;
    const r = parseRstPage("x.rst", rst);
    const code = r.content.find((b) => b.kind === "code");
    expect(code).toBeDefined();
    if (code && code.kind === "code") {
      expect(code.lang).toBe("gdscript");
      expect(code.text).toContain("func foo()");
      expect(code.text).toContain('print("hi")');
    }
  });
});

describe("parseRstPage — paragraphs", () => {
  it("collapses multi-line paragraphs into a single paragraph block", () => {
    const r = parseRstPage(
      "x.rst",
      `Title
=====

First line
of a paragraph.

Second paragraph.`,
    );
    const paras = r.content.filter((b) => b.kind === "paragraph");
    expect(paras.length).toBe(2);
    expect(paras[0]!.kind).toBe("paragraph");
    if (paras[0]!.kind === "paragraph") {
      expect(paras[0]!.text).toContain("First line");
      expect(paras[0]!.text).toContain("of a paragraph");
    }
  });
});

describe("parseRstPage — empty input", () => {
  it("returns an empty content list and uses the path as fallback title", () => {
    const r = parseRstPage("foo.rst", "");
    expect(r.content).toEqual([]);
    expect(r.title).toBe("foo.rst");
  });
});

describe("fetchTarballWithRetry — offline-mode guard", () => {
  // These tests assert that the offline gate fires *before* any network
  // call is attempted. They never reach `https.get` because
  // `assertOnlineAllowed` throws synchronously inside the retry
  // wrapper's first attempt.
  it("throws OfflineModeError for engine tarball when offline=true (explicit X.Y bypass)", async () => {
    await expect(
      fetchTarballWithRetry(
        { asset: "engine", tag: "4.5-stable" },
        { offline: true },
      ),
    ).rejects.toBeInstanceOf(OfflineModeError);
  });

  it("throws OfflineModeError for docs tarball when offline=true", async () => {
    await expect(
      fetchTarballWithRetry(
        { asset: "docs", branch: "4.5" },
        { offline: true },
      ),
    ).rejects.toBeInstanceOf(OfflineModeError);
  });

  it("names the operation in the error message (engine)", async () => {
    await expect(
      fetchTarballWithRetry(
        { asset: "engine", tag: "4.5-stable" },
        { offline: true },
      ),
    ).rejects.toThrow(/codeload-engine-tarball-fetch/);
  });

  it("names the operation in the error message (docs)", async () => {
    await expect(
      fetchTarballWithRetry(
        { asset: "docs", branch: "4.5" },
        { offline: true },
      ),
    ).rejects.toThrow(/codeload-docs-tarball-fetch/);
  });
});
