/**
 * `godot_get_diagnostics` — LSP leaf tool (#25).
 *
 * Returns GDScript diagnostics (errors, warnings, hints, information) for a
 * single file. Diagnostic collection is push-driven: Godot's LSP server
 * emits `textDocument/publishDiagnostics`; the LSP client caches the result
 * per URI and applies a tiered-await strategy (DESIGN.md § Diagnostics):
 *
 *   1. Auto-resync triggers `didChange` if disk content differs from the
 *      last-sent version.
 *   2. If `didChange` was sent, await the next `publishDiagnostics` push
 *      for that URI with a **10s timeout on first-touch, 2s on subsequent
 *      requests**.
 *   3. On timeout, return cached diagnostics with `partial: true` (not an
 *      error — DESIGN.md L443).
 *   4. Return cached diagnostics.
 *
 * This layer is intentionally thin: all tiered-await logic lives in
 * {@link import("../../lsp/client.js").LspClient.getDiagnostics}. The tool
 * converts the 0-based LSP positions to 1-based wire positions
 * (DESIGN.md L490), flattens the range into top-level fields, and strips
 * optional fields (`source`, `code`) that are absent on the diagnostic.
 *
 * Response shape (`partial` field documents DESIGN.md L443):
 * ```json
 * {
 *   "diagnostics": [
 *     {
 *       "severity": 1,
 *       "line": 5,
 *       "character": 3,
 *       "end_line": 5,
 *       "end_character": 12,
 *       "message": "Identifier 'x' not declared in current scope.",
 *       "source": "gdscript",
 *       "code": "E001"
 *     }
 *   ],
 *   "partial": false
 * }
 * ```
 *
 * `severity` values follow the LSP spec: 1 = Error, 2 = Warning, 3 =
 * Information, 4 = Hint. `source` and `code` are absent when the server
 * did not supply them.
 */

import {
  fromLspPosition,
  validateFileInProject,
  withLspClient,
} from "../../lsp/tool-helpers.js";
import type { LspDiagnostic } from "../../lsp/client.js";
import { createErrorResponse } from "../../shared/errors.js";
import type { ToolDefinition, ToolResponse } from "../../shared/types.js";
import { registerLspTool } from "../lsp-tools.js";

// ---------------------------------------------------------------------------
// Wire response type
// ---------------------------------------------------------------------------

/**
 * A single diagnostic entry in the tool's wire response. Positions are
 * 1-based per DESIGN.md L490. `source` and `code` are omitted entirely
 * (not `null`) when absent on the underlying LSP diagnostic.
 */
interface WireDiagnostic {
  severity: number | undefined;
  line: number;
  character: number;
  end_line: number;
  end_character: number;
  message: string;
  source?: string;
  code?: string | number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten an {@link LspDiagnostic} into the wire shape. Converts 0-based
 * LSP positions to 1-based wire positions; omits `source` / `code` when
 * absent.
 */
function flattenDiagnostic(d: LspDiagnostic): WireDiagnostic {
  const start = fromLspPosition(d.range.start);
  const end = fromLspPosition(d.range.end);
  const entry: WireDiagnostic = {
    severity: d.severity,
    line: start.line,
    character: start.character,
    end_line: end.line,
    end_character: end.character,
    message: d.message,
  };
  if (d.source !== undefined) entry.source = d.source;
  if (d.code !== undefined) entry.code = d.code;
  return entry;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const getDiagnosticsDef: ToolDefinition = {
  name: "godot_get_diagnostics",
  description:
    "Get GDScript diagnostics (errors, warnings, hints) for a single file. " +
    "Triggers auto-resync if disk content has changed, then awaits the next " +
    "publishDiagnostics push with a tiered timeout (10s first-touch per URI " +
    "in a session, 2s steady-state). On timeout, returns cached diagnostics " +
    "with `partial: true` instead of an error.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Absolute path to the GDScript or shader file to check. Must be " +
          "inside the Godot project root.",
      },
    },
    required: ["file"],
  },

  async handler(args: { file: string }, ctx): Promise<ToolResponse> {
    return withLspClient(ctx, async ({ client, projectRoot }) => {
      // In-project guard: reject files outside the project root
      // (DESIGN.md L425). `validateFileInProject` throws a plain Error
      // for out-of-bounds paths; convert it to an MCP error response
      // here so callers get a stable `isError: true` envelope rather
      // than an unhandled rejection.
      let validatedPath: string;
      try {
        validatedPath = validateFileInProject(args.file, projectRoot);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createErrorResponse(msg, [
          "Ensure the file path is inside the Godot project root.",
        ]);
      }

      const { diagnostics, partial } =
        await client.getDiagnostics(validatedPath);

      const wireDiagnostics = diagnostics.map(flattenDiagnostic);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ diagnostics: wireDiagnostics, partial }),
          },
        ],
      };
    });
  },
};

registerLspTool(getDiagnosticsDef);
