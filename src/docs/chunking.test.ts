/**
 * Tests for `chunking` — the fallback chain (H2 → H3 → paragraph →
 * token-window) for tutorial RST pages per DESIGN.md L264 / Wave 2 D-Docs
 * M10.
 *
 * The chunker operates over a normalized RST representation (`RstPage`)
 * — see `class-xml.ts` for the parser. Tests here use hand-rolled
 * fixtures so they can target each fallback branch without coupling to
 * the RST parser's surface.
 */

import { describe, it, expect } from "vitest";

import {
  chunkPage,
  estimateTokens,
  CHUNK_SOFT_CAP_TOKENS,
  CHUNK_HARD_CAP_TOKENS,
  CHUNK_OVERLAP_TOKENS,
} from "./chunking.js";

describe("estimateTokens", () => {
  it("approximates ~4 chars per token", () => {
    // 80 chars → ~20 tokens at the 4-chars-per-token heuristic.
    expect(estimateTokens("a".repeat(80))).toBeGreaterThanOrEqual(18);
    expect(estimateTokens("a".repeat(80))).toBeLessThanOrEqual(22);
  });

  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(0);
  });
});

describe("chunkPage — H2 split (happy path)", () => {
  it("splits a multi-H2 page into one chunk per H2", () => {
    const page = {
      pagePath: "tutorials/scripting/gdscript/basics.rst",
      title: "GDScript basics",
      content: [
        { kind: "h1" as const, text: "GDScript basics" },
        { kind: "paragraph" as const, text: "Intro paragraph." },
        { kind: "h2" as const, text: "Variables" },
        {
          kind: "paragraph" as const,
          text: "You declare variables with var.",
        },
        { kind: "h2" as const, text: "Functions" },
        {
          kind: "paragraph" as const,
          text: "Functions are declared with func.",
        },
      ],
    };
    const chunks = chunkPage(page);
    // Expect a leading chunk for the pre-H2 intro, plus one per H2.
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.headingPath).toEqual(["GDScript basics"]);
    expect(chunks[1]!.headingPath).toEqual(["GDScript basics", "Variables"]);
    expect(chunks[2]!.headingPath).toEqual(["GDScript basics", "Functions"]);
  });

  it("preserves code blocks intact within the chunk", () => {
    const page = {
      pagePath: "x.rst",
      title: "Page",
      content: [
        { kind: "h1" as const, text: "Page" },
        { kind: "h2" as const, text: "Section" },
        {
          kind: "code" as const,
          lang: "gdscript",
          text: "func foo():\n  pass",
        },
      ],
    };
    const chunks = chunkPage(page);
    // No pre-H2 content under H1, so we expect a single chunk for the
    // Section. The code fence is preserved verbatim.
    expect(chunks.length).toBe(1);
    const body = chunks[0]!;
    expect(body.headingPath).toEqual(["Page", "Section"]);
    expect(body.text).toContain("```gdscript");
    expect(body.text).toContain("func foo():");
  });
});

describe("chunkPage — paragraph fallback (no H2)", () => {
  it("treats a no-H2 page as a single H1 group and packs paragraphs greedily", () => {
    const page = {
      pagePath: "x.rst",
      title: "Page",
      content: [
        { kind: "h1" as const, text: "Page" },
        { kind: "paragraph" as const, text: "First paragraph." },
        { kind: "paragraph" as const, text: "Second paragraph." },
        { kind: "paragraph" as const, text: "Third paragraph." },
      ],
    };
    const chunks = chunkPage(page);
    // Small paragraphs all fit under the soft cap → one packed chunk.
    // The "Pages with no H2 chunk from paragraphs immediately" guidance
    // (DESIGN.md L264) means we *fall through* to paragraph splitting
    // when needed, not that we over-split tiny content.
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("First paragraph");
    expect(chunks[0]!.text).toContain("Second paragraph");
    expect(chunks[0]!.text).toContain("Third paragraph");
    // Heading path is just the page title since there's no H2 to descend into.
    expect(chunks[0]!.headingPath).toEqual(["Page"]);
  });
});

