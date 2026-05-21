/**
 * Shared types for the GDScript E2E correctness benchmark (issue #31).
 *
 * These types describe the task schema, scoring rubric, and result shapes
 * consumed by the harness runner and scorer.
 */

/** Raw shape of a task.json file. */
export interface TaskJson {
  id: string;
  summary: string;
  prompt: string;
  category: "write" | "modify" | "debug" | "version-sensitive";
  difficulty: 1 | 2 | 3;
  godot_version: string;
  tags: string[];
  evaluation_notes: string;
  api_check: ApiCheck | null;
}

/** API version constraint embedded in a task. */
export interface ApiCheck {
  class_name: string;
  member: string;
  introduced: string;
  removed: string | null;
  notes: string;
}

/**
 * Per-task 3-point rubric (from DESIGN.md §2).
 *
 * - 0 — fails to compile/parse, or uses APIs absent from the target
 *        GODOT_DOCS_VERSION.
 * - 1 — compiles and approximates intent, but uses wrong/deprecated APIs or
 *        misses edge cases.
 * - 2 — matches ground truth in correctness and is version-appropriate.
 */
export type RubricScore = 0 | 1 | 2;

/** Programmatic sub-scores that feed into the composite rubric score. */
export interface ProgrammaticScores {
  /** Whether `godot --check-only` returned exit 0. null = check not run. */
  compilesClean: boolean | null;
  /** Whether the runtime check.gd script passed. null = no check.gd present. */
  runtimeCheckPassed: boolean | null;
  /** Whether the solution uses version-appropriate APIs per api_check. null = not applicable. */
  apiVersionCorrect: boolean | null;
}

/** The agent's output for a single task. */
export interface AgentOutput {
  /** The GDScript code produced by the agent. */
  code: string;
  /**
   * Whether MCP tools were available during the run.
   * The headline comparison is mcp_on vs mcp_off mean scores.
   */
  mcpEnabled: boolean;
  /** ISO-8601 timestamp of when this output was captured. */
  capturedAt: string;
  /**
   * Optional raw MCP tool calls made during this task run.
   * Kept for debugging; not used in scoring.
   */
  toolCallLog?: ToolCall[];
}

/** Minimal record of a single MCP tool call made during an agent run. */
export interface ToolCall {
  tool: string;
  inputSummary: string;
  outputSummary: string;
}

/** Full scored result for one task in one run condition. */
export interface TaskResult {
  taskId: string;
  category: TaskJson["category"];
  difficulty: TaskJson["difficulty"];
  godotVersion: string;
  mcpEnabled: boolean;
  rubricScore: RubricScore;
  programmatic: ProgrammaticScores;
  /** Human-assigned override, if the task was manually reviewed. */
  manualScore: RubricScore | null;
  /**
   * The effective score used in analysis.
   * Prefers manualScore when set, otherwise rubricScore.
   */
  effectiveScore: RubricScore;
  agentOutput: AgentOutput;
  /**
   * Human reviewer notes (optional; filled during manual review phase).
   */
  reviewNotes?: string;
}

/** Per-condition aggregate stats (MCP on or MCP off). */
export interface ConditionStats {
  mcpEnabled: boolean;
  taskCount: number;
  meanScore: number;
  /** Sample standard deviation. */
  stdDev: number;
  /** Number of tasks scoring 2 (full marks). */
  passCount: number;
  /** pass_count / task_count */
  passRate: number;
  scoreDistribution: { 0: number; 1: number; 2: number };
}

/** Top-level result file written to benchmarks/results/gdscript-correctness/. */
export interface BenchmarkRun {
  /** ISO-8601 date of the run, used in the filename. */
  runDate: string;
  /** Git SHA of HEAD at run time. */
  commitSha: string;
  /** Godot binary version string (from `godot --version`). */
  godotVersion: string;
  /** Model identifier used for the agent (e.g. "claude-sonnet-4-6"). */
  modelId: string;
  /**
   * Whether live agent runs were executed, or whether agentOutput slots
   * contain placeholder stubs (used during scaffolding / dry runs).
   */
  isLiveRun: boolean;
  taskResults: TaskResult[];
  stats: {
    mcpOn: ConditionStats;
    mcpOff: ConditionStats;
    /**
     * Paired t-test results (null when there are fewer than 2 paired tasks).
     * Acceptance criterion: delta ≥ 0.3 and p < 0.05.
     */
    pairedTTest: PairedTTestResult | null;
    /** Delta of mean scores: mcpOn.meanScore - mcpOff.meanScore. */
    meanScoreDelta: number;
    meetsAcceptanceCriteria: boolean;
  };
}

/** Output of the paired t-test between MCP-on and MCP-off scores. */
export interface PairedTTestResult {
  /** t-statistic. */
  tStat: number;
  /** Two-tailed p-value. */
  pValue: number;
  /** Degrees of freedom (n - 1 where n = paired task count). */
  degreesOfFreedom: number;
  /** Number of paired tasks used. */
  n: number;
}

/** Configuration passed to the harness runner. */
export interface HarnessConfig {
  /** Absolute path to the task dataset root (v1/tasks/). */
  tasksDir: string;
  /** Absolute path to write result JSON files. */
  resultsDir: string;
  /** Godot executable path. Defaults to GODOT_PATH env var or platform default. */
  godotPath: string | null;
  /** Filter to a subset of task IDs. Empty = run all. */
  taskFilter: string[];
  /** Only score MCP-on, MCP-off, or both. */
  conditions: ("mcp_on" | "mcp_off")[];
  /** Skip live agent execution (dry-run: produce placeholder outputs). */
  dryRun: boolean;
  /** Model ID for agent calls (used in result metadata). */
  modelId: string;
  /**
   * Minimum paired task count required to compute the t-test.
   * Default 2. The acceptance criterion requires ≥ 30.
   */
  minPairedTasksForTTest: number;
}
