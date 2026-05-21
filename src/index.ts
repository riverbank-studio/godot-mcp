#!/usr/bin/env node
/**
 * Godot MCP Server entry point.
 *
 * Composes the server from the modules introduced in #3:
 *   - `src/shared/`        — env/logging/validation/process helpers
 *   - `src/tools/`         — per-area tool registries (auto-discovery pattern)
 *   - `src/dispatch.ts`    — tool-name → handler routing
 *   - `src/shared/server.ts` — server lifecycle (construct, run, cleanup)
 *
 * Importing this file kicks off the server. Tests should import from the
 * submodules — never from here — because of that side effect.
 */

import { GodotServer } from "./shared/server.js";

const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  console.error("Failed to run server:", errorMessage);
  process.exit(1);
});
