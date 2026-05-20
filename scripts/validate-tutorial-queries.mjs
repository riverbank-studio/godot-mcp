#!/usr/bin/env node
/* eslint-disable no-undef --
   TODO(refactor): `process` is a Node built-in global that this script
   legitimately uses. Suppressed for the same reason as scripts/build.js —
   eslint.config.js does not yet declare a Node languageOptions.globals env.
   Revisit when the eslint config is tightened. */
/**
 * Validates the tutorial-retrieval query dataset at
 * benchmarks/datasets/tutorial-retrieval/v1/queries.jsonl.
 *
 * Acceptance criteria (mirrors issue #42):
 *   - Total query count ≥ 50
 *   - Each of the four categories has ≥ 8 queries
 *   - Each query has at least one answer_anchor
 *   - At least 5 queries have multiple answer_anchors
 *   - Held-out split contains exactly 10 queries
 *   - All required fields present and correctly typed on every record
 *   - No duplicate IDs
 *
 * Exit code 0 = valid. Non-zero = invalid (errors printed to stderr).
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATASET_PATH = path.join(
  __dirname,
  "..",
  "benchmarks",
  "datasets",
  "tutorial-retrieval",
  "v1",
  "queries.jsonl",
);

const VALID_CATEGORIES = new Set([
  "conceptual",
  "procedural",
  "api-discovery",
  "troubleshooting",
]);
const VALID_SPLITS = new Set(["train", "held-out"]);
const MIN_TOTAL = 50;
const MIN_PER_CATEGORY = 8;
const MIN_MULTI_ANCHOR = 5;
const REQUIRED_HELD_OUT = 10;

/** @typedef {{ id: string, query: string, answer_anchors: {path: string, heading: string}[], model_answer: string, categories: string[], godot_version: string, split: string }} QueryRecord */

/**
 * Parses and validates a single query record.
 * @param {unknown} obj Raw parsed JSON object
 * @param {number} lineNum 1-based line number in the JSONL file
 * @returns {string[]} List of validation errors for this record (empty = valid)
 */
function validateRecord(obj, lineNum) {
  const errors = [];
  const prefix = `Line ${lineNum}`;

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [`${prefix}: expected a JSON object`];
  }

  // Required string fields
  for (const field of ["id", "query", "model_answer", "godot_version"]) {
    if (typeof obj[field] !== "string" || obj[field].trim() === "") {
      errors.push(
        `${prefix} (${obj["id"] ?? "?"}): "${field}" must be a non-empty string`,
      );
    }
  }

  // categories
  if (!Array.isArray(obj["categories"]) || obj["categories"].length === 0) {
    errors.push(
      `${prefix} (${obj["id"] ?? "?"}): "categories" must be a non-empty array`,
    );
  } else {
    for (const cat of obj["categories"]) {
      if (!VALID_CATEGORIES.has(cat)) {
        errors.push(
          `${prefix} (${obj["id"] ?? "?"}): unknown category "${cat}"; valid: ${[...VALID_CATEGORIES].join(", ")}`,
        );
      }
    }
  }

  // split
  if (!VALID_SPLITS.has(obj["split"])) {
    errors.push(
      `${prefix} (${obj["id"] ?? "?"}): "split" must be one of ${[...VALID_SPLITS].join(", ")}; got "${obj["split"]}"`,
    );
  }

  // answer_anchors
  if (
    !Array.isArray(obj["answer_anchors"]) ||
    obj["answer_anchors"].length === 0
  ) {
    errors.push(
      `${prefix} (${obj["id"] ?? "?"}): "answer_anchors" must be a non-empty array`,
    );
  } else {
    obj["answer_anchors"].forEach((anchor, i) => {
      if (typeof anchor !== "object" || anchor === null) {
        errors.push(
          `${prefix} (${obj["id"] ?? "?"}): answer_anchors[${i}] must be an object`,
        );
        return;
      }
      if (typeof anchor["path"] !== "string" || anchor["path"].trim() === "") {
        errors.push(
          `${prefix} (${obj["id"] ?? "?"}): answer_anchors[${i}].path must be a non-empty string`,
        );
      }
      if (
        typeof anchor["heading"] !== "string" ||
        anchor["heading"].trim() === ""
      ) {
        errors.push(
          `${prefix} (${obj["id"] ?? "?"}): answer_anchors[${i}].heading must be a non-empty string`,
        );
      }
    });
  }

  return errors;
}

function main() {
  let rawContent;
  try {
    rawContent = readFileSync(DATASET_PATH, "utf8");
  } catch (err) {
    process.stderr.write(
      `ERROR: Could not read dataset file at ${DATASET_PATH}\n  ${err.message}\n`,
    );
    process.exit(1);
  }

  const lines = rawContent.split("\n").filter((l) => l.trim() !== "");
  /** @type {QueryRecord[]} */
  const records = [];
  const allErrors = [];

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      allErrors.push(`Line ${lineNum}: JSON parse error — ${err.message}`);
      return;
    }
    const fieldErrors = validateRecord(obj, lineNum);
    if (fieldErrors.length > 0) {
      allErrors.push(...fieldErrors);
    } else {
      records.push(/** @type {QueryRecord} */ (obj));
    }
  });

  // Duplicate ID check
  const seenIds = new Set();
  for (const rec of records) {
    if (seenIds.has(rec.id)) {
      allErrors.push(`Duplicate id: "${rec.id}"`);
    }
    seenIds.add(rec.id);
  }

  // Count-based assertions
  const totalCount = records.length;
  const heldOut = records.filter((r) => r.split === "held-out");
  const multiAnchor = records.filter((r) => r.answer_anchors.length > 1);

  /** @type {Map<string, number>} */
  const categoryCount = new Map();
  for (const cat of VALID_CATEGORIES) categoryCount.set(cat, 0);
  for (const rec of records) {
    for (const cat of rec.categories) {
      categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
    }
  }

  if (totalCount < MIN_TOTAL) {
    allErrors.push(
      `Total query count is ${totalCount}; required ≥ ${MIN_TOTAL}`,
    );
  }

  for (const [cat, count] of categoryCount.entries()) {
    if (count < MIN_PER_CATEGORY) {
      allErrors.push(
        `Category "${cat}" has ${count} queries; required ≥ ${MIN_PER_CATEGORY}`,
      );
    }
  }

  if (multiAnchor.length < MIN_MULTI_ANCHOR) {
    allErrors.push(
      `Only ${multiAnchor.length} queries have multiple answer_anchors; required ≥ ${MIN_MULTI_ANCHOR}`,
    );
  }

  if (heldOut.length !== REQUIRED_HELD_OUT) {
    allErrors.push(
      `Held-out split has ${heldOut.length} queries; required exactly ${REQUIRED_HELD_OUT}`,
    );
  }

  if (allErrors.length > 0) {
    process.stderr.write("Dataset validation FAILED:\n");
    for (const err of allErrors) {
      process.stderr.write(`  - ${err}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    [
      "Dataset validation PASSED",
      `  Total queries     : ${totalCount} (${records.filter((r) => r.split === "train").length} train + ${heldOut.length} held-out)`,
      `  Multi-anchor      : ${multiAnchor.length}`,
      `  Category counts   : ${[...categoryCount.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`,
    ].join("\n") + "\n",
  );
  process.exit(0);
}

main();
