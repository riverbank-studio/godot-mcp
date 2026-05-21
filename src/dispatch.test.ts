/**
 * Behavioral tests for the dispatch layer. The dispatch module:
 *   1. Builds a `ListTools` response from the composed tool registry.
 *   2. Routes `CallTool` requests to the right handler by name.
 *   3. Throws an MCP `MethodNotFound` error for unknown names.
 *
 * The handler receives `(args, ctx)`. We assert the routing contract here;
 * each handler's tool-specific behavior is exercised against a real Godot
 * binary in later integration suites.
 */

import { describe, it, expect, vi } from "vitest";

import {
  buildListToolsResponse,
  callTool,
  type ToolDefinition,
  type ToolContext,
} from "./dispatch.js";

const dummyCtx: ToolContext = {} as ToolContext;

const fooTool: ToolDefinition = {
  name: "foo",
  description: "a fake tool",
  inputSchema: { type: "object", properties: {}, required: [] },
  handler: vi.fn(async () => ({ content: [{ type: "text", text: "foo-ok" }] })),
};

const barTool: ToolDefinition = {
  name: "bar",
  description: "another fake tool",
  inputSchema: { type: "object", properties: {}, required: [] },
  handler: vi.fn(async () => ({ content: [{ type: "text", text: "bar-ok" }] })),
};

describe("buildListToolsResponse", () => {
  it("returns the full {name, description, inputSchema} for each tool", () => {
    const res = buildListToolsResponse([fooTool, barTool]);
    expect(res.tools).toHaveLength(2);
    expect(res.tools[0]).toEqual({
      name: "foo",
      description: "a fake tool",
      inputSchema: fooTool.inputSchema,
    });
    // The handler is intentionally NOT exposed in the ListTools response.
    expect(res.tools[0]).not.toHaveProperty("handler");
  });
});

describe("callTool", () => {
  it("routes to the matching handler and passes args + ctx", async () => {
    await callTool([fooTool, barTool], dummyCtx, "foo", { x: 1 });
    expect(fooTool.handler).toHaveBeenCalledWith({ x: 1 }, dummyCtx);
  });

  it("throws MethodNotFound for unknown tool names", async () => {
    await expect(
      callTool([fooTool, barTool], dummyCtx, "nope", {}),
    ).rejects.toThrowError(/Unknown tool: nope/);
  });
});
