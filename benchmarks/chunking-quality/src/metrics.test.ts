/**
 * Unit tests for chunking-quality benchmark metrics (#32).
 *
 * These tests cover the metric computation layer without touching the live
 * pipeline. They verify that:
 * - coversAnchor implements the bidirectional containment rule correctly.
 * - Recall@1 and Recall@5 are computed correctly.
 * - MRR is computed correctly.
 * - Chunk-length distribution statistics are correct.
 * - Acceptance criteria verdicts are correct.
 */

import { describe, it, expect } from "vitest";
import {
  coversAnchor,
  anyCoverageInTopK,
  reciprocalRank,
  firstHitRank,
  buildPartAQueryResult,
  computePartAMetrics,
  computeChunkLengthStats,
  evaluateAcceptanceCriteria,
} from "./metrics.js";
import type { AnswerAnchor, QueryRecord, RetrievedChunk } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeChunk = (
  page_path: string,
  heading_path: string,
  content = "x",
  token_count = 200,
): RetrievedChunk => ({
  page_path,
  heading_path,
  content,
  token_count,
});

const makeAnchor = (path: string, heading: string): AnswerAnchor => ({
  path,
  heading,
});

const makeRecord = (
  id: string,
  anchors: AnswerAnchor[],
  categories: QueryRecord["categories"] = ["conceptual"],
): QueryRecord => ({
  id,
  query: `Query ${id}`,
  answer_anchors: anchors,
  model_answer: "Answer",
  categories,
  godot_version: "4.5",
  split: "train",
});

// ---------------------------------------------------------------------------
// coversAnchor
// ---------------------------------------------------------------------------

