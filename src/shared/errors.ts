/**
 * MCP error-response builder.
 *
 * Tools return `isError: true` content blocks rather than throwing for
 * predictable failure modes (missing args, invalid paths, Godot not found,
 * etc.) so callers see a stable shape and the optional recovery hints.
 */

import type { ToolResponse } from "./types.js";

/**
 * Build a standardized error response with optional remediation hints.
 * The error itself is also logged to stderr for operator visibility.
 *
 * @param message - human-readable error message; surfaced to the caller as-is.
 * @param possibleSolutions - zero or more remediation hints; rendered as a
 *   bulleted "Possible solutions" block after the message.
 */
export function createErrorResponse(
  message: string,
  possibleSolutions: string[] = [],
): ToolResponse {
  console.error(`[SERVER] Error response: ${message}`);
  if (possibleSolutions.length > 0) {
    console.error(
      `[SERVER] Possible solutions: ${possibleSolutions.join(", ")}`,
    );
  }

  const response: ToolResponse = {
    content: [{ type: "text", text: message }],
    isError: true,
  };

  if (possibleSolutions.length > 0) {
    response.content.push({
      type: "text",
      text: "Possible solutions:\n- " + possibleSolutions.join("\n- "),
    });
  }

  return response;
}
