/**
 * Docs-area tool registry — the auto-discovery surface for the six
 * documentation tools (#14, #15, #16, #17, #18, #19).
 *
 * Why this file exists
 * --------------------
 *
 * orchestration-plan §7 ("Hotspot mitigation: auto-discovery registry")
 * identifies `src/dispatch.ts` and the legacy single `tools` array as
 * the biggest merge-conflict hotspot. The mitigation: each capability
 * area exposes a mutable `ToolDefinition[]` plus a `register*` function,
 * and per-tool PRs only add a new file under `src/tools/docs/` that
 * calls `registerDocsTool` at import time. Two leaf PRs racing each
 * other don't conflict because they touch different files.
 *
 * Auto-discovery model
 * --------------------
 *
 * For the side-effect imports to run, every leaf file must be reached
 * from a top-level import path. The barrel at `src/tools/docs/index.ts`
 * is that entry point — when a leaf is added, the leaf author appends
 * one import line to the barrel. The diff is a single-line append per
 * leaf and merges cleanly across concurrent PRs.
 *
 * The barrel is imported from this file purely for its side effects:
 *
 *   import "./docs/index.js";   // populates docsTools[] via registerDocsTool
 *
 * Phase 1 (this PR) ships the barrel empty. Phase 2 (#14–#19) adds one
 * leaf file + one barrel line each.
 *
 * Mirror modules: `editor-tools.ts`, `scene-tools.ts`, `project-tools.ts`.
 * Symmetry intentional — anyone who's seen one knows the pattern.
 */

import type { ToolDefinition } from "../shared/types.js";

/**
 * In-file mutable registry. Exported (not just returned from a getter)
 * because:
 *
 *   1. `src/tools/index.ts` composes `allTools` by spreading the
 *      area-level arrays — it needs to see the post-registration
 *      contents. With a getter we'd need a deferred-binding step.
 *   2. Tests can snapshot the registry and assert specific names are
 *      present after side-effect imports complete.
 *
 * Mutation is gated to `registerDocsTool` so leaves can't accidentally
 * inject a malformed entry by `docsTools.push(...)` directly. The
 * `as const` is omitted intentionally — the array must remain mutable.
 */
export const docsTools: ToolDefinition[] = [];

/**
 * Append a new docs tool to the registry, enforcing two invariants:
 *
 *   1. **Unique names.** A double-registration is almost always a bug —
 *      two leaves accidentally chose the same tool name, or a file got
 *      imported twice. Throwing surfaces the collision at server-startup
 *      time rather than silently shadowing one entry.
 *   2. **`godot_` prefix.** DESIGN.md L52 mandates the prefix for all
 *      v1 tools. We check here so a leaf PR that forgets the prefix
 *      fails CI rather than ships a confusingly-named tool.
 *
 * Errors thrown here propagate during the leaf's side-effect import,
 * which means the server fails to start — exactly what we want for a
 * malformed registration.
 */
export function registerDocsTool(def: ToolDefinition): void {
  if (!def.name.startsWith("godot_")) {
    throw new Error(
      `registerDocsTool: tool name '${def.name}' must start with 'godot_' (DESIGN.md L52). Rename and retry.`,
    );
  }
  if (docsTools.some((t) => t.name === def.name)) {
    throw new Error(
      `registerDocsTool: tool name '${def.name}' is already registered. Double-import or naming collision.`,
    );
  }
  docsTools.push(def);
}

/**
 * Test-only: clear the registry so each test starts from a known empty
 * state. Tests for the registry surface itself use this; production code
 * must never touch it (registration is one-way and tied to module-load
 * order).
 *
 * Underscore prefix follows the existing repo convention for test
 * back-doors (see `_resetDocsRuntimeForTesting`).
 */
export function _resetDocsToolsForTesting(): void {
  docsTools.length = 0;
}

/**
 * Side-effect import of the per-tool leaf barrel. Each leaf file under
 * `src/tools/docs/` registers itself by calling `registerDocsTool` at
 * top level; importing the barrel here is what triggers those calls.
 *
 * The barrel starts out empty (Phase 1 of #7). Phase 2 leaves (#14–#19)
 * each append one import line to the barrel — that single-line append
 * is the entirety of the dispatch-layer change required to land a new
 * docs tool.
 */
import "./docs/index.js";
