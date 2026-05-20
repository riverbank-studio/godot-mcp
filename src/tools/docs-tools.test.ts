/**
 * Registry-shape tests for `docs-tools.ts`.
 *
 * The docs-tools registry is the auto-discovery surface (DESIGN.md
 * § Module organization; orchestration-plan §7) that the six leaf docs
 * tools (#14–#19) plug into. Phase 1 of epic #7 (this file's scope) ships
 * the registry empty; leaves register themselves via `registerDocsTool`
 * in subsequent PRs.
 *
 * These tests assert the registry surface: an exported mutable array, a
 * register function, and barrel-side integration with `allTools`. The
 * per-tool behavior surface is the leaves' responsibility.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  docsTools,
  registerDocsTool,
  _resetDocsToolsForTesting,
} from "./docs-tools.js";
import { allTools } from "./index.js";
import type { ToolDefinition } from "../shared/types.js";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test description`,
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("docsTools registry", () => {
  beforeEach(() => {
    _resetDocsToolsForTesting();
  });

  it("starts empty in the infra PR; leaves register themselves later", () => {
    expect(docsTools).toEqual([]);
  });

  it("registerDocsTool appends a new tool", () => {
    const t = makeTool("godot_search_api");
    registerDocsTool(t);
    expect(docsTools).toHaveLength(1);
    expect(docsTools[0]).toBe(t);
  });

  it("registerDocsTool rejects a duplicate name", () => {
    registerDocsTool(makeTool("godot_get_class"));
    expect(() => registerDocsTool(makeTool("godot_get_class"))).toThrow(
      /already registered/i,
    );
  });

  it("registerDocsTool rejects non-godot_-prefixed names (DESIGN.md prefix invariant)", () => {
    expect(() => registerDocsTool(makeTool("search_api"))).toThrow(/godot_/i);
  });
});

describe("allTools wiring", () => {
  // We do not reset the registry here — `allTools` is a snapshot at module-load
  // time and reflects whatever the leaf imports populated.
  it("includes the docsTools array (splice point present for leaves)", () => {
    // Phase 1: empty. Phase 2+: leaves contribute. Either way the array
    // identity in `allTools` resolves through `docsTools`, so any future
    // entries flow through.
    for (const t of docsTools) {
      expect(allTools).toContain(t);
    }
  });
});
