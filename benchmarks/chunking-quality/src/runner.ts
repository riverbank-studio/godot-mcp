/**
 * Benchmark runner for chunking quality + correctness (#32).
 *
 * Orchestrates Part A (retrieval) and Part B (answer correctness) across the
 * tutorial-retrieval dataset from issue #42.
 *
 * Usage:
 *   node --experimental-vm-modules benchmarks/chunking-quality/run.mjs [options]
 *
 * Options are parsed by run.mjs (the CLI entry point); this module exposes a
 * programmatic API so it can also be called from tests.
 *
 * Live execution is gated on deps:
 *   #6  — docs ingestion + chunking fallback chain
 *   #7  — godot_search_tutorials tool (hybrid FTS5 + dense retrieval)
 *   #42 — tutorial query dataset (queries.jsonl)
 *
 * In dry-run mode the pipeline adapter stubs return empty results so the
 * harness structure, metric computation, and result writing can all be
 * verified without a live DB.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadQueries, summarizeDataset } from "./dataset.js";
import {
  buildPartAQueryResult,
  computeChunkLengthStats,
  computePartAMetrics,
  computePartBMetrics,
  evaluateAcceptanceCriteria,
} from "./metrics.js";
import {
  getAllChunks,
  getDocsMetadata,
  searchTutorials,
} from "./pipeline-adapter.js";
import { evaluateQuery } from "./part-b-judge.js";
import type {
  BenchmarkRunResult,
  PartAQueryResult,
  PartBQueryResult,
  RunConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Result directory
// ---------------------------------------------------------------------------

/** Resolves the results directory path (benchmarks/results/chunking-quality/). */
function resolveResultsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/ → chunking-quality/ → benchmarks/ → repo root
  const repoRoot = path.resolve(path.dirname(thisFile), "..", "..", "..");
  return path.join(repoRoot, "benchmarks", "results", "chunking-quality");
}

/** Writes the run result JSON to the results directory. */
async function writeResult(result: BenchmarkRunResult): Promise<string> {
  const dir = resolveResultsDir();
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date(result.config.started_at)
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\..+$/, "");
  const fileName = `${ts}.json`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

export interface RunnerOptions {
  /**
   * Which query splits to include.
   * Default: ["train"] — held-out queries are reserved for final eval.
   */
  splits?: Array<"train" | "held-out">;
  /**
   * In dry-run mode the pipeline adapter stubs are used (they return empty
   * results). Metrics will be 0/skipped. Useful for verifying the harness
   * structure and output schema without a live DB.
   */
  dryRun?: boolean;
  /**
   * Skip Part B (answer correctness) evaluation.
   * Default: false (Part B runs by default when Part A returns results).
   * Set to true in CI to avoid API costs when only retrieval metrics are needed.
   */
  noPartB?: boolean;
  /**
   * Path to the compiled docs SQLite database.
   * Required for live runs (passed to the pipeline adapter).
   */
  dbPath?: string;
  /**
   * Model for Part B answer generation.
   * Default: "claude-sonnet-4-6"
   */
  answerModel?: string;
  /**
   * Model for Part B judge scoring.
   * Default: same as answerModel
   */
  judgeModel?: string;
  /**
   * Top-K results to retrieve per query.
   * Default: 5 (matches Recall@5 acceptance criterion).
   */
  retrievalK?: number;
  /**
   * Dataset path override (for tests).
   */
  datasetPath?: string;
  /**
   * Progress callback invoked after each query completes.
   */
  onProgress?: (completed: number, total: number, queryId: string) => void;
}

// ---------------------------------------------------------------------------
// Main runner function
// ---------------------------------------------------------------------------

/**
 * Runs the chunking quality + correctness benchmark.
 *
 * Returns the full result bundle (also written to disk).
 */