describe("chunkPage — H3 fallback (H2 oversize)", () => {
  it("splits by H3 when the H2 section exceeds the hard cap", () => {
    const big = "x ".repeat(CHUNK_HARD_CAP_TOKENS * 2); // way over hard cap
    const page = {
      pagePath: "x.rst",
      title: "Page",
      content: [
        { kind: "h1" as const, text: "Page" },
        { kind: "h2" as const, text: "Section" },
        { kind: "h3" as const, text: "Sub A" },
        { kind: "paragraph" as const, text: big },
        { kind: "h3" as const, text: "Sub B" },
        { kind: "paragraph" as const, text: "small" },
      ],
    };
    const chunks = chunkPage(page);
    // Sub A is still oversize so it falls through to paragraph splitting
    // (or token-window). Sub B fits in one chunk. Verify the *boundary*
    // — we expect both Sub A and Sub B headings in the heading paths.
    const subAChunks = chunks.filter((c) =>
      c.headingPath.join(" > ").endsWith("Sub A"),
    );
    const subBChunks = chunks.filter((c) =>
      c.headingPath.join(" > ").endsWith("Sub B"),
    );
    expect(subAChunks.length).toBeGreaterThan(0);
    expect(subBChunks.length).toBe(1);
  });
});

describe("chunkPage — token-window fallback (single H3 still oversize)", () => {
  it("splits an oversize leaf via token windows with overlap", () => {
    const big = "x ".repeat(CHUNK_HARD_CAP_TOKENS * 3);
    const page = {
      pagePath: "x.rst",
      title: "Page",
      content: [
        { kind: "h1" as const, text: "Page" },
        { kind: "h2" as const, text: "Section" },
        { kind: "paragraph" as const, text: big },
      ],
    };
    const chunks = chunkPage(page);
    // At least two token-window chunks.
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk exceeds the hard cap.
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(CHUNK_HARD_CAP_TOKENS);
    }
  });

  it("includes overlap text between consecutive token-window chunks", () => {
    const big = "alpha bravo charlie delta echo foxtrot ".repeat(
      CHUNK_HARD_CAP_TOKENS,
    );
    const page = {
      pagePath: "x.rst",
      title: "Page",
      content: [
        { kind: "h1" as const, text: "Page" },
        { kind: "paragraph" as const, text: big },
      ],
    };
    const chunks = chunkPage(page);
    // We just want to assert overlap is present — the last N tokens of
    // chunk[i] should overlap the first N tokens of chunk[i+1]. Check
    // by counting shared words via Set intersection size; the exact
    // overlap count is implementation-specific.
    expect(chunks.length).toBeGreaterThan(1);
    const a = chunks[0]!.text.split(/\s+/);
    const b = chunks[1]!.text.split(/\s+/);
    // The last 10 words of `a` and first 10 of `b` should share at
    // least one word.
    const tail = new Set(a.slice(-10));
    const head = new Set(b.slice(0, 10));
    const shared = [...tail].filter((w) => head.has(w));
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("chunkPage — metadata", () => {
  it("records pagePath and chunk index", () => {
    const page = {
      pagePath: "tutorials/foo.rst",
      title: "Foo",
      content: [
        { kind: "h1" as const, text: "Foo" },
        { kind: "paragraph" as const, text: "Body." },
      ],
    };
    const chunks = chunkPage(page);
    expect(chunks[0]!.pagePath).toBe("tutorials/foo.rst");
    expect(chunks[0]!.index).toBe(0);
  });

  it("never emits below-100-token chunks for empty pages", () => {
    // An empty page should produce zero chunks rather than a tiny stub.
    const page = {
      pagePath: "x.rst",
      title: "Empty",
      content: [],
    };
    expect(chunkPage(page)).toEqual([]);
  });
});

describe("chunkPage — soft/hard cap invariants", () => {
  it("no chunk exceeds the hard cap regardless of input shape", () => {
    const page = {
      pagePath: "x.rst",
      title: "T",
      content: [
        { kind: "h1" as const, text: "T" },
        ...Array.from({ length: 50 }, (_, i) => ({
          kind: "paragraph" as const,
          text: ("word" + i + " ").repeat(200),
        })),
      ],
    };
    const chunks = chunkPage(page);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(CHUNK_HARD_CAP_TOKENS);
    }
  });
});

describe("chunking constants", () => {
  it("has sane soft / hard cap and overlap defaults", () => {
    expect(CHUNK_SOFT_CAP_TOKENS).toBe(1500);
    expect(CHUNK_HARD_CAP_TOKENS).toBe(3000);
    expect(CHUNK_OVERLAP_TOKENS).toBe(200);
  });
});
