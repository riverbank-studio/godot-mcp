/**
 * Behavioral tests for the LSP-tool shared helpers.
 *
 * These helpers are consumed by the seven read-only LSP leaf tools
 * (#20–#26) and the advisory-write tool (#27 follow-up). The contracts
 * asserted here are the ones each leaf would otherwise have to re-derive
 * — position conversion, URI<->path mapping, in-project bounds check,
 * categorized-error mapping, and the `withLspClient` envelope.
 *
 * No live LSP is required; the tests construct fake clients via a tiny
 * stub conforming to {@link LspClientLike}.
 */

import * as nodePath from "node:path";

import { describe, it, expect, vi } from "vitest";

import {
  LspBinaryNotFoundError,
  LspConnectionLostError,
  LspHandshakeFailedError,
  LspPortUnavailableError,
  LspSpawnCapExhaustedError,
  LspUnavailableError,
} from "./errors.js";
import { filePathToUri } from "./client.js";
import { RequestTimeoutError } from "./queue.js";
import {
  fromLspPosition,
  fromLspRange,
  mapLspErrorToResponse,
  resolveLspContext,
  toLspPosition,
  toLspRange,
  uriToFilePath,
  validateFileInProject,
  withLspClient,
  type LspClientLike,
  type LspToolContext,
} from "./tool-helpers.js";
import type { ToolContext } from "../shared/types.js";

describe("position conversion", () => {
  it("toLspPosition: 1-based wire → 0-based LSP", () => {
    expect(toLspPosition({ line: 1, character: 1 })).toEqual({
      line: 0,
      character: 0,
    });
    expect(toLspPosition({ line: 42, character: 7 })).toEqual({
      line: 41,
      character: 6,
    });
  });

  it("fromLspPosition: 0-based LSP → 1-based wire", () => {
    expect(fromLspPosition({ line: 0, character: 0 })).toEqual({
      line: 1,
      character: 1,
    });
    expect(fromLspPosition({ line: 41, character: 6 })).toEqual({
      line: 42,
      character: 7,
    });
  });

  it("toLspPosition rejects non-positive line/character", () => {
    expect(() => toLspPosition({ line: 0, character: 1 })).toThrow(/1-based/);
    expect(() => toLspPosition({ line: 1, character: 0 })).toThrow(/1-based/);
    expect(() => toLspPosition({ line: -3, character: 5 })).toThrow(/1-based/);
  });

  it("toLspRange / fromLspRange round-trip preserve half-open semantics", () => {
    const wire = {
      start: { line: 10, character: 5 },
      end: { line: 12, character: 1 },
    };
    const lsp = toLspRange(wire);
    expect(lsp).toEqual({
      start: { line: 9, character: 4 },
      end: { line: 11, character: 0 },
    });
    expect(fromLspRange(lsp)).toEqual(wire);
  });
});

describe("URI ↔ path conversion", () => {
  it("filePathToUri / uriToFilePath round-trip on POSIX absolute", () => {
    const path = "/home/user/project/scripts/player.gd";
    const uri = filePathToUri(path);
    expect(uri).toBe("file:///home/user/project/scripts/player.gd");
    expect(uriToFilePath(uri)).toBe(path);
  });

  it("uriToFilePath decodes Windows drive-letter URIs to native separators", () => {
    // filePathToUri normalizes backslashes → forward slashes; uriToFilePath
    // must restore platform-appropriate behavior (we always return forward
    // slashes for cross-platform stability; tests assert that shape).
    const uri = "file:///C:/Users/dev/project/scripts/player.gd";
    expect(uriToFilePath(uri)).toBe("C:/Users/dev/project/scripts/player.gd");
  });

  it("uriToFilePath decodes percent-encoded characters", () => {
    expect(uriToFilePath("file:///home/user/my%20project/foo.gd")).toBe(
      "/home/user/my project/foo.gd",
    );
    expect(uriToFilePath("file:///tmp/%5Bbracket%5D.gd")).toBe(
      "/tmp/[bracket].gd",
    );
  });

  it("uriToFilePath returns the input when scheme is not file://", () => {
    // Synthetic LSP URIs (`gdscript://`, `godot://`) are passed through so
    // the built-in-symbol redirect in #20 can detect them by prefix.
    expect(uriToFilePath("gdscript://@GlobalScope")).toBe(
      "gdscript://@GlobalScope",
    );
    expect(uriToFilePath("godot://Node")).toBe("godot://Node");
  });

  it("uriToFilePath returns empty string for empty input", () => {
    expect(uriToFilePath("")).toBe("");
  });
});

