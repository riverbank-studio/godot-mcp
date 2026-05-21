/**
 * Docs-tools shared response builders.
 *
 * DESIGN.md § Documentation subsystem → Error handling specifies a
 * uniform shape for "not found" responses across the lookup tools:
 *
 *   - Class not found (#15), member not found (#16), tutorial not found
 *     (#18) → MCP error with a `suggestions` array (cheap FTS5 lookup).
 *   - Case mismatch on a class lookup → error with "did you mean Node?"
 *     hint plus the canonical name in suggestions.
 *
 * Centralizing the builder here means the three leaves emit byte-identical
 * shapes — the agent's downstream code can branch on isError without
 * peeking at the message text.
 *
 * Response shape (machine-parseable layer)
 * ----------------------------------------
 *
 * Beyond the human-readable message in `content[0]`, the not-found
 * response includes a JSON content block with `{ suggestions: [...] }`
 * so a calling agent can pivot without scraping prose. MCP content arrays
 * are unordered from the SDK's perspective; we always append the JSON
 * block AFTER the message so JSON-only consumers can scan for the first
 * `{`-prefixed text content.
 */

import type { ToolResponse } from "../shared/types.js";

/**
 * Options accepted by {@link docsNotFoundResponse} beyond the bare
 * suggestions list. The `didYouMean` field is the canonical name to
 * present in the prose hint — typically a case-corrected match.
 */
export interface NotFoundOptions {
  /**
   * Canonical name to present in a "did you mean ...?" prose hint. Use
   * when a case-insensitive lookup hit but the caller wants the
   * canonical form back (DESIGN.md L342). Pass undefined for plain
   * not-found responses.
   */
  didYouMean?: string;
}

/**
 * Build a "not found" MCP error response with a suggestions list.
 *
 * @param message - human-readable message; surfaced as the first content
 *   block. Should name the target the lookup missed.
 * @param suggestions - similar names from a cheap FTS5 lookup. Empty
 *   array is valid; the JSON block is omitted in that case.
 * @param opts - optional hints (e.g. `didYouMean` for case mismatch).
 */
export function docsNotFoundResponse(
  message: string,
  suggestions: readonly string[],
  opts: NotFoundOptions = {},
): ToolResponse {
  const content: ToolResponse["content"] = [{ type: "text", text: message }];

  if (opts.didYouMean !== undefined) {
    content.push({
      type: "text",
      text: `did you mean \`${opts.didYouMean}\`?`,
    });
  }

  if (suggestions.length > 0) {
    content.push({
      type: "text",
      text: JSON.stringify({ suggestions: Array.from(suggestions) }),
    });
  }

  return { content, isError: true };
}

/**
 * Build a generic docs-tools error response (e.g. docs DB unavailable,
 * malformed args). The shape mirrors {@link createErrorResponse} from
 * `shared/errors.ts` but lives here so the docs leaves can import all
 * their helpers from one module.
 */
export function docsErrorResponse(
  message: string,
  possibleSolutions: readonly string[] = [],
): ToolResponse {
  const content: ToolResponse["content"] = [{ type: "text", text: message }];
  if (possibleSolutions.length > 0) {
    content.push({
      type: "text",
      text: "Possible solutions:\n- " + possibleSolutions.join("\n- "),
    });
  }
  return { content, isError: true };
}

/**
 * Wrap a successful result payload as a single JSON content block.
 *
 * Every docs tool returns JSON to the caller (results, single records,
 * meta info), so the wrapping convention is uniform: serialize the
 * payload with two-space indentation and emit one text content block.
 */
export function docsResultResponse(payload: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}
