/**
 * `godot_signature_help` — Get signature help for a GDScript function call at
 * a given source position.
 *
 * LSP method: `textDocument/signatureHelp`. Returns a `SignatureHelp` object
 * with `signatures`, `activeSignature`, and `activeParameter` when the cursor
 * is inside a function call argument list. Returns `{}` (empty object, not an
 * error) when the position is out of call context (DESIGN.md L492 universal
 * zero-results rule; issue #26: "Returns empty (not error) when out of context").
 *
 * # Known limitations (DESIGN.md L513)
 *
 * Godot's LSP signatureHelp is documented as unreliable on `.new()` constructor
 * calls and multi-line argument lists ([godot#51617](https://github.com/godotengine/godot/issues/51617)).
 * The tool faithfully forwards whatever the LSP returns; callers should not
 * treat an empty result as a definitive "no signature" in those cases.
 *
 * # Behavior summary
 *
 *   - **Inputs:** `file` (absolute path), `line` (1-based), `character` (1-based).
 *   - **Position conversion:** wire 1-based → LSP 0-based via `toLspPosition`.
 *   - **Zero result:** LSP returning `null` / `undefined` / an empty
 *     `signatures` array → `{}` (empty object), never an MCP error.
 *   - **File guard:** `validateFileInProject` rejects paths outside the
 *     project root with an MCP error.
 */

import { registerLspTool } from "../lsp-tools.js";
import {
  filePathToUri,
  toLspPosition,
  validateFileInProject,
  withLspClient,
} from "../../lsp/tool-helpers.js";
import { createErrorResponse } from "../../shared/errors.js";

// ---------------------------------------------------------------------------
// LSP wire types (local; not worth a shared module for leaf-only use)
// ---------------------------------------------------------------------------

/**
 * LSP `ParameterInformation` — a single parameter entry inside a signature.
 * The `label` is either a plain string or a `[start, end]` offset pair into
 * the parent signature's label string.
 */
interface LspParameterInformation {
  label: string | [number, number];
  documentation?: string | { kind: string; value: string };
}

/**
 * LSP `SignatureInformation` — one overload entry returned in the
 * `signatures` array.
 */
interface LspSignatureInformation {
  label: string;
  documentation?: string | { kind: string; value: string };
  parameters?: LspParameterInformation[];
  activeParameter?: number;
}

/**
 * LSP `SignatureHelp` — the full response from
 * `textDocument/signatureHelp`. May be `null` when the cursor is not inside
 * a call expression.
 */
interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

registerLspTool({
  name: "godot_signature_help",
  description:
    "Get signature help (parameter list and active parameter hint) for a GDScript function call at a specific source position. " +
    "Use this when the cursor is inside a function call argument list and you need to know the expected parameter types or which argument is active. " +
    "Returns `{}` when the position is not inside a function call (out of context) — this is not an error. " +
    "Note: Godot's LSP may return incomplete results for `.new()` constructors and multi-line argument lists. " +
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
        type: "integer",
        description:
          "1-based line number of the position inside the function call.",
        minimum: 1,
      },
      character: {
        type: "integer",
        description:
          "1-based character offset (column) of the position inside the function call.",
        minimum: 1,
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
      let absFile: string;
      try {
        absFile = validateFileInProject(file, projectRoot);
      } catch {
        return createErrorResponse(
          `File path is outside the project root: ${file}`,
          [
            "Provide a path inside the Godot project directory. " +
              "Paths outside the project root are not tracked by the LSP.",
          ],
        );
      }

      const lspPosition = toLspPosition({ line, character });
      const fileUri = filePathToUri(absFile);

      const raw = await client.request<LspSignatureHelp | null | undefined>(
        "textDocument/signatureHelp",
        {
          textDocument: { uri: fileUri },
          position: lspPosition,
        },
        [absFile],
        { lane: "interactive" },
      );

      // Zero-result rule (issue #26, DESIGN.md L492): null / undefined /
      // empty signatures array → empty object, never an MCP error.
      if (
        raw == null ||
        !Array.isArray(raw.signatures) ||
        raw.signatures.length === 0
      ) {
        return { content: [{ type: "text", text: JSON.stringify({}) }] };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(raw) }],
      };
    });
  },
});
