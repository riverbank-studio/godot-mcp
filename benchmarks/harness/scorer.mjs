#!/usr/bin/env node
/**
 * scorer.mjs — GDScript E2E correctness benchmark scorer (issue #31).
 *
 * Computes programmatic sub-scores and assembles a composite rubric score
 * for one agent output against one task. Used by the harness runner but
 * exported as a pure function so it can also be called from tests.
 *
 * Scoring strategy (from DESIGN.md §2):
 *
 *   0 — fails to compile/parse, or uses APIs absent from godot_version.
 *   1 — compiles, approximates intent, but wrong/deprecated APIs or misses
 *       edge cases.
 *   2 — matches ground truth in correctness and is version-appropriate.
 *
 * The programmatic checks cover compile + runtime (check.gd). Manual review
 * is needed for full rubric classification; the scorer provides the floor.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Resolve a Godot executable path.
 *
 * Resolution order (mirrors src/index.ts detectGodotPath):
 *   1. Explicit godotPath argument
 *   2. GODOT_PATH env var
 *   3. Platform defaults
 *
 * @param {string | null} godotPath - Explicit path or null for auto-detect.
 * @returns {string | null} Resolved path, or null if not found.
 */
export function resolveGodotPath(godotPath) {
  if (godotPath) return godotPath;
  if (process.env.GODOT_PATH) return process.env.GODOT_PATH;

  const platformDefaults =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Godot\\Godot_v4.3-stable_win64.exe",
          "C:\\Program Files\\Godot\\Godot.exe",
          "godot.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Godot.app/Contents/MacOS/Godot",
            "/usr/local/bin/godot",
          ]
        : ["/usr/local/bin/godot", "/usr/bin/godot", "godot"];

  for (const candidate of platformDefaults) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Run `godot --headless --check-only` on GDScript source text.
 *
 * The code is written to a temp directory so it does not pollute any real
 * Godot project. Returns true if exit code is 0, false otherwise.
 *
 * @param {string} gdscriptCode - The GDScript source code to check.
 * @param {string} resolvedGodotPath - Path to the Godot executable.
 * @returns {Promise<{passed: boolean, stderr: string}>}
 */
export async function checkCompile(gdscriptCode, resolvedGodotPath) {
  /** @type {string | null} */
  let tmpDir = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "gdscript-bench-"));
    const scriptPath = join(tmpDir, "check_target.gd");
    // Wrap bare code in a minimal SceneTree script if needed, so check-only
    // can parse it. If the code already has extends, use it as-is.
    const hasExtends = /^\s*extends\s+/m.test(gdscriptCode);
    const wrapped = hasExtends
      ? gdscriptCode
      : `extends Object\n\n${gdscriptCode}`;
    await writeFile(scriptPath, wrapped, "utf-8");

    const { stderr } = await execFileAsync(
      resolvedGodotPath,
      ["--headless", "--check-only", "--script", scriptPath],
      { timeout: 15_000 },
    ).catch((err) => ({ stderr: err.stderr ?? String(err) }));

    // Godot --check-only exits 0 on success; any non-zero is a parse/type error.
    const passed =
      !stderr.includes("ERROR") && !stderr.includes("SCRIPT ERROR");
    return { passed, stderr: stderr ?? "" };
  } finally {
    if (tmpDir) {
      await unlink(join(tmpDir, "check_target.gd")).catch(() => {});
      // Best-effort: ignore rmdir failure on Windows if handles still open.
    }
  }
}

/**
 * Run the task's check.gd script against the agent's output, if present.
 *
 * check.gd is a SceneTree script that loads `res://solution-a.gd` from the
 * same directory and runs assertions, then exits 0 or 1.
 *
 * @param {string} taskDir - Absolute path to the task directory.
 * @param {string} agentCode - The agent's GDScript output.
 * @param {string} resolvedGodotPath - Path to the Godot executable.
 * @returns {Promise<{passed: boolean | null, stdout: string, stderr: string}>}
 *   passed = null when no check.gd exists.
 */
export async function runRuntimeCheck(taskDir, agentCode, resolvedGodotPath) {
  const checkGdPath = join(taskDir, "check.gd");
  if (!existsSync(checkGdPath)) {
    return { passed: null, stdout: "", stderr: "" };
  }

  /** @type {string | null} */
  let tmpDir = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "gdscript-bench-rt-"));

    // check.gd loads "res://solution-a.gd" — write agent code there.
    const solutionPath = join(tmpDir, "solution-a.gd");
    await writeFile(solutionPath, agentCode, "utf-8");

    // Copy check.gd into the same tmpdir so res:// resolves correctly.
    const checkGdSource = readFileSync(checkGdPath, "utf-8");
    const checkGdDest = join(tmpDir, "check.gd");
    await writeFile(checkGdDest, checkGdSource, "utf-8");

    const result = await execFileAsync(
      resolvedGodotPath,
      ["--headless", "--path", tmpDir, "--script", checkGdDest],
      { timeout: 20_000 },
    ).catch((err) => ({
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
      exitCode: err.code ?? 1,
    }));

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const passed = stdout.includes("PASS") && !stdout.includes("FAIL");
    return { passed, stdout, stderr };
  } finally {
    if (tmpDir) {
      for (const f of ["solution-a.gd", "check.gd"]) {
        await unlink(join(tmpDir, f)).catch(() => {});
      }
    }
  }
}

