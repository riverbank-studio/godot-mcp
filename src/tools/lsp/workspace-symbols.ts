/**
 * `godot_workspace_symbols` tool — issue #24.
 *
 * Search symbols across the entire workspace by a query string, via the LSP
 * `workspace/symbol` method. Returns a flat list of `SymbolInformation`
 * entries (the only shape `workspace/symbol` specifies — hierarchical
 * `DocumentSymbol` trees are a `textDocument/documentSymbol`-only response).
 *
 * Per DESIGN.md L496: the query is treated as a substring, case-insensitive.
 * Godot's LSP does not implement fuzzy or CamelCase matching; the parameter
 * doc documents this explicitly.
 *
 * Output positions are 1-based (wire convention, DESIGN.md L490). Location
 * URIs are decoded to file paths via {@link uriToFilePath}; non-`file://`
 * URIs (e.g. `gdscript://@GlobalScope`) are passed through unchanged so the
 * caller can detect built-in-symbol results by prefix.
 *
 * An empty result is returned as `{ symbols: [] }`, never as an MCP error
 * (DESIGN.md L492 zero-results rule).
 *
 * ## Adapter integration (#13)
 *
 * After the native `workspace/symbol` request returns, results are passed
 * through {@link augment} with the Godot adapter registered for
 * `"workspace/symbol"`. The adapter's {@link unionWithDocumentSymbols}
 * postprocessor fans out `textDocument/documentSymbol` over tracked-open
 * `.gd` files when the native result is empty or sparse (Godot LSP quirk
 * #989), de-duplicates, and tags every entry with
 * `source: "lsp" | "docs" | "grep_fallback"`. The `source` field is
 * preserved verbatim on the wire response.
 */

import {
  fromLspRange,
  uriToFilePath,
  withLspClient,
} from "../../lsp/tool-helpers.js";
import {
  augment,
  createGodotAdapter,
  type AdapterSource,
  type LspSymbolInformation,
} from "../../lsp/adapter.js";
import { DocumentTracker } from "../../lsp/documents.js";
import { createErrorResponse } from "../../shared/errors.js";
import type { ToolContext, ToolResponse } from "../../shared/types.js";
import { registerLspTool } from "../lsp-tools.js";

/** Godot adapter singleton — created once, reused across every handler call. */
const godotAdapter = createGodotAdapter();

// ---------------------------------------------------------------------------
// LSP response shapes
// ---------------------------------------------------------------------------

/** Raw 0-based LSP range (before wire-position conversion). */
interface LspRawRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * LSP `SymbolInformation` — the shape returned by `workspace/symbol`.
 * Discriminated from `DocumentSymbol` by `location` at the top level.
 * The `source` field is added by the adapter's postprocessor.
 */
interface LspSymbolInformationRaw {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: LspRawRange;
  };
  containerName?: string;
  /** Provenance tag injected by the adapter postprocessor. */
  source?: AdapterSource;
}

/** The union of valid `workspace/symbol` responses (native, pre-adapter). */
type LspWorkspaceSymbolResult = LspSymbolInformation[] | null;

// ---------------------------------------------------------------------------
// Wire output shapes
// ---------------------------------------------------------------------------

/**
 * A decoded symbol location: the original LSP URI plus the filesystem path
 * decoded from it (or the URI itself when the scheme is non-`file://`).
 */
interface WireLocation {
  /** The original URI from the LSP response. */
  uri: string;
  /**
   * Filesystem path decoded from the URI. For `file://` URIs this is the
   * percent-decoded, drive-letter-stripped path. For non-`file://` URIs
   * (e.g. `gdscript://`, `godot://`) this equals `uri` so callers can
   * detect built-in results by the `gdscript://` or `godot://` prefix.
   */
  path: string;
  /** Symbol range in 1-based wire coordinates (DESIGN.md L490). */
  range: ReturnType<typeof fromLspRange>;
}

/**
 * A single workspace symbol entry in the wire response. `containerName` is
 * present only when the LSP response included it (e.g. a method inside a
 * class). `source` identifies which subsystem produced this entry.
 */
