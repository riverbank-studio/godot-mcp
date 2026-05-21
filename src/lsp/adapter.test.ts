/**
 * Tests for the per-server LSP adapter (`src/lsp/adapter.ts`).
 *
 * Asserts the contract for issue #13:
 *   - Pass-through semantics for unconfigured methods.
 *   - Per-method timeout overrides via {@link timeoutFor}.
 *   - `workspace/symbol` postprocessor: native-only, fallback-only,
 *     union, query filtering, dedup, and per-file failure isolation.
 *   - Hover postprocessor: `MarkedString`, `MarkedString[]`, and
 *     already-`MarkupContent` cases all collapse to
 *     `MarkupContent { kind: "markdown" }`.
 *   - Source tagging behavior — entries the adapter produces or
 *     touches carry the `source` field.
 *   - Factory wires the documented methods + timeouts.
 *
 * The adapter is tested in isolation: a tiny `AdapterClient` mock
 * captures sub-requests and replays canned responses, and a real
 * {@link DocumentTracker} backed by an in-memory FS exposes the
 * tracked-file enumeration the union fallback needs.
 */

import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdapterClient,
  AdapterContext,
  AdapterSource,
  augment,
  createGodotAdapter,
  LspDocumentSymbol,
  LspHover,
  LspMarkupContent,
  LspSymbolInformation,
  normalizeHoverMarkup,
  postprocessorFor,
  redirectBuiltinUris,
  ServerAdapter,
  timeoutFor,
  unionAutoloadGrep,
  unionWithDocumentSymbols,
} from "./adapter.js";
import { filePathToUri } from "./client.js";
import {
  DocumentTracker,
  type DocumentFs,
  type StatLike,
} from "./documents.js";

/**
 * In-memory FS fake matching the one in `documents.test.ts`. Lets us
 * seed tracked-open files without touching the real filesystem.
 */
function fakeFs(
  initial: Record<string, { text: string; stat: StatLike }> = {},
) {
  const state = new Map<string, { text: string; stat: StatLike }>();
  for (const [k, v] of Object.entries(initial)) {
    state.set(path.resolve(k), v);
  }
  const fs: DocumentFs = {
    statSync(filePath: string): StatLike | null {
      const entry = state.get(path.resolve(filePath));
      return entry ? entry.stat : null;
    },
    readFileSync(filePath: string): string {
      const entry = state.get(path.resolve(filePath));
      if (!entry) throw new Error(`fake fs: missing ${filePath}`);
      return entry.text;
    },
  };
  return { fs, state };
}

/**
 * Build a {@link DocumentTracker} pre-populated with the supplied
 * tracked-open file set. Each entry's `.gd` text is uniform; tests
 * don't depend on the body content.
 */
function trackerWith(files: readonly string[]): DocumentTracker {
  const initial: Record<string, { text: string; stat: StatLike }> = {};
  for (const f of files) {
    initial[f] = { text: "extends Node\n", stat: { mtimeMs: 1, size: 13 } };
  }
  const { fs } = fakeFs(initial);
  const t = new DocumentTracker({ statPollThrottleMs: 1_000, fs });
  // Trigger the lazy didOpen so the tracker's internal set is populated.
  for (const f of files) {
    t.syncReferenced([f]);
  }
  return t;
}

/**
 * Captures sub-requests issued by the adapter and replays a canned
 * `documentSymbol` response per URI.
 */
function fakeClient(
  documentSymbolByUri: Record<string, unknown> = {},
  options: { throwForUri?: string } = {},
): AdapterClient & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request<TResult>(method: string, params: unknown): Promise<TResult> {
      calls.push({ method, params });
      if (method === "textDocument/documentSymbol") {
        const uri = (params as { textDocument: { uri: string } }).textDocument
          .uri;
        if (options.throwForUri && uri === options.throwForUri) {
          throw new Error(`forced failure for ${uri}`);
        }
        return (documentSymbolByUri[uri] ?? []) as TResult;
      }
      return null as unknown as TResult;
    },
  };
}

/**
 * Build a {@link LspSymbolInformation} entry. Defaults are arbitrary
 * but stable so dedup-key assertions are predictable.
 */
