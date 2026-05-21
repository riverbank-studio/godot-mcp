#!/usr/bin/env node
/**
 * run-gdscript-bench.mjs — GDScript E2E correctness benchmark runner (issue #31).
 *
 * HEADLINE METRIC: Can an LLM debug/modify/write GDScript tasks correctly when
 * given access to the godot_* MCP tools (MCP-on) vs without them (MCP-off)?
 * Acceptance criterion: MCP-on mean score ≥ MCP-off mean score + 0.3, p < 0.05.
 *
 * Usage:
 *   node benchmarks/harness/run-gdscript-bench.mjs [options]
 *
 *   --dry-run          Skip live agent execution; produce placeholder outputs.
 *   --task <id>        Run only the specified task (repeatable).
 *   --condition <c>    Run only mcp_on or mcp_off (default: both).
 *   --godot <path>     Override Godot executable path.
 *   --model <id>       Model ID to record in results (default: env MODEL_ID or "unknown").
 *   --results-dir <p>  Override results output directory.
 *   --help             Show this help text.
 *
 * Output:
 *   benchmarks/results/gdscript-correctness/<ISO-date>.json
 *
 * Live agent execution (MCP-on / MCP-off) requires the ANTHROPIC_API_KEY env
 * var and depends on issues #7 + #9 being merged. Until those land, use
 * --dry-run to exercise the harness structure.
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreTask, resolveGodotPath } from "./scorer.mjs";
import { pairedTTest, computeConditionStats } from "./stats.mjs";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/** @type {string} */
const DEFAULT_TASKS_DIR = join(
  REPO_ROOT,
  "benchmarks",
  "datasets",
  "gdscript-correctness",
  "v1",
  "tasks",
);

/** @type {string} */
const DEFAULT_RESULTS_DIR = join(
  REPO_ROOT,
  "benchmarks",
  "results",
  "gdscript-correctness",
);

/** Acceptance-criterion delta (DESIGN.md §2). */
const ACCEPTANCE_DELTA = 0.3;
/** Acceptance-criterion p-value threshold. */
const ACCEPTANCE_P_VALUE = 0.05;
/** Minimum paired task count for acceptance criterion (DESIGN.md §2). */
const ACCEPTANCE_MIN_TASKS = 30;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * Parse process.argv into a config object.
 *
 * @returns {import('./types.d.ts').HarnessConfig & { help: boolean }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  /** @type {import('./types.d.ts').HarnessConfig & { help: boolean }} */
  const config = {
    tasksDir: DEFAULT_TASKS_DIR,
    resultsDir: DEFAULT_RESULTS_DIR,
    godotPath: null,
    taskFilter: [],
    conditions: ["mcp_on", "mcp_off"],
    dryRun: false,
    modelId: process.env.MODEL_ID ?? "unknown",
    minPairedTasksForTTest: 2,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--task":
        if (args[i + 1]) config.taskFilter.push(args[++i]);
        break;
      case "--condition":
        if (args[i + 1]) {
          const c = args[++i];
          if (c === "mcp_on" || c === "mcp_off") config.conditions = [c];
          else die(`Unknown condition: ${c}. Must be mcp_on or mcp_off.`);
        }
        break;
      case "--godot":
        if (args[i + 1]) config.godotPath = args[++i];
        break;
      case "--model":
        if (args[i + 1]) config.modelId = args[++i];
        break;
      case "--results-dir":
        if (args[i + 1]) config.resultsDir = args[++i];
        break;
      case "--help":
        config.help = true;
        break;
      default:
        die(`Unknown argument: ${arg}. Run with --help for usage.`);
    }
  }

  return config;
}

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

/** Print help text and exit. */
function printHelp() {
  console.log(`
GDScript E2E correctness benchmark runner (issue #31)

Usage:
  node benchmarks/harness/run-gdscript-bench.mjs [options]

Options:
  --dry-run          Skip live agent execution; produce stub outputs.
  --task <id>        Run only the specified task ID (repeatable).
  --condition <c>    Run only mcp_on or mcp_off (default: both).
  --godot <path>     Override Godot executable path (default: GODOT_PATH env).
  --model <id>       Model ID to record in metadata (default: MODEL_ID env or "unknown").
  --results-dir <p>  Override results output directory.
  --help             Show this help text.

Headline metric:
  MCP-on mean score >= MCP-off mean score + ${ACCEPTANCE_DELTA}, p < ${ACCEPTANCE_P_VALUE}
  (paired t-test across >= ${ACCEPTANCE_MIN_TASKS} tasks)

Live agent execution requires ANTHROPIC_API_KEY and deps #7 + #9 merged.
Use --dry-run to exercise the harness structure without live calls.
`);
}

