/**
 * Comparison runner for the chunking-config A/B report (#46).
 *
 * Loops the #32 benchmark harness (benchmarks/chunking-quality/src/runner.ts)
 * over a config matrix and collects per-config results. The caller supplies an
 * array of ChunkingConfig objects; this module runs each config in sequence and
 * returns a ConfigRunResult for each.
 *
 * Live execution is gated on the same deps as #32:
 *   #6  — docs ingestion + chunking fallback chain
 *   #7  — godot_search_tutorials tool
 *
 * In dry-run mode the runner delegates to the #32 dry-run path, so no live
 * pipeline is needed and the harness structure can be fully verified.
 */

import type { RunnerOptions } from "../../chunking-quality/src/runner.js";
import { runBenchmark } from "../../chunking-quality/src/runner.js";
import type { ChunkingConfig, ConfigRunResult } from "./types.js";

// ---------------------------------------------------------------------------
// Comparison runner options
// ---------------------------------------------------------------------------

/** Options for the A/B comparison runner. */
export interface ComparisonRunnerOptions extends Omit<
  RunnerOptions,
  "dryRun" | "dbPath"
> {
  /**
   * Whether to run in dry-run mode (no live pipeline calls).
   * When true all config runs delegate to the #32 dry-run path.
   * Default: false.
   */
  dryRun?: boolean;
  /**
   * Path to the compiled docs SQLite database.
   * Required for live runs. Each config may use the same DB or separate
   * per-config DBs (see dbPathForConfig).
   */
  dbPath?: string;
  /**
   * Optional callback that resolves a per-config DB path.
   *
   * When the ingestion pipeline supports parameterised chunking, each config
   * can produce a separate index at a distinct path. This callback receives
   * the config and should return the path to the DB built for it.
   *
   * If omitted, `dbPath` is used for all configs (suitable when the pipeline
   * is not yet parameterisable — callers are expected to rebuild the DB
   * externally before each run).
   */
  dbPathForConfig?: (config: ChunkingConfig) => string;
  /**
   * Progress callback invoked after each config completes.
   */
  onConfigProgress?: (
    completedConfigs: number,
    totalConfigs: number,
    configId: string,
  ) => void;
}

// ---------------------------------------------------------------------------
// Per-config run
// ---------------------------------------------------------------------------

/**
 * Runs the #32 benchmark harness for a single chunking config.
 *
 * The config metadata is passed through to `runBenchmark` options so that
 * per-config parameters (e.g. token limits) can be forwarded to the pipeline
 * once #6 lands.
 *
 * @internal Exported for unit testing.
 */
export async function runConfigBenchmark(
  config: ChunkingConfig,
  options: ComparisonRunnerOptions,
): Promise<ConfigRunResult> {
  const startMs = Date.now();

  const resolvedDbPath = options.dbPathForConfig
    ? options.dbPathForConfig(config)
    : options.dbPath;

  const benchmarkOptions: RunnerOptions = {
    splits: options.splits,
    dryRun: options.dryRun ?? false,
    noPartB: options.noPartB,
    dbPath: resolvedDbPath,
    answerModel: options.answerModel,
    judgeModel: options.judgeModel,
    retrievalK: options.retrievalK,
    datasetPath: options.datasetPath,
    onProgress: options.onProgress,
  };

  const result = await runBenchmark(benchmarkOptions);
  const run_duration_ms = Date.now() - startMs;

  return { config, result, run_duration_ms };
}

// ---------------------------------------------------------------------------
// Main comparison runner
// ---------------------------------------------------------------------------

/**
 * Runs the #32 harness over each config in the matrix, in sequence.
 *
 * Results are returned in the same order as the input configs array. The
 * first config is treated as the baseline in downstream paired-comparison
 * logic.
 *
 * @param configs - Two or more chunking configs to compare. The first is the
 *   baseline; subsequent ones are challengers.
 * @param options - Runner options forwarded to each individual run.
 * @returns Array of per-config results, one per input config.
 * @throws Error when fewer than 2 configs are provided.
 */
export async function runComparison(
  configs: ChunkingConfig[],
  options: ComparisonRunnerOptions = {},
): Promise<ConfigRunResult[]> {
  if (configs.length < 2) {
    throw new Error(
      `runComparison requires at least 2 configs (got ${configs.length}). ` +
        "Provide a baseline and at least one challenger.",
    );
  }

  const results: ConfigRunResult[] = [];

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const configResult = await runConfigBenchmark(config, options);
    results.push(configResult);
    options.onConfigProgress?.(i + 1, configs.length, config.id);
  }

  return results;
}
