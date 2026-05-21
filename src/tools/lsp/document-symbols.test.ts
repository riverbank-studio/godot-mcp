/**
 * Behavioral tests for the `godot_document_symbols` leaf tool (#23).
 *
 * Tests cover:
 *   - Hierarchical `DocumentSymbol[]` response (preferred).
 *   - Flat `SymbolInformation[]` fallback.
 *   - 500-symbol cap with `truncated: true`.
 *   - Zero-results rule (DESIGN.md L492): empty array, not an error.
 *   - Null LSP response (server returns nothing) → empty result.
 *   - In-project guard (file outside project root → error).
 *   - Missing `file` argument → error.
 *   - LSP subsystem not configured → error response (via `withLspClient`).
 *   - LSP error during request → mapped error envelope.
 *   - Tool is registered under the name `godot_document_symbols`.
 */

import { describe, it, expect } from "vitest";

import { lspTools } from "../lsp-tools.js";
import type { LspClientLike } from "../../lsp/tool-helpers.js";
import type { ToolContext, ToolDefinition } from "../../shared/types.js";
import { LspConnectionLostError } from "../../lsp/errors.js";

// ---------------------------------------------------------------------------
// Side-effect import: registers the tool.
// ---------------------------------------------------------------------------
import "./document-symbols.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A raw LSP `DocumentSymbol` node (hierarchical).
 */
interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children?: LspDocumentSymbol[];
}

/**
 * A raw LSP `SymbolInformation` node (flat).
 */
interface LspSymbolInformation {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  };
  containerName?: string;
}

