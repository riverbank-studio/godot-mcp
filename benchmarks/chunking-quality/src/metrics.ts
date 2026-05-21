/**
 * Metric computation for the chunking quality + correctness benchmark (#32).
 *
 * Key design decision from the issue (Wave 2 amendment H3):
 * Ground-truth is page + heading anchor, not chunk ID. A chunk "covers" an
 * anchor when its page_path matches AND its heading_path either contains or
 * is contained by the anchor heading. This keeps recall stable across
 * different chunking configurations.
 */

import type {
  AnswerAnchor,
  ChunkLengthStats,
  PartAAggregateMetrics,
  PartAQueryResult,
  PartBAggregateMetrics,
  PartBQueryResult,
  QueryRecord,
  RetrievedChunk,
} from "./types.js";

// ---------------------------------------------------------------------------
// Anchor coverage check
// ---------------------------------------------------------------------------

/**
 * Determines whether a retrieved chunk covers an answer anchor.
 *
 * Coverage rule (from issue #32 Wave 2 amendment H3 / dataset README):
 * - The chunk's page_path must match the anchor's path exactly.
 * - The chunk's heading_path must either *contain* or *be contained by*
 *   the anchor heading (case-insensitive substring check in both directions).
 *
 * The bidirectional containment handles two cases:
 * - Coarser chunk: chunk covers "Shadow filtering" section → heading_path ends
 *   with "Shadow filtering" (containment: anchor ⊆ heading_path).
 * - Finer chunk: anchor is "2D lights / Shadow filtering", chunk's heading_path
 *   is exactly "Shadow filtering" (containment: heading_path ⊆ anchor heading).
 */
export function coversAnchor(
  chunk: RetrievedChunk,
  anchor: AnswerAnchor,
): boolean {
  if (chunk.page_path !== anchor.path) return false;

  const chunkHeading = chunk.heading_path.toLowerCase();
  const anchorHeading = anchor.heading.toLowerCase();

  // heading_path contains the anchor heading, OR anchor heading contains heading_path
  return (
    chunkHeading.includes(anchorHeading) || anchorHeading.includes(chunkHeading)
  );
}

/**
 * Returns true if *any* anchor in the list is covered by *any* chunk in the list.
 */
export function anyCoverageInTopK(
  chunks: RetrievedChunk[],
  anchors: AnswerAnchor[],
  k: number,
): boolean {
  const topK = chunks.slice(0, k);
  return anchors.some((anchor) =>
    topK.some((chunk) => coversAnchor(chunk, anchor)),
  );
}

/**
 * Returns the reciprocal rank of the first covering chunk.
 * Returns 0 if no covering chunk is found within top-K (default K = 10).
 */
