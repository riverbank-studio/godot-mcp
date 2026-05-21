/**
 * Filesystem helpers for poking at Godot projects on disk — no Godot
 * invocation involved. Used by `list_projects` and `get_project_info`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { logDebug } from "./logging.js";

/**
 * Walk `directory` looking for `project.godot` markers. When `recursive` is
 * false only the directory itself and its immediate children are checked.
 * Hidden directories (leading `.`) are skipped to avoid wasting time on VCS
 * metadata and node_modules-style trees.
 */
export function findGodotProjects(
  directory: string,
  recursive: boolean,
): Array<{ path: string; name: string }> {
  const projects: Array<{ path: string; name: string }> = [];

  try {
    // The directory itself might be a project.
    if (existsSync(join(directory, "project.godot"))) {
      projects.push({ path: directory, name: basename(directory) });
    }

    const entries = readdirSync(directory, { withFileTypes: true });
    if (!recursive) {
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subdir = join(directory, entry.name);
          if (existsSync(join(subdir, "project.godot"))) {
            projects.push({ path: subdir, name: entry.name });
          }
        }
      }
      return projects;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const subdir = join(directory, entry.name);
      if (existsSync(join(subdir, "project.godot"))) {
        projects.push({ path: subdir, name: entry.name });
      } else {
        projects.push(...findGodotProjects(subdir, true));
      }
    }
  } catch (error) {
    logDebug(`Error searching directory ${directory}: ${error}`);
  }

  return projects;
}

/**
 * Asynchronously count scenes/scripts/assets/other files under a project. The
 * promise never rejects — on error it resolves to a zeroed structure with an
 * `error` field, matching pre-refactor behavior.
 */
export function getProjectStructureAsync(projectPath: string): Promise<{
  scenes: number;
  scripts: number;
  assets: number;
  other: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    try {
      const structure = { scenes: 0, scripts: 0, assets: 0, other: 0 };

      const scanDirectory = (currentPath: string) => {
        const entries = readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;

          const entryPath = join(currentPath, entry.name);
          if (entry.isDirectory()) {
            scanDirectory(entryPath);
            continue;
          }
          if (!entry.isFile()) continue;

          const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
          if (ext === "tscn") {
            structure.scenes++;
          } else if (ext === "gd" || ext === "gdscript" || ext === "cs") {
            structure.scripts++;
          } else if (
            [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "svg",
              "ttf",
              "wav",
              "mp3",
              "ogg",
            ].includes(ext)
          ) {
            structure.assets++;
          } else {
            structure.other++;
          }
        }
      };

      scanDirectory(projectPath);
      resolve(structure);
    } catch (error) {
      logDebug(`Error getting project structure asynchronously: ${error}`);
      resolve({
        error: "Failed to get project structure",
        scenes: 0,
        scripts: 0,
        assets: 0,
        other: 0,
      });
    }
  });
}

/**
 * Extract the project name from a `project.godot` config file. Falls back to
 * the directory basename if the config field isn't present or the file can't
 * be read.
 */
export function readProjectName(projectPath: string): string {
  const projectFile = join(projectPath, "project.godot");
  const fallback = basename(projectPath);
  try {
    const content = readFileSync(projectFile, "utf8");
    const match = content.match(/config\/name="([^"]+)"/);
    if (match && match[1]) {
      logDebug(`Found project name in config: ${match[1]}`);
      return match[1];
    }
  } catch (error) {
    logDebug(`Error reading project file: ${error}`);
  }
  return fallback;
}

/**
 * Whether a Godot version string is 4.4 or later — the cutoff for UID
 * support in the bundled GDScript operations.
 */
export function isGodot44OrLater(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (match) {
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return major > 4 || (major === 4 && minor >= 4);
  }
  return false;
}
