/**
 * Tests for {@link resolveSymbol} (`src/lsp/symbol-resolve.ts`).
 *
 * Issue #12 acceptance shape:
 *   - Single-file scope → uses `textDocument/documentSymbol`, exact
 *     name match.
 *   - Project-wide scope → uses `workspace/symbol` via adapter,
 *     unions with documentSymbol over tracked files, exact name match.
 *   - Container/class filter narrows multi-match correctly.
 *   - Multi-match returns an array with `disambiguationHint` per entry.
 *   - Zero-match returns `[]` (Wave 2 D33 universal rule).
 *   - Per-request failure → empty array, never throws.
 *
 * The resolver is tested in isolation: a tiny `AdapterClient` fake
 * captures sub-requests and replays canned responses; a real
 * {@link DocumentTracker} backed by an in-memory FS exposes the
 * tracked-file enumeration that the union fallback walks.
 */

import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AdapterClient,
  type LspDocumentSymbol,
  type LspSymbolInformation,
  createGodotAdapter,
} from "./adapter.js";
import { filePathToUri } from "./client.js";
import {
  DocumentTracker,
  type DocumentFs,
  type StatLike,
} from "./documents.js";
import {
  filterSymbolMatches,
  resolveSymbol,
  type ResolvedSymbol,
} from "./symbol-resolve.js";

/* -------------------------------------------------------------------------- */
/* fakes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * In-memory FS fake matching `adapter.test.ts`'s shape. Lets us seed
 * tracked-open files without touching the real filesystem.
 */
function fakeFs(
  initial: Record<string, { text: string; stat: StatLike }> = {},
): { fs: DocumentFs } {
  const state = new Map<string, { text: string; stat: StatLike }>();
  for (const [k, v] of Object.entries(initial)) {
    state.set(path.resolve(k), v);
  }
  return {
    fs: {
      statSync(filePath: string): StatLike | null {
        const entry = state.get(path.resolve(filePath));
        return entry ? entry.stat : null;
      },
      readFileSync(filePath: string): string {
        const entry = state.get(path.resolve(filePath));
        if (!entry) throw new Error(`fake fs: missing ${filePath}`);
        return entry.text;
      },
    },
  };
}

/**
 * Build a pre-populated {@link DocumentTracker}. Each entry's text is
 * uniform — these tests don't depend on body content.
 */
function trackerWith(files: readonly string[]): DocumentTracker {
  const initial: Record<string, { text: string; stat: StatLike }> = {};
  for (const f of files) {
    initial[f] = { text: "extends Node\n", stat: { mtimeMs: 1, size: 13 } };
  }
  const { fs } = fakeFs(initial);
  const t = new DocumentTracker({ statPollThrottleMs: 1_000, fs });
  for (const f of files) {
    t.syncReferenced([f]);
  }
  return t;
}

/**
 * Adapter-client fake. Methods that aren't explicitly stubbed return
 * `null`. `throwForMethod` lets a test force a sub-request failure.
 */
function fakeClient(
  responses: {
    documentSymbolByUri?: Record<string, unknown>;
    workspaceSymbol?: unknown;
  } = {},
  options: { throwForMethod?: string } = {},
): AdapterClient & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request<TResult>(method: string, params: unknown): Promise<TResult> {
      calls.push({ method, params });
      if (options.throwForMethod === method) {
        throw new Error(`forced failure for ${method}`);
      }
      if (method === "textDocument/documentSymbol") {
        const uri = (params as { textDocument: { uri: string } }).textDocument
          .uri;
        const byUri = responses.documentSymbolByUri ?? {};
        return (byUri[uri] ?? []) as TResult;
      }
      if (method === "workspace/symbol") {
        return (responses.workspaceSymbol ?? null) as TResult;
      }
      return null as unknown as TResult;
    },
  };
}