/**
 * Check whether the agent's code is compatible with the task's api_check
 * constraint (if present).
 *
 * This is a static text-scan heuristic: it looks for the deprecated/removed
 * API patterns in the code. When `api_check.removed` is non-null, the member
 * must NOT appear in the code. When it is null, the member should appear
 * (indicating the agent used the correct API).
 *
 * This is necessarily imperfect — a proper check requires Godot's class
 * reference DB (dependency #9). Returns null when api_check is null.
 *
 * @param {import('./types.d.ts').TaskJson} task - The task metadata.
 * @param {string} agentCode - The agent's GDScript output.
 * @returns {boolean | null}
 */
export function checkApiVersion(task, agentCode) {
  if (!task.api_check) return null;

  const { member, removed } = task.api_check;

  if (removed !== null) {
    // The API was removed; it must not appear in the code.
    const usesRemoved = agentCode.includes(member);
    return !usesRemoved;
  }

  // The API was introduced at api_check.introduced; the agent should use it.
  // Accept if the member appears anywhere in the code.
  return agentCode.includes(member);
}

/**
 * Normalise a GDScript snippet for fuzzy comparison.
 *
 * Strips comments, collapses whitespace, and lower-cases. Used for the
 * "approximate intent" check that separates score 1 from score 0.
 *
 * @param {string} code - Raw GDScript source.
 * @returns {string}
 */
export function normaliseCode(code) {
  return code
    .replace(/#[^\n]*/g, "") // strip line comments
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
    .toLowerCase();
}

/**
 * Compute a fuzzy similarity ratio between two normalised code strings.
 *
 * Uses a simple character-level overlap (intersection of character bigrams).
 * Returns a value in [0, 1]. This is an imprecise heuristic; it is only used
 * to separate score 0 from score 1 when compile succeeds but the solution
 * diverges from ground truth.
 *
 * @param {string} a - Normalised code A.
 * @param {string} b - Normalised code B.
 * @returns {number} Similarity in [0, 1].
 */
export function bigramSimilarity(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  /**
   * @param {string} s
   * @returns {Map<string, number>}
   */
  function bigrams(s) {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  }

  const ba = bigrams(a);
  const bb = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of ba) {
    intersection += Math.min(count, bb.get(bg) ?? 0);
  }
  const total = a.length - 1 + (b.length - 1);
  return total === 0 ? 1 : (2 * intersection) / total;
}

/**
 * Assemble a composite rubric score from programmatic sub-scores.
 *
 * Rule table (priority order):
 *
 * | compilesClean | apiVersionCorrect | runtimeCheckPassed | score |
 * |---------------|-------------------|--------------------|-------|
 * | false         | *                 | *                  | 0     |
 * | true          | false             | *                  | 0     |
 * | true          | null/true         | false (explicit)   | 0     |
 * | true          | null/true         | null               | 1     |
 * | true          | null/true         | true               | 2     |
 *
 * The harness may override the rubric score to 1 when similarity to ground
 * truth is above a threshold and compile passes but runtime is absent.
 *
 * @param {import('./types.d.ts').ProgrammaticScores} scores
 * @returns {import('./types.d.ts').RubricScore}
 */
export function assembleRubricScore(scores) {
  const { compilesClean, apiVersionCorrect, runtimeCheckPassed } = scores;

  if (compilesClean === false) return 0;
  if (apiVersionCorrect === false) return 0;
  if (runtimeCheckPassed === false) return 0;
  if (runtimeCheckPassed === true) return 2;

  // compile passed + no runtime check: conservative default of 1.
  return 1;
}

/**
 * Score one agent output against one task.
 *
 * This is the main entry point called per (task, condition) pair.
 *
 * @param {object} params
 * @param {import('./types.d.ts').TaskJson} params.task - Task metadata.
 * @param {string} params.taskDir - Absolute path to the task directory.
 * @param {string} params.agentCode - The agent's GDScript output.
 * @param {string | null} params.godotPath - Resolved Godot path, or null to skip compile/runtime checks.
 * @param {string} params.solutionCode - Ground-truth solution code for similarity fallback.
 * @returns {Promise<{
 *   rubricScore: import('./types.d.ts').RubricScore,
 *   programmatic: import('./types.d.ts').ProgrammaticScores,
 * }>}
 */
export async function scoreTask({
  task,
  taskDir,
  agentCode,
  godotPath,
  solutionCode,
}) {
  /** @type {import('./types.d.ts').ProgrammaticScores} */
  const programmatic = {
    compilesClean: null,
    runtimeCheckPassed: null,
    apiVersionCorrect: null,
  };

  if (godotPath) {
    // Compile check
    const compileResult = await checkCompile(agentCode, godotPath);
    programmatic.compilesClean = compileResult.passed;

    if (compileResult.passed) {
      // Runtime check (check.gd) if present
      const runtimeResult = await runRuntimeCheck(
        taskDir,
        agentCode,
        godotPath,
      );
      programmatic.runtimeCheckPassed = runtimeResult.passed;
    }
  }

  // API version check (static; does not require Godot executable)
  programmatic.apiVersionCorrect = checkApiVersion(task, agentCode);

  let rubricScore = assembleRubricScore(programmatic);

  // Similarity fallback: if compile passed and no runtime check exists,
  // bump to 2 when bigram similarity to ground truth is very high (≥ 0.85).
  if (
    programmatic.compilesClean !== false &&
    programmatic.runtimeCheckPassed === null &&
    programmatic.apiVersionCorrect !== false
  ) {
    const normAgent = normaliseCode(agentCode);
    const normSolution = normaliseCode(solutionCode);
    const sim = bigramSimilarity(normAgent, normSolution);
    if (sim >= 0.85) {
      rubricScore = 2;
    }
  }

  return { rubricScore, programmatic };
}
