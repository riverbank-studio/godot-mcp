/**
 * Editor-area tools: launching the Godot editor, running and stopping a
 * project, getting captured debug output, and reporting the installed Godot
 * version.
 *
 * Each entry in `editorTools` is a `ToolDefinition` consumed by the
 * auto-discovery registry in `src/dispatch.ts`. Use `registerEditorTool`
 * to append a new tool from another file (the Wave 4 auto-discovery
 * pattern).
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createErrorResponse } from "../shared/errors.js";
import { logDebug } from "../shared/logging.js";
import { normalizeParameters } from "../shared/params.js";
import { validatePath } from "../shared/validation.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolResponse,
} from "../shared/types.js";

const execFileAsync = promisify(execFile);

/**
 * The in-file mutable registry. Other files append via `registerEditorTool`
 * to participate in the same area's tool list — this is the pattern
 * Wave 4 docs/LSP per-tool PRs will use to avoid colliding on `dispatch.ts`.
 */
export const editorTools: ToolDefinition[] = [];

/**
 * Append a new tool definition to the editor-area registry.
 */
export function registerEditorTool(def: ToolDefinition): void {
  editorTools.push(def);
}

// ---------------------------------------------------------------------------
// launch_editor
// ---------------------------------------------------------------------------

/**
 * Handle the `launch_editor` tool — start the Godot editor for a given
 * project directory. Spawn is fire-and-forget; we do not capture stdio.
 */
async function handleLaunchEditor(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any
       -- MCP args come in as JSON-shaped unknown; we narrow with explicit checks. */
  const args: any = normalizeParameters(rawArgs as any);

  if (!args?.projectPath) {
    return createErrorResponse("Project path is required", [
      "Provide a valid path to a Godot project directory",
    ]);
  }
  if (!validatePath(args.projectPath)) {
    return createErrorResponse("Invalid project path", [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  try {
    const godotPath = await ctx.getGodotPath();
    if (!godotPath) {
      return createErrorResponse(
        "Could not find a valid Godot executable path",
        [
          "Ensure Godot is installed correctly",
          "Set GODOT_PATH environment variable to specify the correct path",
        ],
      );
    }

    const projectFile = join(args.projectPath, "project.godot");
    if (!existsSync(projectFile)) {
      return createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          "Ensure the path points to a directory containing a project.godot file",
          "Use list_projects to find valid Godot projects",
        ],
      );
    }

    logDebug(`Launching Godot editor for project: ${args.projectPath}`);
    const proc = spawn(godotPath, ["-e", "--path", args.projectPath], {
      stdio: "pipe",
    });
    proc.on("error", (err: Error) => {
      console.error("Failed to start Godot editor:", err);
    });

    return {
      content: [
        {
          type: "text",
          text: `Godot editor launched successfully for project at ${args.projectPath}.`,
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to launch Godot editor: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
      "Verify the project path is accessible",
    ]);
  }
}

registerEditorTool({
  name: "launch_editor",
  description: "Launch Godot editor for a specific project",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
    },
    required: ["projectPath"],
  },
  handler: handleLaunchEditor,
});

// ---------------------------------------------------------------------------
// run_project
// ---------------------------------------------------------------------------

/**
 * Handle the `run_project` tool — spawn Godot in debug mode and store the
 * handle so `get_debug_output` and `stop_project` can find it.
 */
