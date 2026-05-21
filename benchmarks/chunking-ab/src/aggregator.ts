/**
 * Aggregator for the chunking-config A/B comparison report (#46).
 *
 * Consumes an array of ConfigRunResult objects (one per config) and produces:
 *  - A ConfigMetricRow[] for table rendering (flattened metrics per config).
 *  - A PairedComparison[] comparing every challenger vs the baseline.
 *  - A Recommendation summarising which config to ship.
 *
 * All logic here is pure/deterministic so it can be unit-tested without any
 * live pipeline or API dependencies.
 */

import type {
  ChunkingConfig,
  ConfigMetricRow,
  ConfigRunResult,
  MetricComparison,
  PairedComparison,
  Recommendation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Metric row extraction
// ---------------------------------------------------------------------------

/**
 * Flattens a ConfigRunResult into a ConfigMetricRow for table rendering.
 *
 * @internal Exported for unit testing.
 */
export function toMetricRow(run: ConfigRunResult): ConfigMetricRow {
  const { config, result, run_duration_ms } = run;
  const { part_a, chunk_lengths, part_b, config: runConfig } = result;

  return {
    config_id: config.id,
    config_label: config.label,
    query_count: part_a.query_count,
    recall_at_1: part_a.recall_at_1,
    recall_at_5: part_a.recall_at_5,
    mrr: part_a.mrr,
    full_correctness: part_b?.full_correctness ?? null,
    partial_correctness: part_b?.partial_correctness ?? null,
    mean_score: part_b?.mean_score ?? null,
    total_chunks: chunk_lengths.total_chunks,
    mean_tokens: chunk_lengths.mean,
    median_tokens: chunk_lengths.median,
    p95_tokens: chunk_lengths.p95,
    over_hard_cap: chunk_lengths.over_hard_cap,
    under_min_threshold_fraction: chunk_lengths.under_min_threshold_fraction,
    run_duration_ms,
    run_started_at: runConfig.started_at,
  };
}

// ---------------------------------------------------------------------------
// Metric comparison helpers
// ---------------------------------------------------------------------------

/** Threshold below which a numeric delta is treated as "same". */
const RATE_DELTA_THRESHOLD = 0.005; // 0.5 percentage points
const TOKEN_DELTA_THRESHOLD = 5; // 5 tokens

/**
 * Computes a MetricComparison for a rate (0–1) metric where higher is better.
 *
 * @internal Exported for unit testing.
 */
export function compareRate(
  a: number,
  b: number,
  higherIsBetter = true,
): MetricComparison {
  const delta = b - a;
  let direction: MetricComparison["direction"];
  if (Math.abs(delta) < RATE_DELTA_THRESHOLD) {
    direction = "same";
  } else if (higherIsBetter) {
    direction = delta > 0 ? "better" : "worse";
  } else {
    direction = delta < 0 ? "better" : "worse";
  }
  return { a, b, delta, direction };
}

/**
 * Computes a MetricComparison for a count/token metric.
 *
 * @param higherIsBetter - false for "over_hard_cap" (lower is better).
 *
 * @internal Exported for unit testing.
 */
export function compareCount(
  a: number,
  b: number,
  higherIsBetter = false,
): MetricComparison {
  const delta = b - a;
  let direction: MetricComparison["direction"];
  if (Math.abs(delta) < TOKEN_DELTA_THRESHOLD) {
    direction = "same";
  } else if (higherIsBetter) {
    direction = delta > 0 ? "better" : "worse";
  } else {
    direction = delta < 0 ? "better" : "worse";
  }
  return { a, b, delta, direction };
}

/**
 * Produces a MetricComparison with direction "n/a" when one or both sides
 * are null (Part B was skipped for that config).
 *
 * @internal Exported for unit testing.
 */
export function compareNullable(
  a: number | null,
  b: number | null,
  higherIsBetter = true,
): MetricComparison {
  if (a === null || b === null) {
    return {
      a: a ?? "skipped",
      b: b ?? "skipped",
      delta: null,
      direction: "n/a",
    };
  }
  return compareRate(a, b, higherIsBetter);
}

// ---------------------------------------------------------------------------
// Paired comparison builder
// ---------------------------------------------------------------------------

/**
 * Builds a PairedComparison between a baseline and a challenger config run.
 *
 * @internal Exported for unit testing.
 */
export function buildPairedComparison(
  baseline: ConfigRunResult,
  challenger: ConfigRunResult,
): PairedComparison {
  const a = baseline.result;
  const b = challenger.result;

  // Part A comparisons
  const partA = {
    recall_at_1: compareRate(a.part_a.recall_at_1, b.part_a.recall_at_1),
    recall_at_5: compareRate(a.part_a.recall_at_5, b.part_a.recall_at_5),
    mrr: compareRate(a.part_a.mrr, b.part_a.mrr),
    recall_at_5_by_category: buildCategoryComparisons(
      a.part_a.recall_at_5_by_category,
      b.part_a.recall_at_5_by_category,
    ),
  };

  // Chunk-length comparisons
  const chunkLengths = {
    mean_tokens: compareCount(
      a.chunk_lengths.mean,
      b.chunk_lengths.mean,
      false,
    ),
    median_tokens: compareCount(
      a.chunk_lengths.median,
      b.chunk_lengths.median,
      false,
    ),
    p95_tokens: compareCount(a.chunk_lengths.p95, b.chunk_lengths.p95, false),
    over_hard_cap: compareCount(
      a.chunk_lengths.over_hard_cap,
      b.chunk_lengths.over_hard_cap,
      false,
    ),
    under_min_threshold_fraction: compareRate(
      a.chunk_lengths.under_min_threshold_fraction,
      b.chunk_lengths.under_min_threshold_fraction,
      false, // lower fraction is better
    ),
    total_chunks: compareCount(
      a.chunk_lengths.total_chunks,
      b.chunk_lengths.total_chunks,
      false, // fewer chunks at same quality = cheaper index
    ),
  };

  // Part B comparisons
  const partB =
    a.part_b !== null || b.part_b !== null
      ? {
          full_correctness: compareNullable(
            a.part_b?.full_correctness ?? null,
            b.part_b?.full_correctness ?? null,
          ),
          partial_correctness: compareNullable(
            a.part_b?.partial_correctness ?? null,
            b.part_b?.partial_correctness ?? null,
          ),
          mean_score: compareNullable(
            a.part_b?.mean_score ?? null,
            b.part_b?.mean_score ?? null,
          ),
        }
      : null;

  const overall_winner = computeOverallWinner(partA, chunkLengths, partB);
  const summary = buildSummary(
    baseline.config,
    challenger.config,
    partA,
    overall_winner,
  );

  return {
    baseline_id: baseline.config.id,
    challenger_id: challenger.config.id,
    part_a: partA,
    chunk_lengths: chunkLengths,
    part_b: partB,
    overall_winner,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Category comparison builder
// ---------------------------------------------------------------------------

/**
 * Builds per-category Recall@5 comparisons, merging keys from both sides.
 *
 * @internal Exported for unit testing.
 */
export function buildCategoryComparisons(
  aByCategory: Record<string, number>,
  bByCategory: Record<string, number>,
): Record<string, MetricComparison> {
  const allCategories = new Set([
    ...Object.keys(aByCategory),
    ...Object.keys(bByCategory),
  ]);
  const out: Record<string, MetricComparison> = {};
  for (const cat of allCategories) {
    const aVal = aByCategory[cat] ?? 0;
    const bVal = bByCategory[cat] ?? 0;
    out[cat] = compareRate(aVal, bVal);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overall winner logic
// ---------------------------------------------------------------------------

/**
 * Tallies "better"/"worse" directions across the primary metrics and returns
 * a summary winner verdict.
 *
 * Primary metrics: recall@1, recall@5, MRR (and full_correctness if available).
 * Tie-breaking: chunk_lengths metrics give the challenger a small secondary
 * advantage when primary metrics are equal.
 */
function computeOverallWinner(
  partA: PairedComparison["part_a"],
  chunkLengths: PairedComparison["chunk_lengths"],
  partB: PairedComparison["part_b"] | null,
): PairedComparison["overall_winner"] {
  let better = 0;
  let worse = 0;

  const primaryMetrics: MetricComparison[] = [
    partA.recall_at_1,
    partA.recall_at_5,
    partA.mrr,
  ];

  if (partB?.full_correctness && partB.full_correctness.direction !== "n/a") {
    primaryMetrics.push(partB.full_correctness);
  }

  for (const m of primaryMetrics) {
    if (m.direction === "better") better++;
    else if (m.direction === "worse") worse++;
  }

  // Secondary tie-breaker: over_hard_cap and p95_tokens
  const secondaryMetrics: MetricComparison[] = [
    chunkLengths.over_hard_cap,
    chunkLengths.p95_tokens,
  ];
  for (const m of secondaryMetrics) {
    if (m.direction === "better") better += 0.5;
    else if (m.direction === "worse") worse += 0.5;
  }

  if (better === 0 && worse === 0) return "tie";
  if (better > 0 && worse > 0) return "mixed";
  if (better > worse) return "challenger";
  return "baseline";
}

// ---------------------------------------------------------------------------
// Summary sentence builder
// ---------------------------------------------------------------------------

/**
 * Generates a plain-English summary sentence for a paired comparison.
 *
 * @internal Exported for unit testing.
 */
export function buildSummary(
  baseline: ChunkingConfig,
  challenger: ChunkingConfig,
  partA: PairedComparison["part_a"],
  winner: PairedComparison["overall_winner"],
): string {
  const r5Delta = partA.recall_at_5.delta;
  const r5Pct =
    r5Delta !== null ? `${(r5Delta * 100).toFixed(1)}pp` : "unknown";

  switch (winner) {
    case "challenger":
      return (
        `${challenger.label} outperforms ${baseline.label}: ` +
        `Recall@5 Δ=${r5Pct}, MRR Δ=${partA.mrr.delta !== null ? (partA.mrr.delta * 100).toFixed(1) + "pp" : "unknown"}. ` +
        `Recommend switching to ${challenger.id}.`
      );
    case "baseline":
      return (
        `${baseline.label} holds: ${challenger.label} does not improve on baseline ` +
        `(Recall@5 Δ=${r5Pct}). Keep current config.`
      );
    case "mixed":
      return (
        `Mixed results between ${baseline.label} and ${challenger.label}: ` +
        `some metrics improved (Recall@5 Δ=${r5Pct}), others regressed. Investigate further.`
      );
    case "tie":
    default:
      return (
        `No meaningful difference between ${baseline.label} and ${challenger.label} ` +
        `(Recall@5 Δ=${r5Pct}). Configs are equivalent on measured metrics.`
      );
  }
}

// ---------------------------------------------------------------------------
// Recommendation builder
// ---------------------------------------------------------------------------

/**
 * Produces a final Recommendation from all paired comparisons.
 *
 * Decision logic:
 * - If all comparisons have too many "skipped" metrics: insufficient-data.
 * - If one challenger clearly dominates (wins all comparisons): switch-to.
 * - If baseline holds vs all challengers: ship-baseline.
 * - If a challenger wins some but not all comparisons: investigate.
 * - If picture is mixed across challengers: investigate the best one.
 */
export function buildRecommendation(
  comparisons: PairedComparison[],
  configMap: Map<string, ChunkingConfig>,
): Recommendation {
  if (comparisons.length === 0) {
    return {
      verdict: "insufficient-data",
      text: "No paired comparisons available. At least two configs are required.",
      tuning_levers: [],
    };
  }

  // Count skipped metrics across all comparisons to detect insufficient-data
  const skippedFraction = computeSkippedFraction(comparisons);
  if (skippedFraction > 0.7) {
    return {
      verdict: "insufficient-data",
      text:
        "More than 70% of metrics were skipped (dry-run or pipeline stubs active). " +
        "Run a live benchmark to get a meaningful recommendation.",
      tuning_levers: [
        "Ensure deps #6 + #7 are merged and --db-path is provided for live runs.",
      ],
    };
  }

  const challengerWins = comparisons.filter(
    (c) => c.overall_winner === "challenger",
  );
  const baselineWins = comparisons.filter(
    (c) => c.overall_winner === "baseline",
  );

  const tuningLevers = collectTuningLevers(comparisons, configMap);

  if (challengerWins.length === comparisons.length) {
    // All challengers beat baseline — pick the one with the best Recall@5 delta
    const best = challengerWins.reduce((prev, curr) => {
      const prevDelta = prev.part_a.recall_at_5.delta ?? -Infinity;
      const currDelta = curr.part_a.recall_at_5.delta ?? -Infinity;
      return currDelta > prevDelta ? curr : prev;
    });
    const bestConfig = configMap.get(best.challenger_id);
    return {
      verdict: "switch-to",
      target_config: best.challenger_id,
      text:
        `Switch to ${bestConfig?.label ?? best.challenger_id}. ` +
        `It outperforms the baseline on all primary metrics across every comparison run.`,
      tuning_levers: tuningLevers,
    };
  }

  if (baselineWins.length === comparisons.length) {
    return {
      verdict: "ship-baseline",
      text:
        "Ship the baseline config. No challenger improved on all primary metrics. " +
        "The current chunking configuration is the best-measured option.",
      tuning_levers: tuningLevers,
    };
  }

  // Mixed or partial wins — find the best challenger by Recall@5 delta
  const allNonBaselineWinners = comparisons.filter(
    (c) => c.overall_winner !== "baseline",
  );
  if (allNonBaselineWinners.length > 0) {
    const best = allNonBaselineWinners.reduce((prev, curr) => {
      const prevDelta = prev.part_a.recall_at_5.delta ?? -Infinity;
      const currDelta = curr.part_a.recall_at_5.delta ?? -Infinity;
      return currDelta > prevDelta ? curr : prev;
    });
    const bestConfig = configMap.get(best.challenger_id);
    return {
      verdict: "investigate",
      target_config: best.challenger_id,
      text:
        `Investigate ${bestConfig?.label ?? best.challenger_id} further. ` +
        `It shows improvement on some metrics but results are mixed overall. ` +
        `Consider additional runs with tighter config variants before shipping.`,
      tuning_levers: tuningLevers,
    };
  }

  return {
    verdict: "ship-baseline",
    text:
      "Ship the baseline config. Results were mixed but no single challenger " +
      "emerged as a clear improvement.",
    tuning_levers: tuningLevers,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes the fraction of MetricComparison objects across all paired
 * comparisons that have direction "n/a" (i.e. one or both sides were skipped).
 */
function computeSkippedFraction(comparisons: PairedComparison[]): number {
  let total = 0;
  let skipped = 0;

  for (const c of comparisons) {
    const metrics: MetricComparison[] = [
      c.part_a.recall_at_1,
      c.part_a.recall_at_5,
      c.part_a.mrr,
      c.chunk_lengths.mean_tokens,
      c.chunk_lengths.over_hard_cap,
    ];
    if (c.part_b) {
      metrics.push(c.part_b.full_correctness, c.part_b.mean_score);
    }
    for (const m of metrics) {
      total++;
      if (m.direction === "n/a") skipped++;
    }
  }

  return total === 0 ? 1 : skipped / total;
}

/**
 * Collects tuning lever suggestions from the comparison results.
 *
 * Heuristics:
 * - If a challenger has fewer over_hard_cap chunks but worse recall, suggest
 *   increasing hard cap.
 * - If sliding-window config shows higher p95 but better recall, note the
 *   overlap tradeoff.
 * - If under_min_threshold_fraction increased, warn about over-splitting.
 */
function collectTuningLevers(
  comparisons: PairedComparison[],
  configMap: Map<string, ChunkingConfig>,
): string[] {
  const levers: string[] = [];

  for (const c of comparisons) {
    const config = configMap.get(c.challenger_id);
    if (!config) continue;

    // Over-splitting signal
    if (
      c.chunk_lengths.under_min_threshold_fraction.direction === "worse" &&
      c.part_a.recall_at_5.direction !== "better"
    ) {
      levers.push(
        `${config.label}: increased over-splitting fraction without recall gain — ` +
          `consider raising the soft token limit (currently ${config.soft_token_limit}).`,
      );
    }

    // Sliding-window overlap tradeoff
    if (
      config.strategy === "sliding-window" &&
      config.window_overlap_tokens !== undefined &&
      c.chunk_lengths.total_chunks.direction === "worse"
    ) {
      levers.push(
        `${config.label}: sliding-window overlap (${config.window_overlap_tokens} tokens) ` +
          `increases index size — try reducing overlap to ${Math.round(config.window_overlap_tokens / 2)} tokens ` +
          `to balance recall vs storage.`,
      );
    }

    // Hard cap violations
    if (c.chunk_lengths.over_hard_cap.direction === "worse") {
      levers.push(
        `${config.label}: more chunks exceeded the 3000-token hard cap than in baseline — ` +
          `verify the chunking fallback chain is active for this config.`,
      );
    }
  }

  // Dedup
  return [...new Set(levers)];
}

// ---------------------------------------------------------------------------
// Top-level aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregates an array of per-config run results into metric rows, paired
 * comparisons, and a final recommendation.
 *
 * The first config in the array is treated as the baseline.
 *
 * @returns Tuple of [metricRows, pairedComparisons, recommendation].
 */
export function aggregate(configResults: ConfigRunResult[]): {
  metricRows: ConfigMetricRow[];
  pairedComparisons: PairedComparison[];
  recommendation: Recommendation;
} {
  const metricRows = configResults.map(toMetricRow);

  const [baseline, ...challengers] = configResults;
  const pairedComparisons: PairedComparison[] = challengers.map((challenger) =>
    buildPairedComparison(baseline, challenger),
  );

  const configMap = new Map<string, ChunkingConfig>(
    configResults.map((r) => [r.config.id, r.config]),
  );
  const recommendation = buildRecommendation(pairedComparisons, configMap);

  return { metricRows, pairedComparisons, recommendation };
}
