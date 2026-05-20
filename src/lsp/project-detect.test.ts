/**
 * Tests for `detectProjectRoot` and `validateProjectPath`.
 *
 * The auto-detect walk is filesystem-backed; we use a per-test tmpdir
 * so the walk has known endpoints. Validation is exercised with both
 * happy-path and every failure mode the spawn manager will hit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LspProjectNotFoundError,
  LspProjectPathInvalidError,
} from "./errors.js";
import {
  PROJECT_FILE,
  containsProjectFile,
  detectProjectRoot,
  detectProjectRootOrThrow,
  validateProjectPath,
} from "./project-detect.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-projdetect-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("detectProjectRoot", () => {
  it("returns null when no project.godot exists in cwd or any ancestor", () => {
    const deep = path.join(tmpRoot, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    const root = detectProjectRoot(deep);
    // tmpdir might be inside an unrelated tree, but we can at least assert
    // it didn't find one inside our exclusive tree.
    if (root) {
      expect(root.startsWith(tmpRoot)).toBe(false);
    }
  });

  it("walks up from a nested directory until project.godot is found", () => {
    const projectDir = path.join(tmpRoot, "myproj");
    const subdir = path.join(projectDir, "scripts", "player");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, PROJECT_FILE), "");

    const root = detectProjectRoot(subdir);
    expect(root).toBe(path.resolve(projectDir));
  });

  it("returns the directory itself when it directly contains project.godot", () => {
    const projectDir = path.join(tmpRoot, "myproj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, PROJECT_FILE), "");

    const root = detectProjectRoot(projectDir);
    expect(root).toBe(path.resolve(projectDir));
  });
});

describe("detectProjectRootOrThrow", () => {
  it("throws LspProjectNotFoundError when nothing is found within our tree", () => {
    const deep = path.join(tmpRoot, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    // Walk only up to tmpRoot's parent (not the whole machine) — but the
    // test environment may or may not have a project.godot above tmpdir.
    // We catch either outcome explicitly so the test is portable.
    let didThrow = false;
    let found: string | null = null;
    try {
      found = detectProjectRootOrThrow(deep);
    } catch (err) {
      didThrow = true;
      expect(err).toBeInstanceOf(LspProjectNotFoundError);
    }
    if (!didThrow) {
      // An external tree above tmp has a project.godot; verify the result
      // is at least above tmpRoot.
      expect(found).toBeTruthy();
      expect(found!.startsWith(tmpRoot)).toBe(false);
    }
  });

  it("returns the discovered root on success", () => {
    const projectDir = path.join(tmpRoot, "myproj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, PROJECT_FILE), "");

    const root = detectProjectRootOrThrow(projectDir);
    expect(root).toBe(path.resolve(projectDir));
  });
});

describe("validateProjectPath", () => {
  it("returns the normalized absolute path on a valid project", () => {
    const projectDir = path.join(tmpRoot, "myproj");
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, PROJECT_FILE), "");

    const out = validateProjectPath(projectDir);
    expect(out).toBe(path.resolve(projectDir));
  });

  it("throws when the path does not exist", () => {
    const missing = path.join(tmpRoot, "nope");
    expect(() => validateProjectPath(missing)).toThrow(
      LspProjectPathInvalidError,
    );
  });

  it("throws when the path is a file, not a directory", () => {
    const filePath = path.join(tmpRoot, "f.txt");
    fs.writeFileSync(filePath, "");
    expect(() => validateProjectPath(filePath)).toThrow(
      LspProjectPathInvalidError,
    );
  });

  it("throws when project.godot is absent", () => {
    const projectDir = path.join(tmpRoot, "empty");
    fs.mkdirSync(projectDir);
    expect(() => validateProjectPath(projectDir)).toThrow(
      LspProjectPathInvalidError,
    );
  });

  it("carries the categorized recovery hint on failure", () => {
    const missing = path.join(tmpRoot, "nope");
    try {
      validateProjectPath(missing);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LspProjectPathInvalidError);
      expect((err as LspProjectPathInvalidError).recoveryHint).toContain(
        "project.godot",
      );
    }
  });
});

describe("containsProjectFile", () => {
  it("true when the marker file exists", () => {
    fs.writeFileSync(path.join(tmpRoot, PROJECT_FILE), "");
    expect(containsProjectFile(tmpRoot)).toBe(true);
  });

  it("false when the marker file does not exist", () => {
    expect(containsProjectFile(tmpRoot)).toBe(false);
  });

  it("false when the dir itself does not exist", () => {
    expect(containsProjectFile(path.join(tmpRoot, "ghost"))).toBe(false);
  });
});