/** Build a fake `LspClientLike` that returns a canned result for any `request()` call. */
function makeClient(
  resultFn: (method: string, params: unknown) => unknown,
): LspClientLike {
  return {
    async request<TResult>(method: string, params: unknown): Promise<TResult> {
      return resultFn(method, params) as TResult;
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

/** Build a minimal `ToolContext` with a stub LSP provider. */
function makeCtx(
  client: LspClientLike,
  projectRoot = "/fake/project",
): ToolContext {
  return {
    lsp: { get: () => client, projectRoot: () => projectRoot },
  } as unknown as ToolContext;
}

/** Retrieve the registered `godot_document_symbols` tool definition. */
function getTool(): ToolDefinition {
  const def = lspTools.find((t) => t.name === "godot_document_symbols");
  if (!def) throw new Error("godot_document_symbols not registered");
  return def;
}

// ---------------------------------------------------------------------------
// Factories for sample LSP payloads
// ---------------------------------------------------------------------------

function makeDocumentSymbol(
  name: string,
  kind: number,
  line: number,
  children?: LspDocumentSymbol[],
): LspDocumentSymbol {
  return {
    name,
    kind,
    range: {
      start: { line, character: 0 },
      end: { line: line + 1, character: 0 },
    },
    selectionRange: {
      start: { line, character: 0 },
      end: { line, character: name.length },
    },
    children,
  };
}

function makeSymbolInformation(
  name: string,
  kind: number,
  line: number,
  uri = "file:///fake/project/player.gd",
): LspSymbolInformation {
  return {
    name,
    kind,
    location: {
      uri,
      range: {
        start: { line, character: 0 },
        end: { line: line + 1, character: 0 },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers exactly one tool named godot_document_symbols", () => {
    const matches = lspTools.filter((t) => t.name === "godot_document_symbols");
    expect(matches.length).toBe(1);
  });

  it("tool has required ToolDefinition fields", () => {
    const def = getTool();
    expect(typeof def.description).toBe("string");
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.inputSchema.type).toBe("object");
    expect(typeof def.handler).toBe("function");
  });

  it("tool schema requires a `file` property", () => {
    const def = getTool();
    expect(def.inputSchema.required).toContain("file");
  });
});

// ---------------------------------------------------------------------------
// Happy path — hierarchical DocumentSymbol[]
// ---------------------------------------------------------------------------

describe("hierarchical DocumentSymbol[] response", () => {
  it("returns a symbols array with 1-based positions", async () => {
    const symbols: LspDocumentSymbol[] = [
      makeDocumentSymbol("Player", 5 /* Class */, 0),
      makeDocumentSymbol("_ready", 12 /* Function */, 5),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: unknown[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(Array.isArray(body.symbols)).toBe(true);
    expect(body.symbols).toHaveLength(2);
  });

  it("converts 0-based LSP positions to 1-based wire positions", async () => {
    const symbols: LspDocumentSymbol[] = [
      makeDocumentSymbol("_process", 12, 10),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ range: { start: { line: number; character: number } } }>;
    };
    // LSP 0-based line 10 → 1-based line 11
    expect(body.symbols[0].range.start.line).toBe(11);
    expect(body.symbols[0].range.start.character).toBe(1);
  });

  it("includes children in hierarchical symbols", async () => {
    const child = makeDocumentSymbol("speed", 7 /* Variable */, 2);
    const parent = makeDocumentSymbol("Player", 5, 0, [child]);
    const client = makeClient(() => [parent]);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ children?: unknown[] }>;
    };
    expect(body.symbols[0].children).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Flat SymbolInformation[] fallback
// ---------------------------------------------------------------------------

describe("flat SymbolInformation[] fallback", () => {
  it("handles flat SymbolInformation array (has .location, not .range)", async () => {
    const flat: LspSymbolInformation[] = [
      makeSymbolInformation("Player", 5, 0),
      makeSymbolInformation("_ready", 12, 5),
    ];
    const client = makeClient(() => flat);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: unknown[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.symbols).toHaveLength(2);
  });

  it("converts 0-based LSP positions in SymbolInformation to 1-based wire", async () => {
    const flat: LspSymbolInformation[] = [
      makeSymbolInformation("_process", 12, 9),
    ];
    const client = makeClient(() => flat);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ range: { start: { line: number; character: number } } }>;
    };
    // LSP 0-based line 9 → 1-based line 10
    expect(body.symbols[0].range.start.line).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 500-symbol cap
// ---------------------------------------------------------------------------

describe("500-symbol cap", () => {
  it("caps at 500 and sets truncated: true when response exceeds 500 flat symbols", async () => {
    // Build 600 flat symbols.
    const many: LspSymbolInformation[] = Array.from({ length: 600 }, (_, i) =>
      makeSymbolInformation(`sym_${i}`, 12, i),
    );
    const client = makeClient(() => many);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: unknown[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.symbols).toHaveLength(500);
  });

  it("does not set truncated when exactly 500 symbols returned", async () => {
    const exact: LspSymbolInformation[] = Array.from({ length: 500 }, (_, i) =>
      makeSymbolInformation(`sym_${i}`, 12, i),
    );
    const client = makeClient(() => exact);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    const body = JSON.parse(res.content[0].text) as {
      symbols: unknown[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.symbols).toHaveLength(500);
  });

  it("counts hierarchical symbols by flattening children for the cap check", async () => {
    // Build 600 hierarchical symbols (no children) and check cap applies.
    const many: LspDocumentSymbol[] = Array.from({ length: 600 }, (_, i) =>
      makeDocumentSymbol(`sym_${i}`, 12, i),
    );
    const client = makeClient(() => many);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    const body = JSON.parse(res.content[0].text) as {
      symbols: unknown[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.symbols).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------
// Zero-results rule (DESIGN.md L492)
// ---------------------------------------------------------------------------

describe("zero-results rule", () => {
  it("returns empty symbols array (not an error) when LSP returns []", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: unknown[];
      truncated: boolean;
    };
    expect(body.symbols).toHaveLength(0);
    expect(body.truncated).toBe(false);
  });

  it("returns empty symbols array (not an error) when LSP returns null", async () => {
    const client = makeClient(() => null);
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: unknown[];
    };
    expect(body.symbols).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("validation errors", () => {
  it("returns an error when `file` argument is missing", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client);

    const res = await getTool().handler({}, ctx);

    expect(res.isError).toBe(true);
  });

  it("returns an error when file is outside the project root", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client, "/fake/project");

    const res = await getTool().handler(
      { file: "/other/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/outside the project root/i);
  });
});

// ---------------------------------------------------------------------------
// LSP subsystem failures
// ---------------------------------------------------------------------------

describe("LSP subsystem failures", () => {
  it("returns an error when ctx.lsp is not configured", async () => {
    const ctx = {} as ToolContext;

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/LSP/);
  });

  it("returns a mapped error when the LSP request throws LspConnectionLostError", async () => {
    const client: LspClientLike = {
      async request() {
        throw new LspConnectionLostError("dropped mid-request");
      },
      async notify() {},
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
    const ctx = makeCtx(client);

    const res = await getTool().handler(
      { file: "/fake/project/player.gd" },
      ctx,
    );

    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/connection_lost|retry/i);
  });
});

// ---------------------------------------------------------------------------
// LSP method and params
// ---------------------------------------------------------------------------

describe("LSP request params", () => {
  it("sends textDocument/documentSymbol with the correct URI", async () => {
    let capturedMethod = "";
    let capturedParams: unknown = null;

    const client: LspClientLike = {
      async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        capturedMethod = method;
        capturedParams = params;
        return [] as TResult;
      },
      async notify() {},
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
    const ctx = makeCtx(client);

    await getTool().handler({ file: "/fake/project/player.gd" }, ctx);

    expect(capturedMethod).toBe("textDocument/documentSymbol");
    expect(capturedParams).toMatchObject({
      textDocument: { uri: expect.stringContaining("player.gd") },
    });
  });

  it("passes the file as a referenced file to enable didOpen tracking", async () => {
    let capturedReferencedFiles: readonly string[] = [];

    const client: LspClientLike = {
      async request<TResult>(
        _method: string,
        _params: unknown,
        referencedFiles: readonly string[] = [],
      ): Promise<TResult> {
        capturedReferencedFiles = referencedFiles;
        return [] as TResult;
      },
      async notify() {},
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
    const ctx = makeCtx(client);

    await getTool().handler({ file: "/fake/project/player.gd" }, ctx);

    // The validated path may include a drive letter on Windows (e.g.
    // `E:/fake/project/player.gd`); check for the platform-portable suffix.
    const found = capturedReferencedFiles.some((f) =>
      f.endsWith("/fake/project/player.gd"),
    );
    expect(found).toBe(true);
  });
});
