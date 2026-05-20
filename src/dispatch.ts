/**
 * Tool-name → handler routing for the MCP server.
 *
 * This file owns three cross-cutting responsibilities the DESIGN.md calls
 * out: routing, the ListTools response shape (handler is stripped), and a
 * uniform `MethodNotFound` error path for unknown names. Per-call OTel
 * span wrapping and schema validation land in subsequent waves; the shape
 * here is the seam they hook into.
 */

import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { logDebug } from "./shared/logging.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolResponse,
} from "./shared/types.js";

// Re-export the canonical types so consumers can `import from "./dispatch.js"`
// to grab everything they need to register a new tool.
export type { ToolContext, ToolDefinition, ToolResponse };

/**
 * Build the JSON-RPC response for an MCP `ListTools` call from a flat array of
 * tool definitions. The handler is stripped — it's an internal field.
 */
export function buildListToolsResponse(tools: readonly ToolDefinition[]): {
  tools: Array<Omit<ToolDefinition, "handler">>;
} {
  return {
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  };
}

/**
 * Route a `CallTool` request to the matching handler in `tools`. Throws an
 * MCP `MethodNotFound` error when the name is unknown.
 */
export async function callTool(
  tools: readonly ToolDefinition[],
  ctx: ToolContext,
  name: string,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any
       -- args is whatever MCP sent us; the handler does its own narrowing. */
  args: any,
): Promise<ToolResponse> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  return tool.handler(args, ctx);
}

/**
 * Wire the MCP `ListTools` and `CallTool` request handlers on `server`
 * against a composed tool registry. Called once during server setup.
 */
export function setupToolHandlers(
  server: Server,
  tools: readonly ToolDefinition[],
  ctx: ToolContext,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    buildListToolsResponse(tools),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    logDebug(`Handling tool request: ${request.params.name}`);
    // The SDK's request-handler type uses a Zod-derived loose union; our
    // `ToolResponse` satisfies the runtime shape but TS can't prove it
    // against the inferred union, so we cross the boundary with a cast.
    return callTool(
      tools,
      ctx,
      request.params.name,
      request.params.arguments,
    ) as unknown as ReturnType<Parameters<typeof server.setRequestHandler>[1]>;
  });
}
