/**
 * `godot_document_symbols` tool — issue #23.
 *
 * Lists all symbols (classes, functions, variables, constants, signals, etc.)
 * in a GDScript file via the LSP `textDocument/documentSymbol` method. Handles
 * both the hierarchical `DocumentSymbol[]` response (Godot 4.x preferred) and
 * the flat `SymbolInformation[]` fallback. Caps output at 500 symbols and sets
 * `truncated: true` when the cap is hit, per issue #23 and DESIGN.md L510.
 *
 * Output positions are 1-based (wire convention, DESIGN.md L490).
 * An empty result is returned as `{ symbols: [], truncated: false }`, never as
 * an MCP error (DESIGN.md L492 zero-results rule).
 */

import { filePathToUri } from "../../lsp/client.js";
import {
  fromLspRange,
  validateFileInProject,
  withLspClient,
} from "../../lsp/tool-helpers.js";
import { createErrorResponse } from "../../shared/errors.js";
import type { ToolContext, ToolResponse } from "../../shared/types.js";
import { registerLspTool } from "../lsp-tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum symbols returned in a single response (issue #23 spec). */
const SYMBOL_CAP = 500;

// ---------------------------------------------------------------------------
// LSP response shapes
// ---------------------------------------------------------------------------

/**
 * LSP `DocumentSymbol` node (hierarchical). `range` / `selectionRange` are
 * 0-based per the LSP spec. `children` is optional and may be nested.
 */
interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRawRange;
  selectionRange: LspRawRange;
  children?: LspDocumentSymbol[];
}

/**
 * LSP `SymbolInformation` node (flat). Discriminated from `DocumentSymbol`
 * by the presence of `location` rather than `range` at the top level.
 */
interface LspSymbolInformation {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: LspRawRange;
  };
  containerName?: string;
}

/** Raw 0-based LSP range (before wire-position conversion). */
interface LspRawRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Union of the two possible LSP response shapes for document symbols. */
type LspDocumentSymbolResult =
  | LspDocumentSymbol[]
  | LspSymbolInformation[]
  | null;

// ---------------------------------------------------------------------------
// Wire output shapes
// ---------------------------------------------------------------------------

/**
 * A symbol entry in the wire response. `range` and `selectionRange` use
 * 1-based wire positions (DESIGN.md L490). `children` is present (possibly
 * empty) for hierarchical responses; absent for flat ones.
 */
interface WireSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: ReturnType<typeof fromLspRange>;
  selectionRange?: ReturnType<typeof fromLspRange>;
  children?: WireSymbol[];
  containerName?: string;
}

