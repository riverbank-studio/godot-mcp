/**
 * Registry-shape tests for `lsp-tools.ts`.
 *
 * The seven LSP leaves (#20–#26) each call `registerLspTool` exactly
 * once from their own file. This file asserts the registry surface
 * itself — `lspTools` is an array, `registerLspTool` appends, and the
 * dup-name guard fires. Leaf-tool behavioral tests live alongside each
 * leaf's implementation file.
 */

import { afterEach, describe, expect, it } from "vitest";

import { lspTools, registerLspTool } from "./lsp-tools.js";

describe("lsp-tools registry", () => {
  // Restore between tests so test order doesn't leak state. We capture
  // the registry's initial population (which may be non-empty once the
  // leaves land) and re-trim to that prefix after each test.
  const initialLength = lspTools.length;
  afterEach(() => {
    lspTools.length = initialLength;
  });

  it("exposes `lspTools` as a mutable array of ToolDefinitions", () => {
    expect(Array.isArray(lspTools)).toBe(true);
  });

  it("registerLspTool appends a new tool", () => {
    const def = {
      name: "godot_test_fixture_lsp",
      description: "Fixture tool used only by this test.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
      handler: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    };
    const before = lspTools.length;
    registerLspTool(def);
    expect(lspTools.length).toBe(before + 1);
    expect(lspTools.at(-1)).toBe(def);
  });

  it("registerLspTool rejects duplicate names", () => {
    const def = {
      name: "godot_dup_fixture",
      description: "Dup fixture.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
      handler: async () => ({ content: [{ type: "text" as const, text: "" }] }),
    };
    registerLspTool(def);
    expect(() => registerLspTool({ ...def })).toThrow(
      /duplicate tool name 'godot_dup_fixture'/,
    );
  });

  it("each registered tool has the ToolDefinition shape", () => {
    for (const t of lspTools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTypeOf("object");
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.handler).toBe("function");
    }
  });
});
