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

export { editorTools, sceneTools, projectTools, docsTools };

/**
 * The flat, ordered list of all tools the server exposes.
 *
 * Subsystem ordering matches DESIGN.md § Tool surface: editor / scene /
 * project (the renamed existing tools) precede the docs subsystem. LSP
 * tools will splice in after docs once epic #9-infra lands.
 *
 * The `docsTools` array is populated by side-effect imports listed below
 * this declaration (see the "Docs-tool leaf side-effect imports" block).
 * They must live here — not in `docs-tools.ts` — to avoid the ESM TDZ
 * circular-dep (see orchestration-plan §7). Phase 1 of #7 ships one leaf
 * (#17); remaining Phase 2 leaves (#14, #15, #16, #18, #19) each add one
 * import line to this block.
 */
export const allTools: ToolDefinition[] = [
  ...editorTools,
  ...sceneTools,
  ...projectTools,
  ...docsTools,
];

// Docs-tool leaf side-effect imports.  Each leaf registers itself into
// `docsTools` via `registerDocsTool`; the imports must appear AFTER
// `docsTools` is referenced above to avoid the TDZ circular-dep that
// would arise if they were placed inside `docs-tools.ts`
// (see orchestration-plan §7 hotspot mitigation).
import "./docs/search-tutorials.js";
