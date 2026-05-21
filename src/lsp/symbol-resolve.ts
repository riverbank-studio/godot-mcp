/**
 * Symbol-based LSP resolution (issue #12).
 *
 * Provides an opt-in helper {@link resolveSymbol} that LSP read tools
 * ([`godot_find_definition` #20](https://github.com/riverbank-studio/godot-mcp/issues/20),
 * [`godot_find_references` #21](https://github.com/riverbank-studio/godot-mcp/issues/21),
 * [`godot_hover` #22](https://github.com/riverbank-studio/godot-mcp/issues/22),
 * and [`godot_preview_rename` #28](https://github.com/riverbank-studio/godot-mcp/issues/28))
 * can call when the agent supplied `symbol_name` instead of
 * `(file, line, character)`. The resolver returns the list of
 * `(file, line, character)` candidates the underlying LSP request should
 * be issued against.
 *
 * ## Why a helper, not a wrapper
 *
 * The leaf tools differ in how they consume the resolved position:
 *
 *   - `godot_find_definition` / `godot_find_references` — one request per
 *     candidate, results unioned.
 *   - `godot_hover` — one request per candidate, results returned as an
 *     array (since each candidate may resolve to a different overload).
 *   - `godot_preview_rename` — exactly one match required; multi-match
 *     returns the disambiguation list instead of computing edits.
 *
 * A single wrapper that transforms params before issuing one positional
 * call doesn't cover the rename multi-match case or the hover multi-
 * overload case cleanly. The opt-in helper keeps the per-tool
 * orchestration in the leaf where the policy lives.
 *
 * ## Resolution algorithm
 *
 * Per DESIGN.md L493 and issue #12 acceptance criteria:
 *
 *   1. If `(line, character)` provided AND in-bounds for current file
 *      content → use positional path (existing behavior). The resolver
 *      is **not called** in this case — the leaf tool guards on
 *      "positional params present" before consulting the resolver.
 *   2. If `symbol_name` provided with `file` scoping → issue
 *      `textDocument/documentSymbol` against that file, filter by exact
 *      name match.
 *   3. If `symbol_name` provided without `file` → issue
 *      `workspace/symbol` (which the adapter already shims to a union of
 *      `documentSymbol` over tracked-open files per #13 inhabitant 1),
 *      filter by exact name match.
 *   4. Optional `class_name` (or `container_name` synonym) — further
 *      filter by `containerName` exact match. Per DESIGN.md L493 and
 *      cclsp's `findSymbolsByName` pattern.
 *   5. Multi-match → return array with `disambiguation_hint` per entry.
 *   6. Zero match → return empty array (Wave 2 D33 universal rule).
 *
 * ## Exact match, not substring
 *
 * The adapter's `workspace/symbol` shim uses **case-insensitive
 * substring** because that mirrors what Godot's LSP would return if it
 * worked (per DESIGN.md L496). Symbol-based resolution, by contrast,
 * uses **exact case-sensitive equality** — the agent supplied a specific
 * symbol name and "Player" should not also match "PlayerController".
 * This is the same distinction cclsp draws between `workspaceSymbols`
 * (search) and `findSymbolsByName` (resolution).
 *
 * If the agent really wants substring matching, they use the
 * `godot_workspace_symbols` tool first and pick a hit.
 */

import * as path from "node:path";

import { filePathToUri } from "./client.js";
import { DocumentTracker } from "./documents.js";
import {
  type AdapterClient,
  type AdapterContext,
  type LspSymbolInformation,
  type ServerAdapter,
  augment,
  postprocessorFor,
} from "./adapter.js";

/**
 * Input shape for {@link resolveSymbol}. Either `symbolName` alone, or
 * combined with `file` (single-file scope) and/or `className` (container
 * filter), drives the resolution. The leaf tool decides which fields to
 * forward from its own params object.
 */