function sym(
  name: string,
  uri: string,
  line = 0,
  character = 0,
  extras: Partial<LspSymbolInformation> = {},
): LspSymbolInformation {
  return {
    name,
    kind: 12,
    location: {
      uri,
      range: {
        start: { line, character },
        end: { line, character: character + name.length },
      },
    },
    ...extras,
  };
}

/**
 * Build a hierarchical {@link LspDocumentSymbol} entry, which is what
 * Godot's `textDocument/documentSymbol` returns.
 */
function docSym(
  name: string,
  line = 0,
  character = 0,
  children: LspDocumentSymbol[] = [],
): LspDocumentSymbol {
  return {
    name,
    kind: 12,
    range: {
      start: { line, character },
      end: { line, character: character + name.length },
    },
    selectionRange: {
      start: { line, character },
      end: { line, character: character + name.length },
    },
    children,
  };
}

describe("augment", () => {
  it("passes through unchanged when no postprocessor is registered", async () => {
    const adapter: ServerAdapter = { postprocess: {} };
    const native = [{ value: 1 }];
    const result = await augment(adapter, "any/method", {}, native, {
      client: fakeClient(),
      documents: trackerWith([]),
    });
    expect(result).toBe(native);
  });

  it("passes through when adapter is undefined", async () => {
    const native = { contents: "raw" };
    const result = await augment(undefined, "any/method", {}, native, {
      client: fakeClient(),
      documents: trackerWith([]),
    });
    expect(result).toBe(native);
  });

  it("invokes the registered postprocessor with the right context", async () => {
    let seen: AdapterContext | undefined;
    const adapter: ServerAdapter = {
      postprocess: {
        "x/y": async (native, ctx) => {
          seen = ctx;
          return [{ wrapped: native }];
        },
      },
    };
    const params = { q: "go" };
    const native = ["a"];
    const result = await augment(adapter, "x/y", params, native, {
      client: fakeClient(),
      documents: trackerWith([]),
    });
    expect(result).toEqual([{ wrapped: ["a"] }]);
    expect(seen?.method).toBe("x/y");
    expect(seen?.params).toBe(params);
  });
});

describe("timeoutFor / postprocessorFor", () => {
  it("returns undefined when no override is configured", () => {
    expect(timeoutFor(undefined, "x/y")).toBeUndefined();
    expect(timeoutFor({}, "x/y")).toBeUndefined();
    expect(timeoutFor({ requestTimeouts: {} }, "x/y")).toBeUndefined();
    expect(postprocessorFor(undefined, "x/y")).toBeUndefined();
    expect(postprocessorFor({}, "x/y")).toBeUndefined();
  });

  it("returns the configured override when present", () => {
    const adapter: ServerAdapter = {
      requestTimeouts: { "workspace/symbol": 5_000 },
    };
    expect(timeoutFor(adapter, "workspace/symbol")).toBe(5_000);
    expect(timeoutFor(adapter, "textDocument/hover")).toBeUndefined();
  });
});

