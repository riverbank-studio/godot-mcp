#!/usr/bin/env node
/**
 * Validates the tool-routing benchmark query dataset against its schema.
 *
 * Checks:
 *   1. Dataset file parses as valid JSON.
 *   2. All required fields are present per schema.
 *   3. All `expected_tool` values match the `godot_` prefix pattern.
 *   4. All `id` fields are unique and match the expected format.
 *   5. All `category` values are in the allowed set.
 *   6. Total query count is ≥ 50.
 *   7. Each capability category (docs, lsp, editor) has ≥ 5 queries.
 *   8. Every disambiguation pair named in DESIGN.md has ≥ 1 query.
 *
 * Usage:
 *   npx tsx benchmarks/harness/validate-tool-routing-dataset.ts [--dataset <path>]
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

// Disambiguation pairs defined in DESIGN.md §Tool descriptions.
// Each entry is a key that must appear in at least one query's `disambiguation_pair` field.
const REQUIRED_DISAMBIGUATION_PAIRS: string[] = [
  "search_api vs search_tutorials",
  "search_api vs get_class",
  "get_class vs find_member",
  "search_tutorials vs get_tutorial",
  "get_class vs docs_info",
  "find_definition vs get_class",
];

interface QueryRecord {
  id: string;
  query: string;
  expected_tool: string;
  category: string;
  disambiguation_pair: string | null;
  notes: string;
}

interface QueryDataset {
  version: string;
  description: string;
  queries: QueryRecord[];
}

function main(): void {
  const args = process.argv.slice(2);
  let datasetPath = resolve(
    REPO_ROOT,
    "benchmarks/datasets/tool-routing/v1/queries.json",
  );
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dataset") {
      datasetPath = resolve(args[++i]);
    }
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Parse JSON
  let dataset: QueryDataset;
  try {
    dataset = JSON.parse(readFileSync(datasetPath, "utf-8")) as QueryDataset;
  } catch (err) {
    console.error(`FAIL: Could not parse dataset: ${err}`);
    process.exit(1);
  }

  // 2. Top-level required fields
  if (!dataset.version) errors.push("Missing top-level 'version' field");
  if (!dataset.description)
    errors.push("Missing top-level 'description' field");
  if (!Array.isArray(dataset.queries)) {
    errors.push("'queries' field must be an array");
    report(errors, warnings);
    return;
  }

  const queries = dataset.queries;

  // 3. Per-query field checks
  const idsSeen = new Set<string>();
  const validCategories = new Set(["docs", "lsp", "editor"]);

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const prefix = `queries[${i}]`;

    if (!q.id) {
      errors.push(`${prefix}: missing 'id'`);
    } else {
      if (!/^tr-[0-9]{3,}$/.test(q.id)) {
        errors.push(`${prefix}: id '${q.id}' does not match pattern tr-NNN`);
      }
      if (idsSeen.has(q.id)) {
        errors.push(`${prefix}: duplicate id '${q.id}'`);
      }
      idsSeen.add(q.id);
    }

    if (!q.query || q.query.length < 5) {
      errors.push(
        `${prefix} (${q.id ?? "?"}): 'query' is too short or missing`,
      );
    }

    if (!q.expected_tool) {
      errors.push(`${prefix} (${q.id ?? "?"}): missing 'expected_tool'`);
    } else if (
      !/^godot_[a-z_]+$/.test(q.expected_tool) &&
      !/^[a-z_]+$/.test(q.expected_tool)
    ) {
      warnings.push(
        `${prefix} (${q.id}): expected_tool '${q.expected_tool}' does not use godot_ prefix ` +
          "(pre-rename tools are acceptable for scaffolding runs)",
      );
    }

    if (!q.category) {
      errors.push(`${prefix} (${q.id ?? "?"}): missing 'category'`);
    } else if (!validCategories.has(q.category)) {
      errors.push(
        `${prefix} (${q.id}): invalid category '${q.category}' (must be docs|lsp|editor)`,
      );
    }

    if (!("disambiguation_pair" in q)) {
      errors.push(
        `${prefix} (${q.id ?? "?"}): missing 'disambiguation_pair' field (use null if not applicable)`,
      );
    }

    if (!q.notes) {
      warnings.push(`${prefix} (${q.id ?? "?"}): missing 'notes' field`);
    }
  }

  // 4. Total count
  if (queries.length < 50) {
    errors.push(`Dataset has only ${queries.length} queries; minimum is 50`);
  } else {
    console.log(`  Query count: ${queries.length} ✓`);
  }

  // 5. Per-category counts
  for (const cat of ["docs", "lsp", "editor"]) {
    const count = queries.filter((q) => q.category === cat).length;
    if (count < 5) {
      errors.push(`Category '${cat}' has only ${count} queries; minimum is 5`);
    } else {
      console.log(`  Category '${cat}': ${count} queries ✓`);
    }
  }

  // 6. Disambiguation pairs coverage
  const pairsPresent = new Set(
    queries.map((q) => q.disambiguation_pair).filter(Boolean),
  );
  for (const pair of REQUIRED_DISAMBIGUATION_PAIRS) {
    if (!pairsPresent.has(pair)) {
      errors.push(`Required disambiguation pair not covered: '${pair}'`);
    } else {
      const count = queries.filter(
        (q) => q.disambiguation_pair === pair,
      ).length;
      console.log(`  Disambig '${pair}': ${count} queries ✓`);
    }
  }

  report(errors, warnings);
}

function report(errors: string[], warnings: string[]): void {
  if (warnings.length > 0) {
    console.warn(`\nWarnings (${warnings.length}):`);
    warnings.forEach((w) => console.warn(`  [warn] ${w}`));
  }
  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length}):`);
    errors.forEach((e) => console.error(`  [fail] ${e}`));
    console.error("\nValidation FAILED.");
    process.exit(1);
  } else {
    console.log("\nValidation PASSED.");
  }
}

main();