interface WireSymbol {
  name: string;
  kind: number;
  location: WireLocation;
  containerName?: string;
  /**
   * Provenance tag: where this symbol entry came from. Always present.
   *
   *   - `"lsp"` — native Godot LSP result or adapter tracked-file fallback
   *     (both come from the LSP, just through different methods).
   *   - `"docs"` — docs subsystem (future; built-in symbol redirect).
   *   - `"grep_fallback"` — regex grep over tracked files (future; autoload
   *     globals shim).
   */
  source: AdapterSource;
}

/** The top-level tool response body. */
interface WorkspaceSymbolsBody {
  symbols: WireSymbol[];
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a single adapter-augmented `LspSymbolInformationRaw` to a
 * `WireSymbol`. URI is decoded via {@link uriToFilePath}; range endpoints are
 * shifted to 1-based; `source` defaults to `"lsp"` if the adapter omitted it
 * (pre-adapter code paths in tests that don't exercise the adapter).
 */
function convertSymbolInformation(sym: LspSymbolInformationRaw): WireSymbol {
  const wire: WireSymbol = {
    name: sym.name,
    kind: sym.kind,
    location: {
      uri: sym.location.uri,
      path: uriToFilePath(sym.location.uri),
      range: fromLspRange(sym.location.range),
    },
    source: sym.source ?? "lsp",
  };
  if (sym.containerName !== undefined) {
    wire.containerName = sym.containerName;
  }
  return wire;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Main handler for `godot_workspace_symbols`. Extracted so tests can call it
 * directly without the registration side-effect.
 */
async function workspaceSymbolsHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResponse> {
  const query = args["query"];
  if (typeof query !== "string" || query.trim() === "") {
    return createErrorResponse(
      "`query` argument is required and must be a non-empty string.",
    );
  }

  return withLspClient(ctx, async ({ client }) => {
    const raw = await client.request<LspWorkspaceSymbolResult>(
      "workspace/symbol",
      { query },
    );

    // Build a minimal DocumentTracker for the adapter's union fallback.
    // The real client exposes `documents()` (see LspClientLike); test stubs
    // that don't implement it fall back to an empty tracker so the adapter
    // returns only the (also-empty) native result in those cases.
    const tracker: DocumentTracker =
      typeof client.documents === "function"
        ? client.documents()
        : new DocumentTracker({ statPollThrottleMs: 0 });

    // Pass through the Godot adapter's workspace/symbol postprocessor.
    // The adapter unions native results with tracked-file documentSymbol
    // fallbacks and tags every entry with `source`.
    const augmented = (await augment(
      godotAdapter,
      "workspace/symbol",
      { query },
      raw,
      { client, documents: tracker },
    )) as LspSymbolInformationRaw[] | null;

    // Null / empty → zero-results rule (DESIGN.md L492).
    if (!augmented || augmented.length === 0) {
      const body: WorkspaceSymbolsBody = { symbols: [] };
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    }

    const wireSymbols: WireSymbol[] = augmented.map(convertSymbolInformation);
    const body: WorkspaceSymbolsBody = { symbols: wireSymbols };
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerLspTool({
  name: "godot_workspace_symbols",
  description:
    "Search symbols (classes, functions, variables, constants, signals) across the entire Godot project by name. " +
    "Returns a flat list of matching symbols with their file path, kind, and source range. " +
    "Query is a substring match; case-insensitive. " +
    "Note: Godot's LSP does not implement fuzzy or CamelCase matching — use an exact substring. " +
    "Use this to find where a symbol is defined when you do not know which file it lives in. " +
    "Returns an empty list (not an error) when no symbols match.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description:
          "Substring to search for in symbol names across the project. " +
          "Case-insensitive. Must be a non-empty string. " +
          "Note: Godot's GDScript LSP does not support fuzzy or CamelCase matching.",
      },
    },
    required: ["query"],
  },
  handler: workspaceSymbolsHandler,
});
