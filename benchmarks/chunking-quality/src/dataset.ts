/**
 * Dataset loader for the tutorial-retrieval benchmark dataset (#42).
 *
 * Reads benchmarks/datasets/tutorial-retrieval/v1/queries.jsonl and returns
 * a typed array of QueryRecord objects. Supports filtering by split
 * ("train" | "held-out") per the held-out policy in the dataset README.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { QueryRecord } from "./types.js";

/** Default path to the dataset relative to repo root. */
const DATASET_RELATIVE_PATH =
  "benchmarks/datasets/tutorial-retrieval/v1/queries.jsonl";

/**
 * Resolves the absolute path to the dataset file.
 *
 * Uses the repo root (two directories up from benchmarks/chunking-quality/src/)
 * as the base, so this works regardless of where the script is invoked from.
 */
function resolveDatasetPath(override?: string): string {
  if (override) return override;
  const thisFile = fileURLToPath(import.meta.url);
  // __dirname equivalent: benchmarks/chunking-quality/src/
  // Repo root is three levels up: ../../../
  const repoRoot = path.resolve(path.dirname(thisFile), "..", "..", "..");
  return path.join(repoRoot, DATASET_RELATIVE_PATH);
}

/**
 * Loads query records from the JSONL dataset.
 *
 * @param options.split - Filter to only "train" or "held-out" queries.
 *   Omit to include all queries.
 * @param options.datasetPath - Override the default dataset path (for tests).
 * @returns Array of QueryRecord objects in file order.
 */
export async function loadQueries(options?: {
  split?: "train" | "held-out";
  datasetPath?: string;
}): Promise<QueryRecord[]> {
  const filePath = resolveDatasetPath(options?.datasetPath);
  const records: QueryRecord[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue; // skip blank lines

    let record: QueryRecord;
    try {
      record = JSON.parse(trimmed) as QueryRecord;
    } catch (err) {
      throw new Error(
        `Failed to parse JSONL line in ${filePath}: ${trimmed}\n${err}`,
        {
          cause: err,
        },
      );
    }

    if (options?.split !== undefined && record.split !== options.split)
      continue;
    records.push(record);
  }

  return records;
}

/**
 * Returns dataset statistics for logging/reporting.
 */
export function summarizeDataset(records: QueryRecord[]): {
  total: number;
  train: number;
  held_out: number;
  by_category: Record<string, number>;
  multi_anchor: number;
} {
  const train = records.filter((r) => r.split === "train").length;
  const held_out = records.filter((r) => r.split === "held-out").length;
  const multi_anchor = records.filter(
    (r) => r.answer_anchors.length > 1,
  ).length;

  const by_category: Record<string, number> = {};
  for (const record of records) {
    for (const cat of record.categories) {
      by_category[cat] = (by_category[cat] ?? 0) + 1;
    }
  }

  return { total: records.length, train, held_out, by_category, multi_anchor };
}
