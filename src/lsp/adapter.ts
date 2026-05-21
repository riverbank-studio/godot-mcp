/**
 * Per-server LSP adapter pattern.
 *
 * Adapter layer that augments raw Godot LSP responses for known-broken
 * methods. Inspired by cclsp's Pyright/Vue adapters (per-method timeout
 * overrides + per-method response post-processing); Godot is closer to
 * Pyright (no custom protocol, just polish) than Vue.
 *
 * See docs/DESIGN.md L496 ("`workspace_symbols` query"), L499 (built-in
 * symbol redirect), L500 (autoload-globals shim), and the four-inhabitant
 * inventory in [issue #13](https://github.com/riverbank-studio/godot-mcp/issues/13).
 *
 * ## Shape
 *
 * A {@link ServerAdapter} is a pair of optional maps keyed by JSON-RPC
 * method name:
 *
 *   - `requestTimeouts[method]` — per-method timeout override (ms).
 *     Plumbed into {@link LspRequestQueue} via the existing `timeoutMs`
 *     enqueue option. Where unset, falls back to the queue's default
 *     (`LspConfig.requestTimeoutMs`, 30s baseline per DESIGN.md L506).
 *   - `postprocess[method]` — async function that receives the native
 *     LSP result plus an {@link AdapterContext} and returns an augmented
 *     result. Where unset, native passes through unchanged.
 *
 * ## Source tagging
 *
 * Every augmented result entry the adapter produces carries a `source`
 * tag — `"lsp" | "docs" | "grep_fallback"` — so the agent (and any
 * higher-layer tool) can reason about reliability and provenance. Native
 * passes-through don't get tagged at this layer — leaves know which
 * fields they're returning and can tag them themselves; the adapter
 * only inserts tags on the entries it constructs.
 *
 * ## Initial inhabitants (Wave 2 amendment / LSP M8)
 *
 * Issue #13 enumerates four Godot-specific quirks:
 *
 *   1. `workspace/symbol` → empty: union with `documentSymbol` over
 *      tracked-open `.gd` files. **Implemented** in this module; consumed
 *      by `godot_workspace_symbols` (#24) and the symbol-mode fallback of
 *      `godot_find_definition`/`godot_find_references` (#12).
 *   2. Hover format normalization (`MarkedString` / quirky markdown →
 *      `MarkupContent { kind: "markdown" }`). **Implemented** here as a
 *      pure helper; consumed by `godot_hover` (#22).
 *   3. Built-in symbol URI redirect (`gdscript://` / `fs.access` failure
 *      → docs subsystem lookup). **Placeholder hook** here — the docs
 *      subsystem isn't wired yet, so the augmenter is a documented
 *      pass-through that the docs subsystem PR will replace.
 *   4. `find_references` on autoload globals: project.godot scan + regex
 *      grep union. **Placeholder hook** — the project.godot reader and
 *      grep helper aren't in this PR's scope.
 *
 * Placeholder hooks pass through cleanly so leaf tools written against
 * the adapter today don't break; they'll start receiving augmentation
 * once their dependency lands.
 */

import * as path from "node:path";

import { DocumentTracker } from "./documents.js";
import { filePathToUri } from "./client.js";

/**
 * Source-of-truth tag every augmented result entry carries. The agent
 * (and any caller above the adapter) can branch on this to decide how
 * much to trust the result.
 *
 *   - `"lsp"` — the native Godot LSP returned this entry.
 *   - `"docs"` — the docs subsystem provided this entry (e.g. built-in
 *     symbol redirected from a `gdscript://` URI).
 *   - `"grep_fallback"` — a regex/text-grep over tracked files produced
 *     this entry (e.g. the autoload-globals shim). Least reliable;
 *     lacks semantic awareness.
 */
export type AdapterSource = "lsp" | "docs" | "grep_fallback";

/**
 * Discriminator-friendly wrapper for source-tagged entries. Leaf tools
 * may use {@link AdapterSource} directly on their result shape if they
 * prefer; this helper is convenient when the underlying LSP type already
 * has its own shape and we want to attach the tag without remodeling.
 */
export interface Sourced<T> {
  /** The underlying entry (LSP type, docs row, or grep hit). */
  value: T;
  /** Provenance tag — see {@link AdapterSource}. */
  source: AdapterSource;
}

/**
 * The minimal client surface the adapter needs to make sub-requests
 * (e.g. `documentSymbol` over each tracked file during the
 * `workspace/symbol` fallback). Declared structurally so the adapter
 * can be unit-tested without spinning up a full {@link LspClient}.
 *
 * Production passes a thin shim around {@link LspClient.request}.
 */
