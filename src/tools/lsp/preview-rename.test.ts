/**
 * Behavioral tests for the `godot_preview_rename` tool (#27).
 *
 * Tests are organized around the handler's branches:
 *   - LSP unavailable → mapped error response (via `withLspClient`)
 *   - `renameProvider` capability absent → early error
 *   - File outside project root → validateFileInProject error
 *   - LSP returns `null` (symbol not found / no rename possible) → empty
 *     advisory response
 *   - LSP returns a `WorkspaceEdit` → passed through
 *     `workspaceEditToAdvisory` and returned as JSON
 *
 * All tests stub `LspClientLike` directly — no real TCP socket or process.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { LspClientLike } from "../../lsp/tool-helpers.js";
import type { KnownServerCapabilities } from "../../lsp/client.js";
import type { ToolContext } from "../../shared/types.js";
import { handler } from "./preview-rename.js";

// ---------------------------------------------------------------------------
// Helpers to build minimal stubs
// ---------------------------------------------------------------------------

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-preview-rename-"));
  return dir;
}

/** Build a minimal ToolContext stub with the LSP slot pre-wired. */
function makeCtx(client: LspClientLike, projectRoot: string): ToolContext {
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

/** Stub client with `renameProvider` capability declared. */
function makeClient(overrides: {
  caps?: Partial<KnownServerCapabilities>;
  requestResult?: unknown;
  requestError?: Error;
}): LspClientLike {
  return {
    request: async <TResult>() => {
      if (overrides.requestError) throw overrides.requestError;
      return overrides.requestResult as TResult;
    },
    notify: async () => {},
    getDiagnostics: async () => ({ diagnostics: [], partial: false }),
    serverCapabilities: () =>
      ({
        renameProvider: true,
        ...overrides.caps,
      }) as KnownServerCapabilities,
  };
}

// ---------------------------------------------------------------------------
// Setup: a temp project with a real .gd file
// ---------------------------------------------------------------------------

const PROJECT_ROOT = makeTmpProject();
const GD_FILE = path.join(PROJECT_ROOT, "player.gd").replace(/\\/g, "/");
// Write a small GDScript file that the `readFile` callback can read.
fs.writeFileSync(
  GD_FILE,
  [
    "extends Node",
    "",
    "var old_name = 10",
    "var also_old_name = old_name",
    "",
    "func _ready():",
    "\tprint(old_name)",
  ].join("\n"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("godot_preview_rename handler", () => {
  it("returns an error when LSP is not configured", async () => {
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
      // lsp slot intentionally absent
    };
    const result = await handler(
      { file: GD_FILE, line: 3, character: 5, new_name: "new_name" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not configured/i);
  });

  it("returns an error when renameProvider is not advertised", async () => {
    const client = makeClient({ caps: { renameProvider: undefined } });
    const ctx = makeCtx(client, PROJECT_ROOT);
    const result = await handler(
      { file: GD_FILE, line: 3, character: 5, new_name: "new_name" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/rename.*not supported/i);
  });

  it("returns an error when file is outside the project root", async () => {
    const client = makeClient({});
    const ctx = makeCtx(client, PROJECT_ROOT);
    const result = await handler(
      {
        file: "/tmp/outside.gd",
        line: 1,
        character: 1,
        new_name: "new_name",
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside|project root/i);
  });

  it("returns an empty advisory response when LSP returns null (no rename)", async () => {
    const client = makeClient({ requestResult: null });
    const ctx = makeCtx(client, PROJECT_ROOT);
    const result = await handler(
      { file: GD_FILE, line: 3, character: 5, new_name: "new_name" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.action.kind).toBe("rename");
    expect(body.action.from).toBe("old_name");
    expect(body.action.to).toBe("new_name");
    expect(body.edits).toEqual([]);
    expect(body.summary).toEqual({ files: 0, locations: 0 });
  });

  it("converts a WorkspaceEdit to the advisory shape for a single-file rename", async () => {
    const fileUri = `file:///${GD_FILE.replace(/^\//, "")}`;
    const workspaceEdit = {
      changes: {
        [fileUri]: [
          // "var old_name = 10" at line index 2 (0-based), chars 4–12
          {
            range: {
              start: { line: 2, character: 4 },
              end: { line: 2, character: 12 },
            },
            newText: "new_name",
          },
        ],
      },
    };
    const client = makeClient({ requestResult: workspaceEdit });
    const ctx = makeCtx(client, PROJECT_ROOT);
    const result = await handler(
      { file: GD_FILE, line: 3, character: 5, new_name: "new_name" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.action).toEqual({
      kind: "rename",
      from: "old_name",
      to: "new_name",
    });
    expect(body.edits).toHaveLength(1);
    expect(body.edits[0].changes).toHaveLength(1);
    const change = body.edits[0].changes[0];
    expect(change.line).toBe(3); // 1-based
    expect(change.after).toContain("new_name");
    expect(body.summary.files).toBe(1);
    expect(body.summary.locations).toBe(1);
  });

  it("returns an MCP error when the LSP WorkspaceEdit contains an out-of-project URI", async () => {
    // A compromised or misconfigured LSP could return a URI for a file outside
    // the project root (e.g. /etc/passwd).  The readFile callback must reject
    // it via validateFileInProject, and the handler must wrap the error into an
    // MCP error envelope rather than letting it propagate uncaught.
    const outsideUri = "file:///etc/passwd";
    const workspaceEdit = {
      changes: {
        [outsideUri]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 },
            },
            newText: "OWNED",
          },
        ],
      },
    };
    const client = makeClient({ requestResult: workspaceEdit });
    const ctx = makeCtx(client, PROJECT_ROOT);
    const result = await handler(
      { file: GD_FILE, line: 3, character: 5, new_name: "new_name" },
      ctx,
    );
    expect(result.isError).toBe(true);
    // Message should indicate the workspace-edit processing failure, not crash.
    expect(result.content[0].text).toMatch(
      /workspace edit|outside|project root/i,
    );
  });

  it("accepts camelCase parameter aliases (newName, lineNumber)", async () => {
    const client = makeClient({ requestResult: null });
    const ctx = makeCtx(client, PROJECT_ROOT);
    const result = await handler(
      { file: GD_FILE, line: 3, character: 5, newName: "new_name" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it("surfaces an LSP error as an MCP error response", async () => {
    const lspErr = Object.assign(new Error("LSP exploded"), { code: -32603 });
    const client = makeClient({ requestError: lspErr });
    const ctx = makeCtx(client, PROJECT_ROOT);
    const result = await handler(
      { file: GD_FILE, line: 3, character: 5, new_name: "new_name" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/LSP server error/i);
  });
});