export interface SymbolResolveInput {
  /**
   * The symbol name to resolve. **Exact case-sensitive match.** Required.
   */
  symbolName: string;
  /**
   * Absolute file path to scope resolution to. When supplied, the
   * resolver issues `textDocument/documentSymbol` against this file
   * only — never `workspace/symbol`. Leaf tools use this when they have
   * a `file` parameter alongside `symbol_name` (typical for rename and
   * find-references "in this file" mode).
   */
  file?: string;
  /**
   * Optional container filter. Matched against each candidate's
   * `containerName` with exact case-sensitive equality. Use when the
   * agent supplied a fully-qualified name like `Player._init` —
   * `symbolName: "_init", className: "Player"`.
   *
   * Per cclsp's `findSymbolsByName`, this filter is **additive** on top
   * of `symbolName`. A candidate matches iff its `name` equals
   * `symbolName` AND its `containerName` equals `className`.
   */
  className?: string;
}

/**
 * One resolved candidate. The leaf tool consumes `file`, `line`, and
 * `character` to issue its underlying LSP request; the remaining fields
 * are surfaced back to the agent as the `disambiguation_hint` on
 * multi-match.
 *
 * Positions are **0-based** here — matching the LSP wire format — so
 * the leaf can hand them straight to `request("textDocument/X", ...)`.
 * Tool-layer responses convert to 1-based when surfacing to the agent.
 */
export interface ResolvedSymbol {
  /** Resolved symbol name (mirrors {@link SymbolResolveInput.symbolName}). */
  symbolName: string;
  /** Absolute file path of the symbol's declaration. */
  file: string;
  /**
   * 0-based line number. LSP-native; convert to 1-based at the tool
   * boundary if the tool surfaces positions to the agent.
   */
  line: number;
  /**
   * 0-based character offset. LSP-native; convert at the tool boundary.
   */
  character: number;
  /**
   * LSP `SymbolKind` numeric value (e.g. 12 = Function, 5 = Class).
   * Surfaced to the agent verbatim so it can disambiguate without us
   * needing to maintain a kind-name lookup table.
   */
  kind: number;
  /**
   * The symbol's container, when present. For a GDScript method
   * declared inside `class_name Player`, the LSP returns `Player` here.
   * `undefined` for top-level symbols.
   */
  containerName?: string;
  /**
   * Human-readable string the agent uses to pick a candidate on
   * multi-match. Format: `"<containerName>.<symbolName>` if container is
   * known, otherwise `"<symbolName>"`, plus the file path and 1-based
   * position suffix. The agent doesn't need to parse this — it just
   * sees enough context to choose the right entry.
   *
   * Example: `"Player._init at scripts/player.gd:12:5"`.
   */
  disambiguationHint: string;
}

/**
 * URI scheme prefix length for `file://` — used to strip the prefix
 * during URI→path conversion. Stays a constant so the inverse of
 * `filePathToUri` is unambiguous.
 */
const FILE_URI_PREFIX = "file://";

/**
 * Invert {@link filePathToUri} just far enough for the resolver's needs.
 * Strips the `file://` prefix and, on Windows, the leading slash before
 * the drive letter (`file:///C:/foo` → `C:/foo`). Non-`file://` URIs
 * (e.g. synthetic `gdscript://`) pass through unchanged — the leaf tool
 * sees the raw URI and can choose how to handle it (typically: tag it
 * as a built-in and fall through to the docs subsystem per #34).
 *
 * Not exported from `client.ts` deliberately — symbol resolution is the
 * only consumer today, and a misuse-prone helper deserves a tight
 * blast radius until a second consumer arrives.
 */
function uriToFilePath(uri: string): string {
  if (!uri.startsWith(FILE_URI_PREFIX)) return uri;
  const rest = uri.slice(FILE_URI_PREFIX.length);
  // `file:///C:/foo` → `rest === "/C:/foo"` → drop the leading slash so
  // the drive letter starts the path. `file:///foo` (POSIX) → `rest ===
  // "/foo"` → keep the leading slash.
  const stripped = /^\/[A-Za-z]:\//.test(rest) ? rest.slice(1) : rest;
  // Round-trip through `path.normalize` so the returned path uses the
  // platform-native separator. The DocumentTracker keys on
  // `path.resolve(...)` output (backslashes on Windows), so leaf tools
  // that compare `resolved.file` against tracker keys need matching
  // separators. `filePathToUri` is forward-slash only — this is its
  // intentional inverse for the platform.
  return path.normalize(stripped);
}

