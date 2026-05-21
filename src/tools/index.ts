/**
 * Composed tool registry. Each per-area module owns its own array of
 * `ToolDefinition`s; this barrel concatenates them in a deterministic
 * order so callers (and tests) can rely on it.
 *
 * Order matches DESIGN.md's tool table for the existing tools.
 *
 * **LSP leaf auto-discovery.** The LSP area uses a per-tool file pattern
 * (one file per leaf in `src/tools/lsp/`) rather than the
 * everything-in-one-file pattern of the existing areas. The leaves
 * register via {@link import("./lsp-tools.js").registerLspTool} from
 * their own file's top level; for the side effect to fire, the file
 * must be imported during startup. The imports live in `lsp-tools.ts`
 * itself — one line per leaf — so the leaf PRs only touch their own
 * file plus a single line of the registry header.
 */

import type { ToolDefinition } from "../shared/types.js";

import { editorTools } from "./editor-tools.js";
import { sceneTools } from "./scene-tools.js";
import { projectTools } from "./project-tools.js";
import { lspTools } from "./lsp-tools.js";

export { editorTools, sceneTools, projectTools, lspTools };

// LSP leaf tools — each file calls registerLspTool at import time.
// These imports MUST live here (not in lsp-tools.ts) to avoid a circular
// dependency: lsp-tools.ts exports registerLspTool which the leaves import;
// if lsp-tools.ts also imported the leaves we'd have a cycle that puts
// lspTools in the TDZ when the leaf's registerLspTool call runs.
import "./lsp/find-references.js";

/**
 * The flat, ordered list of all tools the server exposes. Concatenation
 * order: editor → scene → project → LSP. Docs will splice in once #7
 * ships.
 */
export const allTools: ToolDefinition[] = [
  ...editorTools,
  ...sceneTools,
  ...projectTools,
  ...lspTools,
];
