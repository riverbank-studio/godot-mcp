/**
 * Behavioral tests for the `godot_find_definition` leaf tool (#20).
 *
 * The test suite exercises the handler in isolation using a fake
 * {@link LspClientLike} stub so no real Godot process or socket is needed.
 * All behavioral contracts come from DESIGN.md and issue #20:
 *
 *   - Inputs: `file`, `line` (1-based), `character` (1-based).
 *   - Multiple definitions → return array; agent disambiguates.
 *   - Zero results → empty array (not error).
 *   - LSP returns `null` → empty array (not error).
 *   - LSP returns a single `Location` → one-element array.
 *   - LSP returns `Location[]` → array of all results.
 *   - LSP returns `LocationLink[]` → mapped via `targetSelectionRange`.
 *   - Non-`file://` URIs (built-ins such as `gdscript://`) are passed through
 *     as-is in the `file` field so the caller can detect synthetic symbols.
 *   - File not in project root → error response (not throw).
 *   - LSP unavailable → error response (not throw).
 */

import * as nodePath from "node:path";

import { describe, it, expect, beforeEach } from "vitest";

import type { ToolContext } from "../../shared/types.js";
import type { LspClientLike } from "../../lsp/tool-helpers.js";

// The import side-effect registers `godot_find_definition` into `lspTools`.
import "../../tools/lsp/find-definition.js";
import { lspTools } from "../lsp-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake project root used across tests. */
const PROJECT_ROOT = nodePath.resolve("/fake/project").replace(/\\/g, "/");

/** Build a file path inside the fake project root. */
function inProject(rel: string): string {
  return `${PROJECT_ROOT}/${rel}`;
}

/** Build a `file://` URI for a path inside the project. */
function inProjectUri(rel: string): string {
  // filePathToUri encodes spaces etc., but for tests we keep paths simple.
  const p = inProject(rel);
  // On Windows the path starts with a drive letter, so the URI is
  // file:///C:/... — on POSIX it's file:///path/...
  if (/^[A-Za-z]:\//.test(p)) {
    return `file:///${p}`;
  }
  return `file://${p}`;
}

/**
 * Build a minimal fake `LspClientLike` whose `request` returns `returnValue`
 * for any call.
 */
function makeClient(
  returnValue: unknown,
): LspClientLike & { lastParams: unknown } {
  let lastParams: unknown;
  return {
    get lastParams() {
      return lastParams;
    },
    async request<TResult>(_method: string, params: unknown): Promise<TResult> {
      lastParams = params;
      return returnValue as TResult;
    },
    async notify(): Promise<void> {},
    async getDiagnostics() {
      return { diagnostics: [], partial: false };
    },
    serverCapabilities() {
      return { definitionProvider: true };
    },
    projectRoot() {
      return PROJECT_ROOT;
    },
  };
}

/**
 * Build a minimal `ToolContext` wiring in the given fake client and
 * project root.
 */
