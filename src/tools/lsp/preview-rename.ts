/**
 * `godot_preview_rename` — compute a project-wide rename via the Godot LSP
 * and return proposed edits as an advisory-write response (#27, parent #10).
 *
 * The tool is **preview-only**: it calls `textDocument/rename`, converts the
 * `WorkspaceEdit` result through {@link workspaceEditToAdvisory}, and returns
 * the canonical `{action, edits, summary}` envelope. It does **not** apply
 * any changes; the agent applies them via its native edit tools (Claude
 * Code's `Edit`, `Write`, etc.), preserving the checkpoint/rewind flow.
 *
 * Per DESIGN.md § "Write operations: advisory pattern" (L451–L498):
 *
 *   - Input positions are 1-based (wire convention); they are converted to
 *     0-based LSP positions via {@link toLspPosition} before the request.
 *   - The `before`/`after` pairs in the response are widened up to 5
 *     non-blank lines so that `str_replace` can match them uniquely; edits
 *     that can't be disambiguated fall back to LSP-native range coordinates.
 *   - Multiple LSP `TextEdit`s on the same line (e.g.
 *     `var x = old(old(1))`) are merged into a single `(before, after)`
 *     record rather than emitting two overlapping records.
 *
 * Registration: this file calls {@link registerLspTool} at import time so
 * the tool appears in the server's `ListTools` response automatically. The
 * barrel (`src/tools/lsp-tools.ts`) imports this file to trigger the side
 * effect.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { registerLspTool } from "../lsp-tools.js";
import {
  filePathToUri,
  mapLspErrorToResponse,
  toLspPosition,
  uriToFilePath,
  validateFileInProject,
  withLspClient,
} from "../../lsp/tool-helpers.js";
import {
  workspaceEditToAdvisory,
  type LspWorkspaceEdit,
} from "../../lsp/advisory-write.js";
import { createErrorResponse } from "../../shared/errors.js";
import type { ToolContext, ToolResponse } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Exported handler (for unit tests)
// ---------------------------------------------------------------------------

/**
 * Normalized arguments for `godot_preview_rename`. Accepts both snake_case
 * and camelCase parameter aliases per DESIGN.md (§ "Parameter naming").
 */
interface PreviewRenameArgs {
  /** Absolute or project-relative path to the file containing the symbol. */
  file: string;
  /** 1-based line number of the symbol to rename. */
  line: number;
  /** 1-based character offset of the symbol to rename. */
  character: number;
  /** The new name to apply. */
  new_name?: string;
  /** camelCase alias for `new_name`. */
  newName?: string;
}

/**
 * Handler body, exported so unit tests can invoke it directly without
 * going through the MCP dispatch layer.
 */
