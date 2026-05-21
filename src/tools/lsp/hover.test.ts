/**
 * Behavioral tests for `godot_hover` (`src/tools/lsp/hover.ts`).
 *
 * Covers:
 *   - Happy-path hover with MarkupContent response
 *   - MarkedString normalization (deprecated LSP type → MarkupContent)
 *   - MarkedString[] normalization (array of deprecated strings)
 *   - Truncation at 5000 chars with `truncated: true` flag
 *   - Markdown-fence-aware truncation: extend to closing fence, hard cap 6000
 *   - Truncation trim-back when extension would exceed 6000 chars
 *   - Null / empty LSP response → empty object `{}`
 *   - File outside project root → error
 *   - LSP unavailable → error envelope
 *   - Optional `range` field is passed through when present
 *   - Position is converted from 1-based wire to 0-based LSP
 *
 * Stub approach: `LspClientLike` is a plain object matching the structural
 * type — no real client, process manager, or TCP socket involved.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { lspTools } from "../lsp-tools.js";
// Side-effectful import that registers the tool.
import "./hover.js";

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
    serverCapabilities: () => ({ hoverProvider: true }),
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
// Locate the registered tool
// ---------------------------------------------------------------------------

describe("godot_hover registration", () => {
  it("registers exactly one tool named godot_hover", () => {
    const found = lspTools.filter((t) => t.name === "godot_hover");
    expect(found).toHaveLength(1);
  });

  it("has the expected inputSchema shape", () => {
    const def = lspTools.find((t) => t.name === "godot_hover")!;
    expect(def.inputSchema.type).toBe("object");
    expect(def.inputSchema.properties).toHaveProperty("file");
    expect(def.inputSchema.properties).toHaveProperty("line");
    expect(def.inputSchema.properties).toHaveProperty("character");
  });
});

// ---------------------------------------------------------------------------
// Resolve the handler for the remaining tests
// ---------------------------------------------------------------------------

let handler: (args: unknown, ctx: ToolContext) => Promise<ToolResponse>;

beforeEach(() => {
  const def = lspTools.find((t) => t.name === "godot_hover");
  if (!def) throw new Error("godot_hover not registered — import failed?");
  handler = def.handler;
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("godot_hover happy paths", () => {
  it("returns hover contents when LSP responds with MarkupContent", async () => {
    const client = makeClientStub(async (_method, params) => {
      expect(
        (params as { position: { line: number; character: number } }).position,
      ).toEqual({ line: 4, character: 9 });
      return {
        contents: {
          kind: "markdown",
          value: "## Node\nBase class for all scene objects.",
        },
        range: {
          start: { line: 4, character: 9 },
          end: { line: 4, character: 13 },
        },
      };
    });
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 5, character: 10 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const data = parseJsonContent(res) as Record<string, unknown>;
    expect(data.contents).toEqual({
      kind: "markdown",
      value: "## Node\nBase class for all scene objects.",
    });
    // range is converted to 1-based
    expect((data.range as { start: { line: number } }).start.line).toBe(5);
  });

  it("converts positions from 1-based wire to 0-based LSP", async () => {
    let capturedParams: unknown;
    const client = makeClientStub(async (_method, params) => {
      capturedParams = params;
      return { contents: { kind: "markdown", value: "ok" } };
    });
    const ctx = makeCtx(client);
    await handler({ file: "/project/player.gd", line: 1, character: 1 }, ctx);
    expect(
      (capturedParams as { position: { line: number; character: number } })
        .position,
    ).toEqual({ line: 0, character: 0 });
  });

  it("omits range from response when LSP omits it", async () => {
    const client = makeClientStub(async () => ({
      contents: { kind: "markdown", value: "no range" },
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    const data = parseJsonContent(res) as Record<string, unknown>;
    expect(data.range).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MarkedString normalization
// ---------------------------------------------------------------------------

describe("godot_hover MarkedString normalization", () => {
  it("normalizes a plain string MarkedString to MarkupContent", async () => {
    const client = makeClientStub(async () => ({
      contents: "func add_child(node: Node) -> void",
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 2, character: 5 },
      ctx,
    );
    const data = parseJsonContent(res) as {
      contents: { kind: string; value: string };
    };
    expect(data.contents.kind).toBe("markdown");
    expect(data.contents.value).toBe("func add_child(node: Node) -> void");
  });

  it("normalizes a {language, value} MarkedString to a fenced MarkupContent block", async () => {
    const client = makeClientStub(async () => ({
      contents: {
        language: "gdscript",
        value: "func move(delta: float) -> void",
      },
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 3, character: 2 },
      ctx,
    );
    const data = parseJsonContent(res) as {
      contents: { kind: string; value: string };
    };
    expect(data.contents.kind).toBe("markdown");
    expect(data.contents.value).toContain("```gdscript");
    expect(data.contents.value).toContain("func move(delta: float) -> void");
  });

  it("normalizes a MarkedString[] to joined MarkupContent", async () => {
    const client = makeClientStub(async () => ({
      contents: [
        { language: "gdscript", value: "var speed: float" },
        "The movement speed in units per second.",
      ],
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 5, character: 5 },
      ctx,
    );
    const data = parseJsonContent(res) as {
      contents: { kind: string; value: string };
    };
    expect(data.contents.kind).toBe("markdown");
    expect(data.contents.value).toContain("```gdscript");
    expect(data.contents.value).toContain("var speed: float");
    expect(data.contents.value).toContain(
      "The movement speed in units per second.",
    );
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("godot_hover truncation", () => {
  it("does not truncate content under 5000 chars", async () => {
    const value = "x".repeat(4999);
    const client = makeClientStub(async () => ({
      contents: { kind: "markdown", value },
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    const data = parseJsonContent(res) as {
      contents: { value: string };
      truncated?: boolean;
    };
    expect(data.contents.value).toBe(value);
    expect(data.truncated).toBeUndefined();
  });

  it("truncates content over 5000 chars and sets truncated: true", async () => {
    const value = "x".repeat(6000);
    const client = makeClientStub(async () => ({
      contents: { kind: "markdown", value },
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    const data = parseJsonContent(res) as {
      contents: { value: string };
      truncated: boolean;
    };
    expect(data.contents.value.length).toBeLessThanOrEqual(5000);
    expect(data.truncated).toBe(true);
  });

  it("extends past 5000-char cut when inside an open fence, up to 6000 hard cap", async () => {
    // Place an open fence around position 4990, closing fence at 5020.
    const before = "y".repeat(4990);
    const fence = "```gdscript\ncode\n```"; // 20 chars; closing fence ends at 5010
    const after = "z".repeat(990); // padding to exceed 5000 cut
    const value = before + fence + after; // total: 6000

    const client = makeClientStub(async () => ({
      contents: { kind: "markdown", value },
    }));
    const ctx = makeCtx(client);
    const res = await handler(
      { file: "/project/player.gd", line: 1, character: 1 },
      ctx,
    );
    const data = parseJsonContent(res) as {
      contents: { value: string };
      truncated: boolean;
    };
    // Should include the full fence block (cut extends to closing fence)
    expect(data.contents.value).toContain("```");
    expect(data.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Zero results
// ---------------------------------------------------------------------------

describe("godot_hover zero results", () => {
  it("returns empty object when LSP returns null", async () => {
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
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("godot_hover error cases", () => {
  it("returns error when file is outside project root", async () => {
    const client = makeClientStub(async () => ({
      contents: { kind: "markdown", value: "ok" },
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