export async function runBenchmark(
  options: RunnerOptions = {},
): Promise<BenchmarkRunResult> {
  const {
    splits = ["train"],
    dryRun = false,
    noPartB = false,
    dbPath,
    answerModel = "claude-sonnet-4-6",
    judgeModel = answerModel,
    retrievalK = 5,
    datasetPath,
    onProgress,
  } = options;

  const startedAt = new Date().toISOString();

  // -- Load dataset --------------------------------------------------------
  const allRecords = await Promise.all(
    splits.map((split) => loadQueries({ split, datasetPath })),
  ).then((arrays) => arrays.flat());

  // Dataset summary is logged for diagnostics; not used in metric computation.
  // Keeping the call to catch dataset loading errors early in the run.
  void summarizeDataset(allRecords);

  // -- Docs metadata -------------------------------------------------------
  const { docs_version, embedding_model } = dryRun
    ? { docs_version: null, embedding_model: null }
    : await getDocsMetadata({ dbPath });

  // -- Part A: retrieval ---------------------------------------------------
  const partAResults: PartAQueryResult[] = [];

  // Chunk-length stats use all chunks from the index (not just retrieved ones)
  const allChunks = dryRun ? [] : await getAllChunks({ dbPath });

  for (let i = 0; i < allRecords.length; i++) {
    const record = allRecords[i];
    const retrieved = dryRun
      ? []
      : await searchTutorials(record.query, { limit: retrievalK, dbPath });

    const queryResult = buildPartAQueryResult(record, retrieved);
    partAResults.push(queryResult);
    onProgress?.(i + 1, allRecords.length, record.id);
  }

  const partAMetrics = computePartAMetrics(partAResults, allRecords);
  const chunkLengthStats = computeChunkLengthStats(allChunks);

  // -- Part B: answer correctness -----------------------------------------
  const partBResults: PartBQueryResult[] = [];

  const runPartB =
    !noPartB && !dryRun && partAResults.some((r) => r.retrieved.length > 0);

  if (runPartB) {
    for (const record of allRecords) {
      const partAResult = partAResults.find((r) => r.query_id === record.id);
      const contextChunks = partAResult?.retrieved ?? [];

      const result = await evaluateQuery(record, contextChunks, {
        answerModel,
        judgeModel,
        contextK: retrievalK,
      });
      partBResults.push(result);
    }
  }

  const partBMetrics =
    partBResults.length > 0
      ? computePartBMetrics(partBResults, allRecords)
      : null;

  // -- Acceptance criteria -------------------------------------------------
  const acceptance = evaluateAcceptanceCriteria(
    partAMetrics,
    chunkLengthStats,
    partBMetrics,
  );

  // -- Assemble result -----------------------------------------------------
  const completedAt = new Date().toISOString();

  const config: RunConfig = {
    started_at: startedAt,
    completed_at: completedAt,
    dataset_version: "v1",
    splits_included: splits,
    query_count: allRecords.length,
    dry_run: dryRun,
    ...(runPartB && {
      part_b_model: answerModel,
      part_b_judge_model: judgeModel,
    }),
    ...(docs_version && { docs_version }),
    ...(embedding_model && { embedding_model }),
  };

  const result: BenchmarkRunResult = {
    config,
    part_a: partAMetrics,
    chunk_lengths: chunkLengthStats,
    part_a_queries: partAResults,
    part_b: partBMetrics,
    part_b_queries: partBResults,
    acceptance,
  };

  await writeResult(result);
  return result;
}

// ---------------------------------------------------------------------------
// Pretty-print summary
// ---------------------------------------------------------------------------

/**
 * Formats a benchmark run result into a human-readable summary for stdout.
 */