// ---------------------------------------------------------------------------
// Task loading
// ---------------------------------------------------------------------------

/**
 * Load all task metadata from the tasks directory.
 *
 * @param {string} tasksDir - Absolute path to tasks directory.
 * @param {string[]} filter - If non-empty, only include these task IDs.
 * @returns {{ taskId: string, taskDir: string, task: import('./types.d.ts').TaskJson, solutionCode: string }[]}
 */
function loadTasks(tasksDir, filter) {
  if (!existsSync(tasksDir)) {
    die(
      `Tasks directory not found: ${tasksDir}\n` +
        `The GDScript task set (issue #41) must be checked out first.\n` +
        `Run: git show origin/chore/41-gdscript-task-set:benchmarks/... > ... (or merge #41)`,
    );
  }

  const allTaskIds = readdirSync(tasksDir).filter((name) =>
    statSync(join(tasksDir, name)).isDirectory(),
  );

  const taskIds =
    filter.length > 0
      ? allTaskIds.filter((id) => filter.includes(id))
      : allTaskIds;

  if (taskIds.length === 0) {
    die(
      filter.length > 0
        ? `No tasks matched filter: ${filter.join(", ")}`
        : `No task directories found in: ${tasksDir}`,
    );
  }

  /** @type {ReturnType<typeof loadTasks>} */
  const tasks = [];

  for (const taskId of taskIds) {
    const taskDir = join(tasksDir, taskId);
    const taskJsonPath = join(taskDir, "task.json");
    const solutionPath = join(taskDir, "solutions", "solution-a.gd");

    if (!existsSync(taskJsonPath)) {
      console.warn(`  SKIP [${taskId}]: missing task.json`);
      continue;
    }
    if (!existsSync(solutionPath)) {
      console.warn(`  SKIP [${taskId}]: missing solutions/solution-a.gd`);
      continue;
    }

    let task;
    try {
      task = JSON.parse(readFileSync(taskJsonPath, "utf-8"));
    } catch (e) {
      console.warn(`  SKIP [${taskId}]: task.json parse error — ${e.message}`);
      continue;
    }

    const solutionCode = readFileSync(solutionPath, "utf-8");
    tasks.push({ taskId, taskDir, task, solutionCode });
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Godot version detection
// ---------------------------------------------------------------------------

/**
 * Get the Godot version string.
 *
 * @param {string | null} godotPath
 * @returns {Promise<string>}
 */
async function getGodotVersion(godotPath) {
  if (!godotPath) return "unavailable";
  try {
    const { stdout } = await execFileAsync(godotPath, ["--version"], {
      timeout: 10_000,
    });
    return stdout.trim().split("\n")[0] ?? "unknown";
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

/**
 * Run the agent on a single task in one condition.
 *
 * In --dry-run mode this produces a placeholder output consisting of the
 * ground-truth solution, so the rest of the pipeline (scoring, stats) can
 * be exercised without live API calls.
 *
 * LIVE RUN: Requires ANTHROPIC_API_KEY and issues #7 + #9 merged (the
 * Anthropic SDK and godot_* MCP tools). This stub is intentionally
 * unimplemented; a follow-up PR wires up the real agent once deps land.
 *
 * @param {object} params
 * @param {import('./types.d.ts').TaskJson} params.task
 * @param {string} params.taskDir
 * @param {string} params.solutionCode - Ground truth (used as placeholder in dry-run).
 * @param {boolean} params.mcpEnabled
 * @param {boolean} params.dryRun
 * @param {string} params.modelId
 * @returns {Promise<import('./types.d.ts').AgentOutput>}
 */
async function runAgent(params) {
  const { task, solutionCode, mcpEnabled, dryRun } = params;
  const capturedAt = new Date().toISOString();

  if (dryRun) {
    // Dry-run: use the ground-truth solution as the agent output so scores
    // are maximally optimistic. Useful for smoke-testing the pipeline.
    return {
      code: solutionCode,
      mcpEnabled,
      capturedAt,
      toolCallLog: [],
    };
  }

  // Live run: not yet implemented — depends on #7 (Anthropic SDK integration)
  // and #9 (godot_* tool renaming). Raise a clear error rather than silently
  // returning bad data.
  throw new Error(
    `Live agent execution is not yet implemented (waiting for deps #7 + #9).\n` +
      `Run with --dry-run to exercise the harness without live API calls.\n` +
      `Task: ${task.id}, condition: ${mcpEnabled ? "mcp_on" : "mcp_off"}`,
  );
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

/**
 * Get the current git commit SHA.
 *
 * @returns {Promise<string>}
 */
async function getCommitSha() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

/**
 * Main benchmark runner.
 *
 * @param {import('./types.d.ts').HarnessConfig} config
 * @returns {Promise<import('./types.d.ts').BenchmarkRun>}
 */
async function runBenchmark(config) {
  const runDate = new Date().toISOString();
  const [commitSha, godotVersionStr] = await Promise.all([
    getCommitSha(),
    getGodotVersion(resolveGodotPath(config.godotPath)),
  ]);

  const resolvedGodot = resolveGodotPath(config.godotPath);
  if (!config.dryRun && !resolvedGodot) {
    console.warn(
      "WARNING: Godot executable not found. Compile and runtime checks will be skipped.",
    );
  }

  console.log(`\nGDScript E2E correctness benchmark`);
  console.log(`  Run date:    ${runDate}`);
  console.log(`  Commit:      ${commitSha}`);
  console.log(`  Godot:       ${godotVersionStr}`);
  console.log(`  Model:       ${config.modelId}`);
  console.log(`  Dry run:     ${config.dryRun}`);
  console.log(`  Conditions:  ${config.conditions.join(", ")}`);
  console.log(`  Tasks dir:   ${config.tasksDir}`);

  const tasks = loadTasks(config.tasksDir, config.taskFilter);
  console.log(`  Tasks:       ${tasks.length}\n`);

  /** @type {import('./types.d.ts').TaskResult[]} */
  const allResults = [];

  for (const { taskId, taskDir, task, solutionCode } of tasks) {
    for (const condition of config.conditions) {
      const mcpEnabled = condition === "mcp_on";
      const condLabel = mcpEnabled ? "mcp_on " : "mcp_off";

      process.stdout.write(`  [${condLabel}] ${taskId} ... `);

      let agentOutput;
      try {
        agentOutput = await runAgent({
          task,
          taskDir,
          solutionCode,
          mcpEnabled,
          dryRun: config.dryRun,
          modelId: config.modelId,
        });
      } catch (err) {
        console.error(`\n    AGENT ERROR: ${err.message}`);
        // Record a zero-score placeholder so the run can continue.
        agentOutput = {
          code: "",
          mcpEnabled,
          capturedAt: new Date().toISOString(),
        };
      }

      const { rubricScore, programmatic } = await scoreTask({
        task,
        taskDir,
        agentCode: agentOutput.code,
        godotPath: resolvedGodot,
        solutionCode,
      });

      const effectiveScore = rubricScore;

      /** @type {import('./types.d.ts').TaskResult} */
      const result = {
        taskId,
        category: task.category,
        difficulty: task.difficulty,
        godotVersion: task.godot_version,
        mcpEnabled,
        rubricScore,
        programmatic,
        manualScore: null,
        effectiveScore,
        agentOutput,
      };

      allResults.push(result);
      console.log(`score=${rubricScore}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  const mcpOnResults = allResults.filter((r) => r.mcpEnabled);
  const mcpOffResults = allResults.filter((r) => !r.mcpEnabled);

  const mcpOnStats = computeConditionStats(mcpOnResults, true);
  const mcpOffStats = computeConditionStats(mcpOffResults, false);

  // Build paired arrays (same task order guaranteed by outer loop order).
  const pairedTasks = tasks.map((t) => ({
    taskId: t.taskId,
    onScore:
      mcpOnResults.find((r) => r.taskId === t.taskId)?.effectiveScore ?? 0,
    offScore:
      mcpOffResults.find((r) => r.taskId === t.taskId)?.effectiveScore ?? 0,
  }));

  const mcpOnPaired = pairedTasks.map((p) => p.onScore);
  const mcpOffPaired = pairedTasks.map((p) => p.offScore);

  let tTestResult = null;
  if (
    config.conditions.includes("mcp_on") &&
    config.conditions.includes("mcp_off")
  ) {
    tTestResult = pairedTTest(mcpOnPaired, mcpOffPaired);
  }

  const meanScoreDelta = mcpOnStats.meanScore - mcpOffStats.meanScore;
  const meetsAcceptanceCriteria =
    pairedTasks.length >= ACCEPTANCE_MIN_TASKS &&
    meanScoreDelta >= ACCEPTANCE_DELTA &&
    tTestResult !== null &&
    tTestResult.pValue < ACCEPTANCE_P_VALUE;

  // ---------------------------------------------------------------------------
  // Summary report
  // ---------------------------------------------------------------------------

  console.log(`\nResults summary:`);
  if (config.conditions.includes("mcp_on")) {
    console.log(
      `  MCP-on:  mean=${mcpOnStats.meanScore.toFixed(3)}  pass=${mcpOnStats.passCount}/${mcpOnStats.taskCount}  (${(mcpOnStats.passRate * 100).toFixed(1)}%)`,
    );
  }
  if (config.conditions.includes("mcp_off")) {
    console.log(
      `  MCP-off: mean=${mcpOffStats.meanScore.toFixed(3)}  pass=${mcpOffStats.passCount}/${mcpOffStats.taskCount}  (${(mcpOffStats.passRate * 100).toFixed(1)}%)`,
    );
  }
  if (config.conditions.length === 2) {
    console.log(
      `  Delta:   ${meanScoreDelta >= 0 ? "+" : ""}${meanScoreDelta.toFixed(3)}`,
    );
    if (tTestResult) {
      console.log(
        `  t-test:  t=${tTestResult.tStat.toFixed(3)}  df=${tTestResult.degreesOfFreedom}  p=${tTestResult.pValue.toFixed(4)}`,
      );
    }
    console.log(
      `  Acceptance: ${meetsAcceptanceCriteria ? "PASS" : "FAIL"} (need delta>=${ACCEPTANCE_DELTA}, p<${ACCEPTANCE_P_VALUE}, n>=${ACCEPTANCE_MIN_TASKS})`,
    );
  }

  /** @type {import('./types.d.ts').BenchmarkRun} */
  const benchmarkRun = {
    runDate,
    commitSha,
    godotVersion: godotVersionStr,
    modelId: config.modelId,
    isLiveRun: !config.dryRun,
    taskResults: allResults,
    stats: {
      mcpOn: mcpOnStats,
      mcpOff: mcpOffStats,
      pairedTTest: tTestResult,
      meanScoreDelta,
      meetsAcceptanceCriteria,
    },
  };

  return benchmarkRun;
}

// ---------------------------------------------------------------------------
// Results I/O
// ---------------------------------------------------------------------------

/**
 * Write the benchmark run to a JSON file.
 *
 * @param {import('./types.d.ts').BenchmarkRun} run
 * @param {string} resultsDir
 * @returns {string} Path to the written file.
 */
function writeResults(run, resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  // ISO date as filename with colons replaced for Windows compatibility.
  const filename = `${run.runDate.replace(/:/g, "-")}.json`;
  const outPath = join(resultsDir, filename);
  writeFileSync(outPath, JSON.stringify(run, null, 2), "utf-8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  if (config.help) {
    printHelp();
    process.exit(0);
  }

  let run;
  try {
    run = await runBenchmark(config);
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }

  const outPath = writeResults(run, config.resultsDir);
  console.log(`\nResults written to: ${outPath}`);

  // Exit non-zero only when acceptance criteria are explicitly checked
  // (both conditions run, ≥ ACCEPTANCE_MIN_TASKS) and fail.
  // Dry runs and single-condition runs always exit 0.
  const isFullRun =
    !config.dryRun &&
    config.conditions.length === 2 &&
    run.taskResults.length >= ACCEPTANCE_MIN_TASKS * 2;

  if (isFullRun && !run.stats.meetsAcceptanceCriteria) {
    console.error(`\nACCEPTANCE CRITERION NOT MET — see results for details.`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
