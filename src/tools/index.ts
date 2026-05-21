/**
 * Composed tool registry. Each per-area module owns its own array of
 * `ToolDefinition`s; this barrel concatenates them in a deterministic order
 * so callers (and tests) can rely on it.
 *
 * Order matches DESIGN.md's tool table for the existing tools.
 *
 * Docs leaf side-effect imports
 * -----------------------------
 *
 * Leaf tools under `src/tools/docs/` register themselves by calling
 * `registerDocsTool` at module load time. Those imports live here (NOT in
 * `src/tools/docs/index.ts` or `src/tools/docs-tools.ts`) to avoid a TDZ
 * circular dependency: `docs-tools.ts` → `docs/index.ts` → leaf →
 * `registerDocsTool` → `docsTools` (not yet assigned). Importing leaves
 * after the `docsTools` binding is established breaks the cycle.
 */

import type { ToolDefinition } from "../shared/types.js";

import { editorTools } from "./editor-tools.js";
import { sceneTools } from "./scene-tools.js";
import { projectTools } from "./project-tools.js";
import { docsTools } from "./docs-tools.js";

// Docs-leaf side-effect registrations (see module docstring above).
import "./docs/find-member.js";

export { editorTools, sceneTools, projectTools, docsTools };

/**
 * The flat, ordered list of all tools the server exposes.
 *
 * Subsystem ordering matches DESIGN.md § Tool surface: editor / scene /
 * project (the renamed existing tools) precede the docs subsystem. LSP
 * tools will splice in after docs once epic #9-infra lands.
 *
 * The `docsTools` array is populated by side-effect imports in
 * `src/tools/docs-tools.ts` → `src/tools/docs/index.ts`. Phase 1 of #7
 * ships it empty; Phase 2 leaves (#14–#19) register themselves.
 */
export const allTools: ToolDefinition[] = [
  ...editorTools,
  ...sceneTools,
  ...projectTools,
  ...docsTools,
];
