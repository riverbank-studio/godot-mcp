/**
 * Unit tests for stats.mjs (GDScript E2E benchmark #31).
 *
 * Covers: mean, stdDev, countByKey, tDistCDF, pairedTTest, computeConditionStats.
 */

import { describe, it, expect } from "vitest";
import {
  mean,
  stdDev,
  countByKey,
  tDistCDF,
  pairedTTest,
  computeConditionStats,
} from "./stats.mjs";

// ---------------------------------------------------------------------------
// mean
// ---------------------------------------------------------------------------

describe("mean", () => {
  it("returns 0 for empty array", () => {
    expect(mean([])).toBe(0);
  });

  it("computes simple mean", () => {
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("handles single-element array", () => {
    expect(mean([5])).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// stdDev
// ---------------------------------------------------------------------------

describe("stdDev", () => {
  it("returns 0 for empty or single-element array", () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([42])).toBe(0);
  });

  it("computes correct sample std dev", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9]: population mean=5, sample sd≈2.138
    const sd = stdDev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(sd).toBeCloseTo(2.138, 2);
  });

  it("returns 0 for constant array", () => {
    expect(stdDev([3, 3, 3])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// countByKey
// ---------------------------------------------------------------------------

describe("countByKey", () => {
  it("counts occurrences of numeric keys", () => {
    const result = countByKey([0, 1, 2, 1, 0, 2, 2], [0, 1, 2]);
    expect(result[0]).toBe(2);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(3);
  });

  it("returns zeroes for keys not present", () => {
    const result = countByKey([1, 1], [0, 1, 2]);
    expect(result[0]).toBe(0);
    expect(result[2]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tDistCDF
// ---------------------------------------------------------------------------

describe("tDistCDF", () => {
  it("returns 0.5 at t=0 for any df", () => {
    expect(tDistCDF(0, 10)).toBeCloseTo(0.5, 5);
    expect(tDistCDF(0, 30)).toBeCloseTo(0.5, 5);
  });

  it("approaches 1 for large positive t", () => {
    expect(tDistCDF(10, 10)).toBeGreaterThan(0.999);
  });

  it("approaches 0 for large negative t", () => {
    expect(tDistCDF(-10, 10)).toBeLessThan(0.001);
  });

  it("is symmetric: CDF(-t) = 1 - CDF(t)", () => {
    const cdfPos = tDistCDF(2, 10);
    const cdfNeg = tDistCDF(-2, 10);
    expect(cdfPos + cdfNeg).toBeCloseTo(1, 5);
  });

  it("gives approximately correct p-value for known t=2.228, df=10", () => {
    // t_0.025(10) ≈ 2.228 → two-tailed p ≈ 0.05
    const pApprox = 2 * (1 - tDistCDF(2.228, 10));
    expect(pApprox).toBeCloseTo(0.05, 1);
  });
});

// ---------------------------------------------------------------------------
// pairedTTest
// ---------------------------------------------------------------------------

describe("pairedTTest", () => {
  it("returns null when fewer than 2 pairs", () => {
    expect(pairedTTest([], [])).toBeNull();
    expect(pairedTTest([1], [0])).toBeNull();
  });

  it("throws when arrays have different lengths", () => {
    expect(() => pairedTTest([1, 2], [1])).toThrow();
  });

  it("returns t=0, p=1 when all differences are 0", () => {
    const result = pairedTTest([1, 1, 1], [1, 1, 1]);
    expect(result).not.toBeNull();
    expect(result.tStat).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("returns positive t when mcp_on > mcp_off (constant delta)", () => {
    // Constant positive difference → t = Infinity (zero variance, non-zero mean)
    const result = pairedTTest([2, 2, 2], [0, 0, 0]);
    expect(result).not.toBeNull();
    // tStat should be Infinity (positive), pValue should be 0.
    expect(result.tStat).toBe(Infinity);
    expect(result.pValue).toBe(0);
  });

  it("gives significant result (p < 0.05) for large consistent delta (varied)", () => {
    // 30 tasks with a clear but non-constant positive delta (sd > 0)
    const on = Array(15).fill(2).concat(Array(15).fill(1));
    const off = Array(15).fill(0).concat(Array(15).fill(0));
    const result = pairedTTest(on, off);
    expect(result).not.toBeNull();
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.n).toBe(30);
    expect(result.degreesOfFreedom).toBe(29);
  });

  it("does not give significance for zero delta", () => {
    const scores = [1, 2, 0, 1, 2, 0, 1, 2];
    const result = pairedTTest(scores, scores);
    expect(result).not.toBeNull();
    expect(result.tStat).toBe(0);
    expect(result.pValue).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeConditionStats
// ---------------------------------------------------------------------------

describe("computeConditionStats", () => {
  /** @returns {import('./types.d.ts').TaskResult} */
  function fakeResult(taskId, mcpEnabled, score) {
    return {
      taskId,
      category: "write",
      difficulty: 1,
      godotVersion: "4.3",
      mcpEnabled,
      rubricScore: score,
      programmatic: {
        compilesClean: null,
        runtimeCheckPassed: null,
        apiVersionCorrect: null,
      },
      manualScore: null,
      effectiveScore: score,
      agentOutput: { code: "", mcpEnabled, capturedAt: "" },
    };
  }

  it("computes correct pass rate and mean for all-2 results", () => {
    const results = [
      fakeResult("t1", true, 2),
      fakeResult("t2", true, 2),
      fakeResult("t3", true, 2),
    ];
    const stats = computeConditionStats(results, true);
    expect(stats.meanScore).toBe(2);
    expect(stats.passRate).toBe(1);
    expect(stats.passCount).toBe(3);
    expect(stats.taskCount).toBe(3);
    expect(stats.scoreDistribution[2]).toBe(3);
    expect(stats.scoreDistribution[0]).toBe(0);
  });

  it("computes correct mean for mixed scores", () => {
    const results = [
      fakeResult("t1", false, 0),
      fakeResult("t2", false, 1),
      fakeResult("t3", false, 2),
    ];
    const stats = computeConditionStats(results, false);
    expect(stats.meanScore).toBeCloseTo(1, 5);
    expect(stats.passRate).toBeCloseTo(1 / 3, 5);
  });

  it("handles empty result array", () => {
    const stats = computeConditionStats([], true);
    expect(stats.meanScore).toBe(0);
    expect(stats.passRate).toBe(0);
    expect(stats.taskCount).toBe(0);
  });
});
