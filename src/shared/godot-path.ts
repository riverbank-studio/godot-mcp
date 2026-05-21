/**
 * Godot binary path resolution.
 *
 * Resolution order: explicit config arg → `GODOT_PATH` env var →
 * OS-specific platform defaults. Results are cached. Validation is two-tier:
 * a sync existence check during construction, and a real `--version`
 * invocation deferred until first use. `strictPathValidation` toggles whether
 * construction fails fast or defers errors.
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { normalize } from "node:path";
import { promisify } from "node:util";

import { logDebug } from "./logging.js";

const execFileAsync = promisify(execFile);

/**
 * Stateful resolver for the Godot binary path. The MCP server owns one
 * instance; tools borrow it through `ToolContext.getGodotPath`.
 */
export class GodotPathResolver {
  private godotPath: string | null = null;
  private readonly strictPathValidation: boolean;
  private readonly validatedPaths: Map<string, boolean> = new Map();

  /**
   * Build a resolver. If `initialPath` is given it is sync-checked immediately;
   * a failing sync check resets it to null so first-use detection runs.
   */
  constructor(initialPath: string | undefined, strictPathValidation: boolean) {
    this.strictPathValidation = strictPathValidation;

    if (initialPath) {
      const normalized = normalize(initialPath);
      this.godotPath = normalized;
      logDebug(`Custom Godot path provided: ${this.godotPath}`);
      if (!this.isValidGodotPathSync(this.godotPath)) {
        console.warn(
          `[SERVER] Invalid custom Godot path provided: ${this.godotPath}`,
        );
        this.godotPath = null;
      }
    }
  }

  /**
   * Get the currently-resolved Godot path, kicking off auto-detection if it
   * hasn't run yet. May return null when no valid path is available and
   * `strictPathValidation` is false (the legacy non-strict path falls back
   * to a platform-default which may not exist).
   */
  async get(): Promise<string | null> {
    if (this.godotPath && (await this.isValidGodotPath(this.godotPath))) {
      return this.godotPath;
    }
    await this.detect();
    return this.godotPath;
  }

  /**
   * Direct getter that skips the validation roundtrip. Use only when you've
   * already called `get()` once in the same call-stack.
   */
  peek(): string | null {
    return this.godotPath;
  }

  /**
   * Whether strict-mode is enabled.
   */
  isStrict(): boolean {
    return this.strictPathValidation;
  }

  /**
   * Explicitly set a custom Godot path. Returns true if it validates,
   * leaving the previous value alone if it doesn't.
   */
  async set(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }
    const normalized = normalize(customPath);
    if (await this.isValidGodotPath(normalized)) {
      this.godotPath = normalized;
      logDebug(`Godot path set to: ${normalized}`);
      return true;
    }
    logDebug(`Failed to set invalid Godot path: ${normalized}`);
    return false;
  }

  /**
   * Synchronous existence check suitable for the constructor. Returns true
   * for the literal string "godot" since the binary may resolve via $PATH.
   */
  isValidGodotPathSync(path: string): boolean {
    try {
      logDebug(`Quick-validating Godot path: ${path}`);
      return path === "godot" || existsSync(path);
    } catch (error) {
      logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Full validation: existence + a real `--version` invocation. Results are
   * cached so repeated checks don't re-spawn Godot.
   */
  async isValidGodotPath(path: string): Promise<boolean> {
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      logDebug(`Validating Godot path: ${path}`);
      if (path !== "godot" && !existsSync(path)) {
        logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }
      // execFile (not exec) prevents shell interpretation of the path; args
      // are always passed as an array per the project's security posture.
      await execFileAsync(path, ["--version"]);
      logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect a Godot binary on the host, mutating this.godotPath on success.
   * Order: env var → platform defaults. Falls back to a platform default in
   * non-strict mode; throws in strict mode when nothing validates.
   */
  async detect(): Promise<void> {
    if (process.env.GODOT_PATH) {
      const normalized = normalize(process.env.GODOT_PATH);
      logDebug(`Checking GODOT_PATH environment variable: ${normalized}`);
      if (await this.isValidGodotPath(normalized)) {
        this.godotPath = normalized;
        logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      }
      logDebug(`GODOT_PATH environment variable is invalid`);
    }

    const osPlatform = process.platform;
    logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = ["godot"];

    if (osPlatform === "darwin") {
      possiblePaths.push(
        "/Applications/Godot.app/Contents/MacOS/Godot",
        "/Applications/Godot_4.app/Contents/MacOS/Godot",
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
      );
    } else if (osPlatform === "win32") {
      possiblePaths.push(
        "C:\\Program Files\\Godot\\Godot.exe",
        "C:\\Program Files (x86)\\Godot\\Godot.exe",
        "C:\\Program Files\\Godot_4\\Godot.exe",
        "C:\\Program Files (x86)\\Godot_4\\Godot.exe",
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`,
      );
    } else if (osPlatform === "linux") {
      possiblePaths.push(
        "/usr/bin/godot",
        "/usr/local/bin/godot",
        "/snap/bin/godot",
        `${process.env.HOME}/.local/bin/godot`,
      );
    }

    for (const path of possiblePaths) {
      const normalized = normalize(path);
      if (await this.isValidGodotPath(normalized)) {
        this.godotPath = normalized;
        logDebug(`Found Godot at: ${normalized}`);
        return;
      }
    }

    logDebug(
      `Warning: Could not find Godot in common locations for ${osPlatform}`,
    );
    console.error(
      `[SERVER] Could not find Godot in common locations for ${osPlatform}`,
    );
    console.error(
      `[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`,
    );

    if (this.strictPathValidation) {
      throw new Error(
        `Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`,
      );
    }

    // Non-strict legacy fallback: pick a platform default. May not exist.
    if (osPlatform === "win32") {
      this.godotPath = normalize("C:\\Program Files\\Godot\\Godot.exe");
    } else if (osPlatform === "darwin") {
      this.godotPath = normalize(
        "/Applications/Godot.app/Contents/MacOS/Godot",
      );
    } else {
      this.godotPath = normalize("/usr/bin/godot");
    }

    logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
    console.error(
      `[SERVER] Using default path: ${this.godotPath}, but this may not work.`,
    );
    console.error(
      `[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`,
    );
  }
}
