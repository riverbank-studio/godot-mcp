/**
 * Type definitions for the chunking-config A/B comparison report (#46).
 *
 * This module extends #32's BenchmarkRunResult with A/B-specific concepts:
 * - ChunkingConfig: describes a single configuration to test.
 * - ConfigRunResult: pairs a config with its benchmark result.
 * - ComparisonReport: the final structured output covering all configs.
 *
 * Live runs are gated on deps #6 + #7 merging (same precondition as #32).
 */

import type {
  BenchmarkRunResult,
  PartAAggregateMetrics,
  PartBAggregateMetrics,
} from "../../chunking-quality/src/types.js";

// ---------------------------------------------------------------------------
// Chunking configuration definitions
// ---------------------------------------------------------------------------

/**
 * Strategy used to split documents into chunks.
 * - "hierarchical": H2 → H3 → paragraph → token-window fallback chain.
 * - "flat": all content split at a single heading level with no fallback.
 * - "sliding-window": fixed-size windows with overlap between adjacent chunks.
 */
export type ChunkingStrategy = "hierarchical" | "flat" | "sliding-window";

/**
 * A single named chunking configuration to test.
 *
 * These values are passed through to the docs ingestion pipeline (#6) when
 * performing a live run. In dry-run mode they are recorded in the report but
 * the pipeline is not invoked.
 */
