/**
 * Behavioral tests for `godot_signature_help` (`src/tools/lsp/signature-help.ts`).
 *
 * Covers:
 *   - Registration: tool is present in `lspTools` with the correct schema shape.
 *   - Happy path: full SignatureHelp response with signatures, activeSignature,
 *     activeParameter is returned verbatim (wire-format JSON).
 *   - Out-of-context: LSP returns `null` / `undefined` → empty object `{}`,
 *     never an MCP error (DESIGN.md L492 universal zero-results rule; issue #26:
 *     "Returns empty (not error) when out of context").
 *   - Empty signatures array: normalised to `{}` (defensive — some LSP impls
 *     return `{ signatures: [] }` instead of `null`).
 *   - Position conversion: wire 1-based → LSP 0-based.
 *   - File outside project root → MCP error.
 *   - LSP subsystem unavailable (ctx.lsp not set) → MCP error.
 *
 * Stub approach: `LspClientLike` is a plain object matching the structural
 * type — no real client, process manager, or TCP socket involved.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { lspTools } from "../lsp-tools.js";
// Side-effectful import that registers the tool.
import "./signature-help.js";

import type { LspClientLike } from "../../lsp/tool-helpers.js";
import type { ToolContext, ToolResponse } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/** Minimal stub satisfying `LspClientLike`. */
function makeClientStub(
  requestImpl: (method: string, params: unknown) => Promise<unknown>,
): LspClientLike {
  return {
    request: (method, params) => requestImpl(method, params) as Promise<never>,
    notify: async () => {},
    getDiagnostics: async () => ({ diagnostics: [], partial: false }),
    serverCapabilities: () => ({ signatureHelpProvider: true }),
  };
}

/** Build a `ToolContext` with a stubbed LSP provider and fixed project root. */
function makeCtx(client: LspClientLike, projectRoot = "/project"): ToolContext {
  return {
    getGodotPath: async () => null,
    setGodotPath: async () => false,
    isValidGodotPath: async () => false,
    logDebug: () => {},
    executeOperation: async () => ({ stdout: "", stderr: "" }),
    activeProcess: {
      get: () => null,
      set: () => {},
      clear: () => {},
      kill: () => {},
    },
    strictPathValidation: false,
    godotDebugMode: false,
    lsp: {
      get: () => client as unknown,
      projectRoot: () => projectRoot,
    },
  };
}

