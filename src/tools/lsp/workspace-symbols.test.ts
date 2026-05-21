/**
 * Behavioral tests for the `godot_workspace_symbols` leaf tool (#24).
 *
 * Tests cover:
 *   - `SymbolInformation[]` response (the shape workspace/symbol returns).
 *   - Zero-results rule (DESIGN.md L492): empty array, not an error.
 *   - Null LSP response → empty result.
 *   - Missing / empty `query` argument → error.
 *   - Whitespace-only `query` argument → error (minLength: 1 validation).
 *   - LSP subsystem not configured → error response (via `withLspClient`).
 *   - LSP error during request → mapped error envelope.
 *   - Tool is registered under the name `godot_workspace_symbols`.
 *   - LSP method `workspace/symbol` is called with the correct params.
 *   - `uriToFilePath` applied to each result's location URI.
 *   - 0-based LSP positions converted to 1-based wire positions.
 *   - Each result carries a `source` field (adapter integration).
 *   - Zero native + tracked file produces non-empty results (adapter regression).
 */

import { describe, it, expect } from "vitest";

import { lspTools } from "../lsp-tools.js";
import type { LspClientLike } from "../../lsp/tool-helpers.js";
import { DocumentTracker } from "../../lsp/tool-helpers.js";
import type { ToolContext, ToolDefinition } from "../../shared/types.js";
import { LspConnectionLostError } from "../../lsp/errors.js";

// ---------------------------------------------------------------------------
// Side-effect import: registers the tool.
// ---------------------------------------------------------------------------
import "./workspace-symbols.js";

// ---------------------------------------------------------------------------
// LSP response shape
// ---------------------------------------------------------------------------

/**
 * LSP `SymbolInformation` — the only shape `workspace/symbol` returns.
 * Discriminated from `DocumentSymbol` by `location` (not `range`) at the
 * top level.
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

/**
 * LSP `DocumentSymbol` — the hierarchical shape returned by
 * `textDocument/documentSymbol`. Used for adapter fallback tests.
 */
interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  detail?: string;
  children?: LspDocumentSymbol[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake `LspClientLike` that returns a canned result. */
function makeClient(
  resultFn: (method: string, params: unknown) => unknown,
  tracker?: DocumentTracker,
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
    // Expose the document tracker when provided — used by adapter integration tests.
    ...(tracker !== undefined ? { documents: () => tracker } : {}),
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

/** Retrieve the registered `godot_workspace_symbols` tool definition. */
function getTool(): ToolDefinition {
  const def = lspTools.find((t) => t.name === "godot_workspace_symbols");
  if (!def) throw new Error("godot_workspace_symbols not registered");
  return def;
}

/** Build a sample LSP SymbolInformation entry. */
function makeSymbolInformation(
  name: string,
  kind: number,
  line: number,
  uri = "file:///fake/project/player.gd",
  containerName?: string,
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
    ...(containerName !== undefined ? { containerName } : {}),
  };
}

/**
 * Build a DocumentTracker pre-seeded with `filePaths` as if they had been
 * opened. Uses the no-op filesystem stub so `syncReferenced` never fires
 * real I/O.
 */
function makeTrackerWithFiles(filePaths: string[]): DocumentTracker {
  // Stub synchronous fs that always returns a stat — simulates files that
  // are present on disk so syncReferenced can open them and register them
  // into the tracker without real I/O.
  const stubStat = { mtimeMs: 1_000_000, size: 100 };
  const tracker = new DocumentTracker({
    statPollThrottleMs: Number.MAX_SAFE_INTEGER,
    fs: {
      statSync: () => stubStat,
      readFileSync: () => "# stub",
    },
  });
  // Force-inject tracked files by syncing them as referenced (lazy open path).
  for (const fp of filePaths) {
    tracker.syncReferenced([fp]);
  }
  return tracker;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers exactly one tool named godot_workspace_symbols", () => {
    const matches = lspTools.filter(
      (t) => t.name === "godot_workspace_symbols",
    );
    expect(matches.length).toBe(1);
  });

  it("tool has required ToolDefinition fields", () => {
    const def = getTool();
    expect(typeof def.description).toBe("string");
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.inputSchema.type).toBe("object");
    expect(typeof def.handler).toBe("function");
  });

  it("tool schema requires a `query` property", () => {
    const def = getTool();
    expect(def.inputSchema.required).toContain("query");
  });

  it("query schema has minLength: 1", () => {
    const def = getTool();
    const querySchema = def.inputSchema.properties?.["query"] as {
      minLength?: number;
    };
    expect(querySchema?.minLength).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("happy path — SymbolInformation[] response", () => {
  it("returns a symbols array on a valid response", async () => {
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation("Player", 5 /* Class */, 0),
      makeSymbolInformation("_ready", 12 /* Function */, 5),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "player" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as { symbols: unknown[] };
    expect(Array.isArray(body.symbols)).toBe(true);
    expect(body.symbols).toHaveLength(2);
  });

  it("converts 0-based LSP positions to 1-based wire positions", async () => {
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation("_process", 12, 9),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "process" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{
        location: { range: { start: { line: number; character: number } } };
      }>;
    };
    // LSP 0-based line 9 → wire 1-based line 10
    expect(body.symbols[0].location.range.start.line).toBe(10);
    expect(body.symbols[0].location.range.start.character).toBe(1);
  });

  it("decodes URI to a file path in each symbol's location", async () => {
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation("Player", 5, 0, "file:///fake/project/player.gd"),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "Player" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ location: { path: string } }>;
    };
    // URI decoded to a path; the exact drive-letter prefix varies by platform
    expect(body.symbols[0].location.path).toMatch(/fake\/project\/player\.gd$/);
  });

  it("preserves containerName when present", async () => {
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation(
        "speed",
        7 /* Variable */,
        3,
        "file:///fake/project/player.gd",
        "Player",
      ),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "speed" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ containerName?: string }>;
    };
    expect(body.symbols[0].containerName).toBe("Player");
  });

  it("omits containerName when absent", async () => {
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation("Player", 5, 0),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "Player" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ containerName?: string }>;
    };
    expect(body.symbols[0].containerName).toBeUndefined();
  });

  it("passes through non-file URIs (e.g. gdscript://) unchanged in the path field", async () => {
    const syntheticUri = "gdscript://@GlobalScope";
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation("PI", 14 /* Constant */, 0, syntheticUri),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "PI" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ location: { uri: string; path: string } }>;
    };
    // uriToFilePath returns the URI unchanged for non-file:// schemes
    expect(body.symbols[0].location.path).toBe(syntheticUri);
  });

  it("each result entry includes a source field", async () => {
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation("Player", 5, 0),
      makeSymbolInformation("_ready", 12, 5),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "Player" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ source: string }>;
    };
    for (const sym of body.symbols) {
      expect(["lsp", "docs", "grep_fallback"]).toContain(sym.source);
    }
  });
});

