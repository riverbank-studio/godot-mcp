/**
 * `godot_find_references` — find all references to a symbol at a position.
 *
 * LSP method: `textDocument/references` → `Location[]`
 *
 * Behavior (DESIGN.md L492, issue #21):
 *   - Inputs: `file`, `line` (1-based), `character` (1-based)
 *   - Positions on the wire are 1-based; converted to 0-based before the
 *     LSP call via {@link toLspPosition}.
 *   - Zero results → empty array (universal zero-results rule, never an MCP
 *     error).
 *   - File outside the project root → MCP error before any LSP call.
 *   - LSP unavailable → MCP error envelope via {@link withLspClient}.
 */

import type { ToolResponse } from "../../shared/types.js";
import {
  filePathToUri,
  fromLspRange,
  toLspPosition,
  uriToFilePath,
  validateFileInProject,
  withLspClient,
} from "../../lsp/tool-helpers.js";
import { createErrorResponse } from "../../shared/errors.js";
import { registerLspTool } from "../lsp-tools.js";

/**
 * One entry in the wire-level response. Each entry maps a single LSP
 * `Location` to a tool-caller-friendly object with 1-based positions.
 */
interface ReferenceLocation {
  /** Absolute file path of the file containing the reference. */
  file: string;
  /** 1-based range of the reference token inside `file`. */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * LSP `Location` shape as returned by `textDocument/references`. Declared
 * locally to avoid a hard dependency on the LSP protocol package types.
 */
interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

registerLspTool({
  name: "godot_find_references",
  description:
    "Find all references to the GDScript symbol at the given position. " +
    "Returns an array of file locations; empty array when no references are found. " +
    "Positions are 1-based (line 1 = first line, character 1 = first column).",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Absolute path to the GDScript file containing the symbol. " +
          "Must be within the Godot project root.",
      },
      line: {
        type: "integer",
        minimum: 1,
        description: "1-based line number of the symbol.",
      },
      character: {
        type: "integer",
        minimum: 1,
        description: "1-based character offset of the symbol on the line.",
      },
    },
    required: ["file", "line", "character"],
  },

  async handler(args, ctx): Promise<ToolResponse> {
    const { file, line, character } = args as {
      file: string;
      line: number;
      character: number;
    };

    return withLspClient(ctx, async ({ client, projectRoot }) => {
      // Guard: file must be inside the project root (DESIGN.md L425).
      let validatedFile: string;
      try {
        validatedFile = validateFileInProject(file, projectRoot);
      } catch (err) {
        return createErrorResponse(
          err instanceof Error ? err.message : String(err),
          [
            "Ensure the file path is within the Godot project root. " +
              "Set `GODOT_LSP_PROJECT_PATH` if the project root is not auto-detected.",
          ],
        );
      }

      // Convert 1-based wire positions to 0-based LSP positions.
      // toLspPosition throws on non-positive values; catch here so callers
      // receive a clean MCP error instead of an uncaught programmer-bug throw.
      let lspPos: { line: number; character: number };
      try {
        lspPos = toLspPosition({ line, character });
      } catch (err) {
        return createErrorResponse(
          err instanceof Error ? err.message : String(err),
          [
            "Provide 1-based line and character values (minimum 1). " +
              "Line 1 is the first line; character 1 is the first column.",
          ],
        );
      }

      // Send textDocument/references. `includeDeclaration: true` matches the
      // default agent expectation (show definition site + all uses).
      const locations = await client.request<LspLocation[] | null>(
        "textDocument/references",
        {
          textDocument: { uri: filePathToUri(validatedFile) },
          position: lspPos,
          context: { includeDeclaration: true },
        },
      );

      // Universal zero-results rule: null or empty → empty array, not error.
      if (!locations || locations.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify([]) }] };
      }

      // Map LSP 0-based positions to wire 1-based positions.
      const references: ReferenceLocation[] = locations.map((loc) => ({
        file: uriToFilePath(loc.uri),
        range: fromLspRange(loc.range),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(references) }],
      };
    });
  },
});
