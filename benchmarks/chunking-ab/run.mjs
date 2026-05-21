#!/usr/bin/env node
/* eslint-disable no-undef --
   TODO(refactor): `process` and `console` are Node built-in globals this
   script legitimately uses. Suppressed for the same reason as scripts/build.js
   — eslint.config.js does not yet declare a Node languageOptions.globals env.
   Revisit when the eslint config is tightened. */
/**
 * CLI entry point for the chunking-config A/B comparison report (#46).
 *
 * Usage (requires tsx for TypeScript source):
 *   npx tsx benchmarks/chunking-ab/run.mjs [options]
 *
 * Or via npm scripts:
 *   npm run bench:chunking-ab            # live run (requires --db-path)
 *   npm run bench:chunking-ab:dryrun     # verify harness without pipeline
 *
 * Options:
 *   --dry-run                Run without a live pipeline (stubs active).
 *   --no-part-b              Skip Part B answer-correctness evaluation.
 *   --splits <list>          Comma-separated splits: train,held-out. Default: train.
 *   --db-path <path>         Path to the compiled docs SQLite DB (all configs share it).
 *   --answer-model <model>   Part B answer model. Default: claude-sonnet-4-6.
 *   --judge-model <model>    Part B judge model. Default: same as answer-model.
 *   --retrieval-k <n>        Top-K results per query. Default: 5.
 *   --configs <a,b,c>        Comma-separated config IDs to run. Default: all (a,b,c).
 *                            Valid IDs: config-a, config-b, config-c.
 *   --rerender <path>        Re-render an existing JSON report to Markdown (no benchmark run).
 *   --verbose                Print per-query and per-config progress to stderr.
 *
 * Exit codes:
 *   0  — report generated successfully.
 *   1  — recommendation verdict is "insufficient-data" (dry-run or skipped metrics).
 *   2  — harness error (missing dataset, parse failure, etc.).
 *
 * Live execution requires:
 *   - Dep #6 (docs ingestion + chunking fallback) to have merged into main.
 *   - Dep #7 (godot_search_tutorials hybrid retrieval) to have merged.
 *   - ANTHROPIC_API_KEY env var set (for Part B evaluation).
 *   - --db-path pointing to a built docs DB (or GODOT_DOCS_DB_PATH env var).
 *
 * Note: when running live with multiple configs, the docs DB must be rebuilt
 * for each config's chunking parameters before invoking this script. The runner
 * records config metadata but cannot automatically re-index the DB.
 */

import {
  generateReport,
  rerenderReport,
  DEFAULT_CONFIGS,
} from "./src/reporter.js";

// ---------------------------------------------------------------------------
// Argument parsing
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
const rerenderPath = valueOf("--rerender");

const splitsRaw = valueOf("--splits") ?? "train";
const splits = splitsRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const dbPath = valueOf("--db-path") ?? process.env["GODOT_DOCS_DB_PATH"];
const answerModel = valueOf("--answer-model") ?? "claude-sonnet-4-6";
const judgeModel = valueOf("--judge-model") ?? answerModel;
const retrievalK = parseInt(valueOf("--retrieval-k") ?? "5", 10);

// Config filtering
const configIdsRaw = valueOf("--configs");
const requestedIds = configIdsRaw
  ? configIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

const configs = requestedIds
  ? DEFAULT_CONFIGS.filter((c) => requestedIds.includes(c.id))
  : DEFAULT_CONFIGS;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!rerenderPath) {
  if (!dryRun && !dbPath) {
    console.error(
      "Error: --db-path is required for live runs (or set GODOT_DOCS_DB_PATH).\n" +
        "       Use --dry-run to verify the harness without a live pipeline.\n" +
        "\n" +
        "       Note: live runs require deps #6 + #7 to have merged into main.",
    );
    process.exit(2);
  }

  if (configs.length < 2) {
    console.error(
      "Error: at least 2 configs must be selected. Got: " +
        (requestedIds?.join(", ") ?? "none") +
        "\n" +
        "       Valid config IDs: " +
        DEFAULT_CONFIGS.map((c) => c.id).join(", "),
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Re-render path
// ---------------------------------------------------------------------------

if (rerenderPath) {
  try {
    const { report, mdPath } = await rerenderReport(rerenderPath);
    console.log(`Re-rendered report to: ${mdPath}`);
    console.log(`Generated at: ${report.generated_at}`);
    process.exit(0);
  } catch (err) {
    console.error("Re-render error:", err);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

if (verbose) {
  console.error(
    `Running A/B comparison for configs: ${configs.map((c) => c.id).join(", ")}`,
  );
  console.error(`Mode: ${dryRun ? "dry-run" : "live"}`);
  console.error(`Splits: ${splits.join(", ")}`);
}

try {
  const { report, jsonPath, mdPath } = await generateReport({
    configs,
    dryRun,
    noPartB,
    dbPath,
    answerModel,
    judgeModel,
    retrievalK,
    splits,
    onConfigProgress: verbose
      ? (completed, total, configId) => {
          process.stderr.write(
            `  [config ${completed}/${total}] ${configId} complete\n`,
          );
        }
      : undefined,
    onProgress: verbose
      ? (completed, total, queryId) => {
          process.stderr.write(
            `    [query ${completed}/${total}] ${queryId}\n`,
          );
        }
      : undefined,
  });

  console.log(`\nReport written:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log(
    `\nRecommendation: ${report.recommendation.verdict.toUpperCase()}`,
  );
  if (report.recommendation.target_config) {
    console.log(`Target config:  ${report.recommendation.target_config}`);
  }
  console.log(`\n${report.recommendation.text}`);

  if (report.recommendation.tuning_levers.length > 0) {
    console.log("\nTuning levers:");
    for (const lever of report.recommendation.tuning_levers) {
      console.log(`  - ${lever}`);
    }
  }

  const exitCode =
    report.recommendation.verdict === "insufficient-data" ? 1 : 0;
  process.exit(exitCode);
} catch (err) {
  console.error("A/B comparison harness error:", err);
  process.exit(2);
}
