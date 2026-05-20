/**
 * Scene-area tools: godot_create_scene, godot_add_node, godot_load_sprite,
 * godot_export_mesh_library, godot_save_scene. All five funnel through the
 * bundled-GDScript execution path
 * (`ctx.executeOperation`); none invoke Godot CLI flags directly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { createErrorResponse } from "../shared/errors.js";
import { normalizeParameters } from "../shared/params.js";
import { validateClassName, validatePath } from "../shared/validation.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolResponse,
} from "../shared/types.js";

/**
 * Scene-area registry. Wave 4 scene-area tool PRs append via
 * `registerSceneTool`.
 */
export const sceneTools: ToolDefinition[] = [];

/**
 * Append a new tool definition to the scene-area registry.
 */
export function registerSceneTool(def: ToolDefinition): void {
  sceneTools.push(def);
}

// ---------------------------------------------------------------------------
// create_scene
// ---------------------------------------------------------------------------

async function handleCreateScene(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (!args?.projectPath || !args?.scenePath) {
    return createErrorResponse("Project path and scene path are required", [
      "Provide valid paths for both the project and the scene",
    ]);
  }
  if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
    return createErrorResponse("Invalid path", [
      'Provide valid paths without ".." or other potentially unsafe characters',
    ]);
  }

  const rootNodeType = args.rootNodeType || "Node2D";
  if (!validateClassName(rootNodeType)) {
    return createErrorResponse("Invalid rootNodeType", [
      "rootNodeType must be a built-in Godot class name (no paths, no file extensions)",
    ]);
  }

  try {
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

    const params = { scenePath: args.scenePath, rootNodeType };
    const { stdout, stderr } = await ctx.executeOperation(
      "create_scene",
      params,
      args.projectPath,
    );

    if (stderr && stderr.includes("Failed to")) {
      return createErrorResponse(`Failed to create scene: ${stderr}`, [
        "Check if the root node type is valid",
        "Ensure you have write permissions to the scene path",
        "Verify the scene path is valid",
      ]);
    }

    return {
      content: [
        {
          type: "text",
          text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to create scene: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
      "Verify the project path is accessible",
    ]);
  }
}

registerSceneTool({
  name: "godot_create_scene",
  description: "Create a new Godot scene file",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
      scenePath: {
        type: "string",
        description:
          "Path where the scene file will be saved (relative to project)",
      },
      rootNodeType: {
        type: "string",
        description: "Type of the root node (e.g., Node2D, Node3D)",
      },
    },
    required: ["projectPath", "scenePath"],
  },
  handler: handleCreateScene,
});

// ---------------------------------------------------------------------------
// add_node
// ---------------------------------------------------------------------------

async function handleAddNode(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (
    !args?.projectPath ||
    !args?.scenePath ||
    !args?.nodeType ||
    !args?.nodeName
  ) {
    return createErrorResponse("Missing required parameters", [
      "Provide projectPath, scenePath, nodeType, and nodeName",
    ]);
  }
  if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
    return createErrorResponse("Invalid path", [
      'Provide valid paths without ".." or other potentially unsafe characters',
    ]);
  }
  if (!validateClassName(args.nodeType)) {
    return createErrorResponse("Invalid nodeType", [
      "nodeType must be a built-in Godot class name (no paths, no file extensions)",
    ]);
  }

  try {
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

    const scenePath = join(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return createErrorResponse(
        `Scene file does not exist: ${args.scenePath}`,
        [
          "Ensure the scene path is correct",
          "Use godot_create_scene to create a new scene first",
        ],
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      scenePath: args.scenePath,
      nodeType: args.nodeType,
      nodeName: args.nodeName,
    };
    if (args.parentNodePath) params.parentNodePath = args.parentNodePath;
    if (args.properties) params.properties = args.properties;

    const { stdout, stderr } = await ctx.executeOperation(
      "add_node",
      params,
      args.projectPath,
    );

    if (stderr && stderr.includes("Failed to")) {
      return createErrorResponse(`Failed to add node: ${stderr}`, [
        "Check if the node type is valid",
        "Ensure the parent node path exists",
        "Verify the scene file is valid",
      ]);
    }

    return {
      content: [
        {
          type: "text",
          text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to add node: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
      "Verify the project path is accessible",
    ]);
  }
}

registerSceneTool({
  name: "godot_add_node",
  description: "Add a node to an existing scene",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
      scenePath: {
        type: "string",
        description: "Path to the scene file (relative to project)",
      },
      parentNodePath: {
        type: "string",
        description: 'Path to the parent node (e.g., "root" or "root/Player")',
      },
      nodeType: {
        type: "string",
        description: "Type of node to add (e.g., Sprite2D, CollisionShape2D)",
      },
      nodeName: { type: "string", description: "Name for the new node" },
      properties: {
        type: "object",
        description: "Optional properties to set on the node",
      },
    },
    required: ["projectPath", "scenePath", "nodeType", "nodeName"],
  },
  handler: handleAddNode,
});

// ---------------------------------------------------------------------------
// load_sprite
// ---------------------------------------------------------------------------