export interface ChunkingConfig {
  /**
   * Short identifier used in report tables and filenames.
   * Must be unique within a comparison run (e.g. "config-a", "config-b").
   */
  id: string;
  /** Human-readable label (e.g. "Baseline H2/H3, 1500 soft / 3000 hard"). */
  label: string;
  /** Chunking strategy. */
  strategy: ChunkingStrategy;
  /** Soft token limit per chunk (guidance; chunker may exceed for coherence). */
  soft_token_limit: number;
  /** Hard token cap per chunk (enforced by fallback chain). */
  hard_token_cap: number;
  /**
   * Whether H3 sections are always split as separate chunks.
   * Applies to the "hierarchical" strategy only.
   * - true: H3s always produce their own chunks.
   * - false: H3s are merged into the parent H2 chunk unless the H2 exceeds
   *   the soft limit.
   */
  always_split_h3?: boolean;
  /**
   * Token overlap between adjacent windows.
   * Only meaningful for the "sliding-window" strategy; ignored otherwise.
   */
  window_overlap_tokens?: number;
  /**
   * Embedding model override for this config.
   * When set, the pipeline re-indexes with this model instead of the default.
   * Useful for config D (embedding model A/B) from issue #46.
   */
  embedding_model_override?: string;
  /**
   * Free-form notes about this config (appears in the report description column).
   */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Per-config run result
// ---------------------------------------------------------------------------

/**
 * Pairs a chunking config with the benchmark result produced by running the
 * #32 harness under that config.
 */
export interface ConfigRunResult {
  /** The config that was tested. */
  config: ChunkingConfig;
  /** The full benchmark result from the #32 harness. */
  result: BenchmarkRunResult;
  /**
   * Wall-clock milliseconds the benchmark run took for this config.
   * Useful as a proxy for ingestion/re-index cost.
   */
  run_duration_ms: number;
}

// ---------------------------------------------------------------------------
// Paired comparison (one config vs another)
// ---------------------------------------------------------------------------

/**
 * Paired-comparison statistics for two configs on a single metric.
 *
 * For boolean acceptance criteria (pass/fail), delta is 0/±1.
 * For continuous metrics (recall, MRR, mean score), delta = B − A.
 */
export interface MetricComparison {
  /** Value for the "A" (baseline) config. */
  a: number | boolean | "skipped";
  /** Value for the "B" (challenger) config. */
  b: number | boolean | "skipped";
  /**
   * Absolute delta (b − a) for numeric metrics.
   * null when either side is "skipped" or boolean.
   */
  delta: number | null;
  /**
   * Sign of the delta from a retrieval quality standpoint.
   * "better" means B improved on A, "worse" means it regressed, "same" means
   * no meaningful change (|delta| < 0.005 for rates, 0 for counts).
   */
  direction: "better" | "worse" | "same" | "n/a";
}

/**
 * A full set of paired comparisons between one baseline config and one
 * challenger config.
 */
export interface PairedComparison {
  /** ID of the baseline config (the "A" side). */
  baseline_id: string;
  /** ID of the challenger config (the "B" side). */
  challenger_id: string;
  /** Comparisons for Part A retrieval metrics. */
  part_a: {
    recall_at_1: MetricComparison;
    recall_at_5: MetricComparison;
    mrr: MetricComparison;
    /** Per-category Recall@5 comparisons, keyed by category name. */
    recall_at_5_by_category: Record<string, MetricComparison>;
  };
  /** Comparisons for chunk-length distribution metrics. */
  chunk_lengths: {
    mean_tokens: MetricComparison;
    median_tokens: MetricComparison;
    p95_tokens: MetricComparison;
    over_hard_cap: MetricComparison;
    under_min_threshold_fraction: MetricComparison;
    total_chunks: MetricComparison;
  };
  /** Comparisons for Part B answer-correctness metrics. null when Part B was skipped. */
  part_b: {
    full_correctness: MetricComparison;
    partial_correctness: MetricComparison;
    mean_score: MetricComparison;
  } | null;
  /**
   * Summary: which config wins on balance across all evaluated metrics.
   * "baseline" if A is clearly better, "challenger" if B is clearly better,
   * "tie" if no meaningful difference, "mixed" if the picture is split.
   */
  overall_winner: "baseline" | "challenger" | "tie" | "mixed";
  /**
   * Plain-English summary sentence for the report recommendation section
   * (generated by the aggregator from the metric deltas).
   */
  summary: string;
}

// ---------------------------------------------------------------------------
// Full comparison report
// ---------------------------------------------------------------------------

/**
 * Per-config aggregate metrics lifted from the #32 result bundle.
 * Provides a flattened view for table rendering without requiring callers
 * to drill into the nested BenchmarkRunResult structure.
 */
export interface ConfigMetricRow {
  config_id: string;
  config_label: string;
  query_count: number;
  recall_at_1: number;
  recall_at_5: number;
  mrr: number;
  full_correctness: number | null;
  partial_correctness: number | null;
  mean_score: number | null;
  total_chunks: number;
  mean_tokens: number;
  median_tokens: number;
  p95_tokens: number;
  over_hard_cap: number;
  under_min_threshold_fraction: number;
  run_duration_ms: number;
  /**
   * ISO 8601 timestamp of the underlying benchmark run.
   * Used to detect stale results when re-rendering from cached JSON.
   */
  run_started_at: string;
}

/**
 * Recommendation emitted by the aggregator at the end of the report.
 * Follows the issue #46 spec: "ship A", "switch to B", or "investigate C further".
 */
export interface Recommendation {
  /**
   * Short machine-readable verdict.
   * - "ship-baseline": Config A is best; no change needed.
   * - "switch-to": The named config is clearly better than baseline.
   * - "investigate": Results are inconclusive or a non-baseline config is promising
   *   but not dominant enough to recommend switching immediately.
   * - "insufficient-data": Too many skipped metrics to make a call.
   */
  verdict: "ship-baseline" | "switch-to" | "investigate" | "insufficient-data";
  /**
   * Config ID to switch to or investigate (when verdict is "switch-to" or "investigate").
   */
  target_config?: string;
  /** Full recommendation text for the report. */
  text: string;
  /**
   * Tuning levers identified during the comparison (e.g. "reducing overlap
   * in config C from 200 to 100 tokens may reduce index size without hurting
   * recall"). Appears as a bullet list in the report.
   */
  tuning_levers: string[];
}

/**
 * The complete A/B comparison report.
 *
 * Serialised to `benchmarks/reports/chunking-ab-{ISO-date}.json` and rendered
 * to `benchmarks/reports/chunking-ab-{ISO-date}.md`.
 */
export interface ComparisonReport {
  /** ISO 8601 UTC timestamp when the comparison run started. */
  generated_at: string;
  /** Dataset version used across all config runs. */
  dataset_version: string;
  /** Query splits included in all runs. */
  splits_included: Array<"train" | "held-out">;
  /**
   * Whether any run was a dry-run.
   * If true, metrics are not meaningful (pipeline stubs active).
   */
  dry_run: boolean;
  /** All configs that were tested, in the order they were run. */
  configs: ChunkingConfig[];
  /** One row per config for summary table rendering. */
  metric_rows: ConfigMetricRow[];
  /** Full result bundles for every config. */
  config_results: ConfigRunResult[];
  /**
   * Paired comparisons: every challenger vs the baseline (first config).
   * Length = configs.length − 1.
   */
  paired_comparisons: PairedComparison[];
  /** Final recommendation. */
  recommendation: Recommendation;
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type {
  BenchmarkRunResult,
  PartAAggregateMetrics,
  PartBAggregateMetrics,
};
