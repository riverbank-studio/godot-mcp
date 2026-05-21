/**
 * CI gate for the chunking quality + correctness benchmark (#32).
 *
 * Validates the tutorial-retrieval query dataset (from issue #42) that the
 * benchmark harness consumes. Runs as part of `npm test` to catch dataset
 * regressions before the full benchmark run.
 *
 * Does NOT call the docs pipeline or make API calls.
 * Full harness execution: `node benchmarks/chunking-quality/run.mjs --dry-run`
 *
 * Harness unit tests live in benchmarks/chunking-quality/src/metrics.test.ts
 * (included via the `benchmarks/**` glob in vitest.config.ts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");

const DATASET_PATH = join(
  REPO_ROOT,
  "benchmarks",
  "datasets",
  "tutorial-retrieval",
  "v1",
  "queries.jsonl",
);

// ---------------------------------------------------------------------------
// Types (mirrored from the harness schema to keep this test self-contained)
// ---------------------------------------------------------------------------

interface AnswerAnchor {
  path: string;
  heading: string;
}

interface QueryRecord {
  id: string;
  query: string;
  answer_anchors: AnswerAnchor[];
  model_answer: string;
  categories: string[];
  godot_version: string;
  split: string;
}

const VALID_CATEGORIES = new Set([
  "conceptual",
  "procedural",
  "api-discovery",
  "troubleshooting",
]);
const VALID_SPLITS = new Set(["train", "held-out"]);

/** Parses the JSONL dataset. Throws on malformed lines. */
function loadDataset(): QueryRecord[] {
  const raw = readFileSync(DATASET_PATH, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line, idx) => {
      try {
        return JSON.parse(line) as QueryRecord;
      } catch (err) {
        throw new Error(`Parse error at line ${idx + 1}: ${String(err)}`, {
          cause: err,
        });
      }
    });
}

// ---------------------------------------------------------------------------
// Dataset tests
// ---------------------------------------------------------------------------

describe("tutorial-retrieval dataset (benchmarks/datasets/tutorial-retrieval/v1/queries.jsonl)", () => {
  it("dataset file exists", () => {
    expect(existsSync(DATASET_PATH)).toBe(true);
  });

  const records = loadDataset();

  it("contains at least 50 queries", () => {
    expect(records.length).toBeGreaterThanOrEqual(50);
  });

  it("has no duplicate IDs", () => {
    const ids = records.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("every record has required non-empty string fields", () => {
    for (const rec of records) {
      expect(rec.id, `id on ${rec.id}`).toBeTruthy();
      expect(rec.query, `query on ${rec.id}`).toBeTruthy();
      expect(rec.model_answer, `model_answer on ${rec.id}`).toBeTruthy();
      expect(rec.godot_version, `godot_version on ${rec.id}`).toBeTruthy();
    }
  });

  it("every record has a valid split value", () => {
    for (const rec of records) {
      expect(
        VALID_SPLITS.has(rec.split),
        `split "${rec.split}" on ${rec.id} must be one of: ${[...VALID_SPLITS].join(", ")}`,
      ).toBe(true);
    }
  });

  it("every record has at least one answer_anchor with non-empty path and heading", () => {
    for (const rec of records) {
      expect(
        Array.isArray(rec.answer_anchors) && rec.answer_anchors.length > 0,
        `${rec.id} must have at least one answer_anchor`,
      ).toBe(true);
      for (const anchor of rec.answer_anchors) {
        expect(anchor.path, `${rec.id} anchor.path`).toBeTruthy();
        expect(anchor.heading, `${rec.id} anchor.heading`).toBeTruthy();
      }
    }
  });

  it("every record has at least one valid category", () => {
    for (const rec of records) {
      expect(
        Array.isArray(rec.categories) && rec.categories.length > 0,
        `${rec.id} must have at least one category`,
      ).toBe(true);
      for (const cat of rec.categories) {
        expect(
          VALID_CATEGORIES.has(cat),
          `unknown category "${cat}" on ${rec.id}`,
        ).toBe(true);
      }
    }
  });

  it("each category has at least 8 queries", () => {
    const counts = new Map<string, number>();
    for (const cat of VALID_CATEGORIES) counts.set(cat, 0);
    for (const rec of records) {
      for (const cat of rec.categories) {
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
    }
    for (const [cat, count] of counts.entries()) {
      expect(
        count,
        `category "${cat}" has only ${count} queries; need ≥ 8`,
      ).toBeGreaterThanOrEqual(8);
    }
  });

  it("at least 5 queries have multiple answer_anchors", () => {
    const multiAnchor = records.filter((r) => r.answer_anchors.length > 1);
    expect(
      multiAnchor.length,
      `only ${multiAnchor.length} queries have multiple anchors; need ≥ 5`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("held-out split contains exactly 10 queries", () => {
    const heldOut = records.filter((r) => r.split === "held-out");
    expect(heldOut.length).toBe(10);
  });
});
