/**
 * `godot_hover` — Get hover information (signature, docs) for a GDScript
 * symbol at a given source position.
 *
 * LSP method: `textDocument/hover`. Routed to the **interactive lane** per
 * DESIGN.md §Tool-specific behavior (D27 queue spec).
 *
 * # Behavior summary (DESIGN.md L492–L495)
 *
 * - **Inputs:** `file` (absolute path), `line` (1-based), `character` (1-based).
 * - **Position conversion:** wire 1-based → LSP 0-based via `toLspPosition`;
 *   the returned optional `range` is converted back via `fromLspRange`.
 * - **MarkedString normalization:** Godot's LSP may return the deprecated
 *   `MarkedString` (plain string or `{language, value}`) or `MarkedString[]`.
 *   All are normalised to `MarkupContent { kind: "markdown" }` before
 *   returning to callers.
 * - **Truncation:** markdown-fence-aware at 5000 chars. If the naïve cut
 *   falls inside an open fenced code block, the response is extended to
 *   the next closing fence up to a hard cap of 6000 chars. If extending
 *   would exceed 6000, the content is trimmed back to the most recent
 *   fence boundary before the cut. `truncated: true` is added whenever
 *   any truncation occurs.
 * - **Zero result:** LSP returning `null` / `undefined` → `{}` (empty
 *   object), never an MCP error (DESIGN.md L492 universal zero-results rule).
 * - **File guard:** `validateFileInProject` rejects paths outside the
 *   project root with an MCP error.
 */

import { registerLspTool } from "../lsp-tools.js";
import {
  filePathToUri,
  fromLspRange,
  toLspPosition,
  validateFileInProject,
  withLspClient,
} from "../../lsp/tool-helpers.js";
import { createErrorResponse } from "../../shared/errors.js";

// ---------------------------------------------------------------------------
// LSP wire types (local; not worth a shared module for leaf-only use)
// ---------------------------------------------------------------------------

/** LSP `MarkupContent` (preferred). */
interface MarkupContent {
  kind: "markdown" | "plaintext";
  value: string;
}

/** LSP deprecated `MarkedString` — plain string variant. */
type MarkedStringPlain = string;

/** LSP deprecated `MarkedString` — language+value variant. */
interface MarkedStringTagged {
  language: string;
  value: string;
}

/** Union of all LSP `MarkedString` forms. */
type MarkedString = MarkedStringPlain | MarkedStringTagged;

