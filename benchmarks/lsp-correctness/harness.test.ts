/**
 * Unit tests for the LSP correctness benchmark harness — issue #45.
 *
 * These tests exercise the pure functions in harness.ts that can run
 * without a live Godot instance:
 *
 *   - `evaluate()` — expectation evaluation against mock tool responses
 *   - `summarisePassRates()` — per-tool pass-rate computation
 *   - `loadLabels()` — JSON parsing + basic structural invariants
 *
 * No MCP server is started; no Godot binary is required.  The tests run in
 * normal `vitest` mode alongside the main test suite.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  evaluate,
  loadLabels,
  summarisePassRates,
  type LabelResult,
} from "./harness.js";

// ---------------------------------------------------------------------------
// evaluate() — location_array
// ---------------------------------------------------------------------------

describe("evaluate: location_array", () => {
  it("passes an empty array when min_results=0", () => {
    const result = evaluate({ kind: "location_array", min_results: 0 }, []);
    expect(result.pass).toBe(true);
  });

  it("fails when fewer results than min_results", () => {
    const result = evaluate({ kind: "location_array", min_results: 2 }, [
      {
        file: "scripts/player.gd",
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 5 },
        },
      },
    ]);
    expect(result.pass).toBe(false);
    expect((result as { pass: false; reason: string }).reason).toMatch(/≥2/);
  });

  it("passes when result count meets min_results", () => {
    const locs = [
      {
        file: "scripts/entity.gd",
        range: {
          start: { line: 36, character: 1 },
          end: { line: 36, character: 8 },
        },
      },
      {
        file: "scripts/player.gd",
        range: {
          start: { line: 75, character: 1 },
          end: { line: 75, character: 8 },
        },
      },
    ];
    const result = evaluate({ kind: "location_array", min_results: 1 }, locs);
    expect(result.pass).toBe(true);
  });

  it("fails when response is not an array", () => {
    const result = evaluate(
      { kind: "location_array" },
      { error: "not an array" },
    );
    expect(result.pass).toBe(false);
  });

  it("passes when any_result file_suffix matches", () => {
    const locs = [
      {
        file: "/home/user/project/scripts/entity.gd",
        range: {
          start: { line: 36, character: 1 },
          end: { line: 36, character: 8 },
        },
      },
    ];
    const result = evaluate(
      {
        kind: "location_array",
        min_results: 1,
        any_result: { file_suffix: "scripts/entity.gd" },
      },
      locs,
    );
    expect(result.pass).toBe(true);
  });

  it("fails when no result matches any_result file_suffix", () => {
    const locs = [
      {
        file: "/home/user/project/scripts/player.gd",
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 5 },
        },
      },
    ];
    const result = evaluate(
      {
        kind: "location_array",
        min_results: 1,
        any_result: { file_suffix: "scripts/entity.gd" },
      },
      locs,
    );
    expect(result.pass).toBe(false);
  });

  it("fails when result starts with excluded file prefix", () => {
    const locs = [
      {
        file: "file:///home/user/project/scripts/player.gd",
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 5 },
        },
      },
    ];
    // Expect a result that does NOT start with "file://"
    const result = evaluate(
      {
        kind: "location_array",
        min_results: 1,
        any_result: { file_prefix_not: "file://" },
      },
      locs,
    );
    expect(result.pass).toBe(false);
  });

  it("passes when result does not have excluded prefix", () => {
    const locs = [
      {
        file: "gdscript://@GlobalScope",
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 5 },
        },
      },
    ];
    const result = evaluate(
      {
        kind: "location_array",
        min_results: 1,
        any_result: { file_prefix_not: "file://" },
      },
      locs,
    );
    expect(result.pass).toBe(true);
  });

  it("passes when range_start_line matches", () => {
    const locs = [
      {
        file: "scripts/player.gd",
        range: {
          start: { line: 52, character: 1 },
          end: { line: 52, character: 5 },
        },
      },
    ];
    const result = evaluate(
      {
        kind: "location_array",
        min_results: 1,
        any_result: { range_start_line: 52 },
      },
      locs,
    );
    expect(result.pass).toBe(true);
  });

  it("fails when range_start_line does not match", () => {
    const locs = [
      {
        file: "scripts/player.gd",
        range: {
          start: { line: 10, character: 1 },
          end: { line: 10, character: 5 },
        },
      },
    ];
    const result = evaluate(
      {
        kind: "location_array",
        min_results: 1,
        any_result: { range_start_line: 52 },
      },
      locs,
    );
    expect(result.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — hover_substring
// ---------------------------------------------------------------------------

describe("evaluate: hover_substring", () => {
  it("passes when response contains the substring", () => {
    const resp = {
      content: { kind: "markdown", value: "func jump(impulse: float) -> void" },
    };
    const result = evaluate(
      { kind: "hover_substring", substring: "jump" },
      resp,
    );
    expect(result.pass).toBe(true);
  });

  it("is case-insensitive", () => {
    const resp = { content: { kind: "markdown", value: "JUMP definition" } };
    const result = evaluate(
      { kind: "hover_substring", substring: "jump" },
      resp,
    );
    expect(result.pass).toBe(true);
  });

  it("fails when substring is absent", () => {
    const resp = { content: { kind: "markdown", value: "take_damage method" } };
    const result = evaluate(
      { kind: "hover_substring", substring: "jump" },
      resp,
    );
    expect(result.pass).toBe(false);
  });

  it("fails when response is empty and allow_empty=false", () => {
    const result = evaluate(
      { kind: "hover_substring", substring: "jump", allow_empty: false },
      {},
    );
    expect(result.pass).toBe(false);
  });

  it("passes when response is empty and allow_empty=true", () => {
    const result = evaluate(
      { kind: "hover_substring", substring: "jump", allow_empty: true },
      {},
    );
    expect(result.pass).toBe(true);
  });

  it("passes for null response when allow_empty=true", () => {
    const result = evaluate(
      { kind: "hover_substring", substring: "x", allow_empty: true },
      null,
    );
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — hover_or_empty
// ---------------------------------------------------------------------------

describe("evaluate: hover_or_empty", () => {
  it("passes for empty response", () => {
    expect(evaluate({ kind: "hover_or_empty" }, {}).pass).toBe(true);
  });

  it("passes for non-empty response", () => {
    expect(
      evaluate(
        { kind: "hover_or_empty" },
        { content: { kind: "markdown", value: "x" } },
      ).pass,
    ).toBe(true);
  });

  it("passes for null", () => {
    expect(evaluate({ kind: "hover_or_empty" }, null).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — symbol_names_include
// ---------------------------------------------------------------------------

describe("evaluate: symbol_names_include", () => {
  const symbols = [
    { name: "bind_player", kind: 12 },
    { name: "_rebuild_rows", kind: 12 },
    { name: "page_forward", kind: 12 },
    { name: "page_back", kind: 12 },
    { name: "player", kind: 8 },
    { name: "page_offset", kind: 8 },
  ];

  it("passes when all required names are present", () => {
    const result = evaluate(
      { kind: "symbol_names_include", names: ["bind_player", "page_forward"] },
      { symbols, truncated: false },
    );
    expect(result.pass).toBe(true);
  });

  it("fails when a required name is absent", () => {
    const result = evaluate(
      { kind: "symbol_names_include", names: ["bind_player", "nonexistent"] },
      { symbols, truncated: false },
    );
    expect(result.pass).toBe(false);
    expect((result as { pass: false; reason: string }).reason).toContain(
      "nonexistent",
    );
  });

  it("handles flat array response (no symbols wrapper)", () => {
    const result = evaluate(
      { kind: "symbol_names_include", names: ["bind_player"] },
      symbols,
    );
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — diagnostics_min_severity
// ---------------------------------------------------------------------------

describe("evaluate: diagnostics_min_severity", () => {
  const diags = [
    { severity: 1, line: 19, character: 2, message: "type mismatch" },
    { severity: 1, line: 23, character: 2, message: "undeclared identifier" },
    { severity: 2, line: 5, character: 1, message: "unused variable" },
  ];

  it("passes when enough diagnostics have the right severity", () => {
    const result = evaluate(
      { kind: "diagnostics_min_severity", min_count: 2, severity: 1 },
      { diagnostics: diags, partial: false },
    );
    expect(result.pass).toBe(true);
  });

  it("fails when too few diagnostics match severity", () => {
    const result = evaluate(
      { kind: "diagnostics_min_severity", min_count: 3, severity: 1 },
      { diagnostics: diags, partial: false },
    );
    expect(result.pass).toBe(false);
  });

  it("handles flat array response", () => {
    const result = evaluate(
      { kind: "diagnostics_min_severity", min_count: 1, severity: 2 },
      diags,
    );
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — diagnostics_max_severity
// ---------------------------------------------------------------------------

describe("evaluate: diagnostics_max_severity", () => {
  it("passes when no errors present (clean file)", () => {
    const result = evaluate(
      { kind: "diagnostics_max_severity", max_count: 0, severity: 1 },
      {
        diagnostics: [
          { severity: 2, line: 1, character: 1, message: "warning" },
        ],
        partial: false,
      },
    );
    expect(result.pass).toBe(true);
  });

  it("fails when errors are present", () => {
    const result = evaluate(
      { kind: "diagnostics_max_severity", max_count: 0, severity: 1 },
      {
        diagnostics: [{ severity: 1, line: 5, character: 1, message: "error" }],
        partial: false,
      },
    );
    expect(result.pass).toBe(false);
  });

  it("passes when count is within max", () => {
    const result = evaluate(
      { kind: "diagnostics_max_severity", max_count: 2, severity: 1 },
      {
        diagnostics: [{ severity: 1, line: 1, character: 1, message: "e" }],
        partial: false,
      },
    );
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// summarisePassRates()
// ---------------------------------------------------------------------------

describe("summarisePassRates", () => {
  const results: LabelResult[] = [
    {
      id: "a",
      variant: "steady_state",
      tool: "godot_find_definition",
      pass: true,
      latency_ms: 100,
      raw_response: "[]",
    },
    {
      id: "b",
      variant: "steady_state",
      tool: "godot_find_definition",
      pass: false,
      latency_ms: 200,
      raw_response: "[]",
      failure_reason: "no match",
    },
    {
      id: "c",
      variant: "steady_state",
      tool: "godot_hover",
      pass: true,
      latency_ms: 50,
      raw_response: "{}",
    },
  ];

  it("computes correct pass/total/rate per tool", () => {
    const rates = summarisePassRates(results);
    expect(rates["godot_find_definition"]).toEqual({
      pass: 1,
      total: 2,
      rate: 0.5,
    });
    expect(rates["godot_hover"]).toEqual({ pass: 1, total: 1, rate: 1 });
  });

  it("returns empty object for empty results", () => {
    expect(summarisePassRates([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// loadLabels() structural invariants
// ---------------------------------------------------------------------------

describe("loadLabels", () => {
  it("loads a valid labels.json without throwing", () => {
    const lf = loadLabels();
    expect(lf.version).toBe("1");
    expect(Array.isArray(lf.labels)).toBe(true);
    expect(lf.labels.length).toBeGreaterThan(0);
  });

  it("all label ids are unique", () => {
    const lf = loadLabels();
    const ids = lf.labels.map((l) => l.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all labels have at least one variant", () => {
    const lf = loadLabels();
    for (const label of lf.labels) {
      expect(label.variants.length).toBeGreaterThan(0);
    }
  });

  it("position-based labels have line and character", () => {
    const lf = loadLabels();
    const positionTools = [
      "godot_find_definition",
      "godot_find_references",
      "godot_hover",
      "godot_get_diagnostics",
    ];
    for (const label of lf.labels) {
      // diagnostics and imprecise labels may omit position
      if (
        positionTools.includes(label.tool) &&
        !label.symbol_name &&
        label.variants.some((v) => v !== "imprecise_position")
      ) {
        // Only check if it's not the diagnostics or external_edit-only label
        if (
          label.id !== "diagnostics-broken-types" &&
          label.id !== "diagnostics-clean-entity" &&
          label.id !== "external-edit-resync"
        ) {
          expect(label.line, `label ${label.id} missing line`).toBeDefined();
          expect(
            label.character,
            `label ${label.id} missing character`,
          ).toBeDefined();
        }
      }
    }
  });

  it("fixture files referenced in labels exist on disk", () => {
    const lf = loadLabels();
    const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
    const fixtureBase = path.resolve(here, "../datasets/lsp-correctness/v1");
    for (const label of lf.labels) {
      // skip labels with external_edit which may reference project-relative paths
      const root = path.resolve(fixtureBase, "labels", lf.fixture_root);
      const absFile = path.resolve(root, label.file);
      expect(fs.existsSync(absFile), `fixture file missing: ${absFile}`).toBe(
        true,
      );
    }
  });
});
