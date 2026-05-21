/**
 * `godot_find_definition` — LSP leaf tool (#20).
 *
 * Sends a `textDocument/definition` request to Godot's GDScript LSP and
 * returns the definition location(s) for the symbol at the given position.
 *
 * Behavior (per issue #20 and DESIGN.md):
 *   - Inputs: `file`, `line` (1-based), `character` (1-based).
 *   - Multiple definitions → return array; agent disambiguates.
 *   - Zero results or `null` from LSP → empty array (not error).
 *   - `Location` (single object) → one-element array.
 *   - `Location[]` → mapped array.
 *   - `LocationLink[]` → mapped via `targetSelectionRange`.
 *   - Non-`file://` URIs (built-in symbols like `gdscript://`) pass through
 *     so callers can detect them by prefix.
 *
 * Wire format for each result:
 *   ```json
 *   { "file": "/abs/path/to/script.gd",
 *     "range": { "start": { "line": 10, "character": 1 },
 *                "end":   { "line": 10, "character": 9 } } }
 *   ```
 *   All positions are 1-based (DESIGN.md L490). The `range` is
 *   `[start, end)` half-open (DESIGN.md L491).
 */

import { filePathToUri } from "../../lsp/tool-helpers.js";
import {
  fromLspLocation,
  fromLspLocationLink,
  toLspPosition,
  validateFileInProject,
  withLspClient,
  type LspLocation,
  type LspLocationLink,
  type WireLocation,
} from "../../lsp/tool-helpers.js";
import { createErrorResponse } from "../../shared/errors.js";
import { registerLspTool } from "../lsp-tools.js";

// ---------------------------------------------------------------------------
// LSP response types
// ---------------------------------------------------------------------------

/** Discriminate between Location and LocationLink by checking for `targetUri`. */
function isLocationLink(
  v: LspLocation | LspLocationLink,
): v is LspLocationLink {
  return "targetUri" in v;
}

/**
 * Normalise the three possible LSP `textDocument/definition` return shapes
 * into a flat `WireLocation[]`:
 *
 *   - `null`            → `[]`
 *   - `Location`        → `[fromLspLocation(loc)]`
 *   - `Location[]`      → `loc.map(fromLspLocation)`
 *   - `LocationLink[]`  → `loc.map(fromLspLocationLink)`
 */
function normalizeDefinitionResult(
  raw: LspLocation | LspLocation[] | LspLocationLink[] | null,
): WireLocation[] {
  if (raw === null || raw === undefined) return [];

  // Single Location (not an array).
  if (!Array.isArray(raw)) {
    return [fromLspLocation(raw)];
  }

  if (raw.length === 0) return [];

  // Discriminate Location[] vs LocationLink[] by inspecting the first item.
  if (isLocationLink(raw[0])) {
    return (raw as LspLocationLink[]).map(fromLspLocationLink);
  }
  return (raw as LspLocation[]).map(fromLspLocation);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerLspTool({
  name: "godot_find_definition",
  description:
    "Find the definition location(s) of the GDScript symbol at the given position. " +
    "Returns an array of {file, range} objects (1-based positions). " +
    "Returns an empty array when no definition is found. " +
    "Built-in symbols (e.g. Node.add_child) may return non-file:// URIs such as `gdscript://` — " +
    "the caller should inspect the `file` prefix to detect them.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Absolute or project-relative path to the GDScript file containing the symbol.",
      },
      line: {
        type: "integer",
        description: "1-based line number of the symbol.",
        minimum: 1,
      },
      character: {
        type: "integer",
        description: "1-based character offset within the line.",
        minimum: 1,
      },
    },
    required: ["file", "line", "character"],
  },
  handler: async (args, ctx) => {
    const { file, line, character } = args as {
      file: string;
      line: number;
      character: number;
    };

    return withLspClient(ctx, async ({ client, projectRoot }) => {
      // Validate that the file is within the project root.
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

      // Convert 1-based wire position to 0-based LSP position.
      const lspPos = toLspPosition({ line, character });

      // Build the LSP textDocumentIdentifier URI.
      const uri = filePathToUri(absFile);

      // Fire the LSP request.
      type DefinitionResult =
        | LspLocation
        | LspLocation[]
        | LspLocationLink[]
        | null;
      const result = await client.request<DefinitionResult>(
        "textDocument/definition",
        {
          textDocument: { uri },
          position: lspPos,
        },
        [absFile],
      );

      const locations = normalizeDefinitionResult(result);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(locations),
          },
        ],
      };
    });
  },
});
