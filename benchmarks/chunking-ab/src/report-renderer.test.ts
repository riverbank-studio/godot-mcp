/**
 * Unit tests for the chunking-config A/B report renderer (#46).
 *
 * Tests verify that renderReport produces well-formed Markdown containing
 * all required structural sections. No snapshot matching is used — the tests
 * check for the presence of key strings to avoid brittleness from formatting changes.
 */

import { describe, it, expect } from "vitest";
import { renderReport } from "./report-renderer.js";
import type { ComparisonReport, ConfigRunResult } from "./types.js";
import type { BenchmarkRunResult } from "../../chunking-quality/src/types.js";
import { aggregate } from "./aggregator.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBenchmarkResult(
  recall_at_5 = 0.8,
  recall_at_1 = 0.5,
  mrr = 0.6,
): BenchmarkRunResult {
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
      recall_at_1,
      recall_at_5,
      mrr,
      recall_at_5_by_category: { conceptual: 0.82, procedural: 0.76 },
    },
    chunk_lengths: {
      total_chunks: 1000,
      mean: 500,
      median: 480,
      p95: 1200,
      max: 2800,
      min: 110,
      over_hard_cap: 0,
      under_min_threshold: 30,
      under_min_threshold_fraction: 0.03,
    },
    part_a_queries: [],
    part_b: null,
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

function makeComparisonReport(dryRun = false): ComparisonReport {
  const configA = {
    id: "config-a",
    label: "Baseline H2/H3",
    strategy: "hierarchical" as const,
    soft_token_limit: 1500,
    hard_token_cap: 3000,
  };
  const configB = {
    id: "config-b",
    label: "Smaller chunks",
    strategy: "hierarchical" as const,
    soft_token_limit: 800,
    hard_token_cap: 1500,
    always_split_h3: true,
  };

  const configResults: ConfigRunResult[] = [
    {
      config: configA,
      result: makeBenchmarkResult(0.8),
      run_duration_ms: 5000,
    },
    {
      config: configB,
      result: makeBenchmarkResult(0.88, 0.56, 0.66),
      run_duration_ms: 6000,
    },
  ];

  const { metricRows, pairedComparisons, recommendation } =
    aggregate(configResults);

  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    dataset_version: "v1",
    splits_included: ["train"],
    dry_run: dryRun,
    configs: [configA, configB],
    metric_rows: metricRows,
    config_results: configResults,
    paired_comparisons: pairedComparisons,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// renderReport — structural checks
// ---------------------------------------------------------------------------

describe("renderReport", () => {
  it("contains a level-1 heading with the ISO date", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toMatch(/^# Chunking-Config A\/B Comparison Report/m);
    expect(md).toContain("2026-01-01");
  });

  it("contains the Configurations section with both config IDs", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toContain("## Configurations");
    expect(md).toContain("`config-a`");
    expect(md).toContain("`config-b`");
  });

  it("contains the Per-Config Metrics section", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toContain("## Per-Config Metrics");
    expect(md).toContain("Recall@1");
    expect(md).toContain("Recall@5");
  });

  it("contains the Paired Comparisons section", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toContain("## Paired Comparisons");
    expect(md).toContain("config-b vs config-a");
  });

  it("contains the Recommendation section with a verdict", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toContain("## Recommendation");
    expect(md).toContain("**Verdict:**");
  });

  it("contains the Limitations and Methodology sections", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toContain("## Limitations");
    expect(md).toContain("## Methodology");
  });

  it("ends with a newline", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toMatch(/\n$/);
  });

  it("includes the dry-run warning when dry_run=true", () => {
    const md = renderReport(makeComparisonReport(true));
    expect(md).toContain("DRY-RUN MODE");
  });

  it("does not include the dry-run warning for live runs", () => {
    const md = renderReport(makeComparisonReport(false));
    expect(md).not.toContain("DRY-RUN MODE");
  });

  it("shows delta values as percentage points for rate metrics", () => {
    const md = renderReport(makeComparisonReport());
    // Recall@5 delta = 0.88 - 0.80 = 0.08 → +8.0pp
    expect(md).toContain("+8.0pp");
  });

  it("includes per-category breakdown in paired comparison", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toContain("conceptual");
    expect(md).toContain("procedural");
  });

  it("includes chunk-length distribution in paired comparison", () => {
    const md = renderReport(makeComparisonReport());
    expect(md).toContain("Chunk-Length Distribution");
    expect(md).toContain("Mean tokens");
    expect(md).toContain("p95 tokens");
  });
});
