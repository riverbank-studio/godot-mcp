/**
 * Shared type declarations for the godot-mcp server.
 *
 * These types are the contract between `src/dispatch.ts`, `src/index.ts`,
 * the per-area tool registries in `src/tools/`, and the helper modules in
 * `src/shared/`. Keep this file small and behavior-free.
 */

import type { ChildProcess } from "node:child_process";

/**
 * The Node child-process record for the single tracked running Godot project.
 * `output` and `errors` are stdout/stderr line buffers populated by `run_project`
 * and read by `get_debug_output`. There is intentionally no support for
 * multiple concurrent runs — see CLAUDE.md.
 */
export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
}

/**
 * Server-construction configuration accepted by `GodotServer`. All fields are
 * optional; sensible defaults apply.
 */
export interface GodotServerConfig {
  /** Explicit path to a Godot binary; otherwise auto-detect. */
  godotPath?: string;
  /** Enable verbose stderr logging from the server itself. */
  debugMode?: boolean;
  /** Pass `--debug-godot` to bundled-GDScript invocations. */
  godotDebugMode?: boolean;
  /**
   * When true, construction or startup fails fast on an invalid Godot path
   * instead of falling back to a platform default. New deployments should
   * set this; the fallback remains for backwards compatibility.
   */
  strictPathValidation?: boolean;
}

/**
 * Generic operation-parameter bag passed to `executeOperation`. Tool handlers
 * normalize their callers' input into this shape before invoking Godot.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any
     -- Operation parameters intentionally accept arbitrary JSON-serializable
        shapes (the GDScript side parses them). Tightening this would force
        every caller to assert through `unknown` for no payoff. */
export type OperationParams = Record<string, any>;

/**
 * Discriminator-friendly content fragment for an MCP tool response.
 */
export interface ToolResponseContent {
  type: "text";
  text: string;
}

/**
 * The MCP response shape every tool handler must return. `isError: true`
 * marks failures the SDK forwards as content rather than throwing.
 */
export interface ToolResponse {
  content: ToolResponseContent[];
  isError?: boolean;
}

/**
 * One row in a per-area tool registry. The shape matches `ListToolsResult`
 * minus the handler — `buildListToolsResponse` strips the handler before
 * exposing the table to the MCP `ListTools` request.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any
       -- Tool args are JSON; per-handler type-narrowing happens in the handler. */
  handler: (args: any, ctx: ToolContext) => Promise<ToolResponse>;
}

/**
 * The active-process registry contract. The concrete implementation lives in
 * `src/shared/process-registry.ts`. Declared here so handlers can reference
 * the interface without depending on the implementation file.
 */
export interface IActiveProcessRegistry {
  get(): GodotProcess | null;
  set(handle: GodotProcess): void;
  clear(): void;
  kill(): void;
}

/**
 * The execution context every tool handler receives as its second argument.
 *
 * Bundling these dependencies into one object lets each handler be tested
 * with a small stub and lets the server compose them once at startup.
 */
export interface ToolContext {
  /**
   * Resolve the configured Godot binary path, kicking off detection if it
   * hasn't run yet. Returns null when the user has neither configured nor
   * auto-detected a binary.
   */
  getGodotPath: () => Promise<string | null>;

  /**
   * Replace the stored Godot path. Returns true if the new path validated.
   */
  setGodotPath: (path: string) => Promise<boolean>;

  /**
   * Validate that a given path is an executable Godot binary, with caching.
   */
  isValidGodotPath: (path: string) => Promise<boolean>;

  /** Log a debug message to stderr when DEBUG mode is enabled. */
  logDebug: (message: string) => void;

  /**
   * Execute a bundled-GDScript operation by name. Internally invokes
   * `godot_operations.gd <operation> <JSON params>` with the snake_cased
   * parameter object.
   */
  executeOperation: (
    operation: string,
    params: OperationParams,
    projectPath: string,
  ) => Promise<{ stdout: string; stderr: string }>;

  /** The single running-project handle. */
  activeProcess: IActiveProcessRegistry;

  /** Whether to error out (vs. warn) on Godot-path validation failures. */
  strictPathValidation: boolean;

  /** Whether to forward `--debug-godot` on bundled-GDScript invocations. */
  godotDebugMode: boolean;
}