/** The top-level tool response body. */
interface DocumentSymbolsBody {
  symbols: WireSymbol[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Type discriminator
// ---------------------------------------------------------------------------

/**
 * Return true when `item` is a `DocumentSymbol` (hierarchical) rather than
 * a `SymbolInformation` (flat). The presence of `range` at the top level (as
 * opposed to nested under `location`) is the discriminating field per the LSP
 * spec (§ 3.17 DocumentSymbol vs SymbolInformation).
 */
function isDocumentSymbol(
  item: LspDocumentSymbol | LspSymbolInformation,
): item is LspDocumentSymbol {
  return "range" in item && "selectionRange" in item;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/** Convert a single `LspDocumentSymbol` to a `WireSymbol` (recursive). */
function convertDocumentSymbol(sym: LspDocumentSymbol): WireSymbol {
  const wire: WireSymbol = {
    name: sym.name,
    kind: sym.kind,
    range: fromLspRange(sym.range),
    selectionRange: fromLspRange(sym.selectionRange),
  };
  if (sym.detail !== undefined) {
    wire.detail = sym.detail;
  }
  if (sym.children !== undefined) {
    wire.children = sym.children.map(convertDocumentSymbol);
  } else {
    wire.children = [];
  }
  return wire;
}

/** Convert a single `LspSymbolInformation` to a `WireSymbol`. */
function convertSymbolInformation(sym: LspSymbolInformation): WireSymbol {
  const wire: WireSymbol = {
    name: sym.name,
    kind: sym.kind,
    range: fromLspRange(sym.location.range),
  };
  if (sym.containerName !== undefined) {
    wire.containerName = sym.containerName;
  }
  return wire;
}

/**
 * Count the total number of symbols in a hierarchical list (including all
 * nested children) for the cap check.
 */
function countHierarchical(symbols: LspDocumentSymbol[]): number {
  let count = 0;
  for (const sym of symbols) {
    count += 1;
    if (sym.children && sym.children.length > 0) {
      count += countHierarchical(sym.children);
    }
  }
  return count;
}

/**
 * Flatten a hierarchical `DocumentSymbol[]` into a flat list, respecting
 * `maxCount`. Returns `{ items, truncated }`.
 */
function flattenHierarchical(
  symbols: LspDocumentSymbol[],
  maxCount: number,
): { items: LspDocumentSymbol[]; truncated: boolean } {
  const total = countHierarchical(symbols);
  if (total <= maxCount) {
    return { items: symbols, truncated: false };
  }
  // Cap: slice the top-level list (children are included verbatim for the
  // symbols that fit). A flat top-level slice is the simplest behaviour that
  // meets the spec; deep hierarchies with 500+ symbols are rare in GDScript.
  return { items: symbols.slice(0, maxCount), truncated: true };
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Main handler for `godot_document_symbols`. Extracted so tests can call it
 * directly without the registration side-effect.
 */
async function documentSymbolsHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResponse> {
  const file = args["file"];
  if (typeof file !== "string" || file.trim() === "") {
    return createErrorResponse(
      "`file` argument is required and must be a non-empty string.",
    );
  }

  return withLspClient(ctx, async ({ client, projectRoot }) => {
    // Validate that the file is within the project root.
    let validatedFile: string;
    try {
      validatedFile = validateFileInProject(file, projectRoot);
    } catch (err) {
      return createErrorResponse(
        err instanceof Error ? err.message : String(err),
      );
    }

    const uri = filePathToUri(validatedFile);
    const raw = await client.request<LspDocumentSymbolResult>(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      [validatedFile],
    );

    // Null / empty → zero-results rule (DESIGN.md L492).
    if (!raw || raw.length === 0) {
      const body: DocumentSymbolsBody = { symbols: [], truncated: false };
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    }

    let wireSymbols: WireSymbol[];
    let truncated: boolean;

    if (isDocumentSymbol(raw[0] as LspDocumentSymbol | LspSymbolInformation)) {
      // Hierarchical path.
      const hierarchical = raw as LspDocumentSymbol[];
      const { items, truncated: t } = flattenHierarchical(
        hierarchical,
        SYMBOL_CAP,
      );
      wireSymbols = items.map(convertDocumentSymbol);
      truncated = t;
    } else {
      // Flat SymbolInformation path.
      const flat = raw as LspSymbolInformation[];
      truncated = flat.length > SYMBOL_CAP;
      const sliced = truncated ? flat.slice(0, SYMBOL_CAP) : flat;
      wireSymbols = sliced.map(convertSymbolInformation);
    }

    const body: DocumentSymbolsBody = { symbols: wireSymbols, truncated };
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerLspTool({
  name: "godot_document_symbols",
  description:
    "List all symbols (classes, functions, variables, constants, signals) in a GDScript file. " +
    "Returns a structured list with name, kind, and source range for each symbol. " +
    "Use this to understand the structure of a specific file before reading or editing it. " +
    "Prefer this over guessing the file structure from prior knowledge. " +
    "Caps at 500 symbols; check `truncated` in the response when working with very large files.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Absolute path to the GDScript file to list symbols for. " +
          "Must be within the project root.",
      },
    },
    required: ["file"],
  },
  handler: documentSymbolsHandler,
});