export async function handler(
  rawArgs: PreviewRenameArgs,
  ctx: ToolContext,
): Promise<ToolResponse> {
  return withLspClient(ctx, async ({ client, projectRoot }) => {
    // ------------------------------------------------------------------
    // 1. Capability guard — Godot 4.x advertises renameProvider; surface
    //    a clear error rather than a cryptic JSON-RPC -32601 if it ever
    //    isn't present.
    // ------------------------------------------------------------------
    const caps = client.serverCapabilities();
    if (!caps.renameProvider) {
      return createErrorResponse(
        "Rename is not supported: the Godot LSP did not advertise renameProvider.",
        [
          "Ensure you are running Godot 4.x — earlier versions did not expose the rename capability.",
        ],
      );
    }

    // ------------------------------------------------------------------
    // 2. Normalize args (snake_case / camelCase aliases).
    // ------------------------------------------------------------------
    const newName = rawArgs.new_name ?? rawArgs.newName ?? "";
    if (!newName) {
      return createErrorResponse(
        "Missing required parameter: new_name (or newName).",
        [],
      );
    }

    // ------------------------------------------------------------------
    // 3. Resolve and validate the file path.
    // ------------------------------------------------------------------
    const rawFile = rawArgs.file;
    let absFile: string;
    try {
      absFile = validateFileInProject(rawFile, projectRoot);
    } catch {
      return createErrorResponse(
        `File path is outside the project root: ${rawFile}`,
        [
          "Ensure the file is within the Godot project directory pointed to by GODOT_LSP_PROJECT_PATH.",
        ],
      );
    }

    // ------------------------------------------------------------------
    // 4. Convert 1-based wire position → 0-based LSP position.
    // ------------------------------------------------------------------
    let lspPos: { line: number; character: number };
    try {
      lspPos = toLspPosition({
        line: rawArgs.line,
        character: rawArgs.character,
      });
    } catch (err) {
      return createErrorResponse(
        `Invalid position: ${err instanceof Error ? err.message : String(err)}`,
        [],
      );
    }

    // ------------------------------------------------------------------
    // 5. Determine the `from` name for the action envelope.
    //    Read the file and extract the token at the cursor position.
    // ------------------------------------------------------------------
    let fromName: string;
    try {
      const fileContent = fs.readFileSync(absFile, "utf8");
      const lines = fileContent.split("\n");
      const targetLine = lines[lspPos.line] ?? "";
      fromName = extractTokenAt(targetLine, lspPos.character);
    } catch {
      // Non-fatal: fall back to a placeholder. The action envelope is
      // informational; callers should not rely on `from` for correctness.
      fromName = "<unknown>";
    }

    // ------------------------------------------------------------------
    // 6. Send the LSP request.
    // ------------------------------------------------------------------
    const fileUri = filePathToUri(absFile);
    const lspParams = {
      textDocument: { uri: fileUri },
      position: lspPos,
      newName,
    };

    let workspaceEdit: LspWorkspaceEdit | null;
    try {
      workspaceEdit = await client.request<LspWorkspaceEdit | null>(
        "textDocument/rename",
        lspParams,
        [absFile],
        { lane: "background" },
      );
    } catch (err) {
      return mapLspErrorToResponse(err);
    }

    // ------------------------------------------------------------------
    // 7. Convert WorkspaceEdit → advisory response.
    //    A null response means the symbol wasn't found / no renames needed.
    // ------------------------------------------------------------------
    const action = { kind: "rename" as const, from: fromName, to: newName };
    if (!workspaceEdit || !workspaceEdit.changes) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action,
              edits: [],
              summary: { files: 0, locations: 0 },
            }),
          },
        ],
      };
    }

    let advisory: ReturnType<typeof workspaceEditToAdvisory>;
    try {
      advisory = workspaceEditToAdvisory(workspaceEdit, {
        action,
        readFile: (uri: string) => {
          const filePath = uriToFilePath(uri);
          // DESIGN.md L425 — validate each LSP-returned URI is within the
          // project root before reading.  A compromised local Godot LSP could
          // return URIs pointing to arbitrary local files; reject them here to
          // prevent their content from leaking into the advisory `before` lines.
          validateFileInProject(filePath, projectRoot);
          return fs.readFileSync(filePath, "utf8");
        },
        resolveFilePath: (uri: string) => {
          const filePath = uriToFilePath(uri);
          // Return path relative to project root (forward-slash form).
          const rel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
          // If resolving outside root (shouldn't happen after validateFileInProject),
          // fall back to the absolute path.
          return rel.startsWith("..") ? filePath : rel;
        },
      });
    } catch (err) {
      return createErrorResponse(
        `Failed to process workspace edit: ${err instanceof Error ? err.message : String(err)}`,
        [
          "The Godot LSP returned a workspace edit that references a file outside the project root or that could not be read.",
          "Ensure the LSP is connected to the correct project directory.",
        ],
      );
    }

    return {
      content: [{ type: "text", text: JSON.stringify(advisory) }],
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the GDScript identifier token that contains `character` (0-based)
 * on `lineText`. Returns the token text, or `"<unknown>"` if the character
 * is not inside an identifier.
 *
 * GDScript identifiers follow the same rules as Python: `[A-Za-z_][A-Za-z0-9_]*`.
 */
function extractTokenAt(lineText: string, character: number): string {
  // Find the start of the token (scan left while identifier char).
  let start = character;
  while (start > 0 && isIdentChar(lineText[start - 1] ?? "")) {
    start--;
  }
  // Find the end of the token (scan right while identifier char).
  let end = character;
  while (end < lineText.length && isIdentChar(lineText[end] ?? "")) {
    end++;
  }
  const token = lineText.slice(start, end);
  return token.length > 0 ? token : "<unknown>";
}

/**
 * Return `true` if `ch` is a valid GDScript / Python identifier character.
 */
function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

// ---------------------------------------------------------------------------
// Tool registration (side effect, fires on import)
// ---------------------------------------------------------------------------

registerLspTool({
  name: "godot_preview_rename",
  description: [
    "Compute a project-wide rename of a GDScript symbol via the Godot LSP.",
    "Returns proposed edits in an advisory-write envelope",
    "(`{action, edits, summary}`) — does NOT apply them.",
    "Each edit record contains `file`, `line`, `before`, and `after` fields",
    "suitable for `str_replace`. Apply the edits using your native edit tools.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Absolute or project-relative path to the GDScript file containing the symbol to rename.",
      },
      line: {
        type: "number",
        description: "1-based line number of the symbol.",
      },
      character: {
        type: "number",
        description: "1-based character offset of the symbol on the line.",
      },
      new_name: {
        type: "string",
        description: "The new name to give the symbol.",
      },
      newName: {
        type: "string",
        description: "camelCase alias for new_name.",
      },
    },
    required: ["file", "line", "character", "new_name"],
  },
  handler: (args: PreviewRenameArgs, ctx: ToolContext) => handler(args, ctx),
});
