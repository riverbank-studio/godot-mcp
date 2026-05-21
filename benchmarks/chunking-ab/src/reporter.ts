/**
 * Orchestrator for the chunking-config A/B comparison report (#46).
 *
 * Ties together:
 *   1. comparison-runner — runs the #32 harness over each config.
 *   2. aggregator — builds metric rows, paired comparisons, and recommendation.
 *   3. report-renderer — renders the ComparisonReport to Markdown.
 *
 * This module also handles writing the JSON + Markdown outputs to disk at
 * `benchmarks/reports/chunking-ab-{ISO-date}.{json,md}`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runComparison } from "./comparison-runner.js";
import { aggregate } from "./aggregator.js";
import { renderReport } from "./report-renderer.js";
import type {
  ChunkingConfig,
  ComparisonReport,
  ConfigRunResult,
} from "./types.js";
import type { ComparisonRunnerOptions } from "./comparison-runner.js";

// ---------------------------------------------------------------------------
// Output directory
// ---------------------------------------------------------------------------

/** Resolves the reports output directory (benchmarks/reports/). */
function resolveReportsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/ → chunking-ab/ → benchmarks/ → repo root
  const repoRoot = path.resolve(path.dirname(thisFile), "..", "..", "..");
  return path.join(repoRoot, "benchmarks", "reports");
}

// ---------------------------------------------------------------------------
// File writing
// ---------------------------------------------------------------------------

/**
 * Writes the comparison report as both JSON and Markdown to
 * `benchmarks/reports/chunking-ab-{ISO-date}.{json,md}`.
 *
 * @returns Object containing the paths to both written files.
 */
async function writeReportFiles(report: ComparisonReport): Promise<{
  jsonPath: string;
  mdPath: string;
}> {
  const dir = resolveReportsDir();
  await fs.mkdir(dir, { recursive: true });

  // Use the date portion of generated_at for the filename
  const isoDate = report.generated_at
    .slice(0, 19) // YYYY-MM-DDTHH-MM-SS
    .replace(/:/g, "-");
  const baseName = `chunking-ab-${isoDate}`;

  const jsonPath = path.join(dir, `${baseName}.json`);
  const mdPath = path.join(dir, `${baseName}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(mdPath, renderReport(report), "utf-8");

  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Reporter options
// ---------------------------------------------------------------------------

/** Options for the top-level reporter. */
export interface ReporterOptions extends ComparisonRunnerOptions {
  /**
   * Chunking configs to compare. The first is the baseline.
   * Must contain at least 2 configs.
   */
  configs: ChunkingConfig[];
  /**
   * Progress callback for config-level progress.
   * Arguments: completed count, total count, config ID.
   */
  onConfigProgress?: (
    completedConfigs: number,
    totalConfigs: number,
    configId: string,
  ) => void;
}

// ---------------------------------------------------------------------------
// Main report-generation function
// ---------------------------------------------------------------------------

/**
 * Runs the A/B comparison and produces the report.
 *
 * 1. Runs the #32 harness over each config (or uses stubs in dry-run mode).
 * 2. Aggregates results into metric rows, paired comparisons, recommendation.
 * 3. Writes JSON + Markdown report to `benchmarks/reports/`.
 *
 * @returns The full ComparisonReport, plus the paths to the written files.
 */
export async function generateReport(options: ReporterOptions): Promise<{
  report: ComparisonReport;
  jsonPath: string;
  mdPath: string;
}> {
  const { configs, ...runnerOptions } = options;
  const generatedAt = new Date().toISOString();

  // Run the harness over each config
  const configResults: ConfigRunResult[] = await runComparison(
    configs,
    runnerOptions,
  );

  // Aggregate
  const { metricRows, pairedComparisons, recommendation } =
    aggregate(configResults);

  // Determine splits used (from the first result's run config)
  const splitsIncluded = configResults[0]?.result.config.splits_included ?? [
    "train",
  ];

  const report: ComparisonReport = {
    generated_at: generatedAt,
    dataset_version: configResults[0]?.result.config.dataset_version ?? "v1",
    splits_included: splitsIncluded,
    dry_run: runnerOptions.dryRun ?? false,
    configs,
    metric_rows: metricRows,
    config_results: configResults,
    paired_comparisons: pairedComparisons,
    recommendation,
  };

  // Write output files
  const { jsonPath, mdPath } = await writeReportFiles(report);

  return { report, jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Render-only path (for re-rendering existing JSON without re-running)
// ---------------------------------------------------------------------------

/**
 * Loads an existing comparison report JSON and re-renders the Markdown.
 *
 * Useful for updating the report format without re-running the benchmark.
 */
export async function rerenderReport(jsonPath: string): Promise<{
  report: ComparisonReport;
  mdPath: string;
}> {
  const raw = await fs.readFile(jsonPath, "utf-8");
  const report = JSON.parse(raw) as ComparisonReport;

  // Re-render to the same directory as the JSON
  const dir = path.dirname(jsonPath);
  const baseName = path.basename(jsonPath, ".json");
  const mdPath = path.join(dir, `${baseName}.md`);

  await fs.writeFile(mdPath, renderReport(report), "utf-8");
  return { report, mdPath };
}

// ---------------------------------------------------------------------------
// Predefined config matrix (issue #46 spec)
// ---------------------------------------------------------------------------

/**
 * The predefined config matrix from issue #46.
 *
 * Config A is the baseline (H2/H3 hierarchical, 1500/3000 tokens).
 * Config B is the smaller-chunks challenger (H3 always split, 800/1500 tokens).
 * Config C (optional) is the sliding-window variant.
 *
 * These can be passed directly to `generateReport({ configs: DEFAULT_CONFIGS })`.
 */
export const DEFAULT_CONFIGS: ChunkingConfig[] = [
  {
    id: "config-a",
    label: "Baseline H2/H3, 1500 soft / 3000 hard",
    strategy: "hierarchical",
    soft_token_limit: 1500,
    hard_token_cap: 3000,
    always_split_h3: false,
    notes: "As shipped in v1. H2→H3→paragraph→token-window fallback chain.",
  },
  {
    id: "config-b",
    label: "Smaller chunks, H3 always split, 800 soft / 1500 hard",
    strategy: "hierarchical",
    soft_token_limit: 800,
    hard_token_cap: 1500,
    always_split_h3: true,
    notes: "Challenger: more granular chunks, lower token limits.",
  },
  {
    id: "config-c",
    label: "Sliding-window, 1500 soft / 3000 hard, 200-token overlap",
    strategy: "sliding-window",
    soft_token_limit: 1500,
    hard_token_cap: 3000,
    window_overlap_tokens: 200,
    notes: "Optional: 200-token overlap between adjacent chunks.",
  },
];
