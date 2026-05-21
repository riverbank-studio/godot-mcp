/**
 * Seeded-RNG 20-chunk sample for manual inspection (issue #32, Benchmark M7).
 *
 * From the issue:
 *   "The 20 chunks are drawn once with a seeded RNG (seed = 'godot-mcp-chunking-2026');
 *    the same indices are inspected on every revision."
 *
 * Rubric for "coherent":
 *   "The chunk, read in isolation, tells a complete-enough sub-topic that an LLM given
 *    only the chunk could answer a tutorial-style question the chunk should cover."
 *
 * This module provides:
 *   - sampleChunksForInspection(): deterministically selects 20 chunks from the full
 *     chunk list using the pinned seed.
 *   - formatInspectionReport(): formats the sample for human review.
 *   - recordInspectionResult(): writes the inspection outcome to the results directory.
 *
 * Two independent reviewers must agree on ≥ 18/20 for the criterion to pass.
 * Disagreements on individual chunks are logged in the inspection result.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { RetrievedChunk } from "./types.js";

/** Pinned seed string from issue #32. */
const INSPECTION_SEED = "godot-mcp-chunking-2026";
const INSPECTION_COUNT = 20;

// ---------------------------------------------------------------------------
// Seeded pseudo-random number generator (Mulberry32)
// ---------------------------------------------------------------------------

/**
 * Converts the seed string to a 32-bit integer via a simple hash.
 * Uses the same djb2-style hash as is conventional for string seeds.
 */
function seedToUint32(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i);
    h |= 0; // force 32-bit int
  }
  return h >>> 0;
}

/**
 * Mulberry32 PRNG. Returns a function that generates uniform floats in [0, 1).
 * This is a well-known, fast, seedable PRNG suitable for benchmark reproducibility.
 */
function makePrng(seed: string): () => number {
  let state = seedToUint32(seed);
  return function () {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher-Yates shuffle using the seeded PRNG.
 * Returns a new array; does not mutate the input.
 */
function seededShuffle<T>(arr: T[], prng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sample selection
// ---------------------------------------------------------------------------

/**
 * Selects INSPECTION_COUNT chunks from the full chunk list using the pinned
 * seed. The same chunks will be selected on every call with the same input
 * ordering, making the inspection set stable across benchmark revisions.
 *
 * @param allChunks - The full list of indexed chunks (from getAllChunks()).
 * @returns The 20-chunk inspection sample, in stable order.
 */
export function sampleChunksForInspection(
  allChunks: RetrievedChunk[],
): RetrievedChunk[] {
  if (allChunks.length === 0) return [];
  const prng = makePrng(INSPECTION_SEED);
  const shuffled = seededShuffle(allChunks, prng);
  return shuffled.slice(0, Math.min(INSPECTION_COUNT, shuffled.length));
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/**
 * Formats the inspection sample as a plain-text report for human reviewers.
 * Each chunk is shown with its page path, heading path, token count, and
 * content, along with the scoring rubric.
 */
export function formatInspectionReport(
  sample: RetrievedChunk[],
  runDate: string,
): string {
  const lines: string[] = [];
  lines.push("=".repeat(70));
  lines.push("Manual Inspection Report — Chunking Quality Benchmark #32");
  lines.push(`Seed: ${INSPECTION_SEED}   Run date: ${runDate}`);
  lines.push("=".repeat(70));
  lines.push("");
  lines.push("Rubric:");
  lines.push(
    "  COHERENT: The chunk, read in isolation, tells a complete-enough sub-topic",
  );
  lines.push(
    "  that an LLM given only the chunk could answer a tutorial-style question",
  );
  lines.push("  the chunk should cover.");
  lines.push("");
  lines.push(
    "Acceptance criterion: 2 independent reviewers agree on ≥ 18/20 coherent.",
  );
  lines.push("");
  lines.push(
    "Instructions: for each chunk, mark COHERENT or INCOHERENT, and optionally",
  );
  lines.push("add a note. Fill in the JSON template at the end and return it.");
  lines.push("");
  lines.push("=".repeat(70));

  for (let i = 0; i < sample.length; i++) {
    const chunk = sample[i];
    lines.push(`\n--- Chunk ${i + 1} of ${sample.length} ---`);
    lines.push(`Page:    ${chunk.page_path}`);
    lines.push(`Heading: ${chunk.heading_path}`);
    if (chunk.token_count !== undefined) {
      lines.push(`Tokens:  ${chunk.token_count}`);
    }
    lines.push("Content:");
    lines.push("-".repeat(40));
    lines.push(chunk.content);
    lines.push("-".repeat(40));
    lines.push(`Verdict: ___________  Note: ___________`);
  }

  lines.push("");
  lines.push("=".repeat(70));
  lines.push("JSON result template (fill in and return):");
  lines.push(
    JSON.stringify(
      {
        reviewer: "<name>",
        run_date: runDate,
        seed: INSPECTION_SEED,
        verdicts: sample.map((_, i) => ({
          chunk_index: i + 1,
          coherent: null,
          note: "",
        })),
      },
      null,
      2,
    ),
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inspection result recording
// ---------------------------------------------------------------------------

export interface InspectionResult {
  reviewer: string;
  run_date: string;
  seed: string;
  verdicts: Array<{
    chunk_index: number;
    coherent: boolean;
    note: string;
  }>;
}

export interface InspectionSummary {
  reviewer_a: string;
  reviewer_b: string;
  run_date: string;
  agreed_coherent: number;
  agreed_incoherent: number;
  disagreements: number;
  agreement_count: number;
  criterion_pass: boolean;
}

/**
 * Reconciles two reviewer results and writes the summary to the results directory.
 *
 * Per issue #32: "Two independent reviewers must agree on ≥ 18/20 for the criterion
 * to pass. Reviewer disagreement on individual chunks is logged."
 */
export async function reconcileInspectionResults(
  a: InspectionResult,
  b: InspectionResult,
  resultsDir?: string,
): Promise<InspectionSummary> {
  let agreed_coherent = 0;
  let agreed_incoherent = 0;
  let disagreements = 0;

  const count = Math.min(a.verdicts.length, b.verdicts.length);
  for (let i = 0; i < count; i++) {
    const va = a.verdicts[i].coherent;
    const vb = b.verdicts[i].coherent;
    if (va === vb) {
      if (va) agreed_coherent++;
      else agreed_incoherent++;
    } else {
      disagreements++;
    }
  }

  const agreement_count = agreed_coherent + agreed_incoherent;
  const criterion_pass = agreed_coherent >= 18;

  const summary: InspectionSummary = {
    reviewer_a: a.reviewer,
    reviewer_b: b.reviewer,
    run_date: a.run_date,
    agreed_coherent,
    agreed_incoherent,
    disagreements,
    agreement_count,
    criterion_pass,
  };

  if (resultsDir) {
    const summaryPath = path.join(
      resultsDir,
      `inspection-summary-${a.run_date}.json`,
    );
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
  }

  return summary;
}