async function handleRunProject(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (!args?.projectPath) {
    return createErrorResponse("Project path is required", [
      "Provide a valid path to a Godot project directory",
    ]);
  }
  if (!validatePath(args.projectPath)) {
    return createErrorResponse("Invalid project path", [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  try {
    const projectFile = join(args.projectPath, "project.godot");
    if (!existsSync(projectFile)) {
      return createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          "Ensure the path points to a directory containing a project.godot file",
          "Use list_projects to find valid Godot projects",
        ],
      );
    }

    const godotPath = await ctx.getGodotPath();
    if (!godotPath) {
      return createErrorResponse(
        "Could not find a valid Godot executable path",
        [
          "Ensure Godot is installed correctly",
          "Set GODOT_PATH environment variable to specify the correct path",
        ],
      );
    }

    const cmdArgs = ["-d", "--path", args.projectPath];
    if (args.scene && validatePath(args.scene)) {
      logDebug(`Adding scene parameter: ${args.scene}`);
      cmdArgs.push(args.scene);
    }

    logDebug(`Running Godot project: ${args.projectPath}`);
    const proc = spawn(godotPath, cmdArgs, { stdio: "pipe" });
    const output: string[] = [];
    const errors: string[] = [];

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      output.push(...lines);
      for (const line of lines) {
        if (line.trim()) logDebug(`[Godot stdout] ${line}`);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      errors.push(...lines);
      for (const line of lines) {
        if (line.trim()) logDebug(`[Godot stderr] ${line}`);
      }
    });

    proc.on("exit", (code: number | null) => {
      logDebug(`Godot process exited with code ${code}`);
      const cur = ctx.activeProcess.get();
      if (cur && cur.process === proc) {
        ctx.activeProcess.clear();
      }
    });

    proc.on("error", (err: Error) => {
      console.error("Failed to start Godot process:", err);
      const cur = ctx.activeProcess.get();
      if (cur && cur.process === proc) {
        ctx.activeProcess.clear();
      }
    });

    // `set()` kills any prior process before storing the new one.
    ctx.activeProcess.set({ process: proc, output, errors });

    return {
      content: [
        {
          type: "text",
          text: `Godot project started in debug mode. Use get_debug_output to see output.`,
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to run Godot project: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
      "Verify the project path is accessible",
    ]);
  }
}

registerEditorTool({
  name: "run_project",
  description: "Run the Godot project and capture output",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
      scene: { type: "string", description: "Optional: Specific scene to run" },
    },
    required: ["projectPath"],
  },
  handler: handleRunProject,
});

// ---------------------------------------------------------------------------
// get_debug_output
// ---------------------------------------------------------------------------

/**
 * Handle the `get_debug_output` tool — read the buffered stdout/stderr of the
 * single active project run.
 */
async function handleGetDebugOutput(
  _args: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  const active = ctx.activeProcess.get();
  if (!active) {
    return createErrorResponse("No active Godot process.", [
      "Use run_project to start a Godot project first",
      "Check if the Godot process crashed unexpectedly",
    ]);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { output: active.output, errors: active.errors },
          null,
          2,
        ),
      },
    ],
  };
}

registerEditorTool({
  name: "get_debug_output",
  description: "Get the current debug output and errors",
  inputSchema: { type: "object", properties: {}, required: [] },
  handler: handleGetDebugOutput,
});

// ---------------------------------------------------------------------------
// stop_project
// ---------------------------------------------------------------------------

/**
 * Handle the `stop_project` tool — kill the active project and return its
 * final captured output and errors.
 */
async function handleStopProject(
  _args: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  const active = ctx.activeProcess.get();
  if (!active) {
    return createErrorResponse("No active Godot process to stop.", [
      "Use run_project to start a Godot project first",
      "The process may have already terminated",
    ]);
  }

  logDebug("Stopping active Godot process");
  const output = active.output;
  const errors = active.errors;
  ctx.activeProcess.kill();

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: "Godot project stopped",
            finalOutput: output,
            finalErrors: errors,
          },
          null,
          2,
        ),
      },
    ],
  };
}

registerEditorTool({
  name: "stop_project",
  description: "Stop the currently running Godot project",
  inputSchema: { type: "object", properties: {}, required: [] },
  handler: handleStopProject,
});

// ---------------------------------------------------------------------------
// get_godot_version
// ---------------------------------------------------------------------------

/**
 * Handle the `get_godot_version` tool — `godot --version` against the
 * configured binary.
 */
async function handleGetGodotVersion(
  _args: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  try {
    const godotPath = await ctx.getGodotPath();
    if (!godotPath) {
      return createErrorResponse(
        "Could not find a valid Godot executable path",
        [
          "Ensure Godot is installed correctly",
          "Set GODOT_PATH environment variable to specify the correct path",
        ],
      );
    }
    logDebug("Getting Godot version");
    const { stdout } = await execFileAsync(godotPath, ["--version"]);
    return { content: [{ type: "text", text: stdout.trim() }] };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to get Godot version: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
    ]);
  }
}

registerEditorTool({
  name: "get_godot_version",
  description: "Get the installed Godot version",
  inputSchema: { type: "object", properties: {}, required: [] },
  handler: handleGetGodotVersion,
});
