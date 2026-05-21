/**
 * Unit tests for the chunking-config A/B aggregator (#46).
 *
 * Tests cover:
 * - toMetricRow: flattening a ConfigRunResult into a ConfigMetricRow.
 * - compareRate / compareCount / compareNullable: metric comparison helpers.
 * - buildCategoryComparisons: per-category merging.
 * - buildPairedComparison: full comparison object construction.
 * - buildRecommendation: recommendation logic for various comparison outcomes.
 * - aggregate: top-level orchestration.
 */

import { describe, it, expect } from "vitest";
import {
  toMetricRow,
  compareRate,
  compareCount,
  compareNullable,
  buildCategoryComparisons,
  buildPairedComparison,
  buildRecommendation,
  buildSummary,
  aggregate,
} from "./aggregator.js";
import type {
  ChunkingConfig,
  ConfigRunResult,
  PairedComparison,
} from "./types.js";
import type { BenchmarkRunResult } from "../../chunking-quality/src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a minimal BenchmarkRunResult with controllable Part A + chunk metrics. */
function makeBenchmarkResult(overrides?: {
  recall_at_1?: number;
  recall_at_5?: number;
  mrr?: number;
  total_chunks?: number;
  mean?: number;
  median?: number;
  p95?: number;
  max?: number;
  min?: number;
  over_hard_cap?: number;
  under_min_threshold?: number;
  under_min_threshold_fraction?: number;
  part_b_full?: number | null;
}): BenchmarkRunResult {
  const o = overrides ?? {};
  return {
    config: {
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
      dataset_version: "v1",
      splits_included: ["train"],
      query_count: 50,
      dry_run: false,
    },
    part_a: {
      query_count: 50,
      recall_at_1: o.recall_at_1 ?? 0.5,
      recall_at_5: o.recall_at_5 ?? 0.8,
      mrr: o.mrr ?? 0.6,
      recall_at_5_by_category: { conceptual: 0.8, procedural: 0.75 },
    },
    chunk_lengths: {
      total_chunks: o.total_chunks ?? 1000,
      mean: o.mean ?? 500,
      median: o.median ?? 480,
      p95: o.p95 ?? 1200,
      max: o.max ?? 2800,
      min: o.min ?? 110,
      over_hard_cap: o.over_hard_cap ?? 0,
      under_min_threshold: o.under_min_threshold ?? 30,
      under_min_threshold_fraction: o.under_min_threshold_fraction ?? 0.03,
    },
    part_a_queries: [],
    part_b:
      o.part_b_full !== null && o.part_b_full !== undefined
        ? {
            query_count: 50,
            partial_correctness: 0.85,
            full_correctness: o.part_b_full,
            mean_score: 1.5,
            full_correctness_by_category: {},
          }
        : null,
    part_b_queries: [],
    acceptance: {
      recall_at_5_gte_80pct: true,
      recall_at_1_gte_50pct: true,
      answer_correctness_gte_70pct: "skipped",
      no_chunks_over_hard_cap: true,
      under_min_threshold_lte_5pct: true,
    },
  };
}

const CONFIG_A: ChunkingConfig = {
  id: "config-a",
  label: "Baseline",
  strategy: "hierarchical",
  soft_token_limit: 1500,
  hard_token_cap: 3000,
};

const CONFIG_B: ChunkingConfig = {
  id: "config-b",
  label: "Smaller chunks",
  strategy: "hierarchical",
  soft_token_limit: 800,
  hard_token_cap: 1500,
  always_split_h3: true,
};

function makeConfigRunResult(
  config: ChunkingConfig,
  overrides?: Parameters<typeof makeBenchmarkResult>[0],
  durationMs = 5000,
): ConfigRunResult {
  return {
    config,
    result: makeBenchmarkResult(overrides),
    run_duration_ms: durationMs,
  };
}

// ---------------------------------------------------------------------------
// toMetricRow
// ---------------------------------------------------------------------------

