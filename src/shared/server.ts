/**
 * Server lifecycle: construct the MCP server, wire dispatch, register
 * signal handlers, and run the stdio transport.
 *
 * `src/index.ts` is the binary entry point; this file is the orchestration
 * that used to live inside the monolithic `GodotServer` class.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { setupToolHandlers } from "../dispatch.js";
import { bootstrapDocsRuntime } from "../docs/bootstrap.js";
import { getDocsRuntime } from "../docs/runtime.js";
import { allTools } from "../tools/index.js";

import { parseSharedEnv } from "./env.js";
import {
  executeOperation as executeOperationImpl,
  getOperationsScriptPath,
} from "./execute-operation.js";
import { GodotPathResolver } from "./godot-path.js";
import { logDebug } from "./logging.js";
import { ActiveProcessRegistry } from "./process-registry.js";
import type {
  GodotServerConfig,
  OperationParams,
  ToolContext,
} from "./types.js";

/**
 * The top-level MCP server. Owns the resolver, the active-process registry,
 * the underlying `Server` instance, and the operations script path.
 */
export class GodotServer {
  private readonly server: Server;
  private readonly resolver: GodotPathResolver;
  private readonly activeProcess: ActiveProcessRegistry;
  private readonly operationsScriptPath: string;
  private readonly godotDebugMode: boolean;
  private readonly strictPathValidation: boolean;

  /**
   * Build a server. The construction-time path check matches the pre-refactor
   * behavior: a sync existence check now, a real `--version` invocation
   * deferred to `run()`. See CLAUDE.md (Godot path resolution).
   */
  constructor(config?: GodotServerConfig) {
    // Default `godotDebugMode` to true to match the pre-refactor behavior
    // (`GODOT_DEBUG_MODE = true; // Always use GODOT DEBUG MODE`).
    this.godotDebugMode = config?.godotDebugMode ?? true;
    this.strictPathValidation = config?.strictPathValidation ?? false;

    this.resolver = new GodotPathResolver(
      config?.godotPath,
      this.strictPathValidation,
    );
    this.activeProcess = new ActiveProcessRegistry();
    this.operationsScriptPath = getOperationsScriptPath();
    logDebug(`Operations script path: ${this.operationsScriptPath}`);

    this.server = new Server(
      { name: "godot-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    const ctx: ToolContext = {
      getGodotPath: () => this.resolver.get(),
      setGodotPath: (p: string) => this.resolver.set(p),
      isValidGodotPath: (p: string) => this.resolver.isValidGodotPath(p),
      logDebug,
      executeOperation: (
        operation: string,
        params: OperationParams,
        projectPath: string,
      ) =>
        executeOperationImpl(
          this.resolver,
          this.operationsScriptPath,
          this.godotDebugMode,
          operation,
          params,
          projectPath,
        ),
      activeProcess: this.activeProcess,
      strictPathValidation: this.strictPathValidation,
      godotDebugMode: this.godotDebugMode,
    };

    setupToolHandlers(this.server, allTools, ctx);

    this.server.onerror = (error) => console.error("[MCP Error]", error);

    // Best-effort cleanup on Ctrl+C — async to give the SDK time to shut down.
    process.on("SIGINT", async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Programmatic Godot-path setter. Exposed so embedders can override after
   * construction; mirrors the pre-refactor `GodotServer.setGodotPath`.
   */
  setGodotPath(customPath: string): Promise<boolean> {
    return this.resolver.set(customPath);
  }

  /**
   * Kill any active project, close the docs DB, and close the MCP server.
   */
  async cleanup(): Promise<void> {
    logDebug("Cleaning up resources");
    this.activeProcess.kill();
    // Best-effort: dispose() is idempotent and swallows close-errors on
    // a never-opened DB, so calling it even on a failed-bootstrap is safe.
    getDocsRuntime().dispose();
    await this.server.close();
  }

  /**
   * Detect Godot, sanity-check the path (strict mode opt-in), then connect
   * the stdio transport. Process exits non-zero on any startup failure.
   */
  async run(): Promise<void> {
    try {
      const godotPath = await this.resolver.get();
      if (!godotPath) {
        console.error("[SERVER] Failed to find a valid Godot executable path");
        console.error(
          "[SERVER] Please set GODOT_PATH environment variable or provide a valid path",
        );
        process.exit(1);
      }

      const isValid = await this.resolver.isValidGodotPath(godotPath);
      if (!isValid) {
        if (this.strictPathValidation) {
          console.error(`[SERVER] Invalid Godot path: ${godotPath}`);
          console.error(
            "[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path",
          );
          process.exit(1);
        } else {
          console.error(
            `[SERVER] Warning: Using potentially invalid Godot path: ${godotPath}`,
          );
          console.error(
            "[SERVER] This may cause issues when executing Godot commands",
          );
          console.error(
            "[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.",
          );
        }
      }

      console.error(`[SERVER] Using Godot at: ${godotPath}`);

      // Docs runtime bootstrap. Per DESIGN.md § Cross-subsystem independence,
      // docs is the core MCP value — cold-startup failure crashes the server.
      // The bootstrap is synchronous (better-sqlite3 open is sync) and either
      // initializes the runtime or fails it with a precise message. We do not
      // crash here on docs failure because (a) Phase 1 of #7 deliberately
      // does not implement the runtime fetcher for `latest`/cache-miss, and
      // (b) editor/LSP tools still work against a failed docs runtime. The
      // docs tool handlers themselves surface the failure as MCP errors.
      const envConfig = parseSharedEnv(process.env);
      bootstrapDocsRuntime(getDocsRuntime(), {
        offline: envConfig.offline,
        docsDbPath: envConfig.docsDbPath,
        docsVersion: envConfig.docsVersion,
      });
      const docsState = getDocsRuntime().state();
      if (docsState.kind === "ready") {
        console.error(
          `[SERVER] Docs DB loaded (${docsState.source}): ${docsState.path}`,
        );
      } else if (docsState.kind === "failed") {
        console.error(
          `[SERVER] Docs subsystem unavailable: ${docsState.error.message}`,
        );
      }

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("Godot MCP server running on stdio");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("[SERVER] Failed to start:", msg);
      process.exit(1);
    }
  }
}
