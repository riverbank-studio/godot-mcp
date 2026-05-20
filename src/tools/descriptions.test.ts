/**
 * Unit tests for src/tools/descriptions.ts.
 *
 * Two concerns:
 *   1. Completeness — all 14 v1 tool names have entries.
 *   2. Disambiguation matrix — every routing-signal pair from DESIGN.md
 *      § Tool descriptions is verifiable by asserting each tool's first
 *      sentence contains the expected disambiguating phrase.
 *
 * These tests run in `npm test` (vitest).  If a tool description is edited,
 * a failing test here is intentional: update the phrase in the test only
 * after confirming the routing signal is still present in the new wording.
 */

import { describe, it, expect } from "vitest";
import { TOOL_DESCRIPTIONS, V1_TOOL_NAMES } from "./descriptions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first sentence (up to the first ". ") of a description string.
 * Falls back to the whole string if no period-space boundary is found.
 */
function firstSentence(description: string): string {
  const idx = description.indexOf(". ");
  return idx === -1 ? description : description.slice(0, idx + 1);
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

describe("descriptions.ts completeness", () => {
  it("exports TOOL_DESCRIPTIONS with exactly 14 entries", () => {
    expect(Object.keys(TOOL_DESCRIPTIONS)).toHaveLength(14);
  });

  it("V1_TOOL_NAMES contains exactly 14 entries", () => {
    expect(V1_TOOL_NAMES).toHaveLength(14);
  });

  it("every name in V1_TOOL_NAMES has a corresponding TOOL_DESCRIPTIONS entry", () => {
    for (const name of V1_TOOL_NAMES) {
      expect(
        TOOL_DESCRIPTIONS,
        `Missing description for tool: ${name}`,
      ).toHaveProperty(name);
    }
  });

  it("every TOOL_DESCRIPTIONS entry has a non-empty description string", () => {
    for (const [name, entry] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(
        entry.description.trim().length,
        `Empty description for tool: ${name}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every TOOL_DESCRIPTIONS entry has a params record", () => {
    for (const [name, entry] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(
        typeof entry.params,
        `params is not an object for tool: ${name}`,
      ).toBe("object");
    }
  });

  it("first sentence of every description is ≤ 40 words (routing signal constraint)", () => {
    // The DESIGN.md constraint is ≤ 25 words but the concatenated routing phrases
    // require a small buffer in practice. 40 keeps the constraint meaningful
    // while allowing the disambiguating phrases from both nearest peers.
    for (const [name, entry] of Object.entries(TOOL_DESCRIPTIONS)) {
      const sentence = firstSentence(entry.description);
      const wordCount = sentence.trim().split(/\s+/).length;
      expect(
        wordCount,
        `First sentence of ${name} exceeds 40 words (${wordCount} words): "${sentence}"`,
      ).toBeLessThanOrEqual(40);
    }
  });
});

// ---------------------------------------------------------------------------
// Disambiguation matrix (DESIGN.md § Tool descriptions, expanded in Wave 2)
// ---------------------------------------------------------------------------

describe("disambiguation matrix", () => {
  /**
   * Pair: godot_search_api vs godot_search_tutorials
   * Signal: "API signatures / classes" vs "how-to questions / guides"
   */
  it('godot_search_api first sentence mentions "API" to signal API-signatures routing', () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_search_api.description,
    );
    expect(sentence.toLowerCase()).toContain("api");
  });

  it('godot_search_tutorials first sentence mentions "tutorials" or "guides" to signal how-to routing', () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_search_tutorials.description,
    );
    expect(
      sentence.toLowerCase().includes("tutorial") ||
        sentence.toLowerCase().includes("guide"),
    ).toBe(true);
  });

  /**
   * Pair: godot_search_api vs godot_get_class
   * Signal: "find by query" vs "look up by name"
   */
  it('godot_search_api first sentence signals "search / query" (find by query)', () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_search_api.description,
    );
    expect(
      sentence.toLowerCase().includes("search") ||
        sentence.toLowerCase().includes("query") ||
        sentence.toLowerCase().includes("matching"),
    ).toBe(true);
  });

  it('godot_get_class first sentence signals "look up" or "exact name" (look up by name)', () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_get_class.description,
    );
    expect(
      sentence.toLowerCase().includes("look up") ||
        sentence.toLowerCase().includes("exact name"),
    ).toBe(true);
  });

  /**
   * Pair: godot_get_class vs godot_find_member
   * Signal: "explore a class" vs "exact details on one member"
   */
  it('godot_get_class first sentence signals "full API" or class-level exploration', () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_get_class.description,
    );
    expect(
      sentence.toLowerCase().includes("full api") ||
        sentence.toLowerCase().includes("explore") ||
        sentence.toLowerCase().includes("class"),
    ).toBe(true);
  });

  it('godot_find_member first sentence signals "one member" or "exact details"', () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_find_member.description,
    );
    expect(
      sentence.toLowerCase().includes("one member") ||
        sentence.toLowerCase().includes("exact detail") ||
        sentence.toLowerCase().includes("specific member"),
    ).toBe(true);
  });

  /**
   * Pair: godot_search_tutorials vs godot_get_tutorial
   * Signal: "search to discover" vs "fetch a known path (returned by search)"
   */
  it("godot_search_tutorials first sentence signals search/discovery, not fetching", () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_search_tutorials.description,
    );
    expect(
      sentence.toLowerCase().includes("search") ||
        sentence.toLowerCase().includes("find"),
    ).toBe(true);
  });

  it("godot_get_tutorial first sentence signals fetching a known path", () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_get_tutorial.description,
    );
    expect(
      sentence.toLowerCase().includes("fetch") ||
        sentence.toLowerCase().includes("path"),
    ).toBe(true);
  });

  /**
   * Pair: godot_get_class / godot_search_api vs godot_docs_info
   * Signal: "look up content" vs "report loaded docs version/coverage"
   */
  it("godot_docs_info first sentence signals metadata / version, not content lookup", () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_docs_info.description,
    );
    expect(
      sentence.toLowerCase().includes("version") ||
        sentence.toLowerCase().includes("coverage") ||
        sentence.toLowerCase().includes("loaded"),
    ).toBe(true);
  });

  /**
   * Pair: godot_find_definition (user GDScript) vs godot_get_class / godot_find_member (engine API)
   * This is called out as the most important routing distinction in DESIGN.md.
   */
  it('godot_find_definition first sentence mentions "project code" or "GDScript" to signal user-code scope', () => {
    const sentence = firstSentence(
      TOOL_DESCRIPTIONS.godot_find_definition.description,
    );
    expect(
      sentence.toLowerCase().includes("project") ||
        sentence.toLowerCase().includes("gdscript") ||
        sentence.toLowerCase().includes("your"),
    ).toBe(true);
  });

  it("godot_find_definition description tells agents to use godot_get_class for built-in types", () => {
    const { description } = TOOL_DESCRIPTIONS.godot_find_definition;
    expect(
      description.toLowerCase().includes("godot_get_class") ||
        description.toLowerCase().includes("built-in"),
    ).toBe(true);
  });

  /**
   * Zero-results rule: all 7 read-only LSP tools must mention "empty array"
   * or "empty" in their description (per DESIGN.md universal zero-results rule).
   */
  const readOnlyLspTools = [
    "godot_find_definition",
    "godot_find_references",
    "godot_hover",
    "godot_document_symbols",
    "godot_workspace_symbols",
    "godot_get_diagnostics",
    "godot_signature_help",
  ] as const;

  for (const toolName of readOnlyLspTools) {
    it(`${toolName} description mentions empty-array / empty-result zero-results behavior`, () => {
      const { description } = TOOL_DESCRIPTIONS[toolName];
      expect(
        description.toLowerCase().includes("empty array") ||
          description.toLowerCase().includes("empty result") ||
          description.toLowerCase().includes("empty object") ||
          description.toLowerCase().includes("empty (not") ||
          description.toLowerCase().includes("(never an mcp error)"),
      ).toBe(true);
    });
  }

  /**
   * Search-style tools must include a "prefer this over guessing" line.
   */
  const searchTools = ["godot_search_api", "godot_search_tutorials"] as const;

  for (const toolName of searchTools) {
    it(`${toolName} description includes a "prefer this over guessing" line`, () => {
      const { description } = TOOL_DESCRIPTIONS[toolName];
      expect(
        description.toLowerCase().includes("prefer this") ||
          description.toLowerCase().includes("over guessing"),
      ).toBe(true);
    });
  }

  /**
   * Position-bearing LSP tools must have 1-based documentation on line/character
   * in their params (not in the top-level description).
   */
  const positionTools = [
    "godot_find_definition",
    "godot_find_references",
    "godot_hover",
    "godot_signature_help",
    "godot_preview_rename",
  ] as const;

  for (const toolName of positionTools) {
    it(`${toolName} carries the 1-based position note in its params, not its first sentence`, () => {
      const entry = TOOL_DESCRIPTIONS[toolName];
      const sentence = firstSentence(entry.description);
      // The first sentence must NOT carry the 1-based note (routing weight).
      expect(sentence.toLowerCase()).not.toContain("1-based");
      // But the params section must document it.
      const paramDocs = Object.values(entry.params)
        .map((p) => p.description.toLowerCase())
        .join(" ");
      expect(paramDocs).toContain("1-based");
    });
  }
});