describe("validateFileInProject", () => {
  // Use `path.resolve` to build platform-portable absolute paths inside
  // a temp-ish prefix. On POSIX `/home/user/project` is already absolute;
  // on Win32 `path.resolve` prepends the current drive letter. Asserting
  // against the resolved form keeps the test platform-portable.

  it("accepts paths inside the project root", () => {
    const root = nodePath.resolve("/home/user/project");
    const file = nodePath.resolve("/home/user/project/scripts/player.gd");
    expect(validateFileInProject(file, root)).toBe(file.replace(/\\/g, "/"));
  });

  it("rejects paths outside the project root", () => {
    const root = nodePath.resolve("/home/user/project");
    const file = nodePath.resolve("/home/user/other/script.gd");
    expect(() => validateFileInProject(file, root)).toThrow(
      /outside the project root/,
    );
  });

  it("rejects paths escaping via ..", () => {
    const root = nodePath.resolve("/home/user/project");
    const file = nodePath.resolve("/home/user/project/../other/script.gd");
    expect(() => validateFileInProject(file, root)).toThrow(
      /outside the project root/,
    );
  });

  it("normalizes mixed-separator paths so backslashes match (Win32-style)", () => {
    // The function should not be platform-fragile; tests pass both styles.
    // We use `resolve()` to land on a real absolute path on whichever
    // platform the test runs, then assert the forward-slash return form.
    const root = nodePath.resolve("/Users/dev/project");
    const file = nodePath.resolve("/Users/dev/project/scripts/player.gd");
    const got = validateFileInProject(file, root);
    expect(got).toBe(file.replace(/\\/g, "/"));
  });

  it("treats the root directory itself as inside", () => {
    const root = nodePath.resolve("/home/user/project");
    expect(validateFileInProject(root, root)).toBe(root.replace(/\\/g, "/"));
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("mapLspErrorToResponse", () => {
  it("includes the recoveryHint verbatim from LspUnavailableError subclasses", () => {
    const err = new LspBinaryNotFoundError("/no/such/binary");
    const res = mapLspErrorToResponse(err);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    // The recovery hint should land in the response somewhere.
    expect(joined).toContain("Set `GODOT_PATH` to your Godot binary.");
    // The reason tag should also appear so callers / tests can branch on it.
    expect(joined).toContain("binary_not_found");
  });

  it("formats LspPortUnavailableError with its recovery hint", () => {
    const err = new LspPortUnavailableError(6005, 32);
    const res = mapLspErrorToResponse(err);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toContain(
      "Could not bind any port in range; check for runaway Godot processes.",
    );
  });

  it("maps LspSpawnCapExhaustedError to a terminal-session message", () => {
    const err = new LspSpawnCapExhaustedError(3);
    const res = mapLspErrorToResponse(err);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toContain("spawn budget for this session");
  });

  it("maps RequestTimeoutError to a per-request timeout error", () => {
    const err = new RequestTimeoutError("textDocument/hover", 30_000);
    const res = mapLspErrorToResponse(err);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toMatch(/timed out/);
    expect(joined).toContain("textDocument/hover");
  });

  it("maps LspConnectionLostError with a retry hint", () => {
    const err = new LspConnectionLostError("socket closed");
    const res = mapLspErrorToResponse(err);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toContain("retry the operation");
  });

  it("maps generic JSON-RPC-shaped errors with code -32601 to method-not-found", () => {
    const err = Object.assign(new Error("method not implemented"), {
      code: -32601,
    });
    const res = mapLspErrorToResponse(err);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toContain("not supported");
  });

  it("falls back to a generic message for unrecognized errors", () => {
    const err = new Error("something else broke");
    const res = mapLspErrorToResponse(err);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toContain("something else broke");
  });

  it("never throws on non-Error inputs", () => {
    // Defensive: handlers `catch (err: unknown)` and we shouldn't add a
    // second failure mode just because the thrown value wasn't an Error.
    const res = mapLspErrorToResponse("bare string");
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("bare string");
  });
});

// ---------------------------------------------------------------------------
// LSP context resolution
// ---------------------------------------------------------------------------

/**
 * Minimal fake matching the {@link LspClientLike} surface. Each instance
 * records which methods were called so individual tests can assert.
 */
function makeFakeClient(): LspClientLike & {
  requests: Array<{ method: string; params: unknown }>;
} {
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    requests,
    async request<TResult>(method: string, params: unknown): Promise<TResult> {
      requests.push({ method, params });
      return null as TResult;
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

describe("resolveLspContext", () => {
  it("returns the LspToolContext when ctx.lsp is configured", () => {
    const fake = makeFakeClient();
    const ctx = {
      lsp: { get: () => fake, projectRoot: () => "/fake/project" },
    } as unknown as ToolContext;
    const resolved = resolveLspContext(ctx);
    expect(resolved.kind).toBe("ok");
    if (resolved.kind === "ok") {
      expect(resolved.client).toBe(fake);
      expect(resolved.projectRoot).toBe("/fake/project");
    }
  });

  it("returns a failure response when ctx.lsp is undefined", () => {
    const ctx = {} as ToolContext;
    const resolved = resolveLspContext(ctx);
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") {
      expect(resolved.response.isError).toBe(true);
      const joined = resolved.response.content.map((c) => c.text).join("\n");
      expect(joined).toMatch(/LSP/);
    }
  });

  it("returns a failure response when ctx.lsp.get() throws", () => {
    const ctx = {
      lsp: {
        get: () => {
          throw new LspHandshakeFailedError("bad handshake");
        },
        projectRoot: () => null,
      },
    } as unknown as ToolContext;
    const resolved = resolveLspContext(ctx);
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") {
      const joined = resolved.response.content.map((c) => c.text).join("\n");
      expect(joined).toContain("bad handshake");
    }
  });

  it("returns a failure response when projectRoot is null", () => {
    const fake = makeFakeClient();
    const ctx = {
      lsp: { get: () => fake, projectRoot: () => null },
    } as unknown as ToolContext;
    const resolved = resolveLspContext(ctx);
    expect(resolved.kind).toBe("error");
  });
});

describe("withLspClient", () => {
  it("invokes the handler with the resolved LspToolContext and returns its result", async () => {
    const fake = makeFakeClient();
    const ctx = {
      lsp: { get: () => fake, projectRoot: () => "/fake/project" },
    } as unknown as ToolContext;
    const handler = vi.fn(async (lsp: LspToolContext) => {
      expect(lsp.client).toBe(fake);
      expect(lsp.projectRoot).toBe("/fake/project");
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    const res = await withLspClient(ctx, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("ok");
  });

  it("returns the failure response when ctx.lsp is undefined (handler not called)", async () => {
    const ctx = {} as ToolContext;
    const handler = vi.fn();
    const res = await withLspClient(ctx, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });

  it("catches LspUnavailableError thrown inside the handler", async () => {
    const fake = makeFakeClient();
    const ctx = {
      lsp: { get: () => fake, projectRoot: () => "/fake/project" },
    } as unknown as ToolContext;
    const handler = async () => {
      throw new LspConnectionLostError("mid-flight drop");
    };
    const res = await withLspClient(ctx, handler);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toContain("connection_lost");
  });

  it("catches RequestTimeoutError thrown inside the handler", async () => {
    const fake = makeFakeClient();
    const ctx = {
      lsp: { get: () => fake, projectRoot: () => "/fake/project" },
    } as unknown as ToolContext;
    const handler = async () => {
      throw new RequestTimeoutError("textDocument/references", 30_000);
    };
    const res = await withLspClient(ctx, handler);
    expect(res.isError).toBe(true);
    const joined = res.content.map((c) => c.text).join("\n");
    expect(joined).toContain("textDocument/references");
  });

  it("re-throws non-LSP errors (programmer bugs)", async () => {
    const fake = makeFakeClient();
    const ctx = {
      lsp: { get: () => fake, projectRoot: () => "/fake/project" },
    } as unknown as ToolContext;
    const handler = async () => {
      throw new TypeError("forgot to await something");
    };
    await expect(withLspClient(ctx, handler)).rejects.toThrow(TypeError);
  });

  it("passes through LspUnavailableError base class subclasses uniformly", async () => {
    const fake = makeFakeClient();
    const ctx = {
      lsp: { get: () => fake, projectRoot: () => "/fake/project" },
    } as unknown as ToolContext;
    const cases: LspUnavailableError[] = [
      new LspBinaryNotFoundError("missing"),
      new LspPortUnavailableError(6005, 32),
      new LspSpawnCapExhaustedError(3),
    ];
    for (const err of cases) {
      const handler = async () => {
        throw err;
      };
      const res = await withLspClient(ctx, handler);
      expect(res.isError).toBe(true);
      const joined = res.content.map((c) => c.text).join("\n");
      expect(joined).toContain(err.reason);
    }
  });
});