export function formatSummary(result: BenchmarkRunResult): string {
  const { config, part_a, chunk_lengths, part_b, acceptance } = result;
  const lines: string[] = [];

  lines.push("=".repeat(60));
  lines.push("Chunking Quality + Correctness Benchmark (#32)");
  lines.push("=".repeat(60));
  lines.push(`Run started:   ${config.started_at}`);
  lines.push(`Run completed: ${config.completed_at}`);
  lines.push(`Dataset:       tutorial-retrieval/${config.dataset_version}`);
  lines.push(`Splits:        ${config.splits_included.join(", ")}`);
  lines.push(`Queries:       ${config.query_count}`);
  if (config.docs_version) lines.push(`Docs version:  ${config.docs_version}`);
  if (config.embedding_model)
    lines.push(`Embedding:     ${config.embedding_model}`);
  if (config.dry_run)
    lines.push("Mode:          DRY RUN (pipeline stubs active)");

  lines.push("");
  lines.push("--- Part A: Retrieval ---");
  lines.push(
    `Recall@1:  ${pct(part_a.recall_at_1)}  (pass ≥ 50%: ${verdict(acceptance.recall_at_1_gte_50pct)})`,
  );
  lines.push(
    `Recall@5:  ${pct(part_a.recall_at_5)}  (pass ≥ 80%: ${verdict(acceptance.recall_at_5_gte_80pct)})`,
  );
  lines.push(`MRR:       ${part_a.mrr.toFixed(4)}`);

  if (Object.keys(part_a.recall_at_5_by_category).length > 0) {
    lines.push("Recall@5 by category:");
    for (const [cat, val] of Object.entries(part_a.recall_at_5_by_category)) {
      lines.push(`  ${cat.padEnd(18)} ${pct(val)}`);
    }
  }

  if (chunk_lengths.total_chunks > 0) {
    lines.push("");
    lines.push("--- Chunk-length distribution ---");
    lines.push(`Total chunks:  ${chunk_lengths.total_chunks}`);
    lines.push(`Mean tokens:   ${chunk_lengths.mean.toFixed(1)}`);
    lines.push(`Median tokens: ${chunk_lengths.median.toFixed(1)}`);
    lines.push(`p95 tokens:    ${chunk_lengths.p95}`);
    lines.push(
      `Max tokens:    ${chunk_lengths.max}  (pass ≤ 3000: ${verdict(acceptance.no_chunks_over_hard_cap)})`,
    );
    lines.push(
      `< 100 tokens:  ${chunk_lengths.under_min_threshold} (${pct(chunk_lengths.under_min_threshold_fraction)})  (pass ≤ 5%: ${verdict(acceptance.under_min_threshold_lte_5pct)})`,
    );
  }

  if (part_b !== null) {
    lines.push("");
    lines.push("--- Part B: Answer Correctness ---");
    lines.push(`Model:               ${config.part_b_model ?? "?"}`);
    lines.push(`Judge model:         ${config.part_b_judge_model ?? "?"}`);
    lines.push(
      `Full correctness:    ${pct(part_b.full_correctness)}  (pass ≥ 70%: ${verdict(acceptance.answer_correctness_gte_70pct)})`,
    );
    lines.push(`Partial correctness: ${pct(part_b.partial_correctness)}`);
    lines.push(`Mean score:          ${part_b.mean_score.toFixed(2)} / 2.0`);
  } else {
    lines.push("");
    lines.push("--- Part B: Skipped ---");
    lines.push(
      config.dry_run
        ? "  (dry run — no live pipeline)"
        : "  (--no-part-b flag or no retrieved results)",
    );
  }

  lines.push("");
  lines.push("--- Acceptance Criteria ---");
  lines.push(
    `Recall@5 ≥ 80%:          ${verdict(acceptance.recall_at_5_gte_80pct)}`,
  );
  lines.push(
    `Recall@1 ≥ 50%:          ${verdict(acceptance.recall_at_1_gte_50pct)}`,
  );
  lines.push(
    `Answer correct ≥ 70%:    ${verdict(acceptance.answer_correctness_gte_70pct)}`,
  );
  lines.push(
    `No chunks > 3000 tokens: ${verdict(acceptance.no_chunks_over_hard_cap)}`,
  );
  lines.push(
    `< 5% chunks < 100 tokens:${verdict(acceptance.under_min_threshold_lte_5pct)}`,
  );

  lines.push("=".repeat(60));
  return lines.join("\n");
}

function pct(val: number): string {
  return `${(val * 100).toFixed(1)}%`;
}

function verdict(v: boolean | "skipped"): string {
  if (v === "skipped") return "SKIPPED";
  return v ? "PASS" : "FAIL";
}
