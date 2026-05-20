/**
 * Project-area tools: godot_list_projects, godot_get_project_info,
 * godot_get_uid, godot_update_project_uids. UID tools require Godot 4.4+ —
 * that check is enforced here against the version Godot reports.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createErrorResponse } from "../shared/errors.js";
import { logDebug } from "../shared/logging.js";
import { normalizeParameters } from "../shared/params.js";
import {
  getProjectStructureAsync,
  findGodotProjects,
  isGodot44OrLater,
  readProjectName,
} from "../shared/project-helpers.js";
import { validatePath } from "../shared/validation.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolResponse,
} from "../shared/types.js";

const execFileAsync = promisify(execFile);

/**
 * Project-area registry. Wave 4 project-area tool PRs append via
 * `registerProjectTool`.
 */
export const projectTools: ToolDefinition[] = [];

/**
 * Append a new tool definition to the project-area registry.
 */
export function registerProjectTool(def: ToolDefinition): void {
  projectTools.push(def);
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

async function handleListProjects(rawArgs: unknown): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (!args?.directory) {
    return createErrorResponse("Directory is required", [
      "Provide a valid directory path to search for Godot projects",
    ]);
  }
  if (!validatePath(args.directory)) {
    return createErrorResponse("Invalid directory path", [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  try {
    logDebug(`Listing Godot projects in directory: ${args.directory}`);
    if (!existsSync(args.directory)) {
      return createErrorResponse(
        `Directory does not exist: ${args.directory}`,
        ["Provide a valid directory path that exists on the system"],
      );
    }
    const recursive = args.recursive === true;
    const projects = findGodotProjects(args.directory, recursive);
    return {
      content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    return createErrorResponse(
      `Failed to list projects: ${error?.message || "Unknown error"}`,
      [
        "Ensure the directory exists and is accessible",
        "Check if you have permission to read the directory",
      ],
    );
  }
}

registerProjectTool({
  name: "godot_list_projects",
  description: "List Godot projects in a directory",
  inputSchema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Directory to search for Godot projects",
      },
      recursive: {
        type: "boolean",
        description: "Whether to search recursively (default: false)",
      },
    },
    required: ["directory"],
  },
  handler: handleListProjects,
});

// ---------------------------------------------------------------------------
// get_project_info
// ---------------------------------------------------------------------------

async function handleGetProjectInfo(
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
          "Use godot_list_projects to find valid Godot projects",
        ],
      );
    }

    logDebug(`Getting project info for: ${args.projectPath}`);
    const execOptions = { timeout: 10000 };
    const { stdout } = await execFileAsync(
      godotPath,
      ["--version"],
      execOptions,
    );
    const projectStructure = await getProjectStructureAsync(args.projectPath);
    const projectName = readProjectName(args.projectPath);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: projectName,
              path: args.projectPath,
              godotVersion: stdout.trim(),
              structure: projectStructure,
            },
            null,
            2,
          ),
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    return createErrorResponse(
      `Failed to get project info: ${error?.message || "Unknown error"}`,
      [
        "Ensure Godot is installed correctly",
        "Check if the GODOT_PATH environment variable is set correctly",
        "Verify the project path is accessible",
      ],
    );
  }
}

registerProjectTool({
  name: "godot_get_project_info",
  description: "Retrieve metadata about a Godot project",
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
  handler: handleGetProjectInfo,
});

// ---------------------------------------------------------------------------
// get_uid
// ---------------------------------------------------------------------------

async function handleGetUid(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (!args?.projectPath || !args?.filePath) {
    return createErrorResponse("Missing required parameters", [
      "Provide projectPath and filePath",
    ]);
  }
  if (!validatePath(args.projectPath) || !validatePath(args.filePath)) {
    return createErrorResponse("Invalid path", [
      'Provide valid paths without ".." or other potentially unsafe characters',
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
          "Use godot_list_projects to find valid Godot projects",
        ],
      );
    }
    const filePath = join(args.projectPath, args.filePath);
    if (!existsSync(filePath)) {
      return createErrorResponse(`File does not exist: ${args.filePath}`, [
        "Ensure the file path is correct",
      ]);
    }

    const { stdout: versionOutput } = await execFileAsync(godotPath, [
      "--version",
    ]);
    const version = versionOutput.trim();
    if (!isGodot44OrLater(version)) {
      return createErrorResponse(
        `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
        [
          "Upgrade to Godot 4.4 or later to use UIDs",
          "Use resource paths instead of UIDs for this version of Godot",
        ],
      );
    }

    const params = { filePath: args.filePath };
    const { stdout, stderr } = await ctx.executeOperation(
      "get_uid",
      params,
      args.projectPath,
    );

    if (stderr && stderr.includes("Failed to")) {
      return createErrorResponse(`Failed to get UID: ${stderr}`, [
        "Check if the file is a valid Godot resource",
        "Ensure the file path is correct",
      ]);
    }

    return {
      content: [
        {
          type: "text",
          text: `UID for ${args.filePath}: ${stdout.trim()}`,
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    return createErrorResponse(
      `Failed to get UID: ${error?.message || "Unknown error"}`,
      [
        "Ensure Godot is installed correctly",
        "Check if the GODOT_PATH environment variable is set correctly",
        "Verify the project path is accessible",
      ],
    );
  }
}

registerProjectTool({
  name: "godot_get_uid",
  description:
    "Get the UID for a specific file in a Godot project (for Godot 4.4+)",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
      filePath: {
        type: "string",
        description:
          "Path to the file (relative to project) for which to get the UID",
      },
    },
    required: ["projectPath", "filePath"],
  },
  handler: handleGetUid,
});

// ---------------------------------------------------------------------------
// update_project_uids
// ---------------------------------------------------------------------------

async function handleUpdateProjectUids(
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
          "Use godot_list_projects to find valid Godot projects",
        ],
      );
    }

    const { stdout: versionOutput } = await execFileAsync(godotPath, [
      "--version",
    ]);
    const version = versionOutput.trim();
    if (!isGodot44OrLater(version)) {
      return createErrorResponse(
        `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
        [
          "Upgrade to Godot 4.4 or later to use UIDs",
          "Use resource paths instead of UIDs for this version of Godot",
        ],
      );
    }

    // The legacy operation name on the GDScript side is `resave_resources`;
    // preserve it verbatim — changing it would break the bundled script.
    const params = { projectPath: args.projectPath };
    const { stdout, stderr } = await ctx.executeOperation(
      "resave_resources",
      params,
      args.projectPath,
    );

    if (stderr && stderr.includes("Failed to")) {
      return createErrorResponse(`Failed to update project UIDs: ${stderr}`, [
        "Check if the project is valid",
        "Ensure you have write permissions to the project directory",
      ]);
    }

    return {
      content: [
        {
          type: "text",
          text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    return createErrorResponse(
      `Failed to update project UIDs: ${error?.message || "Unknown error"}`,
      [
        "Ensure Godot is installed correctly",
        "Check if the GODOT_PATH environment variable is set correctly",
        "Verify the project path is accessible",
      ],
    );
  }
}

registerProjectTool({
  name: "godot_update_project_uids",
  description:
    "Update UID references in a Godot project by resaving resources (for Godot 4.4+)",
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
  handler: handleUpdateProjectUids,
});