// ---------------------------------------------------------------------------
// Zero-results rule (DESIGN.md L492)
// ---------------------------------------------------------------------------

describe("zero-results rule", () => {
  it("returns empty symbols array (not an error) when LSP returns []", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "nothing" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as { symbols: unknown[] };
    expect(body.symbols).toHaveLength(0);
  });

  it("returns empty symbols array (not an error) when LSP returns null", async () => {
    const client = makeClient(() => null);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "nothing" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as { symbols: unknown[] };
    expect(body.symbols).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("validation errors", () => {
  it("returns an error when `query` argument is missing", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client);

    const res = await getTool().handler({}, ctx);

    expect(res.isError).toBe(true);
  });

  it("returns an error when `query` is an empty string", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "" }, ctx);

    expect(res.isError).toBe(true);
  });

  it("returns an error when `query` is not a string", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: 42 }, ctx);

    expect(res.isError).toBe(true);
  });

  it("returns an error when `query` is whitespace-only", async () => {
    const client = makeClient(() => []);
    const ctx = makeCtx(client);

    // A string of only spaces passes the `typeof` check but fails `trim() === ""`
    const res = await getTool().handler({ query: "   " }, ctx);

    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/non-empty/i);
  });
});

// ---------------------------------------------------------------------------
// LSP subsystem failures
// ---------------------------------------------------------------------------

describe("LSP subsystem failures", () => {
  it("returns an error when ctx.lsp is not configured", async () => {
    const ctx = {} as ToolContext;

    const res = await getTool().handler({ query: "Player" }, ctx);

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

    const res = await getTool().handler({ query: "Player" }, ctx);

    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/connection_lost|retry/i);
  });
});

// ---------------------------------------------------------------------------
// LSP method and params
// ---------------------------------------------------------------------------

describe("LSP request params", () => {
  it("sends workspace/symbol with the query string", async () => {
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

    await getTool().handler({ query: "Player" }, ctx);

    expect(capturedMethod).toBe("workspace/symbol");
    expect(capturedParams).toMatchObject({ query: "Player" });
  });
});

// ---------------------------------------------------------------------------
// Adapter integration
// ---------------------------------------------------------------------------

describe("adapter integration", () => {
  it("result entries have source: 'lsp' when native results are returned", async () => {
    const symbols: LspSymbolInformation[] = [
      makeSymbolInformation("Player", 5, 0),
    ];
    const client = makeClient(() => symbols);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "Player" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ source: string }>;
    };
    expect(body.symbols[0].source).toBe("lsp");
  });

  it("zero native results + tracked .gd file with matching symbol produces a non-empty response", async () => {
    // The adapter fans out documentSymbol over tracked files when workspace/symbol
    // returns empty — this is the key regression vector for the adapter integration.
    const docSymbol: LspDocumentSymbol = {
      name: "Player",
      kind: 5, // Class
      range: {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      },
      selectionRange: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 6 },
      },
    };

    const trackedFile = "/fake/project/player.gd";
    const tracker = makeTrackerWithFiles([trackedFile]);

    const client = makeClient((method: string) => {
      if (method === "workspace/symbol") return []; // native returns empty
      if (method === "textDocument/documentSymbol") return [docSymbol];
      return [];
    }, tracker);
    const ctx = makeCtx(client);

    const res = await getTool().handler({ query: "Player" }, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as {
      symbols: Array<{ name: string; source: string }>;
    };
    // Adapter fallback should have found "Player" from documentSymbol
    expect(body.symbols.length).toBeGreaterThan(0);
    const found = body.symbols.find((s) => s.name === "Player");
    expect(found).toBeDefined();
    expect(found?.source).toBe("lsp");
  });
});
