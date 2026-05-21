/**
 * Unit tests for scorer.mjs (GDScript E2E benchmark #31).
 *
 * Covers: normaliseCode, bigramSimilarity, checkApiVersion, assembleRubricScore.
 * compile and runtime checks are integration-test shaped (require Godot binary)
 * and are not exercised here.
 */

import { describe, it, expect } from "vitest";
import {
  normaliseCode,
  bigramSimilarity,
  checkApiVersion,
  assembleRubricScore,
} from "./scorer.mjs";

// ---------------------------------------------------------------------------
// normaliseCode
// ---------------------------------------------------------------------------

describe("normaliseCode", () => {
  it("strips line comments", () => {
    const result = normaliseCode("var x = 1 # comment here\nvar y = 2");
    expect(result).not.toContain("#");
    expect(result).not.toContain("comment");
  });

  it("collapses whitespace", () => {
    const result = normaliseCode("var  x   =\t1\n\nvar y = 2");
    expect(result).toMatch(/^var x = 1 var y = 2$/);
  });

  it("lower-cases", () => {
    const result = normaliseCode("FUNC _Ready()");
    expect(result).toBe("func _ready()");
  });

  it("returns empty string for empty input", () => {
    expect(normaliseCode("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// bigramSimilarity
// ---------------------------------------------------------------------------

describe("bigramSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(bigramSimilarity("hello", "hello")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    // No shared bigrams between "ab" and "cd"
    expect(bigramSimilarity("ab", "cd")).toBe(0);
  });

  it("returns 1 for two empty strings", () => {
    expect(bigramSimilarity("", "")).toBe(1);
  });

  it("returns 0 when one string is empty", () => {
    expect(bigramSimilarity("", "hello")).toBe(0);
    expect(bigramSimilarity("hello", "")).toBe(0);
  });

  it("returns a value in [0, 1]", () => {
    const sim = bigramSimilarity("extends Node", "extends CharacterBody2D");
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it("is higher for near-identical code than for different code", () => {
    const base = "var speed: float = 200.0\nfunc _ready(): pass";
    const similar = "var speed: float = 200.0\nfunc _ready(): pass # minor";
    const different =
      "func calculate_damage(base: float) -> float: return base";
    const simHigh = bigramSimilarity(
      normaliseCode(base),
      normaliseCode(similar),
    );
    const simLow = bigramSimilarity(
      normaliseCode(base),
      normaliseCode(different),
    );
    expect(simHigh).toBeGreaterThan(simLow);
  });
});

// ---------------------------------------------------------------------------
// checkApiVersion
// ---------------------------------------------------------------------------

describe("checkApiVersion", () => {
  it("returns null when api_check is null", () => {
    const task = /** @type {any} */ ({ api_check: null });
    expect(checkApiVersion(task, "some code")).toBeNull();
  });

  it("returns false when removed API is used in code", () => {
    const task = /** @type {any} */ ({
      api_check: {
        class_name: "Node",
        member: "yield",
        introduced: "3.0",
        removed: "4.0",
        notes: "yield removed in Godot 4",
      },
    });
    expect(checkApiVersion(task, "yield(get_tree(), 'idle_frame')")).toBe(
      false,
    );
  });

  it("returns true when removed API is NOT used in code", () => {
    const task = /** @type {any} */ ({
      api_check: {
        class_name: "Node",
        member: "yield",
        introduced: "3.0",
        removed: "4.0",
        notes: "yield removed in Godot 4",
      },
    });
    expect(checkApiVersion(task, "await get_tree().process_frame")).toBe(true);
  });

  it("returns true when non-removed API is present in code", () => {
    const task = /** @type {any} */ ({
      api_check: {
        class_name: "Signal",
        member: "connect",
        introduced: "4.0",
        removed: null,
        notes: "Godot 4 signal.connect()",
      },
    });
    expect(checkApiVersion(task, "$Timer.timeout.connect(_on_timeout)")).toBe(
      true,
    );
  });

  it("returns false when non-removed API is absent from code", () => {
    const task = /** @type {any} */ ({
      api_check: {
        class_name: "Signal",
        member: "connect",
        introduced: "4.0",
        removed: null,
        notes: "Godot 4 signal.connect()",
      },
    });
    // Code does not contain "connect" at all.
    expect(checkApiVersion(task, "func _ready(): pass")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assembleRubricScore
// ---------------------------------------------------------------------------

describe("assembleRubricScore", () => {
  it("returns 0 when compile fails", () => {
    expect(
      assembleRubricScore({
        compilesClean: false,
        runtimeCheckPassed: null,
        apiVersionCorrect: null,
      }),
    ).toBe(0);
  });

  it("returns 0 when api version check fails", () => {
    expect(
      assembleRubricScore({
        compilesClean: true,
        runtimeCheckPassed: null,
        apiVersionCorrect: false,
      }),
    ).toBe(0);
  });

  it("returns 0 when runtime check explicitly fails", () => {
    expect(
      assembleRubricScore({
        compilesClean: true,
        runtimeCheckPassed: false,
        apiVersionCorrect: null,
      }),
    ).toBe(0);
  });

  it("returns 2 when runtime check passes", () => {
    expect(
      assembleRubricScore({
        compilesClean: true,
        runtimeCheckPassed: true,
        apiVersionCorrect: null,
      }),
    ).toBe(2);
  });

  it("returns 1 when compile passes but no runtime check", () => {
    expect(
      assembleRubricScore({
        compilesClean: true,
        runtimeCheckPassed: null,
        apiVersionCorrect: null,
      }),
    ).toBe(1);
  });

  it("returns 1 when compile passes, api correct, no runtime check", () => {
    expect(
      assembleRubricScore({
        compilesClean: true,
        runtimeCheckPassed: null,
        apiVersionCorrect: true,
      }),
    ).toBe(1);
  });

  it("returns 2 when compile passes, api correct, runtime passes", () => {
    expect(
      assembleRubricScore({
        compilesClean: true,
        runtimeCheckPassed: true,
        apiVersionCorrect: true,
      }),
    ).toBe(2);
  });

  it("treats null compilesClean as non-failing (returns 1 with no runtime check)", () => {
    // compilesClean: null means check not run — should not penalise.
    expect(
      assembleRubricScore({
        compilesClean: null,
        runtimeCheckPassed: null,
        apiVersionCorrect: null,
      }),
    ).toBe(1);
  });
});
