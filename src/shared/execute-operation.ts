/**
 * The "bundled GDScript" execution path.
 *
 * Tools that need rich Godot-side behavior funnel through `executeOperation`,
 * which runs the single bundled `godot_operations.gd` script with a
 * JSON-encoded params blob:
 *
 *   godot --headless --path <project> --script <ops>.gd <operation> <JSON>
 *
 * Adding a new operation means (a) a TypeScript handler that calls this,
 * and (b) a branch in the GDScript's `match operation:` block. Do not
 * introduce one-off temporary `.gd` scripts — extend `godot_operations.gd`.
 */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { logDebug } from "./logging.js";
import { convertCamelToSnakeCase } from "./params.js";
import type { GodotPathResolver } from "./godot-path.js";
import type { OperationParams } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve the on-disk path to the bundled `godot_operations.gd` script.
 * The build step (`scripts/build.js`) copies it into `build/scripts/`; in
 * source this resolves relative to `src/shared/`.
 */
export function getOperationsScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/shared/execute-operation.ts → src/scripts/godot_operations.gd
  //   (build/shared/execute-operation.js → build/scripts/godot_operations.gd)
  return join(here, "..", "scripts", "godot_operations.gd");
}

/**
 * Bundled-GDScript operation runner. Converts camelCase params to snake_case
 * for the GDScript side, builds the argv array, and runs Godot headless.
 *
 * Arguments are always passed as an array — never string-concatenated — to
 * avoid shell injection. The codebase deliberately uses `execFile`, not
 * `exec`.
 */
export async function executeOperation(
  resolver: GodotPathResolver,
  operationsScriptPath: string,
  godotDebugMode: boolean,
  operation: string,
  params: OperationParams,
  projectPath: string,
): Promise<{ stdout: string; stderr: string }> {
  logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
  logDebug(`Original operation params: ${JSON.stringify(params)}`);

  const snakeCaseParams = convertCamelToSnakeCase(params);
  logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

  const godotPath = await resolver.get();
  if (!godotPath) {
    throw new Error("Could not find a valid Godot executable path");
  }

  try {
    const paramsJson = JSON.stringify(snakeCaseParams);

    const args = [
      "--headless",
      "--path",
      projectPath,
      "--script",
      operationsScriptPath,
      operation,
      paramsJson,
    ];

    if (godotDebugMode) {
      args.push("--debug-godot");
    }

    logDebug(`Executing: ${godotPath} ${args.join(" ")}`);

    const { stdout, stderr } = await execFileAsync(godotPath, args);
    return { stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error: unknown) {
    // execFileAsync rejects on non-zero exit; pick stdout/stderr out of the
    // error so callers see whatever Godot did manage to print.
    if (error instanceof Error && "stdout" in error && "stderr" in error) {
      const execError = error as Error & { stdout: string; stderr: string };
      return {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? "",
      };
    }
    throw error;
  }
}
