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
import { docsTools } from "./docs-tools.js";

// Docs-tools leaf registrations. Each import below triggers a side-effect
// `registerDocsTool` call in the leaf file. Appended here (not in
// docs-tools.ts → docs/index.ts) to avoid the TDZ circular dependency that
// arises when docs-tools.ts imports its own barrel before `docsTools` is
// initialized. New docs leaves append one line here per DESIGN.md §7.
import "./docs/search-api.js";

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
