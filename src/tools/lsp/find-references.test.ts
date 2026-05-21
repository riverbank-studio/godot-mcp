/**
 * Behavioral tests for the `godot_find_references` leaf tool.
 *
 * The tool wraps `textDocument/references` and maps the LSP `Location[]`
 * response to a wire-friendly array with 1-based positions. A real LSP
 * connection is never required — each test constructs a minimal stub of
 * {@link LspClientLike} and passes it through a fake {@link ToolContext}.
 *
 * Coverage:
 *   - Happy path: returns a mapped array of reference locations.
 *   - Zero results: returns an empty array (universal zero-results rule,
 *     DESIGN.md L492).
 *   - LSP null result: treated the same as empty array.
 *   - File outside project root: returns an MCP error, no LSP call made.
 *   - LSP context unavailable (ctx.lsp undefined): returns an MCP error.
 *   - LSP error mid-request: returns a mapped MCP error envelope.
 *   - Schema / registration: tool is registered with the correct name,
 *     required fields, and a non-empty description.
 */

import { describe, it, expect } from "vitest";

import { lspTools } from "../lsp-tools.js";
// Side-effect import registers the tool.
import "./find-references.js";

import type { LspClientLike } from "../../lsp/tool-helpers.js";
import type { ToolContext } from "../../shared/types.js";
import { LspConnectionLostError } from "../../lsp/errors.js";
import { filePathToUri } from "../../lsp/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake client stub used across tests. `resolvedResult` is returned by `request`. */
function makeClient(
  resolvedResult: unknown = [],
): LspClientLike & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request<TResult>(method: string, params: unknown): Promise<TResult> {
      calls.push({ method, params });
      return resolvedResult as TResult;
    },
    async notify(): Promise<void> {},
    async getDiagnostics() {
      return { diagnostics: [], partial: false };
    },
    serverCapabilities() {
      return {};
    },
    projectRoot() {
      return "/fake/project";
    },
  };
}

function makeCtx(
  client: LspClientLike,
  projectRoot = "/fake/project",
): ToolContext {
  return {
    lsp: { get: () => client, projectRoot: () => projectRoot },
  } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Find the registered tool
// ---------------------------------------------------------------------------

describe("godot_find_references — registration", () => {
  it("is registered in lspTools with the correct name", () => {
    const tool = lspTools.find((t) => t.name === "godot_find_references");
    expect(tool).toBeDefined();
  });

  it("has a non-empty description", () => {
    const tool = lspTools.find((t) => t.name === "godot_find_references")!;
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("has the expected required input schema fields", () => {
    const tool = lspTools.find((t) => t.name === "godot_find_references")!;
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).toContain("file");
    expect(tool.inputSchema.required).toContain("line");
    expect(tool.inputSchema.required).toContain("character");
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests
// ---------------------------------------------------------------------------

describe("godot_find_references — behavior", () => {
  /** Retrieve the registered handler so we can call it directly. */
  function getHandler() {
    const tool = lspTools.find((t) => t.name === "godot_find_references");
    if (!tool) throw new Error("godot_find_references not registered");
    return tool.handler;
  }

  it("returns mapped Location[] with 1-based positions on success", async () => {
    const lspLocations = [
      {
        uri: filePathToUri("/fake/project/scripts/player.gd"),
        range: {
          start: { line: 9, character: 4 },
          end: { line: 9, character: 10 },
        },
      },
      {
        uri: filePathToUri("/fake/project/scripts/enemy.gd"),
        range: {
          start: { line: 24, character: 0 },
          end: { line: 24, character: 6 },
        },
      },
    ];
    const client = makeClient(lspLocations);
    const ctx = makeCtx(client);

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 5, character: 3 },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as unknown[];
    expect(parsed).toHaveLength(2);

    const first = parsed[0] as {
      file: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    };
    // LSP 0-based → wire 1-based
    expect(first.range.start.line).toBe(10);
    expect(first.range.start.character).toBe(5);
    expect(first.range.end.line).toBe(10);
    expect(first.range.end.character).toBe(11);
  });

  it("sends the correct textDocument/references request params", async () => {
    const client = makeClient([]);
    const ctx = makeCtx(client);

    // Use the exact file path that makeCtx/validateFileInProject will accept
    // (inside "/fake/project"). On Windows, `validateFileInProject` resolves
    // the path so we derive the expected URI from the same helper to stay
    // platform-portable.
    const filePath = "/fake/project/scripts/player.gd";
    await getHandler()({ file: filePath, line: 1, character: 1 }, ctx);

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call.method).toBe("textDocument/references");
    const params = call.params as {
      textDocument: { uri: string };
      position: { line: number; character: number };
      context: { includeDeclaration: boolean };
    };
    // The URI is derived from the validated (resolved) file path; verify
    // that it is a file:// URI containing the file name.
    expect(params.textDocument.uri).toMatch(/^file:\/\/\//);
    expect(params.textDocument.uri).toContain("player.gd");
    // Wire 1-based → LSP 0-based
    expect(params.position.line).toBe(0);
    expect(params.position.character).toBe(0);
    expect(params.context.includeDeclaration).toBe(true);
  });

  it("returns an empty array when LSP returns []", async () => {
    const client = makeClient([]);
    const ctx = makeCtx(client);

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 1, character: 1 },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as unknown[];
    expect(parsed).toEqual([]);
  });

  it("returns an empty array when LSP returns null", async () => {
    const client = makeClient(null);
    const ctx = makeCtx(client);

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 1, character: 1 },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as unknown[];
    expect(parsed).toEqual([]);
  });

  it("returns an MCP error when the file is outside the project root", async () => {
    const client = makeClient([]);
    const ctx = makeCtx(client, "/fake/project");

    const result = await getHandler()(
      { file: "/other/project/scripts/player.gd", line: 1, character: 1 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(client.calls).toHaveLength(0);
    const joined = result.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/outside the project root/);
  });

  it("returns an MCP error when ctx.lsp is undefined", async () => {
    const ctx = {} as ToolContext;

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 1, character: 1 },
      ctx,
    );

    expect(result.isError).toBe(true);
    const joined = result.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/LSP/);
  });

  it("maps an LspConnectionLostError to an MCP error envelope", async () => {
    const client = makeClient(null);
    // Override request to throw mid-flight
    client.request = async () => {
      throw new LspConnectionLostError("socket closed");
    };
    const ctx = makeCtx(client);

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 1, character: 1 },
      ctx,
    );

    expect(result.isError).toBe(true);
    const joined = result.content.map((c) => c.text).join("\n");
    expect(joined).toContain("connection_lost");
  });

  it("returns an MCP error (not an uncaught throw) when line is 0", async () => {
    const client = makeClient([]);
    const ctx = makeCtx(client);

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 0, character: 1 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(client.calls).toHaveLength(0);
    const joined = result.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/line/);
  });

  it("returns an MCP error (not an uncaught throw) when character is 0", async () => {
    const client = makeClient([]);
    const ctx = makeCtx(client);

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 1, character: 0 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(client.calls).toHaveLength(0);
    const joined = result.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/character/);
  });

  it("includes file path in each returned reference", async () => {
    const fileUri = filePathToUri("/fake/project/scripts/player.gd");
    const lspLocations = [
      {
        uri: fileUri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
      },
    ];
    const client = makeClient(lspLocations);
    const ctx = makeCtx(client);

    const result = await getHandler()(
      { file: "/fake/project/scripts/player.gd", line: 1, character: 1 },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as Array<{
      file: string;
    }>;
    expect(parsed[0].file).toBe("/fake/project/scripts/player.gd");
  });
});
