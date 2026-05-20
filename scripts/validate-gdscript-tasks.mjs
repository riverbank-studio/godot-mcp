#!/usr/bin/env node
/**
 * validate-gdscript-tasks.mjs
 *
 * Validates the GDScript correctness benchmark dataset at
 * benchmarks/datasets/gdscript-correctness/v1/tasks/.
 *
 * Exit 0 on success, exit 1 on any failure.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TASKS_DIR = join(
  REPO_ROOT,
  "benchmarks",
  "datasets",
  "gdscript-correctness",
  "v1",
  "tasks",
);

const MIN_TASKS = 50;
const MAX_TASKS = 80;
const MIN_VERSION_SENSITIVE_RATIO = 0.2;

const VALID_CATEGORIES = ["write", "modify", "debug", "version-sensitive"];
const VALID_DIFFICULTIES = [1, 2, 3];

/** @typedef {{ field: string, message: string }} ValidationError */

/**
 * Validate a single task.json object.
 *
 * @param {unknown} data - Parsed JSON.
 * @param {string} taskId - Expected task ID (directory name).
 * @returns {ValidationError[]} List of validation errors (empty = valid).
 */
function validateTaskJson(data, taskId) {
  /** @type {ValidationError[]} */
  const errors = [];

  if (typeof data !== "object" || data === null) {
    errors.push({
      field: "(root)",
      message: "task.json must be a JSON object",
    });
    return errors;
  }

  const task = /** @type {Record<string, unknown>} */ (data);

  // id
  if (typeof task.id !== "string" || task.id.trim() === "") {
    errors.push({ field: "id", message: "must be a non-empty string" });
  } else if (task.id !== taskId) {
    errors.push({
      field: "id",
      message: `id "${task.id}" does not match directory name "${taskId}"`,
    });
  }

  // summary
  if (typeof task.summary !== "string" || task.summary.trim() === "") {
    errors.push({ field: "summary", message: "must be a non-empty string" });
  }

  // prompt
  if (typeof task.prompt !== "string" || task.prompt.trim() === "") {
    errors.push({ field: "prompt", message: "must be a non-empty string" });
  }

  // category
  if (!VALID_CATEGORIES.includes(/** @type {string} */ (task.category))) {
    errors.push({
      field: "category",
      message: `must be one of: ${VALID_CATEGORIES.join(", ")}`,
    });
  }

  // difficulty
  if (!VALID_DIFFICULTIES.includes(/** @type {number} */ (task.difficulty))) {
    errors.push({
      field: "difficulty",
      message: `must be one of: ${VALID_DIFFICULTIES.join(", ")}`,
    });
  }

  // godot_version
  if (
    typeof task.godot_version !== "string" ||
    task.godot_version.trim() === ""
  ) {
    errors.push({
      field: "godot_version",
      message: "must be a non-empty string (e.g. '4.3')",
    });
  }

  // tags
  if (
    !Array.isArray(task.tags) ||
    task.tags.some((t) => typeof t !== "string")
  ) {
    errors.push({ field: "tags", message: "must be an array of strings" });
  }

  // evaluation_notes
  if (
    typeof task.evaluation_notes !== "string" ||
    task.evaluation_notes.trim() === ""
  ) {
    errors.push({
      field: "evaluation_notes",
      message: "must be a non-empty string",
    });
  }

  // api_check — null or object with required sub-fields
  if (task.api_check !== null) {
    if (typeof task.api_check !== "object" || Array.isArray(task.api_check)) {
      errors.push({
        field: "api_check",
        message: "must be null or an object",
      });
    } else {
      const check = /** @type {Record<string, unknown>} */ (task.api_check);
      for (const field of ["class_name", "member", "introduced", "notes"]) {
        if (typeof check[field] !== "string" || check[field] === "") {
          errors.push({
            field: `api_check.${field}`,
            message: "must be a non-empty string",
          });
        }
      }
      // removed may be null or string
      if (check.removed !== null && typeof check.removed !== "string") {
        errors.push({
          field: "api_check.removed",
          message: "must be null or a string",
        });
      }
    }
  }

  return errors;
}

/**
 * Main validation routine.
 */
function main() {
  let failed = false;

  // Check the tasks directory exists
  if (!existsSync(TASKS_DIR)) {
    console.error(`ERROR: tasks directory not found: ${TASKS_DIR}`);
    process.exit(1);
  }

  const taskDirs = readdirSync(TASKS_DIR).filter((name) => {
    const full = join(TASKS_DIR, name);
    return statSync(full).isDirectory();
  });

  const totalCount = taskDirs.length;
  console.log(`Found ${totalCount} task directories.`);

  /** @type {string[]} */
  const versionSensitiveTasks = [];

  for (const taskId of taskDirs) {
    const taskDir = join(TASKS_DIR, taskId);
    const taskJsonPath = join(taskDir, "task.json");

    // task.json must exist
    if (!existsSync(taskJsonPath)) {
      console.error(`  FAIL [${taskId}]: missing task.json`);
      failed = true;
      continue;
    }

    // task.json must parse
    let data;
    try {
      data = JSON.parse(readFileSync(taskJsonPath, "utf-8"));
    } catch (e) {
      console.error(
        `  FAIL [${taskId}]: task.json is not valid JSON — ${e.message}`,
      );
      failed = true;
      continue;
    }

    // task.json schema validation
    const errors = validateTaskJson(data, taskId);
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(`  FAIL [${taskId}]: ${err.field} — ${err.message}`);
      }
      failed = true;
    }

    // solutions/solution-a.gd must exist
    const solutionPath = join(taskDir, "solutions", "solution-a.gd");
    if (!existsSync(solutionPath)) {
      console.error(`  FAIL [${taskId}]: missing solutions/solution-a.gd`);
      failed = true;
    }

    // Track version-sensitive tasks
    if (
      typeof data === "object" &&
      data !== null &&
      /** @type {Record<string,unknown>} */ (data).category ===
        "version-sensitive"
    ) {
      versionSensitiveTasks.push(taskId);
    }
  }

  // Count checks
  if (totalCount < MIN_TASKS) {
    console.error(
      `FAIL: only ${totalCount} tasks found — minimum is ${MIN_TASKS}`,
    );
    failed = true;
  } else if (totalCount > MAX_TASKS) {
    console.error(`FAIL: ${totalCount} tasks found — maximum is ${MAX_TASKS}`);
    failed = true;
  }

  // Version-sensitive ratio check
  const versionSensitiveRatio =
    totalCount > 0 ? versionSensitiveTasks.length / totalCount : 0;

  if (versionSensitiveRatio < MIN_VERSION_SENSITIVE_RATIO) {
    console.error(
      `FAIL: only ${versionSensitiveTasks.length}/${totalCount} tasks are version-sensitive ` +
        `(${(versionSensitiveRatio * 100).toFixed(1)}%) — minimum is ${MIN_VERSION_SENSITIVE_RATIO * 100}%`,
    );
    failed = true;
  }

  // Summary
  if (!failed) {
    console.log(`\nPASS — ${totalCount} tasks validated.`);
    console.log(
      `  Version-sensitive: ${versionSensitiveTasks.length}/${totalCount} ` +
        `(${(versionSensitiveRatio * 100).toFixed(1)}%)`,
    );
    process.exit(0);
  } else {
    console.error("\nFAIL — see errors above.");
    process.exit(1);
  }
}

main();
