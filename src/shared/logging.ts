/**
 * Stderr-only debug logging. stdout is reserved for MCP JSON-RPC.
 */

const DEBUG_MODE: boolean = process.env.DEBUG === "true";

/**
 * Whether debug logging is enabled. Captured once at module load — set the
 * `DEBUG` environment variable before launching the server.
 */
export const isDebugEnabled: boolean = DEBUG_MODE;

/**
 * Write a `[DEBUG]`-prefixed line to stderr if debug mode is enabled.
 * Always uses stderr to avoid corrupting the JSON-RPC stream on stdout.
 */
export function logDebug(message: string): void {
  if (DEBUG_MODE) {
    console.error(`[DEBUG] ${message}`);
  }
}