export interface AdapterClient {
  /**
   * Send an LSP request. Mirrors {@link LspClient.request}'s signature
   * minus the `enqueueOpts` argument (the adapter never needs to override
   * lane routing or timeouts for sub-requests; those obey the queue's
   * defaults).
   */
  request<TResult>(
    method: string,
    params: unknown,
    referencedFiles?: readonly string[],
  ): Promise<TResult>;
}

/**
 * Context handed to every {@link Postprocessor}. The adapter passes:
 *
 *   - `client`: send sub-requests (e.g. `documentSymbol` per tracked file).
 *   - `documents`: enumerate tracked-open `.gd` files for the
 *     `workspace/symbol` union fallback.
 *   - `method`: the JSON-RPC method name being post-processed. Useful for
 *     post-processors that handle multiple related methods through one
 *     function.
 *   - `params`: the original request params, in case the postprocessor
 *     needs the query string (e.g. `workspace/symbol`'s `{query}` field)
 *     or position (e.g. `definition`'s `{textDocument, position}`).
 */
export interface AdapterContext {
  /** Sub-request issuer; see {@link AdapterClient}. */
  client: AdapterClient;
  /** Tracked-open document set. */
  documents: DocumentTracker;
  /** The JSON-RPC method name the postprocessor is handling. */
  method: string;
  /** The original request params. */
  params: unknown;
}

/**
 * Per-method response post-processor. Receives the native LSP result
 * (which may be `null`, an empty array, or fully populated) and returns
 * the augmented result. The post-processor decides when to issue sub-
 * requests, when to fall back to alternative data sources, and how to
 * tag entries with {@link AdapterSource}.
 *
 * **Pass-through contract:** A post-processor that has no augmentation
 * to perform must return the input unchanged. Returning a different
 * shape than the LSP spec defines for `method` will break leaf tools.
 */
export type Postprocessor = (
  nativeResult: unknown,
  ctx: AdapterContext,
) => Promise<unknown>;

/**
 * The adapter surface. Both fields are optional so an adapter can opt
 * into just timeout overrides, just post-processing, or both.
 *
 * @example
 * ```ts
 * const godotAdapter: ServerAdapter = {
 *   requestTimeouts: {
 *     "textDocument/references": 60_000,
 *     "workspace/symbol": 5_000,
 *   },
 *   postprocess: {
 *     "workspace/symbol": unionWithDocumentSymbols,
 *     "textDocument/hover": normalizeHoverMarkup,
 *   },
 * };
 * ```
 */
export interface ServerAdapter {
  /**
   * Per-method timeout override in ms. Plumbed into
   * {@link LspRequestQueue} via the `timeoutMs` enqueue option.
   */
  requestTimeouts?: Readonly<Record<string, number>>;
  /**
   * Per-method response post-processor. See {@link Postprocessor}.
   */
  postprocess?: Readonly<Record<string, Postprocessor>>;
}

/**
 * Resolve the timeout override (if any) for a method. Returns
 * `undefined` when no override is configured; callers should treat
 * `undefined` as "use the queue default."
 */
export function timeoutFor(
  adapter: ServerAdapter | undefined,
  method: string,
): number | undefined {
  return adapter?.requestTimeouts?.[method];
}

/**
 * Look up the postprocessor (if any) for a method.
 */
export function postprocessorFor(
  adapter: ServerAdapter | undefined,
  method: string,
): Postprocessor | undefined {
  return adapter?.postprocess?.[method];
}

/**
 * Apply the adapter's postprocessor (if any) to a native LSP result.
 * Pass-through when no postprocessor is registered for the method.
 *
 * @param adapter   The adapter, or undefined to bypass entirely.
 * @param method    The JSON-RPC method name.
 * @param params    The original request params.
 * @param native    The result returned by the LSP server.
 * @param services  Sub-request issuer + tracked-document accessor.
 * @returns         The augmented (or pass-through) result.
 */
export async function augment(
  adapter: ServerAdapter | undefined,
  method: string,
  params: unknown,
  native: unknown,
  services: { client: AdapterClient; documents: DocumentTracker },
): Promise<unknown> {
  const pp = postprocessorFor(adapter, method);
  if (!pp) return native;
  return pp(native, {
    client: services.client,
    documents: services.documents,
    method,
    params,
  });
}

/* -------------------------------------------------------------------------- */
/* Initial inhabitant 1: workspace/symbol union fallback                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimal `SymbolInformation` shape per LSP spec. Declared inline so we
 * don't drag in `vscode-languageserver-types`; the adapter only needs
 * the fields it filters on (`name`) and the fields it preserves when
 * tagging (everything else).
 */