async function handleLoadSprite(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (
    !args?.projectPath ||
    !args?.scenePath ||
    !args?.nodePath ||
    !args?.texturePath
  ) {
    return createErrorResponse("Missing required parameters", [
      "Provide projectPath, scenePath, nodePath, and texturePath",
    ]);
  }
  if (
    !validatePath(args.projectPath) ||
    !validatePath(args.scenePath) ||
    !validatePath(args.nodePath) ||
    !validatePath(args.texturePath)
  ) {
    return createErrorResponse("Invalid path", [
      'Provide valid paths without ".." or other potentially unsafe characters',
    ]);
  }

  try {
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
    const scenePath = join(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return createErrorResponse(
        `Scene file does not exist: ${args.scenePath}`,
        [
          "Ensure the scene path is correct",
          "Use godot_create_scene to create a new scene first",
        ],
      );
    }
    const texturePath = join(args.projectPath, args.texturePath);
    if (!existsSync(texturePath)) {
      return createErrorResponse(
        `Texture file does not exist: ${args.texturePath}`,
        [
          "Ensure the texture path is correct",
          "Upload or create the texture file first",
        ],
      );
    }

    const params = {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      texturePath: args.texturePath,
    };
    const { stdout, stderr } = await ctx.executeOperation(
      "load_sprite",
      params,
      args.projectPath,
    );

    if (stderr && stderr.includes("Failed to")) {
      return createErrorResponse(`Failed to load sprite: ${stderr}`, [
        "Check if the node path is correct",
        "Ensure the node is a Sprite2D, Sprite3D, or TextureRect",
        "Verify the texture file is a valid image format",
      ]);
    }

    return {
      content: [
        {
          type: "text",
          text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to load sprite: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
      "Verify the project path is accessible",
    ]);
  }
}

registerSceneTool({
  name: "godot_load_sprite",
  description: "Load a sprite into a Sprite2D node",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
      scenePath: {
        type: "string",
        description: "Path to the scene file (relative to project)",
      },
      nodePath: {
        type: "string",
        description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
      },
      texturePath: {
        type: "string",
        description: "Path to the texture file (relative to project)",
      },
    },
    required: ["projectPath", "scenePath", "nodePath", "texturePath"],
  },
  handler: handleLoadSprite,
});

// ---------------------------------------------------------------------------
// export_mesh_library
// ---------------------------------------------------------------------------

async function handleExportMeshLibrary(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (!args?.projectPath || !args?.scenePath || !args?.outputPath) {
    return createErrorResponse("Missing required parameters", [
      "Provide projectPath, scenePath, and outputPath",
    ]);
  }
  if (
    !validatePath(args.projectPath) ||
    !validatePath(args.scenePath) ||
    !validatePath(args.outputPath)
  ) {
    return createErrorResponse("Invalid path", [
      'Provide valid paths without ".." or other potentially unsafe characters',
    ]);
  }

  try {
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
    const scenePath = join(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return createErrorResponse(
        `Scene file does not exist: ${args.scenePath}`,
        [
          "Ensure the scene path is correct",
          "Use godot_create_scene to create a new scene first",
        ],
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      scenePath: args.scenePath,
      outputPath: args.outputPath,
    };
    if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
      params.meshItemNames = args.meshItemNames;
    }

    const { stdout, stderr } = await ctx.executeOperation(
      "export_mesh_library",
      params,
      args.projectPath,
    );

    if (stderr && stderr.includes("Failed to")) {
      return createErrorResponse(`Failed to export mesh library: ${stderr}`, [
        "Check if the scene contains valid 3D meshes",
        "Ensure the output path is valid",
        "Verify the scene file is valid",
      ]);
    }

    return {
      content: [
        {
          type: "text",
          text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to export mesh library: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
      "Verify the project path is accessible",
    ]);
  }
}

registerSceneTool({
  name: "godot_export_mesh_library",
  description: "Export a scene as a MeshLibrary resource",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
      scenePath: {
        type: "string",
        description: "Path to the scene file (.tscn) to export",
      },
      outputPath: {
        type: "string",
        description: "Path where the mesh library (.res) will be saved",
      },
      meshItemNames: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional: Names of specific mesh items to include (defaults to all)",
      },
    },
    required: ["projectPath", "scenePath", "outputPath"],
  },
  handler: handleExportMeshLibrary,
});

// ---------------------------------------------------------------------------
// save_scene
// ---------------------------------------------------------------------------

async function handleSaveScene(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = normalizeParameters(rawArgs as any);

  if (!args?.projectPath || !args?.scenePath) {
    return createErrorResponse("Missing required parameters", [
      "Provide projectPath and scenePath",
    ]);
  }
  if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
    return createErrorResponse("Invalid path", [
      'Provide valid paths without ".." or other potentially unsafe characters',
    ]);
  }
  if (args.newPath && !validatePath(args.newPath)) {
    return createErrorResponse("Invalid new path", [
      'Provide a valid new path without ".." or other potentially unsafe characters',
    ]);
  }

  try {
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
    const scenePath = join(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return createErrorResponse(
        `Scene file does not exist: ${args.scenePath}`,
        [
          "Ensure the scene path is correct",
          "Use godot_create_scene to create a new scene first",
        ],
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = { scenePath: args.scenePath };
    if (args.newPath) params.newPath = args.newPath;

    const { stdout, stderr } = await ctx.executeOperation(
      "save_scene",
      params,
      args.projectPath,
    );

    if (stderr && stderr.includes("Failed to")) {
      return createErrorResponse(`Failed to save scene: ${stderr}`, [
        "Check if the scene file is valid",
        "Ensure you have write permissions to the output path",
        "Verify the scene can be properly packed",
      ]);
    }

    const savePath = args.newPath || args.scenePath;
    return {
      content: [
        {
          type: "text",
          text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(`Failed to save scene: ${msg}`, [
      "Ensure Godot is installed correctly",
      "Check if the GODOT_PATH environment variable is set correctly",
      "Verify the project path is accessible",
    ]);
  }
}

registerSceneTool({
  name: "godot_save_scene",
  description: "Save changes to a scene file",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the Godot project directory",
      },
      scenePath: {
        type: "string",
        description: "Path to the scene file (relative to project)",
      },
      newPath: {
        type: "string",
        description:
          "Optional: New path to save the scene to (for creating variants)",
      },
    },
    required: ["projectPath", "scenePath"],
  },
  handler: handleSaveScene,
});