/** LSP `Hover` response. */
interface LspHoverResult {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalize one `MarkedString` segment to a markdown string fragment.
 * Plain strings are returned unchanged; tagged strings are wrapped in a
 * fenced code block.
 */
function normalizeMarkedStringSegment(seg: MarkedString): string {
  if (typeof seg === "string") return seg;
  // Tagged `{language, value}` → fenced block.
  const lang = seg.language.trim();
  return `\`\`\`${lang}\n${seg.value}\n\`\`\``;
}

/**
 * Normalize the `contents` field of an LSP `Hover` response to a
 * canonical `MarkupContent { kind: "markdown" }`. Handles:
 *   - Already-`MarkupContent` (passes through, converted to markdown if plaintext)
 *   - Single `MarkedString` (plain or tagged)
 *   - `MarkedString[]` (joined with `\n\n`)
 */
function normalizeContents(
  contents: MarkupContent | MarkedString | MarkedString[],
): MarkupContent {
  // MarkupContent has a `kind` property on an object (not an array).
  if (
    !Array.isArray(contents) &&
    typeof contents === "object" &&
    "kind" in contents
  ) {
    // Already MarkupContent — ensure kind is markdown.
    return { kind: "markdown", value: (contents as MarkupContent).value };
  }

  if (Array.isArray(contents)) {
    // MarkedString[] — normalize each segment and join.
    const parts = contents.map(normalizeMarkedStringSegment);
    return { kind: "markdown", value: parts.join("\n\n") };
  }

  // Single MarkedString (plain string or {language, value}).
  return {
    kind: "markdown",
    value: normalizeMarkedStringSegment(contents as MarkedString),
  };
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/** Soft cap: naïve truncation target. */
const TRUNCATION_SOFT_CAP = 5000;
/** Hard cap: maximum extent when extending past a fence boundary. */
const TRUNCATION_HARD_CAP = 6000;

/**
 * Apply markdown-fence-aware truncation to `text` per DESIGN.md L495:
 *
 *   1. If `text.length <= SOFT_CAP` → return unchanged, no flag.
 *   2. Find the naïve cut at `SOFT_CAP`.
 *   3. Determine whether the cut lands inside an open fenced code block.
 *      A block is "open" if an odd number of `` ``` `` fence markers appear
 *      before the cut (using a simple scan — block nesting is not a GDScript
 *      hover concern).
 *   4a. If inside a fence: extend forward to the next closing `` ``` `` line
 *       up to `HARD_CAP`. If found within the hard cap, include it.
 *   4b. If extending would exceed `HARD_CAP`: trim back to the most recent
 *       fence boundary before the cut.
 *   5. Return `{ value, truncated: true }`.
 *
 * Returns `{ value: text, truncated: false }` when no truncation is needed.
 */
function truncateMarkdown(text: string): { value: string; truncated: boolean } {
  if (text.length <= TRUNCATION_SOFT_CAP) {
    return { value: text, truncated: false };
  }

  const head = text.slice(0, TRUNCATION_SOFT_CAP);

  // Count how many opening/closing ``` fences appear before the cut.
  // A line starting with ``` (possibly indented) toggles the fence state.
  const fenceRe = /^[ \t]*```/gm;
  let fenceCount = 0;
  while (fenceRe.exec(head) !== null) {
    fenceCount++;
  }

  const insideFence = fenceCount % 2 === 1;

  if (insideFence) {
    // Try to extend to the next closing fence within the hard cap.
    const tail = text.slice(TRUNCATION_SOFT_CAP, TRUNCATION_HARD_CAP);
    const closingFenceRe = /^[ \t]*```/m;
    const closingMatch = closingFenceRe.exec(tail);
    if (closingMatch !== null) {
      // Include through the end of the closing fence line.
      const closeLineEnd =
        TRUNCATION_SOFT_CAP + tail.indexOf("\n", closingMatch.index) + 1;
      const extended =
        closeLineEnd > TRUNCATION_SOFT_CAP
          ? text.slice(0, closeLineEnd)
          : text.slice(
              0,
              TRUNCATION_SOFT_CAP + closingMatch.index + closingMatch[0].length,
            );
      return { value: extended, truncated: true };
    }
    // No closing fence found within the hard cap — trim back to the last
    // fence boundary before the soft cut.
    const lastFenceIdx = head.lastIndexOf("```");
    const trimmed = lastFenceIdx > 0 ? head.slice(0, lastFenceIdx) : head;
    return { value: trimmed, truncated: true };
  }

  // Not inside a fence — simple truncation at soft cap.
  return { value: head, truncated: true };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

registerLspTool({
  name: "godot_hover",
  description:
    "Get hover information (type signature and documentation) for a GDScript symbol at a specific source position. " +
    "Prefer this over guessing from prior knowledge when you need accurate type info or docs for a symbol in the open project. " +
    "Returns `{}` when no hover information is available at that position (not an error). " +
    "Positions are 1-based (line 1 = first line, character 1 = first column).",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Absolute path to the GDScript file (.gd). Must be within the project root.",
      },
      line: {
        type: "number",
        description: "1-based line number of the symbol to inspect.",
      },
      character: {
        type: "number",
        description:
          "1-based character offset (column) of the symbol to inspect.",
      },
    },
    required: ["file", "line", "character"],
  },
  handler: async (args: unknown, ctx) => {
    const { file, line, character } = args as {
      file: string;
      line: number;
      character: number;
    };

    return withLspClient(ctx, async ({ client, projectRoot }) => {
      // Guard: file must be within the project root.
      // validateFileInProject throws a plain Error on violation; convert it
      // here rather than letting withLspClient re-throw it uncaught (only
      // LspUnavailableError / RequestTimeoutError are mapped there).
      try {
        validateFileInProject(file, projectRoot);
      } catch (err) {
        return createErrorResponse(
          err instanceof Error ? err.message : String(err),
        );
      }

      const lspPosition = toLspPosition({ line, character });
      const fileUri = filePathToUri(file);

      const raw = await client.request<LspHoverResult | null | undefined>(
        "textDocument/hover",
        {
          textDocument: { uri: fileUri },
          position: lspPosition,
        },
        [file],
        { lane: "interactive" },
      );

      // Zero-result rule: null / undefined → empty object.
      if (raw == null) {
        return { content: [{ type: "text", text: JSON.stringify({}) }] };
      }

      const normalizedContents = normalizeContents(raw.contents);
      const { value: truncatedValue, truncated } = truncateMarkdown(
        normalizedContents.value,
      );

      const result: Record<string, unknown> = {
        contents: { kind: "markdown", value: truncatedValue },
      };

      if (raw.range !== undefined) {
        result.range = fromLspRange(raw.range);
      }

      if (truncated) {
        result.truncated = true;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    });
  },
});