export interface LspSymbolInformation {
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
  /**
   * Provenance tag added by the adapter. Native LSP results carry
   * `"lsp"`; fallback entries from the tracked-file union carry
   * `"lsp"` as well (they still came out of the LSP, just through a
   * different method). Future adapters may tag with `"docs"` or
   * `"grep_fallback"`.
   */
  source?: AdapterSource;
}

/**
 * Minimal `DocumentSymbol` shape per LSP spec (the hierarchical variant
 * Godot returns from `textDocument/documentSymbol`). The adapter
 * flattens these to {@link LspSymbolInformation} for the union with
 * `workspace/symbol` results.
 */
export interface LspDocumentSymbol {
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

/**
 * Recursively flatten a `DocumentSymbol` tree into
 * {@link LspSymbolInformation} entries, prefixing nested names with
 * their container per LSP convention. The `containerName` field is
 * populated from the parent chain.
 */
function flattenDocumentSymbols(
  symbols: readonly LspDocumentSymbol[],
  uri: string,
  containerName?: string,
): LspSymbolInformation[] {
  const out: LspSymbolInformation[] = [];
  for (const sym of symbols) {
    out.push({
      name: sym.name,
      kind: sym.kind,
      location: { uri, range: sym.selectionRange },
      containerName,
    });
    if (sym.children && sym.children.length > 0) {
      out.push(...flattenDocumentSymbols(sym.children, uri, sym.name));
    }
  }
  return out;
}

/**
 * Distinguish hierarchical {@link LspDocumentSymbol}[] from the legacy
 * `SymbolInformation[]` shape some servers return for
 * `textDocument/documentSymbol`. Godot returns hierarchical; tests of
 * adjacent servers may exercise the flat path.
 */
function isHierarchical(
  arr: readonly unknown[],
): arr is readonly LspDocumentSymbol[] {
  if (arr.length === 0) return true;
  const head = arr[0] as { range?: unknown; location?: unknown };
  return head?.range !== undefined && head?.location === undefined;
}

/**
 * Coerce whatever `documentSymbol` returned into a flat
 * {@link LspSymbolInformation}[] list keyed to the given `uri`.
 */
function coerceToSymbolInformation(
  result: unknown,
  uri: string,
): LspSymbolInformation[] {
  if (!Array.isArray(result)) return [];
  if (isHierarchical(result)) {
    return flattenDocumentSymbols(result as readonly LspDocumentSymbol[], uri);
  }
  // Already flat — assume the entries are SymbolInformation-shaped. We
  // don't deeply validate (the LSP server is the source of truth); we
  // just ensure the union output is uniform.
  return result as LspSymbolInformation[];
}

/**
 * Read the query string from a `workspace/symbol` request. The LSP
 * spec defines `params: { query: string }`; we tolerate `null`/missing
 * by treating it as the empty query (which conventionally returns
 * everything — though Godot returns empty either way, hence this shim).
 */
function readQuery(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    "query" in params &&
    typeof (params as { query: unknown }).query === "string"
  ) {
    return (params as { query: string }).query;
  }
  return "";
}

/**
 * Case-insensitive substring filter. Per DESIGN.md L496, Godot's LSP
 * does not implement fuzzy or CamelCase matching; the adapter shim
 * matches its semantics exactly so leaves don't see surprise behavior
 * differences between native and fallback paths.
 */