describe("toMetricRow", () => {
  it("extracts Part A and chunk-length metrics correctly", () => {
    const run = makeConfigRunResult(CONFIG_A);
    const row = toMetricRow(run);

    expect(row.config_id).toBe("config-a");
    expect(row.config_label).toBe("Baseline");
    expect(row.recall_at_1).toBeCloseTo(0.5);
    expect(row.recall_at_5).toBeCloseTo(0.8);
    expect(row.mrr).toBeCloseTo(0.6);
    expect(row.total_chunks).toBe(1000);
    expect(row.mean_tokens).toBeCloseTo(500);
    expect(row.p95_tokens).toBe(1200);
    expect(row.over_hard_cap).toBe(0);
    expect(row.run_duration_ms).toBe(5000);
    expect(row.run_started_at).toBe("2026-01-01T00:00:00Z");
  });

  it("sets Part B fields to null when Part B was skipped", () => {
    const run = makeConfigRunResult(CONFIG_A, { part_b_full: null });
    const row = toMetricRow(run);
    expect(row.full_correctness).toBeNull();
    expect(row.partial_correctness).toBeNull();
    expect(row.mean_score).toBeNull();
  });

  it("includes Part B fields when Part B ran", () => {
    const run = makeConfigRunResult(CONFIG_A, { part_b_full: 0.72 });
    const row = toMetricRow(run);
    expect(row.full_correctness).toBeCloseTo(0.72);
  });
});

// ---------------------------------------------------------------------------
// compareRate
// ---------------------------------------------------------------------------

describe("compareRate", () => {
  it("marks delta > threshold as better (higher-is-better)", () => {
    const m = compareRate(0.5, 0.56);
    expect(m.direction).toBe("better");
    expect(m.delta).toBeCloseTo(0.06);
  });

  it("marks delta < threshold as worse", () => {
    const m = compareRate(0.8, 0.74);
    expect(m.direction).toBe("worse");
  });

  it("marks tiny delta as same", () => {
    const m = compareRate(0.8, 0.802);
    expect(m.direction).toBe("same");
  });

  it("inverts direction when higherIsBetter=false", () => {
    const m = compareRate(0.1, 0.06, false);
    expect(m.direction).toBe("better");
  });
});

// ---------------------------------------------------------------------------
// compareCount
// ---------------------------------------------------------------------------

describe("compareCount", () => {
  it("marks lower as better when higherIsBetter=false", () => {
    const m = compareCount(100, 90, false);
    expect(m.direction).toBe("better");
  });

  it("marks same within threshold", () => {
    const m = compareCount(1000, 1003, false);
    expect(m.direction).toBe("same");
  });
});

// ---------------------------------------------------------------------------
// compareNullable
// ---------------------------------------------------------------------------

describe("compareNullable", () => {
  it("returns n/a direction when either side is null", () => {
    const m = compareNullable(null, 0.8);
    expect(m.direction).toBe("n/a");
    expect(m.delta).toBeNull();
    expect(m.a).toBe("skipped");
    expect(m.b).toBeCloseTo(0.8);
  });

  it("delegates to compareRate when both are non-null", () => {
    const m = compareNullable(0.5, 0.6);
    expect(m.direction).toBe("better");
  });
});

// ---------------------------------------------------------------------------
// buildCategoryComparisons
// ---------------------------------------------------------------------------

describe("buildCategoryComparisons", () => {
  it("covers categories present in only one side", () => {
    const result = buildCategoryComparisons(
      { conceptual: 0.8 },
      { conceptual: 0.85, troubleshooting: 0.6 },
    );
    expect(result["conceptual"].direction).toBe("better");
    expect(result["troubleshooting"].a).toBeCloseTo(0); // absent from A → 0
    expect(result["troubleshooting"].b).toBeCloseTo(0.6);
  });
});

