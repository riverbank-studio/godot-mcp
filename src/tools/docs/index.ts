/**
 * Docs-tools leaf barrel — the auto-discovery entry point for the six
 * documentation tools (#14, #15, #16, #17, #18, #19).
 *
 * Adding a new docs tool
 * ----------------------
 *
 * The full ceremony for landing a new docs tool is two file edits:
 *
 *   1. Create `src/tools/docs/<tool-name>.ts`. At top-level, import
 *      `registerDocsTool` from `../docs-tools.js` and call it with the
 *      `ToolDefinition`. (See `src/tools/editor-tools.ts` for the
 *      shape; mirror that exactly.)
 *   2. Add one line to `src/tools/index.ts` (NOT this file):
 *
 *      ```ts
 *      import "./docs/<tool-name>.js";
 *      ```
 *
 *      Imports must live in `src/tools/index.ts` to avoid a
 *      temporal dead-zone (TDZ) circular dependency: this barrel
 *      is itself imported by `src/tools/index.ts`, so adding a
 *      leaf import here would create a cycle that silently breaks
 *      `registerDocsTool` registration at module-load time.
 *      Imports are intentionally side-effect-only — the leaf's
 *      `registerDocsTool` call runs when the file is loaded, which
 *      is what populates the `docsTools` array consumed by
 *      `src/tools/index.ts` → `allTools`.
 *
 * Why a manual barrel instead of dynamic discovery
 * ------------------------------------------------
 *
 * A glob-based auto-discovery (`fs.readdirSync` at module-load) is
 * tempting but trips over (a) the `build/` layout where the JS files
 * land flat, (b) bundler limits when this server is embedded, and (c)
 * test-time module isolation. A static barrel is boring but
 * predictable: every leaf is reachable from the import graph, and the
 * import order is deterministic.
 *
 * The single-line-per-leaf design is also the merge-friendliness
 * property the orchestration plan §7 calls out: six concurrent leaf
 * PRs each appending one line to this file produces a trivial git auto-
 * merge in the common case (no overlapping edits to other files).
 *
 * Phase 1 invariant
 * -----------------
 *
 * This file is intentionally empty in the epic-infra PR (Phase 1 of
 * #7). Leaf PRs append one line each; no leaf code lives here.
 */

export {};
