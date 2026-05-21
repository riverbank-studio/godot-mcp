/**
 * Behavioral tests for the `godot_get_diagnostics` LSP leaf tool (#25).
 *
 * The tool delegates all diagnostic retrieval to `LspClient.getDiagnostics`
 * which implements the tiered-await semantics (10s first-touch / 2s
 * steady-state) and the auto-resync `didChange` trigger. This file does
 * NOT test those lower-level mechanics — `src/lsp/client.test.ts` owns
 * them. Instead, it tests:
 *
 *   - Tool registration (name, schema shape, required params).
 *   - Happy-path response format: 1-based positions, flattened fields.
 *   - `partial: true` propagation (timeout / no push yet).
 *   - Empty diagnostics response (zero-results rule per DESIGN.md L492).
 *   - In-project guard: file outside root → MCP error.
 *   - LSP-unavailable guard: `withLspClient` error envelope.
 *   - Severity passthrough for all four LSP severity values.
 *   - Optional fields (`source`, `code`) present/absent.
 */

import { describe, expect, it, afterEach } from "vitest";
import * as nodePath from "node:path";

import { lspTools, registerLspTool } from "../lsp-tools.js";
import type { LspClientLike } from "../../lsp/tool-helpers.js";
import type { ToolContext } from "../../shared/types.js";
import type { LspDiagnostic } from "../../lsp/client.js";

// Import the module under test so its `registerLspTool` side effect fires.
import "./get-diagnostics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal `LspClientLike` stub with controllable getDiagnostics. */
function makeClient(
  diagnostics: LspDiagnostic[] = [],
  partial = false,
): LspClientLike {
  return {
    async request<TResult>(): Promise<TResult> {
      return null as TResult;
    },
    async notify(): Promise<void> {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getDiagnostics(_filePath: string) {
      return { diagnostics, partial };
    },
    serverCapabilities() {
      return {};
    },
  };
}

/** Build a minimal `ToolContext` with `lsp` pre-wired. */
function makeCtx(
  client: LspClientLike,
  projectRoot = "/fake/project",
): ToolContext {
  return {
    lsp: { get: () => client, projectRoot: () => projectRoot },
  } as unknown as ToolContext;
}

/** Retrieve the registered `godot_get_diagnostics` definition. */
function getTool() {
  const def = lspTools.find((t) => t.name === "godot_get_diagnostics");
  if (!def) throw new Error("godot_get_diagnostics not registered");
  return def;
}

// Restore registry length between tests so side-effect imports don't
// accumulate across test files.
const initialLength = lspTools.length;
afterEach(() => {
  lspTools.length = initialLength;
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers `godot_get_diagnostics` in lspTools", () => {
    const names = lspTools.map((t) => t.name);
    expect(names).toContain("godot_get_diagnostics");
  });

  it("has the expected input schema shape", () => {
    const def = getTool();
    expect(def.inputSchema.type).toBe("object");
    expect(def.inputSchema.required).toContain("file");
    expect(def.inputSchema.properties).toHaveProperty("file");
  });

  it("duplicate registration throws", () => {
    // The guard lives in registerLspTool; this test verifies it fires when
    // someone accidentally imports the leaf twice.
    const def = getTool();
    expect(() => registerLspTool(def)).toThrow(
      /duplicate tool name 'godot_get_diagnostics'/,
    );
  });
});

// ---------------------------------------------------------------------------
// Happy path: non-empty diagnostics
// ---------------------------------------------------------------------------