/**
 * Build the human-readable disambiguation hint for a candidate. Format
 * lives in {@link ResolvedSymbol.disambiguationHint}'s docstring.
 *
 * The 1-based suffix matches the editor convention (and the
 * agent-facing position convention documented at DESIGN.md L490) so the
 * agent can copy-paste the hint into a position-mode call without
 * mental conversion.
 */
function buildHint(
  symbolName: string,
  containerName: string | undefined,
  file: string,
  line: number,
  character: number,
): string {
  const qualified = containerName
    ? `${containerName}.${symbolName}`
    : symbolName;
  // Convert 0-based LSP coords to 1-based for the hint string.
  return `${qualified} at ${file}:${line + 1}:${character + 1}`;
}

/**
 * Coerce a {@link LspSymbolInformation} into a {@link ResolvedSymbol}.
 * Pulls `(line, character)` from the location's start position and
 * inverts the URI to an absolute file path.
 */
function toResolved(s: LspSymbolInformation): ResolvedSymbol {
  const file = uriToFilePath(s.location.uri);
  const line = s.location.range.start.line;
  const character = s.location.range.start.character;
  return {
    symbolName: s.name,
    file,
    line,
    character,
    kind: s.kind,
    containerName: s.containerName,
    disambiguationHint: buildHint(
      s.name,
      s.containerName,
      file,
      line,
      character,
    ),
  };
}

/**
 * Apply the candidate filters to a raw symbol list. Pure for unit-
 * testing — separated from the I/O-bound {@link resolveSymbol} so each
 * filter rule can be exercised without a fake client.
 *
 *   - `symbolName` — exact case-sensitive name equality.
 *   - `className` — exact case-sensitive container equality (when set).
 *
 * The order in which matches are returned mirrors input order, which
 * for the union shim means "native LSP results first, then
 * tracked-file fallback" — see `unionWithDocumentSymbols` in
 * `adapter.ts`. The leaf tool can rely on this order when picking a
 * "first hit" for single-match optimistic resolution.
 */