describe("coversAnchor", () => {
  it("returns false when page_path does not match", () => {
    const chunk = makeChunk("tutorials/foo.rst", "Shadow filtering");
    const anchor = makeAnchor("tutorials/bar.rst", "Shadow filtering");
    expect(coversAnchor(chunk, anchor)).toBe(false);
  });

  it("returns true when page_path matches and heading_path equals anchor heading", () => {
    const chunk = makeChunk("tutorials/2d/lights.rst", "Shadow filtering");
    const anchor = makeAnchor("tutorials/2d/lights.rst", "Shadow filtering");
    expect(coversAnchor(chunk, anchor)).toBe(true);
  });

  it("returns true when heading_path contains anchor heading (coarser chunk)", () => {
    // Chunk covers "2D lights / Shadow filtering", anchor is just "Shadow filtering"
    const chunk = makeChunk(
      "tutorials/2d/lights.rst",
      "2D lights / Shadow filtering",
    );
    const anchor = makeAnchor("tutorials/2d/lights.rst", "Shadow filtering");
    expect(coversAnchor(chunk, anchor)).toBe(true);
  });

  it("returns true when anchor heading contains heading_path (finer chunk)", () => {
    // Chunk is "Shadow filtering", anchor is "2D lights / Shadow filtering"
    const chunk = makeChunk("tutorials/2d/lights.rst", "Shadow filtering");
    const anchor = makeAnchor(
      "tutorials/2d/lights.rst",
      "2D lights / Shadow filtering",
    );
    expect(coversAnchor(chunk, anchor)).toBe(true);
  });

  it("is case-insensitive", () => {
    const chunk = makeChunk("tutorials/2d/lights.rst", "shadow filtering");
    const anchor = makeAnchor("tutorials/2d/lights.rst", "Shadow Filtering");
    expect(coversAnchor(chunk, anchor)).toBe(true);
  });

  it("returns false when neither string contains the other", () => {
    const chunk = makeChunk("tutorials/2d/lights.rst", "Adding a Light2D");
    const anchor = makeAnchor("tutorials/2d/lights.rst", "Shadow filtering");
    expect(coversAnchor(chunk, anchor)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// anyCoverageInTopK
// ---------------------------------------------------------------------------

describe("anyCoverageInTopK", () => {
  const anchor = makeAnchor("tutorials/a.rst", "Section B");
  const hitChunk = makeChunk("tutorials/a.rst", "Section B");
  const missChunk = makeChunk("tutorials/a.rst", "Section C");

  it("returns true when a covering chunk is within K", () => {
    const chunks = [missChunk, hitChunk];
    expect(anyCoverageInTopK(chunks, [anchor], 2)).toBe(true);
  });

  it("returns false when covering chunk is beyond K", () => {
    const chunks = [missChunk, hitChunk];
    expect(anyCoverageInTopK(chunks, [anchor], 1)).toBe(false);
  });

  it("returns false when no chunk covers any anchor", () => {
    expect(anyCoverageInTopK([missChunk], [anchor], 5)).toBe(false);
  });

  it("returns true for multi-anchor queries when any anchor is covered", () => {
    const anchor2 = makeAnchor("tutorials/b.rst", "Section X");
    const chunk2 = makeChunk("tutorials/b.rst", "Section X");
    expect(anyCoverageInTopK([chunk2], [anchor, anchor2], 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reciprocalRank
// ---------------------------------------------------------------------------

describe("reciprocalRank", () => {
  const anchor = makeAnchor("tutorials/a.rst", "Section");
  const hitChunk = makeChunk("tutorials/a.rst", "Section");
  const missChunk = makeChunk("tutorials/b.rst", "Other");

  it("returns 1.0 when covering chunk is rank 1", () => {
    expect(reciprocalRank([hitChunk, missChunk], [anchor])).toBe(1);
  });

  it("returns 0.5 when covering chunk is rank 2", () => {
    expect(reciprocalRank([missChunk, hitChunk], [anchor])).toBeCloseTo(0.5);
  });

  it("returns 0 when no covering chunk found in top K", () => {
    expect(reciprocalRank([missChunk, missChunk, missChunk], [anchor], 3)).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// firstHitRank
// ---------------------------------------------------------------------------

describe("firstHitRank", () => {
  const anchor = makeAnchor("tutorials/a.rst", "Section");
  const hitChunk = makeChunk("tutorials/a.rst", "Section");
  const missChunk = makeChunk("tutorials/b.rst", "Other");

  it("returns 0 for rank-1 hit", () => {
    expect(firstHitRank([hitChunk], [anchor])).toBe(0);
  });

  it("returns 1 for rank-2 hit", () => {
    expect(firstHitRank([missChunk, hitChunk], [anchor])).toBe(1);
  });

  it("returns null when no hit in top K", () => {
    expect(firstHitRank([missChunk], [anchor], 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computePartAMetrics
// ---------------------------------------------------------------------------

describe("computePartAMetrics", () => {
  it("computes recall correctly from per-query results", () => {
    const anchor = makeAnchor("tutorials/a.rst", "Section");
    const hitChunk = makeChunk("tutorials/a.rst", "Section");
    const missChunk = makeChunk("tutorials/b.rst", "Other");

    const records = [
      makeRecord("q-001", [anchor]),
      makeRecord("q-002", [anchor]),
    ];
    const r1 = buildPartAQueryResult(records[0], [hitChunk]);
    const r2 = buildPartAQueryResult(records[1], [missChunk]);

    const metrics = computePartAMetrics([r1, r2], records);
    expect(metrics.query_count).toBe(2);
    expect(metrics.recall_at_1).toBeCloseTo(0.5);
    expect(metrics.recall_at_5).toBeCloseTo(0.5);
    expect(metrics.mrr).toBeCloseTo(0.5); // (1/1 + 0) / 2
  });

  it("returns zero metrics for empty results", () => {
    const m = computePartAMetrics([], []);
    expect(m.recall_at_1).toBe(0);
    expect(m.mrr).toBe(0);
  });

  it("computes per-category breakdown", () => {
    const anchor = makeAnchor("tutorials/a.rst", "Section");
    const hitChunk = makeChunk("tutorials/a.rst", "Section");
    const missChunk = makeChunk("tutorials/b.rst", "Other");

    const records = [
      makeRecord("q-001", [anchor], ["conceptual"]),
      makeRecord("q-002", [anchor], ["procedural"]),
    ];
    const r1 = buildPartAQueryResult(records[0], [hitChunk]);
    const r2 = buildPartAQueryResult(records[1], [missChunk]);

    const m = computePartAMetrics([r1, r2], records);
    expect(m.recall_at_5_by_category["conceptual"]).toBeCloseTo(1.0);
    expect(m.recall_at_5_by_category["procedural"]).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// computeChunkLengthStats
// ---------------------------------------------------------------------------

describe("computeChunkLengthStats", () => {
  it("handles empty chunk list", () => {
    const s = computeChunkLengthStats([]);
    expect(s.total_chunks).toBe(0);
    expect(s.mean).toBe(0);
  });

  it("computes basic stats correctly", () => {
    const chunks = [
      makeChunk("a.rst", "h", "x", 100),
      makeChunk("b.rst", "h", "x", 200),
      makeChunk("c.rst", "h", "x", 300),
    ];
    const s = computeChunkLengthStats(chunks);
    expect(s.total_chunks).toBe(3);
    expect(s.mean).toBeCloseTo(200);
    expect(s.median).toBeCloseTo(200);
    expect(s.min).toBe(100);
    expect(s.max).toBe(300);
  });

  it("flags chunks over the hard cap (3000 tokens)", () => {
    const chunks = [
      makeChunk("a.rst", "h", "x", 100),
      makeChunk("b.rst", "h", "x", 3001),
    ];
    const s = computeChunkLengthStats(chunks);
    expect(s.over_hard_cap).toBe(1);
  });

  it("flags chunks below 100 tokens and computes fraction", () => {
    const chunks = [
      makeChunk("a.rst", "h", "x", 50),
      makeChunk("b.rst", "h", "x", 200),
      makeChunk("c.rst", "h", "x", 300),
      makeChunk("d.rst", "h", "x", 400),
    ];
    const s = computeChunkLengthStats(chunks);
    expect(s.under_min_threshold).toBe(1);
    expect(s.under_min_threshold_fraction).toBeCloseTo(0.25);
  });
});

// ---------------------------------------------------------------------------
// evaluateAcceptanceCriteria
// ---------------------------------------------------------------------------

describe("evaluateAcceptanceCriteria", () => {
  const basePartA = {
    query_count: 50,
    recall_at_1: 0.52,
    recall_at_5: 0.82,
    mrr: 0.6,
    recall_at_5_by_category: {},
  };

  const baseChunkLengths = {
    total_chunks: 1000,
    mean: 500,
    median: 480,
    p95: 1200,
    max: 2800,
    min: 110,
    over_hard_cap: 0,
    under_min_threshold: 30,
    under_min_threshold_fraction: 0.03,
  };

  const basePartB = {
    query_count: 50,
    partial_correctness: 0.85,
    full_correctness: 0.72,
    mean_score: 1.5,
    full_correctness_by_category: {},
  };

  it("returns all PASS for metrics above thresholds", () => {
    const c = evaluateAcceptanceCriteria(
      basePartA,
      baseChunkLengths,
      basePartB,
    );
    expect(c.recall_at_5_gte_80pct).toBe(true);
    expect(c.recall_at_1_gte_50pct).toBe(true);
    expect(c.answer_correctness_gte_70pct).toBe(true);
    expect(c.no_chunks_over_hard_cap).toBe(true);
    expect(c.under_min_threshold_lte_5pct).toBe(true);
  });

  it("returns FAIL for recall@5 < 80%", () => {
    const c = evaluateAcceptanceCriteria(
      { ...basePartA, recall_at_5: 0.78 },
      baseChunkLengths,
      basePartB,
    );
    expect(c.recall_at_5_gte_80pct).toBe(false);
  });

  it("returns FAIL when chunks exceed hard cap", () => {
    const c = evaluateAcceptanceCriteria(
      basePartA,
      { ...baseChunkLengths, over_hard_cap: 2 },
      basePartB,
    );
    expect(c.no_chunks_over_hard_cap).toBe(false);
  });

  it("returns SKIPPED for Part B when partB is null", () => {
    const c = evaluateAcceptanceCriteria(basePartA, baseChunkLengths, null);
    expect(c.answer_correctness_gte_70pct).toBe("skipped");
  });

  it("returns SKIPPED for chunk stats when no chunks indexed", () => {
    const emptyChunks = {
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
    const c = evaluateAcceptanceCriteria(basePartA, emptyChunks, null);
    expect(c.no_chunks_over_hard_cap).toBe("skipped");
    expect(c.under_min_threshold_lte_5pct).toBe("skipped");
  });
});
