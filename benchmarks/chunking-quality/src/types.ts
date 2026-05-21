/**
 * Type definitions for the chunking quality + correctness benchmark (#32).
 *
 * Parts A (retrieval) and B (answer correctness) share these types.
 * Part C (A/B config comparison) is tracked separately in issue #46.
 */

// ---------------------------------------------------------------------------
// Dataset types (mirrors benchmarks/datasets/tutorial-retrieval/v1 schema)
// ---------------------------------------------------------------------------

/** A single acceptable answer location, expressed as page + heading anchor. */
export interface AnswerAnchor {
  /** RST file path relative to the godot-docs repo root. */
  path: string;
  /** Section heading within that page. */
  heading: string;
}

/** One row from queries.jsonl. */
export interface QueryRecord {
  /** Unique identifier, zero-padded three-digit integer (e.g. "q-001"). */
  id: string;
  /** Verbatim query text. */
  query: string;
  /** One or more acceptable answer locations. */
  answer_anchors: AnswerAnchor[];
  /** Short canonical answer paragraph for Part B scoring. */
  model_answer: string;
  /** Category labels for per-category breakdown. */
  categories: Array<
    "conceptual" | "procedural" | "api-discovery" | "troubleshooting"
  >;
  /** Godot version this query/answer is valid for. */
  godot_version: string;
  /** "train" | "held-out" — held-out queries reserved for final eval. */
  split: "train" | "held-out";
}

// ---------------------------------------------------------------------------
// Retrieval result types (what the docs search pipeline returns)
// ---------------------------------------------------------------------------

/**
 * A single chunk returned by the retrieval pipeline.
 *
 * The harness accepts any object that has these fields; additional fields are
 * ignored. This keeps the harness loosely coupled to the actual DB schema
 * (which lives in src/docs/schema.ts, not yet implemented).
 */
export interface RetrievedChunk {
  /** RST file path relative to godot-docs root (matches AnswerAnchor.path). */
  page_path: string;
  /**
   * Slash-joined heading path from root to the section, e.g.
   * "Using lights / 2D lights / Shadow filtering".
   * The heading path covers the chunk when it *contains* or *is contained by*
   * the anchor heading (see `coversAnchor` in metrics.ts).
   */
  heading_path: string;
  /** Raw chunk text. */
  content: string;
  /** Approximate token count (used for chunk-length distribution). */
  token_count?: number;
  /** BM25 rank (1-based, lower = higher relevance). */
  bm25_rank?: number;
  /** Dense retrieval rank (1-based). */
  dense_rank?: number;
  /** RRF fusion score (higher = more relevant). */
  rrf_score?: number;
}

// ---------------------------------------------------------------------------
// Per-query result types
// ---------------------------------------------------------------------------

/** Part A retrieval result for one query. */
export interface PartAQueryResult {
  query_id: string;
  query: string;
  answer_anchors: AnswerAnchor[];
  /** Chunks returned by the pipeline, in ranked order (best first). */
  retrieved: RetrievedChunk[];
  /** Whether a covering chunk appears in top-1 results. */
  hit_at_1: boolean;
  /** Whether a covering chunk appears in top-5 results. */
  hit_at_5: boolean;
  /** Reciprocal rank of the first covering chunk (0 if none in top-K). */
  reciprocal_rank: number;
  /** Index (0-based) of first covering chunk, or null if none found in top-K. */
  first_hit_rank: number | null;
}

/** Part B answer-correctness result for one query. */
export interface PartBQueryResult {
  query_id: string;
  query: string;
  /** Top-K chunks fed to the model. */
  context_chunks: RetrievedChunk[];
  /** The model's answer. */
  model_response: string;
  /** The canonical ground-truth answer. */
  ground_truth: string;
  /**
   * Correctness score: 0 | 1 | 2.
   * 0 = wrong/irrelevant, 1 = partially correct, 2 = correct and complete.
   * Scored by a judge model (same model family, recorded in run metadata).
   */
  score: 0 | 1 | 2;
  /** Raw judge model rationale. */
  judge_rationale: string;
}

// ---------------------------------------------------------------------------
// Aggregate metrics
// ---------------------------------------------------------------------------