function matchesQuery(name: string, query: string): boolean {
  if (query === "") return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

/**
 * Build a stable de-duplication key for a symbol entry. Two entries
 * are considered duplicates iff they share URI + start position + name.
 * This is the same key cclsp uses for its symbol union; using start
 * position rather than full range avoids treating "function definition"
 * and "function selection range" as distinct.
 */
function dedupKey(s: LspSymbolInformation): string {
  return `${s.location.uri}|${s.location.range.start.line}:${s.location.range.start.character}|${s.name}`;
}

/**
 * `workspace/symbol` postprocessor: union native results with a
 * `documentSymbol` sweep over tracked-open `.gd` files, filtered by
 * the query string.
 *
 * Algorithm:
 *   1. Coerce native result to an array (Godot returns `null` or `[]`
 *      for most queries — see [godot-vscode-plugin#989]).
 *   2. For each tracked-open file, issue `textDocument/documentSymbol`
 *      and flatten the response into {@link LspSymbolInformation}[].
 *   3. Filter the flat list by case-insensitive substring on `name`.
 *   4. De-duplicate against native results (URI + start pos + name).
 *   5. Tag every entry with `source: "lsp"` and return the union.
 *
 * Failures on per-file `documentSymbol` are swallowed (logged at the
 * call site) — the union shouldn't fail wholesale because one file's
 * sub-request errored. The native portion is always preserved.
 */
export const unionWithDocumentSymbols: Postprocessor = async (
  nativeResult,
  ctx,
) => {
  const query = readQuery(ctx.params);

  // Step 1: normalize native to an array of tagged entries.
  const nativeArr: LspSymbolInformation[] = Array.isArray(nativeResult)
    ? (nativeResult as LspSymbolInformation[]).map((s) => ({
        ...s,
        source: "lsp" as AdapterSource,
      }))
    : [];

  // Step 2: fan out documentSymbol per tracked file.
  const tracked = ctx.documents.trackedFiles();
  const fallback: LspSymbolInformation[] = [];
  for (const abs of tracked) {
    // Only fan out over `.gd` / `.gdshader` — the tracker already
    // filters but we double-check so a future tracker change can't
    // silently widen the fallback set.
    if (!DocumentTracker.isTracked(abs)) continue;
    const uri = filePathToUri(abs);
    let symbols: unknown;
    try {
      symbols = await ctx.client.request(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        [abs],
      );
    } catch {
      // Per-file failure — skip this file's contribution, preserve the
      // rest. The native portion is unaffected.
      continue;
    }
    const flat = coerceToSymbolInformation(symbols, uri);
    for (const sym of flat) {
      if (!matchesQuery(sym.name, query)) continue;
      fallback.push({ ...sym, source: "lsp" });
    }
  }

  // Step 3: de-dupe. Native entries win — they came through the
  // server's native path and may carry richer `containerName` info than
  // a flattened `documentSymbol` traversal.
  const seen = new Set<string>();
  const out: LspSymbolInformation[] = [];
  for (const s of nativeArr) {
    const k = dedupKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  for (const s of fallback) {
    const k = dedupKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/* Initial inhabitant 2: hover format normalization                           */
/* -------------------------------------------------------------------------- */

/**
 * Minimal `Hover` shape per LSP spec. `contents` may be
 * `MarkedString | MarkedString[] | MarkupContent` per the spec, where
 * `MarkedString` is `string | { language, value }` (deprecated). The
 * adapter normalizes all three into `MarkupContent { kind: "markdown" }`.
 *
 * Snap-to-fence truncation is **not** done here — it lives in
 * `godot_hover` per DESIGN.md L495 ("snap-to-fence truncation lives in
 * `godot_hover` (#22), not here"). The adapter handles format
 * normalization only.
 */
export interface LspHover {
  contents: unknown;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * `MarkupContent` shape per LSP spec.
 */
export interface LspMarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

/**
 * Normalize a single `MarkedString` (the deprecated LSP type) to a
 * markdown string. The plain-string variant is left as-is; the
 * `{ language, value }` variant is wrapped in a fenced code block.
 */
function markedStringToMarkdown(ms: unknown): string {
  if (typeof ms === "string") return ms;
  if (
    typeof ms === "object" &&
    ms !== null &&
    "value" in ms &&
    typeof (ms as { value: unknown }).value === "string"
  ) {
    const value = (ms as { value: string }).value;
    const lang =
      "language" in ms &&
      typeof (ms as { language: unknown }).language === "string"
        ? (ms as { language: string }).language
        : "";
    return `\`\`\`${lang}\n${value}\n\`\`\``;
  }
  return "";
}

/**
 * Test whether `contents` is already a `MarkupContent` envelope. Loose
 * structural check — we accept `kind` of either `"markdown"` or
 * `"plaintext"` even though Godot only produces markdown, because the
 * adapter is the right layer to make that assertion liberal.
 */
function isMarkupContent(contents: unknown): contents is LspMarkupContent {
  return (
    typeof contents === "object" &&
    contents !== null &&
    "kind" in contents &&
    "value" in contents &&
    typeof (contents as { value: unknown }).value === "string"
  );
}

/**
 * `textDocument/hover` postprocessor: normalize legacy `MarkedString` /
 * `MarkedString[]` variants (godot#87192) into a uniform
 * `MarkupContent { kind: "markdown" }` envelope.
 *
 * Pass-through cases:
 *   - `null` (no hover available) — returned unchanged.
 *   - `contents` already `MarkupContent` — wrapped object preserved
 *     (with `kind` coerced to `"markdown"` if it was `"plaintext"`,
 *     since Godot's actual content is always markdown by convention
 *     and a `plaintext` tag is itself a server bug).
 */
export const normalizeHoverMarkup: Postprocessor = async (nativeResult) => {
  if (nativeResult === null || nativeResult === undefined) return nativeResult;
  if (typeof nativeResult !== "object") return nativeResult;
  const hover = nativeResult as LspHover;
  const contents = hover.contents;

  if (isMarkupContent(contents)) {
    // Already MarkupContent — preserve range, coerce kind to markdown.
    const normalized: LspMarkupContent = {
      kind: "markdown",
      value: contents.value,
    };
    return { ...hover, contents: normalized };
  }

  if (Array.isArray(contents)) {
    // MarkedString[] — concatenate each rendered piece with blank-line
    // separation per LSP convention.
    const parts = contents.map(markedStringToMarkdown).filter((p) => p !== "");
    const value = parts.join("\n\n");
    return {
      ...hover,
      contents: { kind: "markdown", value } as LspMarkupContent,
    };
  }

  // Single MarkedString (string or { language, value }).
  const value = markedStringToMarkdown(contents);
  return {
    ...hover,
    contents: { kind: "markdown", value } as LspMarkupContent,
  };
};

/* -------------------------------------------------------------------------- */
/* Initial inhabitants 3 & 4: placeholder hooks (pass-through)                */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder for the built-in symbol URI redirect (issue #13 inhabitant
 * 3). The real implementation needs the docs subsystem to be wired
 * (`godot_find_member` per Wave 2 D2 rename) and a research item #34
 * resolution for the URI scheme used by Godot for built-ins. Until then
 * this is a documented pass-through so `godot_find_definition` can be
 * built against the adapter today without breaking.
 *
 * When the docs subsystem lands, this function should:
 *   1. For each `Location` whose URI matches `gdscript://` or
 *      `godot://` (or whose file fails `fs.access(R_OK)`), redirect to
 *      `godot_find_member` and return the result with `source: "docs"`.
 *   2. Pass through all other locations unchanged (tagging with
 *      `source: "lsp"`).
 */
export const redirectBuiltinUris: Postprocessor = async (nativeResult) => {
  // Pass-through until docs subsystem lands.
  return nativeResult;
};

/**
 * Placeholder for the autoload-globals references shim (issue #13
 * inhabitant 4). The real implementation needs a `project.godot`
 * parser (to read the `[autoload]` section) and a regex-grep helper
 * over tracked files. Until then this is a documented pass-through.
 *
 * When the project.godot reader lands, this function should:
 *   1. Read `[autoload]` entries from `project.godot`.
 *   2. If the request's identifier matches an autoload name, fan out a
 *      regex grep over tracked files and union the hits with native
 *      LSP results, tagging grep-derived hits with
 *      `source: "grep_fallback"`.
 *   3. Otherwise pass through unchanged.
 */
export const unionAutoloadGrep: Postprocessor = async (nativeResult) => {
  // Pass-through until project.godot reader lands.
  return nativeResult;
};

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Default Godot LSP adapter. Wires all four inhabitants documented in
 * issue #13:
 *
 *   1. `workspace/symbol` — union with `documentSymbol` over tracked
 *      `.gd` files (implemented).
 *   2. `textDocument/hover` — `MarkedString` normalization (implemented).
 *   3. `textDocument/definition` — built-in URI redirect (placeholder).
 *   4. `textDocument/references` — autoload grep union (placeholder).
 *
 * Per-method timeouts:
 *   - `textDocument/references`: 60s (large projects can be slow).
 *   - `workspace/symbol`: 5s (we have a fast fallback; don't block the
 *     interactive lane waiting for Godot's broken native path).
 *
 * Caller can override fields by spreading the result and merging:
 *
 * ```ts
 * const a = createGodotAdapter();
 * const custom: ServerAdapter = {
 *   ...a,
 *   requestTimeouts: { ...a.requestTimeouts, "textDocument/hover": 1_000 },
 * };
 * ```
 */
export function createGodotAdapter(): ServerAdapter {
  return {
    requestTimeouts: {
      "textDocument/references": 60_000,
      "workspace/symbol": 5_000,
    },
    postprocess: {
      "workspace/symbol": unionWithDocumentSymbols,
      "textDocument/hover": normalizeHoverMarkup,
      "textDocument/definition": redirectBuiltinUris,
      "textDocument/references": unionAutoloadGrep,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Path helpers exposed for tests                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a list of file paths into the absolute form the
 * {@link DocumentTracker} keys on. Re-exported so adapter tests can
 * build expectation lists without re-implementing the path resolution.
 */
export function resolveTrackedPath(filePath: string): string {
  return path.resolve(filePath);
}