describe("unionWithDocumentSymbols", () => {
  const fileA = path.resolve("/proj/a.gd");
  const fileB = path.resolve("/proj/b.gd");
  const uriA = filePathToUri(fileA);
  const uriB = filePathToUri(fileB);

  it("returns only native-tagged entries when no files are tracked", async () => {
    const native = [sym("foo", "file:///elsewhere/x.gd")];
    const ctx: AdapterContext = {
      client: fakeClient(),
      documents: trackerWith([]),
      method: "workspace/symbol",
      params: { query: "" },
    };
    const result = (await unionWithDocumentSymbols(
      native,
      ctx,
    )) as LspSymbolInformation[];
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe<AdapterSource>("lsp");
  });

  it("falls back to documentSymbol when native is empty", async () => {
    const tracker = trackerWith([fileA]);
    const client = fakeClient({
      [uriA]: [docSym("foo_func", 3, 0), docSym("bar_func", 10, 0)],
    });
    const ctx: AdapterContext = {
      client,
      documents: tracker,
      method: "workspace/symbol",
      params: { query: "foo" },
    };
    const result = (await unionWithDocumentSymbols(
      [],
      ctx,
    )) as LspSymbolInformation[];
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("foo_func");
    expect(result[0].source).toBe<AdapterSource>("lsp");
    expect(result[0].location.uri).toBe(uriA);
    // Verify the adapter actually asked for documentSymbol on the
    // tracked file.
    expect(
      client.calls.some(
        (c) =>
          c.method === "textDocument/documentSymbol" &&
          (c.params as { textDocument: { uri: string } }).textDocument.uri ===
            uriA,
      ),
    ).toBe(true);
  });

  it("unions native and fallback entries, preferring native on dedup", async () => {
    const tracker = trackerWith([fileA]);
    // The native result and the fallback have the same (uri, start, name);
    // native should win and the fallback duplicate dropped.
    const native = [sym("foo", uriA, 3, 0, { containerName: "Player" })];
    const client = fakeClient({
      [uriA]: [docSym("foo", 3, 0), docSym("bar", 5, 0)],
    });
    const ctx: AdapterContext = {
      client,
      documents: tracker,
      method: "workspace/symbol",
      params: { query: "" },
    };
    const result = (await unionWithDocumentSymbols(
      native,
      ctx,
    )) as LspSymbolInformation[];
    expect(result).toHaveLength(2);
    // The dedup-winner is the native entry (preserved containerName).
    const foo = result.find((r) => r.name === "foo");
    expect(foo?.containerName).toBe("Player");
    const bar = result.find((r) => r.name === "bar");
    expect(bar?.source).toBe<AdapterSource>("lsp");
  });

  it("applies case-insensitive substring filtering to fallback entries", async () => {
    const tracker = trackerWith([fileA]);
    const client = fakeClient({
      [uriA]: [
        docSym("Player", 0, 0),
        docSym("Enemy", 5, 0),
        docSym("PlayerController", 10, 0),
      ],
    });
    const ctx: AdapterContext = {
      client,
      documents: tracker,
      method: "workspace/symbol",
      params: { query: "play" },
    };
    const result = (await unionWithDocumentSymbols(
      [],
      ctx,
    )) as LspSymbolInformation[];
    const names = result.map((r) => r.name);
    expect(names).toContain("Player");
    expect(names).toContain("PlayerController");
    expect(names).not.toContain("Enemy");
  });

  it("skips files whose documentSymbol sub-request fails", async () => {
    const tracker = trackerWith([fileA, fileB]);
    const client = fakeClient(
      {
        [uriA]: [docSym("from_a", 0, 0)],
        [uriB]: [docSym("from_b", 0, 0)],
      },
      { throwForUri: uriA },
    );
    const ctx: AdapterContext = {
      client,
      documents: tracker,
      method: "workspace/symbol",
      params: { query: "" },
    };
    const result = (await unionWithDocumentSymbols(
      [],
      ctx,
    )) as LspSymbolInformation[];
    const names = result.map((r) => r.name);
    expect(names).toEqual(["from_b"]);
  });

  it("flattens nested DocumentSymbol children into the union", async () => {
    const tracker = trackerWith([fileA]);
    const client = fakeClient({
      [uriA]: [docSym("Player", 0, 0, [docSym("move", 2, 2)])],
    });
    const ctx: AdapterContext = {
      client,
      documents: tracker,
      method: "workspace/symbol",
      params: { query: "move" },
    };
    const result = (await unionWithDocumentSymbols(
      [],
      ctx,
    )) as LspSymbolInformation[];
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("move");
    expect(result[0].containerName).toBe("Player");
  });

  it("treats a null native result the same as an empty array", async () => {
    const tracker = trackerWith([fileA]);
    const client = fakeClient({ [uriA]: [docSym("foo", 0, 0)] });
    const ctx: AdapterContext = {
      client,
      documents: tracker,
      method: "workspace/symbol",
      params: { query: "" },
    };
    const result = (await unionWithDocumentSymbols(
      null,
      ctx,
    )) as LspSymbolInformation[];
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("foo");
  });

  it("reads the query from arbitrary param shapes without crashing", async () => {
    const tracker = trackerWith([fileA]);
    const client = fakeClient({ [uriA]: [docSym("anything", 0, 0)] });
    // Missing-query case: empty query matches everything.
    const ctx: AdapterContext = {
      client,
      documents: tracker,
      method: "workspace/symbol",
      params: {
        /* no query */
      },
    };
    const result = (await unionWithDocumentSymbols(
      [],
      ctx,
    )) as LspSymbolInformation[];
    expect(result).toHaveLength(1);
  });
});

