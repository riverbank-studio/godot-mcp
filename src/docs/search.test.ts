/**
 * Tests for FTS5 query helpers shared by the six docs-tools leaves
 * (#14, #16, #17). The helpers exist to ensure (a) user input cannot
 * inject FTS5 operators (quotes, NEAR, etc.) and (b) every leaf builds
 * the same prefix-AND MATCH expression so retrieval behaves uniformly.
 *
 * Reference: docs/research/fts5-tokenizer-bm25.md (#39) — the production
 * MATCH strategy is "split on non-word chars, AND tokens with trailing
 * `*` for prefix matching", excluding the `trigram` tokenizer (which
 * v1 doesn't use).
 */

import { describe, it, expect } from "vitest";

import {
  escapeFtsToken,
  tokenizeQuery,
  buildPrefixMatch,
  isQueryEffectivelyEmpty,
} from "./search.js";

describe("escapeFtsToken", () => {
  it("wraps a token in double quotes so reserved characters do not parse as operators", () => {
    expect(escapeFtsToken("add_child")).toBe('"add_child"');
  });

  it("escapes embedded double quotes by doubling them (FTS5 string-literal rule)", () => {
    // FTS5 string literals use the same doubling convention as SQL.
    expect(escapeFtsToken('foo"bar')).toBe('"foo""bar"');
  });

  it("does not strip leading underscores (identifiers like _init must survive)", () => {
    expect(escapeFtsToken("_init")).toBe('"_init"');
  });
});

describe("tokenizeQuery", () => {
  it("splits on non-word characters", () => {
    expect(tokenizeQuery("add child node")).toEqual(["add", "child", "node"]);
  });

  it("preserves underscores so snake_case identifiers stay intact (DESIGN.md tokenchars '_')", () => {
    expect(tokenizeQuery("add_child Node")).toEqual(["add_child", "Node"]);
  });

  it("drops empty tokens and collapses multiple separators", () => {
    expect(tokenizeQuery("  foo  ,, bar  ")).toEqual(["foo", "bar"]);
  });

  it("returns [] for an empty / whitespace-only / undefined query", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
    expect(tokenizeQuery(undefined)).toEqual([]);
  });
});

describe("buildPrefixMatch", () => {
  it("returns null for an empty token set (caller decides whether to error or return [])", () => {
    expect(buildPrefixMatch("")).toBeNull();
    expect(buildPrefixMatch("   ")).toBeNull();
  });

  it("AND-joins tokens with trailing prefix wildcard for each", () => {
    expect(buildPrefixMatch("add child")).toBe('"add" * AND "child" *');
  });

  it("preserves a snake_case identifier as a single token", () => {
    expect(buildPrefixMatch("add_child")).toBe('"add_child" *');
  });

  it("handles a query containing a literal double-quote without producing an FTS5 parse error", () => {
    // The double-quote is a non-word character per our tokenizer, so it
    // splits `foo"bar` into two tokens. What matters is the output is a
    // valid FTS5 MATCH expression (no unbalanced quotes), not the exact
    // split — that's an internal detail of our prefix-AND strategy.
    expect(buildPrefixMatch('foo"bar baz')).toBe(
      '"foo" * AND "bar" * AND "baz" *',
    );
  });

  it("escapes an internal quote that survives tokenization in the (impossible-today) path where one does", () => {
    // Defensive: if the tokenizer is ever changed to allow embedded
    // quotes in a token, the per-token escape still produces valid
    // FTS5 by doubling the quote. We exercise the path directly via
    // escapeFtsToken since tokenizeQuery currently never emits a
    // quote-containing token.
    expect(escapeFtsToken('foo"bar')).toBe('"foo""bar"');
  });
});

describe("isQueryEffectivelyEmpty", () => {
  it("is true for missing, empty, or whitespace-only input", () => {
    expect(isQueryEffectivelyEmpty(undefined)).toBe(true);
    expect(isQueryEffectivelyEmpty("")).toBe(true);
    expect(isQueryEffectivelyEmpty("   ")).toBe(true);
    expect(isQueryEffectivelyEmpty("\t\n")).toBe(true);
  });

  it("is true when the input contains only non-word characters", () => {
    // FTS5 would tokenize "!!! ???" to nothing — equivalent to empty.
    expect(isQueryEffectivelyEmpty("!!! ???")).toBe(true);
  });

  it("is false for any input that contains at least one word character", () => {
    expect(isQueryEffectivelyEmpty("a")).toBe(false);
    expect(isQueryEffectivelyEmpty("add_child")).toBe(false);
    expect(isQueryEffectivelyEmpty("  Node ")).toBe(false);
  });
});