describe("happy path — non-empty diagnostics", () => {
  it("returns diagnostics with 1-based positions", async () => {
    const diags: LspDiagnostic[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        severity: 1,
        message: "Identifier 'foo' not declared in current scope.",
        source: "gdscript",
        code: "E001",
      },
    ];
    const client = makeClient(diags);
    const ctx = makeCtx(client);
    const tool = getTool();
    const res = await tool.handler(
      { file: "/fake/project/scripts/player.gd" },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text) as {
      diagnostics: unknown[];
      partial: boolean;
    };
    expect(parsed.partial).toBe(false);
    expect(parsed.diagnostics).toHaveLength(1);
    const d = parsed.diagnostics[0] as {
      severity: number;
      line: number;
      character: number;
      end_line: number;
      end_character: number;
      message: string;
      source: string;
      code: string;
    };
    // LSP 0-based (0,0)–(0,5) → wire 1-based (1,1)–(1,6)
    expect(d.line).toBe(1);
    expect(d.character).toBe(1);
    expect(d.end_line).toBe(1);
    expect(d.end_character).toBe(6);
    expect(d.message).toBe("Identifier 'foo' not declared in current scope.");
    expect(d.source).toBe("gdscript");
    expect(d.code).toBe("E001");
    expect(d.severity).toBe(1);
  });

  it("converts non-zero-based LSP positions correctly", async () => {
    const diags: LspDiagnostic[] = [
      {
        range: {
          start: { line: 9, character: 3 },
          end: { line: 11, character: 0 },
        },
        severity: 2,
        message: "Unused variable.",
      },
    ];
    const client = makeClient(diags);
    const ctx = makeCtx(client);
    const res = await getTool().handler({ file: "/fake/project/main.gd" }, ctx);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text) as {
      diagnostics: Array<{
        line: number;
        character: number;
        end_line: number;
        end_character: number;
      }>;
    };
    const d = parsed.diagnostics[0];
    expect(d.line).toBe(10);
    expect(d.character).toBe(4);
    expect(d.end_line).toBe(12);
    expect(d.end_character).toBe(1);
  });

  it("omits `source` and `code` when the LSP diagnostic lacks them", async () => {
    const diags: LspDiagnostic[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        severity: 3,
        message: "Hint text.",
        // no source, no code
      },
    ];
    const client = makeClient(diags);
    const ctx = makeCtx(client);
    const res = await getTool().handler({ file: "/fake/project/a.gd" }, ctx);
    const parsed = JSON.parse(res.content[0].text) as {
      diagnostics: Array<Record<string, unknown>>;
    };
    const d = parsed.diagnostics[0];
    expect("source" in d).toBe(false);
    expect("code" in d).toBe(false);
  });

  it("passes all four severity levels through unchanged", async () => {
    for (const severity of [1, 2, 3, 4] as const) {
      const diags: LspDiagnostic[] = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity,
          message: "msg",
        },
      ];
      const client = makeClient(diags);
      const ctx = makeCtx(client);
      const res = await getTool().handler({ file: "/fake/project/a.gd" }, ctx);
      const parsed = JSON.parse(res.content[0].text) as {
        diagnostics: Array<{ severity: number }>;
      };
      expect(parsed.diagnostics[0].severity).toBe(severity);
    }
  });
});

// ---------------------------------------------------------------------------
// Zero-results rule
// ---------------------------------------------------------------------------

describe("zero-results rule", () => {
  it("returns an empty diagnostics array, not an error, when there are no issues", async () => {
    const client = makeClient([], false);
    const ctx = makeCtx(client);
    const res = await getTool().handler(
      { file: "/fake/project/clean.gd" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text) as {
      diagnostics: unknown[];
      partial: boolean;
    };
    expect(parsed.diagnostics).toHaveLength(0);
    expect(parsed.partial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Partial flag
// ---------------------------------------------------------------------------

describe("partial flag", () => {
  it("propagates partial:true from the client when the await timed out", async () => {
    const client = makeClient([], true);
    const ctx = makeCtx(client);
    const res = await getTool().handler(
      { file: "/fake/project/pending.gd" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text) as { partial: boolean };
    expect(parsed.partial).toBe(true);
  });

  it("propagates partial:true alongside whatever diagnostics were cached", async () => {
    const diags: LspDiagnostic[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        severity: 1,
        message: "stale diagnostic",
      },
    ];
    const client = makeClient(diags, true);
    const ctx = makeCtx(client);
    const res = await getTool().handler(
      { file: "/fake/project/stale.gd" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text) as {
      diagnostics: unknown[];
      partial: boolean;
    };
    expect(parsed.partial).toBe(true);
    expect(parsed.diagnostics).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// In-project guard
// ---------------------------------------------------------------------------

describe("in-project guard", () => {
  it("returns an MCP error when the file is outside the project root", async () => {
    const client = makeClient();
    // projectRoot is /fake/project; file is /other/script.gd → outside
    const ctx = makeCtx(client, nodePath.resolve("/fake/project"));
    const res = await getTool().handler(
      { file: nodePath.resolve("/other/script.gd") },
      ctx,
    );
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/outside the project root/i);
  });
});

// ---------------------------------------------------------------------------
// LSP-unavailable guard
// ---------------------------------------------------------------------------

describe("LSP-unavailable guard", () => {
  it("returns an MCP error when ctx.lsp is undefined", async () => {
    const ctx = {} as ToolContext;
    const res = await getTool().handler({ file: "/fake/project/a.gd" }, ctx);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/LSP/i);
  });

  it("returns an MCP error when ctx.lsp.projectRoot() is null", async () => {
    const client = makeClient();
    const ctx = {
      lsp: { get: () => client, projectRoot: () => null },
    } as unknown as ToolContext;
    const res = await getTool().handler({ file: "/fake/project/a.gd" }, ctx);
    expect(res.isError).toBe(true);
  });
});