/** Part A aggregate metrics across all queries. */
export interface PartAAggregateMetrics {
  /** Number of queries evaluated. */
  query_count: number;
  /** Recall@1: fraction of queries where a covering chunk is rank-1. */
  recall_at_1: number;
  /** Recall@5: fraction of queries where a covering chunk appears in top 5. */
  recall_at_5: number;
  /** Mean Reciprocal Rank across all queries. */
  mrr: number;
  /** Per-category breakdown of Recall@5. */
  recall_at_5_by_category: Record<string, number>;
}

/** Chunk-length distribution statistics. */
export interface ChunkLengthStats {
  /** Total chunks in the index. */
  total_chunks: number;
  /** Mean token count. */
  mean: number;
  /** Median token count. */
  median: number;
  /** 95th-percentile token count. */
  p95: number;
  /** Maximum token count. */
  max: number;
  /** Minimum token count. */
  min: number;
  /** Number of chunks exceeding the 3000-token hard cap. */
  over_hard_cap: number;
  /** Number of chunks below 100 tokens (over-split signal). */
  under_min_threshold: number;
  /** Fraction of chunks below 100 tokens. */
  under_min_threshold_fraction: number;
}

/** Part B aggregate metrics. */
export interface PartBAggregateMetrics {
  /** Number of queries evaluated. */
  query_count: number;
  /** Fraction of queries scoring ≥ 1 (partially or fully correct). */
  partial_correctness: number;
  /** Fraction of queries scoring 2 (fully correct). */
  full_correctness: number;
  /** Mean score across all queries (0–2 scale). */
  mean_score: number;
  /** Per-category breakdown of full correctness rate. */
  full_correctness_by_category: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Run-level metadata and full result bundle
// ---------------------------------------------------------------------------

/** Configuration captured at benchmark run time. */
export interface RunConfig {
  /** ISO 8601 UTC timestamp when the run started. */
  started_at: string;
  /** ISO 8601 UTC timestamp when the run completed. */
  completed_at: string;
  /** Dataset version used (e.g. "v1"). */
  dataset_version: string;
  /** Which query splits were included. */
  splits_included: Array<"train" | "held-out">;
  /** Total number of queries evaluated. */
  query_count: number;
  /**
   * Whether this is a dry-run (no live pipeline calls).
   * In dry-run mode the retrieval step is skipped and metrics are not meaningful.
   */
  dry_run: boolean;
  /** Model used for Part B answer generation (e.g. "claude-sonnet-4-6"). */
  part_b_model?: string;
  /** Model used as judge for Part B scoring. */
  part_b_judge_model?: string;
  /**
   * Godot docs version the pipeline was indexed against.
   * Populated from the DB meta table when available.
   */
  docs_version?: string;
  /**
   * Embedding model ID used by the pipeline.
   * Populated from the DB meta table when available.
   */
  embedding_model?: string;
}

/** Complete result bundle written to benchmarks/results/chunking-quality/. */
export interface BenchmarkRunResult {
  /** Run metadata. */
  config: RunConfig;
  /** Part A aggregate metrics. */
  part_a: PartAAggregateMetrics;
  /** Chunk-length distribution. */
  chunk_lengths: ChunkLengthStats;
  /** Per-query Part A results. */
  part_a_queries: PartAQueryResult[];
  /**
   * Part B aggregate metrics.
   * null when Part B was skipped (dry-run, or --no-part-b flag).
   */
  part_b: PartBAggregateMetrics | null;
  /**
   * Per-query Part B results.
   * Empty array when Part B was skipped.
   */
  part_b_queries: PartBQueryResult[];
  /**
   * Acceptance criteria verdicts.
   * Populated after all parts complete.
   */
  acceptance: AcceptanceCriteria;
}

/** Pass/fail verdicts for each acceptance criterion from issue #32. */
export interface AcceptanceCriteria {
  /** Recall@5 ≥ 80% (covering chunk in top 5 for ≥ 40/50 queries). */
  recall_at_5_gte_80pct: boolean | "skipped";
  /** Recall@1 ≥ 50% (covering chunk is top result for ≥ 25/50 queries). */
  recall_at_1_gte_50pct: boolean | "skipped";
  /** Answer correctness ≥ 70% on Part B (full_correctness ≥ 0.70). */
  answer_correctness_gte_70pct: boolean | "skipped";
  /** No chunks exceeding the 3000-token hard cap. */
  no_chunks_over_hard_cap: boolean | "skipped";
  /** ≤ 5% of chunks below 100 tokens. */
  under_min_threshold_lte_5pct: boolean | "skipped";
}