describe("normalizeHoverMarkup", () => {
  const ctx: AdapterContext = {
    client: fakeClient(),
    documents: trackerWith([]),
    method: "textDocument/hover",
    params: {},
  };

  it("passes through null unchanged", async () => {
    expect(await normalizeHoverMarkup(null, ctx)).toBeNull();
  });

  it("normalizes a bare-string MarkedString to MarkupContent", async () => {
    const hover: LspHover = { contents: "raw markdown" };
    const out = (await normalizeHoverMarkup(hover, ctx)) as LspHover;
    const contents = out.contents as LspMarkupContent;
    expect(contents.kind).toBe("markdown");
    expect(contents.value).toBe("raw markdown");
  });

  it("normalizes a {language, value} MarkedString to a fenced block", async () => {
    const hover: LspHover = {
      contents: { language: "gdscript", value: "func _ready():" },
    };
    const out = (await normalizeHoverMarkup(hover, ctx)) as LspHover;
    const contents = out.contents as LspMarkupContent;
    expect(contents.kind).toBe("markdown");
    expect(contents.value).toBe("```gdscript\nfunc _ready():\n```");
  });

  it("concatenates MarkedString[] with blank-line separation", async () => {
    const hover: LspHover = {
      contents: [
        "Doc paragraph.",
        { language: "gdscript", value: "var x: int" },
      ],
    };
    const out = (await normalizeHoverMarkup(hover, ctx)) as LspHover;
    const contents = out.contents as LspMarkupContent;
    expect(contents.kind).toBe("markdown");
    expect(contents.value).toBe(
      "Doc paragraph.\n\n```gdscript\nvar x: int\n```",
    );
  });

  it("preserves an already-MarkupContent envelope and forces kind=markdown", async () => {
    const hover: LspHover = {
      contents: { kind: "plaintext", value: "already wrapped" },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
    };
    const out = (await normalizeHoverMarkup(hover, ctx)) as LspHover;
    const contents = out.contents as LspMarkupContent;
    expect(contents.kind).toBe("markdown");
    expect(contents.value).toBe("already wrapped");
    expect(out.range).toEqual(hover.range);
  });
});

describe("placeholder shims (issue #13 inhabitants 3 & 4)", () => {
  const ctx: AdapterContext = {
    client: fakeClient(),
    documents: trackerWith([]),
    method: "x",
    params: {},
  };

  it("redirectBuiltinUris is currently a pass-through", async () => {
    const native = [{ uri: "gdscript://Node.gd" }];
    expect(await redirectBuiltinUris(native, ctx)).toBe(native);
  });

  it("unionAutoloadGrep is currently a pass-through", async () => {
    const native = [{ uri: "file:///proj/x.gd" }];
    expect(await unionAutoloadGrep(native, ctx)).toBe(native);
  });
});

describe("createGodotAdapter", () => {
  it("wires the four documented postprocess hooks", () => {
    const a = createGodotAdapter();
    expect(a.postprocess?.["workspace/symbol"]).toBe(unionWithDocumentSymbols);
    expect(a.postprocess?.["textDocument/hover"]).toBe(normalizeHoverMarkup);
    expect(a.postprocess?.["textDocument/definition"]).toBe(
      redirectBuiltinUris,
    );
    expect(a.postprocess?.["textDocument/references"]).toBe(unionAutoloadGrep);
  });

  it("declares the documented per-method timeouts", () => {
    const a = createGodotAdapter();
    expect(timeoutFor(a, "textDocument/references")).toBe(60_000);
    expect(timeoutFor(a, "workspace/symbol")).toBe(5_000);
    // Anything else falls through.
    expect(timeoutFor(a, "textDocument/hover")).toBeUndefined();
  });
});
