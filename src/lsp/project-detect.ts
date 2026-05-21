/**
 * Project-root detection + validation for the LSP subsystem.
 *
 * Per `docs/DESIGN.md` § Project association:
 *   - Walk up from cwd looking for `project.godot`. Stop at filesystem root.
 *   - Cache the result for the session (the cache lives in the caller; this
 *     module is pure).
 *   - Path validation: exists, is directory, contains `project.godot`,
 *     is readable. Fail fast on first LSP call.
 *
 * Pure I/O helpers — no Godot invocation, no network. Lets the spawn
 * manager validate fast without paying the cost of an actual LSP connect.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  LspProjectNotFoundError,
  LspProjectPathInvalidError,
} from "./errors.js";

/**
 * The marker filename whose presence defines a Godot project root.
 */
export const PROJECT_FILE = "project.godot";

/**
 * Walk up from `startDir` looking for a directory that contains
 * `project.godot`. Returns the discovered root (always absolute, with the
 * marker file's parent directory) or `null` when the filesystem root is
 * reached without a hit.
 *
 * Symlinks are not resolved — `path.dirname` walks the lexical parent so a
 * looped symlink can't trap the scan.
 */
export function detectProjectRoot(startDir: string): string | null {
  // Resolve to absolute up front so the parent-walk terminates cleanly at
  // the OS root (`path.dirname("/") === "/"` on POSIX, `"C:\\"` on Win32).
  let current = path.resolve(startDir);
  // Guard against pathological loops; OS-root parent is a fixed point so
  // the loop terminates on its own, but a hard ceiling avoids a runaway in
  // exotic FS layouts.
  for (let depth = 0; depth < 1024; depth++) {
    if (containsProjectFile(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Like {@link detectProjectRoot} but throws {@link LspProjectNotFoundError}
 * when no project is found. Used at the boundary where the caller wants the
 * categorized error rather than a null check.
 */
export function detectProjectRootOrThrow(startDir: string): string {
  const found = detectProjectRoot(startDir);
  if (!found) {
    throw new LspProjectNotFoundError(path.resolve(startDir));
  }
  return found;
}

/**
 * Validate that `projectPath` is a real project root: existing absolute
 * directory containing `project.godot`. Throws
 * {@link LspProjectPathInvalidError} on any failure mode. The thrown error
 * carries the user-facing recovery hint verbatim.
 *
 * Returns the normalized absolute path on success so callers can store one
 * canonical value.
 */
export function validateProjectPath(projectPath: string): string {
  const absolute = path.resolve(projectPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LspProjectPathInvalidError(
      absolute,
      `path does not exist (${detail})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new LspProjectPathInvalidError(absolute, "not a directory");
  }
  const markerPath = path.join(absolute, PROJECT_FILE);
  if (!fs.existsSync(markerPath)) {
    throw new LspProjectPathInvalidError(
      absolute,
      `no ${PROJECT_FILE} present`,
    );
  }
  // Readability check — `--lsp-port` needs to read the project; an
  // unreadable directory will deadlock the spawn.
  try {
    fs.accessSync(absolute, fs.constants.R_OK);
  } catch {
    throw new LspProjectPathInvalidError(absolute, "directory is not readable");
  }
  return absolute;
}

/**
 * True iff `dir` contains a `project.godot` file. Internal helper; exposed
 * for tests that want to assert the marker-detection contract independent
 * of the walk.
 */
export function containsProjectFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, PROJECT_FILE)).isFile();
  } catch {
    return false;
  }
}