// ---------------------------------------------------------------------------
// buildPairedComparison
// ---------------------------------------------------------------------------

describe("buildPairedComparison", () => {
  it("marks challenger as overall winner when all primary metrics improve", () => {
    const baseline = makeConfigRunResult(CONFIG_A, {
      recall_at_1: 0.5,
      recall_at_5: 0.8,
      mrr: 0.6,
    });
    const challenger = makeConfigRunResult(CONFIG_B, {
      recall_at_1: 0.58,
      recall_at_5: 0.88,
      mrr: 0.68,
    });
    const cmp = buildPairedComparison(baseline, challenger);
    expect(cmp.overall_winner).toBe("challenger");
    expect(cmp.baseline_id).toBe("config-a");
    expect(cmp.challenger_id).toBe("config-b");
  });

  it("marks baseline as winner when challenger regresses on all primary metrics", () => {
    const baseline = makeConfigRunResult(CONFIG_A, {
      recall_at_1: 0.6,
      recall_at_5: 0.85,
      mrr: 0.7,
    });
    const challenger = makeConfigRunResult(CONFIG_B, {
      recall_at_1: 0.4,
      recall_at_5: 0.72,
      mrr: 0.5,
    });
    const cmp = buildPairedComparison(baseline, challenger);
    expect(cmp.overall_winner).toBe("baseline");
  });

  it("marks tie when deltas are within threshold", () => {
    const baseline = makeConfigRunResult(CONFIG_A, {
      recall_at_1: 0.5,
      recall_at_5: 0.8,
      mrr: 0.6,
    });
    const challenger = makeConfigRunResult(CONFIG_B, {
      recall_at_1: 0.502,
      recall_at_5: 0.802,
      mrr: 0.601,
    });
    const cmp = buildPairedComparison(baseline, challenger);
    expect(cmp.overall_winner).toBe("tie");
  });

  it("marks mixed when some metrics improve and some regress", () => {
    const baseline = makeConfigRunResult(CONFIG_A, {
      recall_at_1: 0.5,
      recall_at_5: 0.8,
      mrr: 0.7,
    });
    const challenger = makeConfigRunResult(CONFIG_B, {
      recall_at_1: 0.58, // better
      recall_at_5: 0.72, // worse
      mrr: 0.65, // worse
    });
    const cmp = buildPairedComparison(baseline, challenger);
    expect(cmp.overall_winner).toBe("mixed");
  });

  it("produces null part_b when both sides skipped Part B", () => {
    const baseline = makeConfigRunResult(CONFIG_A, { part_b_full: null });
    const challenger = makeConfigRunResult(CONFIG_B, { part_b_full: null });
    const cmp = buildPairedComparison(baseline, challenger);
    expect(cmp.part_b).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------

describe("buildSummary", () => {
  const partA: PairedComparison["part_a"] = {
    recall_at_1: { a: 0.5, b: 0.58, delta: 0.08, direction: "better" },
    recall_at_5: { a: 0.8, b: 0.88, delta: 0.08, direction: "better" },
    mrr: { a: 0.6, b: 0.68, delta: 0.08, direction: "better" },
    recall_at_5_by_category: {},
  };

  it("mentions challenger label when challenger wins", () => {
    const summary = buildSummary(CONFIG_A, CONFIG_B, partA, "challenger");
    expect(summary).toContain(CONFIG_B.label);
    expect(summary.toLowerCase()).toContain("outperform");
  });

  it("mentions baseline holding when baseline wins", () => {
    const summary = buildSummary(CONFIG_A, CONFIG_B, partA, "baseline");
    expect(summary.toLowerCase()).toContain("holds");
  });

  it("mentions investigate when mixed", () => {
    const summary = buildSummary(CONFIG_A, CONFIG_B, partA, "mixed");
    expect(summary.toLowerCase()).toContain("investigate");
  });
});

// ---------------------------------------------------------------------------
// buildRecommendation
// ---------------------------------------------------------------------------

describe("buildRecommendation", () => {
  const configMap = new Map<string, ChunkingConfig>([
    ["config-a", CONFIG_A],
    ["config-b", CONFIG_B],
  ]);

  it("returns insufficient-data when comparisons array is empty", () => {
    const rec = buildRecommendation([], configMap);
    expect(rec.verdict).toBe("insufficient-data");
  });

  it("returns ship-baseline when challenger loses", () => {
    const cmp: PairedComparison = buildPairedComparison(
      makeConfigRunResult(CONFIG_A, {
        recall_at_1: 0.6,
        recall_at_5: 0.85,
        mrr: 0.7,
      }),
      makeConfigRunResult(CONFIG_B, {
        recall_at_1: 0.4,
        recall_at_5: 0.72,
        mrr: 0.5,
      }),
    );
    const rec = buildRecommendation([cmp], configMap);
    expect(rec.verdict).toBe("ship-baseline");
  });

  it("returns switch-to when challenger wins", () => {
    const cmp: PairedComparison = buildPairedComparison(
      makeConfigRunResult(CONFIG_A, {
        recall_at_1: 0.5,
        recall_at_5: 0.8,
        mrr: 0.6,
      }),
      makeConfigRunResult(CONFIG_B, {
        recall_at_1: 0.58,
        recall_at_5: 0.88,
        mrr: 0.68,
      }),
    );
    const rec = buildRecommendation([cmp], configMap);
    expect(rec.verdict).toBe("switch-to");
    expect(rec.target_config).toBe("config-b");
  });

  it("returns investigate when result is mixed", () => {
    const cmp: PairedComparison = buildPairedComparison(
      makeConfigRunResult(CONFIG_A, {
        recall_at_1: 0.5,
        recall_at_5: 0.8,
        mrr: 0.7,
      }),
      makeConfigRunResult(CONFIG_B, {
        recall_at_1: 0.58,
        recall_at_5: 0.72,
        mrr: 0.65,
      }),
    );
    const rec = buildRecommendation([cmp], configMap);
    expect(["investigate", "ship-baseline"]).toContain(rec.verdict);
  });
});

// ---------------------------------------------------------------------------
// aggregate (top-level)
// ---------------------------------------------------------------------------

describe("aggregate", () => {
  it("produces metricRows, pairedComparisons, recommendation for 2 configs", () => {
    const results = [
      makeConfigRunResult(CONFIG_A),
      makeConfigRunResult(CONFIG_B, { recall_at_5: 0.88, mrr: 0.68 }),
    ];
    const { metricRows, pairedComparisons, recommendation } =
      aggregate(results);

    expect(metricRows).toHaveLength(2);
    expect(pairedComparisons).toHaveLength(1);
    expect(pairedComparisons[0].baseline_id).toBe("config-a");
    expect(pairedComparisons[0].challenger_id).toBe("config-b");
    expect(recommendation.verdict).toBeDefined();
  });

  it("treats first config as baseline in paired comparisons", () => {
    const CONFIG_C: ChunkingConfig = {
      id: "config-c",
      label: "Config C",
      strategy: "sliding-window",
      soft_token_limit: 1500,
      hard_token_cap: 3000,
      window_overlap_tokens: 200,
    };
    const results = [
      makeConfigRunResult(CONFIG_A),
      makeConfigRunResult(CONFIG_B),
      makeConfigRunResult(CONFIG_C),
    ];
    const { pairedComparisons } = aggregate(results);

    expect(pairedComparisons).toHaveLength(2);
    expect(pairedComparisons[0].baseline_id).toBe("config-a");
    expect(pairedComparisons[1].baseline_id).toBe("config-a");
    expect(pairedComparisons[0].challenger_id).toBe("config-b");
    expect(pairedComparisons[1].challenger_id).toBe("config-c");
  });
});