export function reciprocalRank(
  chunks: RetrievedChunk[],
  anchors: AnswerAnchor[],
  k: number = 10,
): number {
  const topK = chunks.slice(0, k);
  const idx = topK.findIndex((chunk) =>
    anchors.some((anchor) => coversAnchor(chunk, anchor)),
  );
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/**
 * Returns the 0-based index of the first covering chunk in top-K, or null.
 */
export function firstHitRank(
  chunks: RetrievedChunk[],
  anchors: AnswerAnchor[],
  k: number = 10,
): number | null {
  const topK = chunks.slice(0, k);
  const idx = topK.findIndex((chunk) =>
    anchors.some((anchor) => coversAnchor(chunk, anchor)),
  );
  return idx === -1 ? null : idx;
}

// ---------------------------------------------------------------------------
// Part A per-query result builder
// ---------------------------------------------------------------------------

/**
 * Builds a PartAQueryResult from a query record and its retrieved chunks.
 * K is set per the acceptance criteria in issue #32 (Recall@1 and Recall@5).
 */
export function buildPartAQueryResult(
  record: QueryRecord,
  retrieved: RetrievedChunk[],
): PartAQueryResult {
  return {
    query_id: record.id,
    query: record.query,
    answer_anchors: record.answer_anchors,
    retrieved,
    hit_at_1: anyCoverageInTopK(retrieved, record.answer_anchors, 1),
    hit_at_5: anyCoverageInTopK(retrieved, record.answer_anchors, 5),
    reciprocal_rank: reciprocalRank(retrieved, record.answer_anchors, 10),
    first_hit_rank: firstHitRank(retrieved, record.answer_anchors, 10),
  };
}

// ---------------------------------------------------------------------------
// Part A aggregate metrics
// ---------------------------------------------------------------------------

/**
 * Computes Part A aggregate metrics from per-query results and the original
 * query records (needed for category labels).
 */
export function computePartAMetrics(
  results: PartAQueryResult[],
  records: QueryRecord[],
): PartAAggregateMetrics {
  const n = results.length;
  if (n === 0) {
    return {
      query_count: 0,
      recall_at_1: 0,
      recall_at_5: 0,
      mrr: 0,
      recall_at_5_by_category: {},
    };
  }

  const recall1 = results.filter((r) => r.hit_at_1).length / n;
  const recall5 = results.filter((r) => r.hit_at_5).length / n;
  const mrr = results.reduce((sum, r) => sum + r.reciprocal_rank, 0) / n;

  // Per-category Recall@5
  const categoryMap = new Map<string, QueryRecord>();
  for (const r of records) categoryMap.set(r.id, r);

  const categoryHits = new Map<string, { hits: number; total: number }>();
  for (const result of results) {
    const record = categoryMap.get(result.query_id);
    if (!record) continue;
    for (const cat of record.categories) {
      const entry = categoryHits.get(cat) ?? { hits: 0, total: 0 };
      entry.total++;
      if (result.hit_at_5) entry.hits++;
      categoryHits.set(cat, entry);
    }
  }

  const recall_at_5_by_category: Record<string, number> = {};
  for (const [cat, { hits, total }] of categoryHits) {
    recall_at_5_by_category[cat] = total > 0 ? hits / total : 0;
  }

  return {
    query_count: n,
    recall_at_1: recall1,
    recall_at_5: recall5,
    mrr,
    recall_at_5_by_category,
  };
}

// ---------------------------------------------------------------------------
// Chunk-length distribution
// ---------------------------------------------------------------------------

/**
 * Computes chunk-length distribution statistics from a list of chunks.
 *
 * Acceptance criteria from issue #32:
 * - No chunks exceeding the 3000-token hard cap.
 * - ≤ 5% of chunks below 100 tokens (over-split signal).
 */
export function computeChunkLengthStats(
  chunks: RetrievedChunk[],
): ChunkLengthStats {
  const HARD_CAP = 3000;
  const MIN_THRESHOLD = 100;

  if (chunks.length === 0) {
    return {
      total_chunks: 0,
      mean: 0,
      median: 0,
      p95: 0,
      max: 0,
      min: 0,
      over_hard_cap: 0,
      under_min_threshold: 0,
      under_min_threshold_fraction: 0,
    };
  }

  // token_count falls back to content word-count approximation if not present
  const tokenCounts = chunks.map(
    (c) => c.token_count ?? Math.ceil(c.content.split(/\s+/).length * 1.3),
  );
  const sorted = [...tokenCounts].sort((a, b) => a - b);

  const total = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / total;
  const median =
    total % 2 === 0
      ? (sorted[total / 2 - 1] + sorted[total / 2]) / 2
      : sorted[Math.floor(total / 2)];
  const p95Idx = Math.floor(total * 0.95);
  const p95 = sorted[Math.min(p95Idx, total - 1)];
  const max = sorted[total - 1];
  const min = sorted[0];

  const over_hard_cap = tokenCounts.filter((v) => v > HARD_CAP).length;
  const under_min_threshold = tokenCounts.filter(
    (v) => v < MIN_THRESHOLD,
  ).length;
  const under_min_threshold_fraction = under_min_threshold / total;

  return {
    total_chunks: total,
    mean,
    median,
    p95,
    max,
    min,
    over_hard_cap,
    under_min_threshold,
    under_min_threshold_fraction,
  };
}

// ---------------------------------------------------------------------------
// Part B aggregate metrics
// ---------------------------------------------------------------------------

/**
 * Computes Part B aggregate metrics from per-query results.
 */
export function computePartBMetrics(
  results: PartBQueryResult[],
  records: QueryRecord[],
): PartBAggregateMetrics {
  const n = results.length;
  if (n === 0) {
    return {
      query_count: 0,
      partial_correctness: 0,
      full_correctness: 0,
      mean_score: 0,
      full_correctness_by_category: {},
    };
  }

  const partial = results.filter((r) => r.score >= 1).length / n;
  const full = results.filter((r) => r.score === 2).length / n;
  const meanScore = results.reduce((s, r) => s + r.score, 0) / n;

  // Per-category full correctness
  const categoryMap = new Map<string, QueryRecord>();
  for (const r of records) categoryMap.set(r.id, r);

  const categoryHits = new Map<string, { hits: number; total: number }>();
  for (const result of results) {
    const record = categoryMap.get(result.query_id);
    if (!record) continue;
    for (const cat of record.categories) {
      const entry = categoryHits.get(cat) ?? { hits: 0, total: 0 };
      entry.total++;
      if (result.score === 2) entry.hits++;
      categoryHits.set(cat, entry);
    }
  }

  const full_correctness_by_category: Record<string, number> = {};
  for (const [cat, { hits, total }] of categoryHits) {
    full_correctness_by_category[cat] = total > 0 ? hits / total : 0;
  }

  return {
    query_count: n,
    partial_correctness: partial,
    full_correctness: full,
    mean_score: meanScore,
    full_correctness_by_category,
  };
}

// ---------------------------------------------------------------------------
// Acceptance criteria evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates acceptance criteria from issue #32 against computed metrics.
 *
 * Criteria that depend on Part B or chunk-length stats are marked "skipped"
 * when those parts were not run.
 */
export function evaluateAcceptanceCriteria(
  partA: PartAAggregateMetrics,
  chunkLengths: ChunkLengthStats,
  partB: PartBAggregateMetrics | null,
): {
  recall_at_5_gte_80pct: boolean | "skipped";
  recall_at_1_gte_50pct: boolean | "skipped";
  answer_correctness_gte_70pct: boolean | "skipped";
  no_chunks_over_hard_cap: boolean | "skipped";
  under_min_threshold_lte_5pct: boolean | "skipped";
} {
  const hasChunkStats = chunkLengths.total_chunks > 0;

  return {
    recall_at_5_gte_80pct:
      partA.query_count > 0 ? partA.recall_at_5 >= 0.8 : "skipped",
    recall_at_1_gte_50pct:
      partA.query_count > 0 ? partA.recall_at_1 >= 0.5 : "skipped",
    answer_correctness_gte_70pct:
      partB !== null ? partB.full_correctness >= 0.7 : "skipped",
    no_chunks_over_hard_cap: hasChunkStats
      ? chunkLengths.over_hard_cap === 0
      : "skipped",
    under_min_threshold_lte_5pct: hasChunkStats
      ? chunkLengths.under_min_threshold_fraction <= 0.05
      : "skipped",
  };
}
