/**
 * LSP-area tools: registry surface for the seven read-only LSP leaves
 * (#20–#26) and the advisory-write `godot_preview_rename` follow-up.
 *
 * The pattern matches `editor-tools.ts` / `scene-tools.ts` /
 * `project-tools.ts`: a module-level mutable array (`lspTools`) and a
 * `registerLspTool()` appender. Each leaf PR adds a single new file
 * (e.g. `src/tools/lsp/find-definition.ts`) that imports
 * `registerLspTool` and registers its `ToolDefinition` at import time;
 * the leaf then re-exports nothing back here. The barrel
 * (`src/tools/index.ts`) imports this file so the registration side
 * effects fire during server startup.
 *
 * Leaf tools are expected to:
 *
 *   1. Define a `ToolDefinition` whose `handler` body wraps its real
 *      work in {@link import("../lsp/tool-helpers.js").withLspClient} so
 *      the categorized-error mapping is uniform across the family.
 *   2. Use the shared {@link import("../lsp/tool-helpers.js").toLspPosition},
 *      {@link import("../lsp/tool-helpers.js").uriToFilePath}, and
 *      {@link import("../lsp/tool-helpers.js").validateFileInProject}
 *      helpers rather than re-deriving them.
 *   3. Emit responses with 1-based wire positions per DESIGN.md L490
 *      and the universal zero-results rule (DESIGN.md L492): empty
 *      array (or empty object for hover) on no results, never an MCP
 *      error.
 *
 * The file ships **empty** at the registry level — the seven leaves
 * land as separate PRs (#20–#26) that each `registerLspTool` themselves.
 * Tests assert the empty-but-registered shape so the registry surface
 * itself is exercised before any leaf is in flight.
 */

import type { ToolDefinition } from "../shared/types.js";

/**
 * The mutable LSP-area tool registry. Leaves append via
 * {@link registerLspTool}; the barrel re-exports this array so the
 * composed `allTools` list picks them up.
 */
export const lspTools: ToolDefinition[] = [];

/**
 * Append a new tool definition to the LSP-area registry. The leaf-tool
 * PRs (#20–#26) each call this exactly once from their own file's top
 * level; the import in `src/tools/index.ts` ensures the side effect
 * fires before `allTools` is consumed.
 */
export function registerLspTool(def: ToolDefinition): void {
  // Sanity guard: catch the obvious "double-register" / "name collision"
  // bug here rather than letting `ListTools` return duplicates. The
  // surrounding `tools.test.ts` already asserts on uniqueness across the
  // composed list, but the per-registry guard surfaces the failure with
  // the actual offending name.
  if (lspTools.some((t) => t.name === def.name)) {
    throw new Error(`registerLspTool: duplicate tool name '${def.name}'`);
  }
  lspTools.push(def);
}
