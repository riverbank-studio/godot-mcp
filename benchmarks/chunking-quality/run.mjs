#!/usr/bin/env node
/* eslint-disable no-undef --
   TODO(refactor): `process` and `console` are Node built-in globals this
   script legitimately uses. Suppressed for the same reason as scripts/build.js
   — eslint.config.js does not yet declare a Node languageOptions.globals env.
   Revisit when the eslint config is tightened. */
/**
 * CLI entry point for the chunking quality + correctness benchmark (#32).
 *
 * Usage (requires tsx for TypeScript source):
 *   npx tsx benchmarks/chunking-quality/run.mjs [options]
 *
 * Or via npm scripts:
 *   npm run bench:chunking-quality         # live run (requires --db-path)
 *   npm run bench:chunking-quality:dryrun  # verify harness without pipeline
 *
 * Options:
 *   --dry-run           Run without a live pipeline (uses stubs, verifies harness).
 *   --no-part-b         Skip Part B answer-correctness evaluation.
 *   --splits <list>     Comma-separated splits to include: train,held-out
 *                       Default: train
 *   --db-path <path>    Path to the compiled docs SQLite DB file.
 *   --answer-model <m>  Model for Part B answer generation (default: claude-sonnet-4-6).
 *   --judge-model <m>   Model for Part B judge scoring (default: same as answer-model).
 *   --retrieval-k <n>   Top-K results per query (default: 5).
 *   --verbose           Print per-query progress to stderr.
 *
 * Exit codes:
 *   0  — all evaluated acceptance criteria PASS (or were SKIPPED in dry-run).
 *   1  — one or more acceptance criteria FAIL.
 *   2  — harness error (missing dataset, parse failure, etc.).
 *
 * Live execution requires:
 *   - Dep #6 (docs ingestion + chunking fallback) to have merged into main.
 *   - Dep #7 (godot_search_tutorials hybrid retrieval) to have merged.
 *   - Dep #42 (tutorial query dataset) to have merged (provides queries.jsonl).
 *   - ANTHROPIC_API_KEY env var set (for Part B answer generation + judging).
 *   - --db-path pointing to a built docs DB, or GODOT_DOCS_DB_PATH env var.
 */

import { runBenchmark, formatSummary } from "./src/runner.js";

// ---------------------------------------------------------------------------
// Argument parsing (no external deps — keep the harness self-contained)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const valueOf = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
};

const dryRun = flags.has("--dry-run");
const noPartB = flags.has("--no-part-b");
const verbose = flags.has("--verbose");

const splitsRaw = valueOf("--splits") ?? "train";
const splits = splitsRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const dbPath = valueOf("--db-path") ?? process.env["GODOT_DOCS_DB_PATH"];
const answerModel = valueOf("--answer-model") ?? "claude-sonnet-4-6";
const judgeModel = valueOf("--judge-model") ?? answerModel;
const retrievalK = parseInt(valueOf("--retrieval-k") ?? "5", 10);

if (!dryRun && !dbPath) {
  console.error(
    "Error: --db-path is required for live runs (or set GODOT_DOCS_DB_PATH).\n" +
      "       Use --dry-run to verify the harness without a live pipeline.\n" +
      "\n" +
      "       Note: live runs require deps #6 + #7 to have merged into main.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  const result = await runBenchmark({
    splits,
    dryRun,
    noPartB,
    dbPath,
    answerModel,
    judgeModel,
    retrievalK,
    onProgress: verbose
      ? (completed, total, queryId) => {
          process.stderr.write(`  [${completed}/${total}] ${queryId}\n`);
        }
      : undefined,
  });

  console.log(formatSummary(result));

  // Determine exit code from acceptance criteria
  const criteria = Object.values(result.acceptance);
  const anyFail = criteria.some((v) => v === false);
  process.exit(anyFail ? 1 : 0);
} catch (err) {
  console.error("Benchmark harness error:", err);
  process.exit(2);
}