/** Parse the first text content item from a ToolResponse as JSON. */
function parseJsonContent(res: ToolResponse): unknown {
  const text = res.content[0]?.text ?? "";
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("godot_signature_help registration", () => {
  it("registers exactly one tool named godot_signature_help", () => {
    const found = lspTools.filter((t) => t.name === "godot_signature_help");
    expect(found).toHaveLength(1);
  });

  it("has the expected inputSchema shape", () => {
    const def = lspTools.find((t) => t.name === "godot_signature_help")!;
    expect(def.inputSchema.type).toBe("object");
    expect(def.inputSchema.properties).toHaveProperty("file");
    expect(def.inputSchema.properties).toHaveProperty("line");
    expect(def.inputSchema.properties).toHaveProperty("character");
    expect(def.inputSchema.required).toContain("file");
    expect(def.inputSchema.required).toContain("line");
    expect(def.inputSchema.required).toContain("character");
  });

  it("has a non-empty description", () => {
    const def = lspTools.find((t) => t.name === "godot_signature_help")!;
    expect(typeof def.description).toBe("string");
    expect(def.description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Resolve the handler for remaining tests
// ---------------------------------------------------------------------------

let handler: (args: unknown, ctx: ToolContext) => Promise<ToolResponse>;

beforeEach(() => {
  const def = lspTools.find((t) => t.name === "godot_signature_help");
  if (!def)
    throw new Error("godot_signature_help not registered — import failed?");
  handler = def.handler;
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("godot_signature_help happy paths", () => {
  it("returns SignatureHelp when LSP responds with a full result", async () => {
    const client = makeClientStub(async (_method, params) => {
      // Verify position was converted 1-based → 0-based before sending.
      expect(
        (params as { position: { line: number; character: number } }).position,
      ).toEqual({ line: 4, character: 9 });
      return {
        signatures: [
          {
            label: "move(delta: float) -> void",
            documentation: { kind: "markdown", value: "Move the node." },
            parameters: [
              { label: "delta: float", documentation: "Delta time." },
            ],
          },
        ],
        activeSignature: 0,
        activeParameter: 0,
      };
    });
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 5, character: 10 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const data = parseJsonContent(res) as {
      signatures: unknown[];
      activeSignature: number;
      activeParameter: number;
    };
    expect(data.signatures).toHaveLength(1);
    expect(data.activeSignature).toBe(0);
    expect(data.activeParameter).toBe(0);
  });

  it("returns the full signatures array with all fields intact", async () => {
    const sigPayload = {
      signatures: [
        {
          label: "func_a(x: int, y: int) -> bool",
          parameters: [{ label: "x: int" }, { label: "y: int" }],
        },
        {
          label: "func_a(x: float) -> bool",
          parameters: [{ label: "x: float" }],
        },
      ],
      activeSignature: 1,
      activeParameter: 0,
    };
    const client = makeClientStub(async () => sigPayload);
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 3, character: 5 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const data = parseJsonContent(res) as typeof sigPayload;
    expect(data.signatures).toHaveLength(2);
    expect(data.activeSignature).toBe(1);
    expect(data.signatures[0]).toMatchObject({
      label: "func_a(x: int, y: int) -> bool",
    });
  });

  it("converts positions from 1-based wire to 0-based LSP", async () => {
    let capturedParams: unknown;
    const client = makeClientStub(async (_method, params) => {
      capturedParams = params;
      return {
        signatures: [{ label: "fn()" }],
        activeSignature: 0,
        activeParameter: 0,
      };
    });
    const ctx = makeCtx(client);
    await handler({ file: "/project/player.gd", line: 1, character: 1 }, ctx);
    expect(
      (capturedParams as { position: { line: number; character: number } })
        .position,
    ).toEqual({ line: 0, character: 0 });
  });

  it("sends a textDocument/signatureHelp LSP request", async () => {
    let capturedMethod = "";
    const client = makeClientStub(async (method) => {
      capturedMethod = method;
      return {
        signatures: [{ label: "fn()" }],
        activeSignature: 0,
        activeParameter: 0,
      };
    });
    const ctx = makeCtx(client);
    await handler({ file: "/project/player.gd", line: 2, character: 3 }, ctx);
    expect(capturedMethod).toBe("textDocument/signatureHelp");
  });
});

// ---------------------------------------------------------------------------
// Out-of-context (zero-results) cases
// ---------------------------------------------------------------------------

describe("godot_signature_help out-of-context / zero results", () => {
  it("returns empty object when LSP returns null (out of context)", async () => {
    const client = makeClientStub(async () => null);
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const data = parseJsonContent(res);
    expect(data).toEqual({});
  });

  it("returns empty object when LSP returns undefined", async () => {
    const client = makeClientStub(async () => undefined);
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const data = parseJsonContent(res);
    expect(data).toEqual({});
  });

  it("returns empty object when LSP returns empty signatures array", async () => {
    const client = makeClientStub(async () => ({
      signatures: [],
      activeSignature: 0,
      activeParameter: 0,
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const data = parseJsonContent(res);
    expect(data).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("godot_signature_help error cases", () => {
  it("returns error when file is outside project root", async () => {
    const client = makeClientStub(async () => ({
      signatures: [{ label: "fn()" }],
      activeSignature: 0,
      activeParameter: 0,
    }));
    const ctx = makeCtx(client, "/project");
    const res = await handler(
      { file: "/other/player.gd", line: 1, character: 1 },
      ctx,
    );
    expect(res.isError).toBe(true);
    const text = res.content[0]?.text ?? "";
    expect(text).toMatch(/outside.*project|project.*root/i);
  });

  it("returns error when LSP subsystem is unavailable", async () => {
    const ctx: ToolContext = {
      getGodotPath: async () => null,
      setGodotPath: async () => false,
      isValidGodotPath: async () => false,
      logDebug: () => {},
      executeOperation: async () => ({ stdout: "", stderr: "" }),
      activeProcess: {
        get: () => null,
        set: () => {},
        clear: () => {},
        kill: () => {},
      },
      strictPathValidation: false,
      godotDebugMode: false,
      // lsp intentionally omitted
    };
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    expect(res.isError).toBe(true);
    const text = res.content[0]?.text ?? "";
    expect(text).toMatch(/lsp.*not configured|not configured/i);
  });
});