export function filterSymbolMatches(
  symbols: readonly LspSymbolInformation[],
  input: SymbolResolveInput,
): LspSymbolInformation[] {
  const out: LspSymbolInformation[] = [];
  for (const s of symbols) {
    if (s.name !== input.symbolName) continue;
    if (input.className !== undefined && s.containerName !== input.className) {
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * Coerce whatever `documentSymbol` returns into a flat
 * {@link LspSymbolInformation}[] list keyed to `uri`. Mirrors the
 * adapter's internal coercion — duplicated here rather than exported so
 * the adapter stays free to change its representation without breaking
 * us. (When the layouts converge, we'll lift this into a shared util.)
 */
function flattenDocumentSymbols(
  result: unknown,
  uri: string,
): LspSymbolInformation[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 0) return [];
  const head = result[0] as { range?: unknown; location?: unknown };
  // Already-flat SymbolInformation[]: pass through.
  if (head?.location !== undefined && head?.range === undefined) {
    return result as LspSymbolInformation[];
  }
  // Hierarchical DocumentSymbol[]: walk children, prefix containerName.
  const out: LspSymbolInformation[] = [];
  type DocSym = {
    name: string;
    kind: number;
    selectionRange: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    children?: DocSym[];
  };
  const walk = (arr: readonly DocSym[], containerName?: string): void => {
    for (const sym of arr) {
      out.push({
        name: sym.name,
        kind: sym.kind,
        location: { uri, range: sym.selectionRange },
        containerName,
      });
      if (sym.children && sym.children.length > 0) {
        walk(sym.children, sym.name);
      }
    }
  };
  walk(result as readonly DocSym[]);
  return out;
}

/**
 * Resolve a symbol name to one or more `(file, line, character)`
 * candidates. See module docstring for the full algorithm.
 *
 * @param services  Sub-request issuer + tracked-document accessor.
 *                  Production passes `{ client: <LspClient shim>,
 *                  documents: <LspClient.documents>, adapter:
 *                  createGodotAdapter() }`.
 * @param input     The resolution input — `symbolName` plus optional
 *                  `file` (single-file scope) and `className` (container
 *                  filter).
 * @returns         Zero, one, or many {@link ResolvedSymbol} entries.
 *                  Empty array means "no symbol found" (consistent with
 *                  D33 universal zero-results rule).
 *
 * @example Single-file resolution
 * ```ts
 * const matches = await resolveSymbol(
 *   { client, documents, adapter },
 *   { symbolName: "_ready", file: "/proj/player.gd" },
 * );
 * if (matches.length === 1) {
 *   await client.request("textDocument/definition", {
 *     textDocument: { uri: filePathToUri(matches[0].file) },
 *     position: { line: matches[0].line, character: matches[0].character },
 *   });
 * }
 * ```
 *
 * @example Project-wide resolution with container filter
 * ```ts
 * const matches = await resolveSymbol(
 *   { client, documents, adapter },
 *   { symbolName: "_init", className: "Player" },
 * );
 * ```
 */
export async function resolveSymbol(
  services: {
    client: AdapterClient;
    documents: DocumentTracker;
    adapter?: ServerAdapter;
  },
  input: SymbolResolveInput,
): Promise<ResolvedSymbol[]> {
  // Single-file scope: documentSymbol over the named file.
  if (input.file !== undefined) {
    const uri = filePathToUri(input.file);
    let native: unknown;
    try {
      native = await services.client.request(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        [input.file],
      );
    } catch {
      // Per-file failure → no candidates. Consistent with the
      // adapter's per-file isolation in the union shim.
      return [];
    }
    const flat = flattenDocumentSymbols(native, uri);
    const matches = filterSymbolMatches(flat, input);
    return matches.map(toResolved);
  }

  // Project-wide scope: workspace/symbol via the adapter.
  //
  // The query we send is the symbolName itself. The adapter's
  // workspace/symbol postprocessor does case-insensitive substring
  // filtering with that query, which is a SUPERSET of our exact-match
  // filter — so we get every candidate the adapter would surface, then
  // tighten to exact equality at the filter step below.
  //
  // We invoke the adapter explicitly via `augment` rather than relying
  // on a wrapping client because the resolver may be called from
  // contexts that don't have an augment-aware client surface. Callers
  // that DO have one (e.g. when the LspClient grows native adapter
  // integration in #20-22) can pass `adapter: undefined` and the
  // resolver will use whatever post-processing the underlying client
  // does itself.
  const params = { query: input.symbolName };
  let native: unknown;
  try {
    native = await services.client.request("workspace/symbol", params);
  } catch {
    return [];
  }

  // If the caller asked us to apply an adapter, do so. The adapter's
  // workspace/symbol postprocessor unions native results with a
  // documentSymbol sweep over tracked-open files (the #13 inhabitant 1
  // shim). Without the adapter, an empty native `workspace/symbol`
  // response from Godot would silently produce zero matches — the
  // exact failure mode #12 is designed to avoid.
  let symbols: unknown = native;
  if (
    services.adapter !== undefined &&
    postprocessorFor(services.adapter, "workspace/symbol")
  ) {
    const ctx: AdapterContext = {
      client: services.client,
      documents: services.documents,
      method: "workspace/symbol",
      params,
    };
    symbols = await augment(
      services.adapter,
      "workspace/symbol",
      params,
      native,
      { client: services.client, documents: services.documents },
    );
    // Reference ctx so an unused-binding lint doesn't strip the
    // intentional documentation of the post-processor's argument
    // shape. `augment` builds an equivalent ctx internally.
    void ctx;
  }

  if (!Array.isArray(symbols)) return [];
  const matches = filterSymbolMatches(
    symbols as readonly LspSymbolInformation[],
    input,
  );
  return matches.map(toResolved);
}
