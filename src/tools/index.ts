/**
 * Composed tool registry. Each per-area module owns its own array of
 * `ToolDefinition`s; this barrel concatenates them in a deterministic order
 * so callers (and tests) can rely on it.
 *
 * Order matches DESIGN.md's tool table for the existing tools.
 */

import type { ToolDefinition } from "../shared/types.js";

import { editorTools } from "./editor-tools.js";
import { sceneTools } from "./scene-tools.js";
import { projectTools } from "./project-tools.js";

export { editorTools, sceneTools, projectTools };

/**
 * The flat, ordered list of all tools the server exposes. Wave 2+ subsystem
 * registries (docs, LSP) will splice into this array.
 */
export const allTools: ToolDefinition[] = [
  ...editorTools,
  ...sceneTools,
  ...projectTools,
];