/**
 * Build a flat {@link LspSymbolInformation}. Mirrors the helper in
 * `adapter.test.ts`.
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
 * Build a hierarchical {@link LspDocumentSymbol} (what Godot returns
 * from `textDocument/documentSymbol`).
 */
function docSym(
  name: string,
  line = 0,
  character = 0,
  kind = 12,
  children: LspDocumentSymbol[] = [],
): LspDocumentSymbol {
  return {
    name,
    kind,
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

/* -------------------------------------------------------------------------- */
/* filterSymbolMatches                                                        */
/* -------------------------------------------------------------------------- */

describe("filterSymbolMatches", () => {
  const uri = "file:///proj/a.gd";

  it("requires exact case-sensitive name equality", () => {
    const symbols = [
      sym("Player", uri),
      sym("player", uri, 1),
      sym("PlayerController", uri, 2),
    ];
    expect(
      filterSymbolMatches(symbols, { symbolName: "Player" }).map((s) => s.name),
    ).toEqual(["Player"]);
  });

  it("additionally narrows by className when supplied", () => {
    const symbols = [
      sym("_init", uri, 0, 0, { containerName: "Player" }),
      sym("_init", uri, 1, 0, { containerName: "Enemy" }),
      sym("_init", uri, 2, 0),
    ];
    const matches = filterSymbolMatches(symbols, {
      symbolName: "_init",
      className: "Enemy",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].containerName).toBe("Enemy");
    expect(matches[0].location.range.start.line).toBe(1);
  });

  it("preserves input order on multi-match", () => {
    const symbols = [
      sym("foo", uri, 5),
      sym("foo", uri, 2),
      sym("foo", uri, 9),
    ];
    const lines = filterSymbolMatches(symbols, { symbolName: "foo" }).map(
      (s) => s.location.range.start.line,
    );
    expect(lines).toEqual([5, 2, 9]);
  });

  it("returns [] on zero match without throwing", () => {
    expect(
      filterSymbolMatches([sym("a", uri), sym("b", uri)], { symbolName: "c" }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* resolveSymbol — single-file scope                                          */
/* -------------------------------------------------------------------------- */

describe("resolveSymbol (file scope)", () => {
  const fileA = path.resolve("/proj/a.gd");
  const uriA = filePathToUri(fileA);

  it("issues documentSymbol against the named file only", async () => {
    const documents = trackerWith([fileA, path.resolve("/proj/b.gd")]);
    const client = fakeClient({
      documentSymbolByUri: {
        [uriA]: [docSym("Player", 4, 0, 5), docSym("Enemy", 20, 0, 5)],
      },
    });
    const out = await resolveSymbol(
      { client, documents },
      { symbolName: "Player", file: fileA },
    );
    expect(out).toHaveLength(1);
    expect(out[0].symbolName).toBe("Player");
    expect(out[0].file).toBe(fileA);
    expect(out[0].line).toBe(4);
    expect(out[0].character).toBe(0);
    expect(out[0].kind).toBe(5);
    // Should NOT have asked workspace/symbol when file is scoped.
    expect(client.calls.some((c) => c.method === "workspace/symbol")).toBe(
      false,
    );
    expect(
      client.calls.filter((c) => c.method === "textDocument/documentSymbol"),
    ).toHaveLength(1);
  });

  it("flattens hierarchical children and exposes containerName", async () => {
    const documents = trackerWith([fileA]);
    const playerClass = docSym("Player", 0, 0, 5, [
      docSym("_init", 1, 4, 12),
      docSym("attack", 6, 4, 12),
    ]);
    const client = fakeClient({
      documentSymbolByUri: { [uriA]: [playerClass] },
    });
    const out = await resolveSymbol(
      { client, documents },
      { symbolName: "_init", file: fileA },
    );
    expect(out).toHaveLength(1);
    expect(out[0].containerName).toBe("Player");
    expect(out[0].line).toBe(1);
    expect(out[0].character).toBe(4);
    expect(out[0].disambiguationHint).toContain("Player._init");
    // 1-based suffix in the hint (line 1 + 1 = 2, char 4 + 1 = 5).
    expect(out[0].disambiguationHint).toContain(":2:5");
  });

  it("returns [] when the file's documentSymbol throws", async () => {
    const documents = trackerWith([fileA]);
    const client = fakeClient(
      { documentSymbolByUri: { [uriA]: [docSym("Player", 0, 0)] } },
      { throwForMethod: "textDocument/documentSymbol" },
    );
    const out = await resolveSymbol(
      { client, documents },
      { symbolName: "Player", file: fileA },
    );
    expect(out).toEqual([]);
  });

  it("returns [] on zero match", async () => {
    const documents = trackerWith([fileA]);
    const client = fakeClient({
      documentSymbolByUri: { [uriA]: [docSym("OtherName", 0, 0)] },
    });
    const out = await resolveSymbol(
      { client, documents },
      { symbolName: "Player", file: fileA },
    );
    expect(out).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* resolveSymbol — project-wide scope (uses adapter)                          */
/* -------------------------------------------------------------------------- */

describe("resolveSymbol (project scope, no file)", () => {
  const fileA = path.resolve("/proj/a.gd");
  const fileB = path.resolve("/proj/b.gd");
  const uriA = filePathToUri(fileA);
  const uriB = filePathToUri(fileB);

  it("filters native workspace/symbol results by exact name", async () => {
    const documents = trackerWith([]);
    const client = fakeClient({
      workspaceSymbol: [
        sym("Player", uriA, 4, 0),
        sym("PlayerController", uriB, 0, 0),
      ],
    });
    const out = await resolveSymbol(
      { client, documents },
      { symbolName: "Player" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].symbolName).toBe("Player");
    expect(out[0].file).toBe(fileA);
  });

  it("unions with documentSymbol fallback via the godot adapter", async () => {
    // Native workspace/symbol returns empty (the actual Godot behavior
    // this whole subsystem is designed around). The adapter unions
    // documentSymbol over tracked files; filterSymbolMatches then
    // tightens to exact name equality.
    const documents = trackerWith([fileA, fileB]);
    const client = fakeClient({
      workspaceSymbol: [],
      documentSymbolByUri: {
        [uriA]: [docSym("Player", 4, 0, 5), docSym("noise", 10, 0)],
        [uriB]: [docSym("Enemy", 0, 0, 5)],
      },
    });
    const out = await resolveSymbol(
      { client, documents, adapter: createGodotAdapter() },
      { symbolName: "Player" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].symbolName).toBe("Player");
    expect(out[0].file).toBe(fileA);
    expect(out[0].line).toBe(4);
  });

  it("returns multi-match with per-entry disambiguationHint", async () => {
    // Two distinct files declare the same symbol name → multi-match.
    const documents = trackerWith([fileA, fileB]);
    const client = fakeClient({
      workspaceSymbol: [],
      documentSymbolByUri: {
        [uriA]: [docSym("attack", 12, 4, 12)],
        [uriB]: [docSym("attack", 30, 4, 12)],
      },
    });
    const out = await resolveSymbol(
      { client, documents, adapter: createGodotAdapter() },
      { symbolName: "attack" },
    );
    expect(out).toHaveLength(2);
    const files = out.map((r: ResolvedSymbol) => r.file).sort();
    expect(files).toEqual([fileA, fileB].sort());
    for (const r of out) {
      expect(r.disambiguationHint).toContain("attack at ");
      // 1-based position suffix (line 12 -> 13, char 4 -> 5; line 30 -> 31).
      expect(r.disambiguationHint).toMatch(/:(13|31):5$/);
    }
  });

  it("returns [] when workspace/symbol throws AND no adapter", async () => {
    const documents = trackerWith([fileA]);
    const client = fakeClient(
      { workspaceSymbol: [], documentSymbolByUri: { [uriA]: [] } },
      { throwForMethod: "workspace/symbol" },
    );
    const out = await resolveSymbol(
      { client, documents },
      { symbolName: "Player" },
    );
    expect(out).toEqual([]);
    // Adapter not engaged → no documentSymbol fallback issued.
    expect(
      client.calls.some((c) => c.method === "textDocument/documentSymbol"),
    ).toBe(false);
  });

  it("returns [] on zero matches even with rich fallback data", async () => {
    const documents = trackerWith([fileA]);
    const client = fakeClient({
      workspaceSymbol: [],
      documentSymbolByUri: { [uriA]: [docSym("foo", 0, 0)] },
    });
    const out = await resolveSymbol(
      { client, documents, adapter: createGodotAdapter() },
      { symbolName: "DoesNotExist" },
    );
    expect(out).toEqual([]);
  });

  it("respects className container filter on project-wide resolution", async () => {
    const documents = trackerWith([fileA, fileB]);
    // Two classes with _init each — container filter must pick exactly one.
    const playerClass = docSym("Player", 0, 0, 5, [docSym("_init", 1, 4, 12)]);
    const enemyClass = docSym("Enemy", 0, 0, 5, [docSym("_init", 1, 4, 12)]);
    const client = fakeClient({
      workspaceSymbol: [],
      documentSymbolByUri: {
        [uriA]: [playerClass],
        [uriB]: [enemyClass],
      },
    });
    const out = await resolveSymbol(
      { client, documents, adapter: createGodotAdapter() },
      { symbolName: "_init", className: "Enemy" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].containerName).toBe("Enemy");
    expect(out[0].file).toBe(fileB);
  });
});

/* -------------------------------------------------------------------------- */
/* integration-shaped: end-to-end resolution + position handoff               */
/* -------------------------------------------------------------------------- */

describe("resolveSymbol — integration", () => {
  const fileA = path.resolve("/proj/scripts/player.gd");
  const uriA = filePathToUri(fileA);

  it(
    "drives the full agent path: symbol_name → candidate → 0-based " +
      "(file, line, character) suitable for a follow-up LSP request",
    async () => {
      // Scenario: agent says "find references to Player._init" with NO
      // position. Resolver hits workspace/symbol (empty), unions with
      // documentSymbol over the tracked-open player.gd, narrows by
      // exact name + container, and returns one candidate. The leaf
      // tool then issues `textDocument/references` against the
      // candidate's URI + 0-based position.
      const documents = trackerWith([fileA]);
      const playerClass = docSym("Player", 0, 0, 5, [
        docSym("_init", 2, 4, 12),
        docSym("attack", 8, 4, 12),
      ]);
      const client = fakeClient({
        workspaceSymbol: [],
        documentSymbolByUri: { [uriA]: [playerClass] },
      });
      const candidates = await resolveSymbol(
        { client, documents, adapter: createGodotAdapter() },
        { symbolName: "_init", className: "Player" },
      );
      expect(candidates).toHaveLength(1);
      const [hit] = candidates;
      expect(hit.file).toBe(fileA);
      expect(hit.line).toBe(2);
      expect(hit.character).toBe(4);
      expect(hit.containerName).toBe("Player");
      expect(hit.kind).toBe(12);
      expect(hit.disambiguationHint).toBe(`Player._init at ${fileA}:3:5`);

      // The agent (or leaf tool) can hand this straight to an LSP call.
      // We don't actually call references in this test — we only assert
      // the resolver produced the bits a leaf tool would feed in.
      const referencesParams = {
        textDocument: { uri: filePathToUri(hit.file) },
        position: { line: hit.line, character: hit.character },
        context: { includeDeclaration: true },
      };
      expect(referencesParams.textDocument.uri).toBe(uriA);
      expect(referencesParams.position).toEqual({ line: 2, character: 4 });
    },
  );
});
