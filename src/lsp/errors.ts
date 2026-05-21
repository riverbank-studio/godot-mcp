/**
 * Error types for the LSP subsystem.
 *
 * Per `docs/DESIGN.md` § LSP subsystem → Initialization failure semantics and
 * Wave 2 amendment "Spawn-cycle cap reset", every LSP failure surfaced to a
 * tool handler carries:
 *
 *   - A category-specific subclass so handlers can branch on `instanceof`
 *     without parsing message strings.
 *   - A `reason` short label (e.g. `"binary_not_found"`, `"port_unavailable"`)
 *     intended for telemetry attributes and error envelopes.
 *   - A `recoveryHint` string the MCP tool layer copies verbatim into the
 *     user-facing error envelope's `recovery_hint` field.
 *
 * The base `LspUnavailableError` is the type tool handlers in Wave 4 will
 * catch and translate to MCP responses; the specific subclasses exist so
 * tests and the spawn manager can assert the exact failure mode.
 */

/**
 * The discriminated reason label set. Each value corresponds to one
 * subclass; tools and telemetry consume these as opaque tags.
 */
export type LspUnavailableReason =
  | "binary_not_found"
  | "project_not_found"
  | "project_path_invalid"
  | "port_unavailable"
  | "spawn_failed"
  | "handshake_timeout"
  | "handshake_failed"
  | "spawn_cap_exhausted"
  | "connection_lost";

/**
 * Base class for every LSP-unavailable failure mode. Tool handlers catch
 * this and copy `recoveryHint` into the MCP response's `recovery_hint`
 * field per DESIGN.md § Initialization failure semantics.
 */
export class LspUnavailableError extends Error {
  /** Category tag for telemetry / programmatic branching. */
  readonly reason: LspUnavailableReason;
  /** User-facing remediation hint surfaced via the MCP error envelope. */
  readonly recoveryHint: string;

  constructor(
    reason: LspUnavailableReason,
    message: string,
    recoveryHint: string,
  ) {
    super(message);
    this.name = "LspUnavailableError";
    this.reason = reason;
    this.recoveryHint = recoveryHint;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * `GODOT_PATH` is unset or points to something that isn't a Godot binary.
 * Recovery hint matches DESIGN.md L403.
 */
export class LspBinaryNotFoundError extends LspUnavailableError {
  constructor(detail: string) {
    super(
      "binary_not_found",
      `Godot binary not found: ${detail}`,
      "Set `GODOT_PATH` to your Godot binary.",
    );
    this.name = "LspBinaryNotFoundError";
  }
}

/**
 * Auto-detect failed to find a `project.godot` in cwd or its ancestors and
 * no explicit `GODOT_LSP_PROJECT_PATH` was provided.
 */
export class LspProjectNotFoundError extends LspUnavailableError {
  constructor(startDir: string) {
    super(
      "project_not_found",
      `No project.godot found in cwd or ancestors starting at ${startDir}`,
      "Set `GODOT_LSP_PROJECT_PATH` to your Godot project directory.",
    );
    this.name = "LspProjectNotFoundError";
  }
}

/**
 * The configured project path exists but isn't a valid Godot project root
 * (not a directory, no `project.godot` inside, or unreadable).
 */
export class LspProjectPathInvalidError extends LspUnavailableError {
  constructor(projectPath: string, detail: string) {
    super(
      "project_path_invalid",
      `Invalid Godot project at ${projectPath}: ${detail}`,
      `No \`project.godot\` found at \`${projectPath}\`.`,
    );
    this.name = "LspProjectPathInvalidError";
  }
}

/**
 * Upward port scan from `GODOT_LSP_PORT` exhausted its budget without
 * binding any port. Matches DESIGN.md L405.
 */
export class LspPortUnavailableError extends LspUnavailableError {
  constructor(startPort: number, attempts: number) {
    super(
      "port_unavailable",
      `Could not bind any port in range [${startPort}, ${startPort + attempts - 1}]`,
      "Could not bind any port in range; check for runaway Godot processes.",
    );
    this.name = "LspPortUnavailableError";
  }
}

/**
 * `child_process.spawn` itself failed (e.g. EACCES). The Godot binary may
 * be unreadable or not executable.
 */
export class LspSpawnFailedError extends LspUnavailableError {
  constructor(detail: string) {
    super(
      "spawn_failed",
      `Failed to spawn headless Godot: ${detail}`,
      "Check that the Godot binary at `GODOT_PATH` is executable.",
    );
    this.name = "LspSpawnFailedError";
  }
}

/**
 * Connected to the LSP socket but the `initialize` handshake didn't return
 * within the per-request timeout. Distinct from `handshake_failed` so the
 * spawn manager can decide whether to retry with backoff.
 */
export class LspHandshakeTimeoutError extends LspUnavailableError {
  constructor(timeoutMs: number) {
    super(
      "handshake_timeout",
      `LSP handshake timed out after ${timeoutMs}ms`,
      "Restart MCP server; if persistent, increase `GODOT_LSP_DIAGNOSTIC_FIRST_MS` or check for a Godot import deadlock.",
    );
    this.name = "LspHandshakeTimeoutError";
  }
}

/**
 * The handshake completed with an error response rather than timing out.
 * Used when Godot's LSP rejects our `initialize` payload outright.
 */
export class LspHandshakeFailedError extends LspUnavailableError {
  constructor(detail: string) {
    super(
      "handshake_failed",
      `LSP handshake failed: ${detail}`,
      "Restart MCP server; verify the Godot version supports the `--lsp-port` flag (Godot 4.x).",
    );
    this.name = "LspHandshakeFailedError";
  }
}

/**
 * The spawn-cycle counter hit its cap (default 3) within the active
 * `GODOT_LSP_SPAWN_RESET_MINUTES` window. LSP is permanently unavailable
 * for the rest of the session. Recovery hint copy is locked verbatim by
 * the Wave 2 amendment to issue #8.
 */
export class LspSpawnCapExhaustedError extends LspUnavailableError {
  constructor(cap: number) {
    super(
      "spawn_cap_exhausted",
      `LSP exhausted its ${cap}-cycle spawn budget for this session`,
      "Restart MCP server (the LSP has exhausted its spawn budget for this session). If this happens repeatedly, check for runaway Godot processes.",
    );
    this.name = "LspSpawnCapExhaustedError";
  }
}

/**
 * Surfaced from in-flight requests when the underlying connection drops.
 * The client's tiered-recovery layer translates this into a respawn cycle;
 * tools should retry their request once before propagating to the user.
 */
export class LspConnectionLostError extends LspUnavailableError {
  constructor(detail: string) {
    super(
      "connection_lost",
      `LSP connection lost: ${detail}`,
      "Godot LSP disconnected mid-request; retry the operation.",
    );
    this.name = "LspConnectionLostError";
  }
}