function makeCtx(client: LspClientLike): ToolContext {
  return {
    lsp: {
      get: () => client,
      projectRoot: () => PROJECT_ROOT,
    },
  } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Resolve the registered handler
// ---------------------------------------------------------------------------

function getHandler() {
  const def = lspTools.find((t) => t.name === "godot_find_definition");
  if (!def) throw new Error("godot_find_definition not registered");
  return def.handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("godot_find_definition registration", () => {
  it("is registered in lspTools with the correct name", () => {
    const def = lspTools.find((t) => t.name === "godot_find_definition");
    expect(def).toBeDefined();
    expect(def?.name).toBe("godot_find_definition");
  });

  it("has a non-empty description", () => {
    const def = lspTools.find((t) => t.name === "godot_find_definition");
    expect(typeof def?.description).toBe("string");
    expect(def!.description.length).toBeGreaterThan(0);
  });

  it("declares the required input schema fields", () => {
    const def = lspTools.find((t) => t.name === "godot_find_definition");
    const schema = def?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(schema?.required).toContain("file");
    expect(schema?.required).toContain("line");
    expect(schema?.required).toContain("character");
  });
});

describe("godot_find_definition handler — result shapes", () => {
  let handler: ReturnType<typeof getHandler>;

  beforeEach(() => {
    handler = getHandler();
  });

  it("returns an empty array when LSP returns null", async () => {
    const client = makeClient(null);
    const res = await handler(
      { file: inProject("scripts/player.gd"), line: 5, character: 10 },
      makeCtx(client),
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as unknown;
    expect(Array.isArray(payload)).toBe(true);
    expect((payload as unknown[]).length).toBe(0);
  });

  it("returns an empty array when LSP returns an empty array", async () => {
    const client = makeClient([]);
    const res = await handler(
      { file: inProject("scripts/player.gd"), line: 5, character: 10 },
      makeCtx(client),
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as unknown[];
    expect(payload.length).toBe(0);
  });

  it("maps a single Location object (not wrapped in array) to a one-element array", async () => {
    const client = makeClient({
      uri: inProjectUri("scripts/player.gd"),
      range: {
        start: { line: 9, character: 4 },
        end: { line: 9, character: 12 },
      },
    });
    const res = await handler(
      { file: inProject("scripts/player.gd"), line: 1, character: 1 },
      makeCtx(client),
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as Array<{
      file: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>;
    expect(payload.length).toBe(1);
    // Positions must be converted back to 1-based.
    expect(payload[0].range.start).toEqual({ line: 10, character: 5 });
    expect(payload[0].range.end).toEqual({ line: 10, character: 13 });
  });

  it("maps a Location[] to an array of results", async () => {
    const client = makeClient([
      {
        uri: inProjectUri("scripts/player.gd"),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
      {
        uri: inProjectUri("scripts/enemy.gd"),
        range: {
          start: { line: 19, character: 3 },
          end: { line: 19, character: 9 },
        },
      },
    ]);
    const res = await handler(
      { file: inProject("scripts/player.gd"), line: 1, character: 1 },
      makeCtx(client),
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as Array<{
      file: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>;
    expect(payload.length).toBe(2);
    expect(payload[0].range.start).toEqual({ line: 1, character: 1 });
    expect(payload[1].range.start).toEqual({ line: 20, character: 4 });
  });

  it("maps LocationLink[] using targetSelectionRange", async () => {
    const client = makeClient([
      {
        targetUri: inProjectUri("scripts/player.gd"),
        targetRange: {
          start: { line: 5, character: 0 },
          end: { line: 10, character: 0 },
        },
        targetSelectionRange: {
          start: { line: 5, character: 7 },
          end: { line: 5, character: 13 },
        },
      },
    ]);
    const res = await handler(
      { file: inProject("scripts/player.gd"), line: 1, character: 1 },
      makeCtx(client),
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as Array<{
      file: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>;
    expect(payload.length).toBe(1);
    // targetSelectionRange used (not targetRange)
    expect(payload[0].range.start).toEqual({ line: 6, character: 8 });
    expect(payload[0].range.end).toEqual({ line: 6, character: 14 });
  });

  it("passes through non-file:// URIs (built-in symbols) without error", async () => {
    const client = makeClient({
      uri: "gdscript://@GlobalScope",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    });
    const res = await handler(
      { file: inProject("scripts/player.gd"), line: 1, character: 1 },
      makeCtx(client),
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as Array<{ file: string }>;
    expect(payload.length).toBe(1);
    expect(payload[0].file).toBe("gdscript://@GlobalScope");
  });
});

describe("godot_find_definition handler — position forwarding", () => {
  it("converts 1-based wire positions to 0-based LSP params", async () => {
    const client = makeClient(null);
    const handler = getHandler();
    await handler(
      { file: inProject("scripts/player.gd"), line: 10, character: 5 },
      makeCtx(client),
    );
    const params = client.lastParams as {
      position: { line: number; character: number };
    };
    expect(params.position).toEqual({ line: 9, character: 4 });
  });

  it("passes the file URI in textDocumentIdentifier", async () => {
    const client = makeClient(null);
    const handler = getHandler();
    const filePath = inProject("scripts/player.gd");
    await handler({ file: filePath, line: 1, character: 1 }, makeCtx(client));
    const params = client.lastParams as {
      textDocument: { uri: string };
    };
    // The URI should be a file:// URI derived from the file path.
    expect(params.textDocument.uri).toMatch(/^file:\/\//);
    expect(params.textDocument.uri).toContain("player.gd");
  });
});

describe("godot_find_definition handler — error cases", () => {
  it("returns an error response when LSP subsystem is not configured", async () => {
    const handler = getHandler();
    const ctx = {} as ToolContext;
    const res = await handler(
      { file: inProject("scripts/player.gd"), line: 1, character: 1 },
      ctx,
    );
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/LSP/);
  });

  it("returns an error response when the file is outside the project root", async () => {
    const client = makeClient(null);
    const handler = getHandler();
    const res = await handler(
      {
        file: nodePath.resolve("/outside/the/project/script.gd"),
        line: 1,
        character: 1,
      },
      makeCtx(client),
    );
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/outside/i);
  });
});
