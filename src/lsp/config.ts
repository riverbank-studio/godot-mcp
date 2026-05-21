/**
 * LSP-specific env-var parsing.
 *
 * Layers on top of `SharedEnvConfig` from `src/shared/env.ts`. Owns the
 * `GODOT_LSP_*` family documented in `docs/DESIGN.md` § LSP subsystem.
 * Failure modes throw `EnvParseError` so the top-level startup handler can
 * map them to exit code 2 uniformly with the shared env parser.
 *
 * Single source of truth lives here; the process manager, client, and
 * documents tracker receive a `LspConfig` rather than re-reading
 * `process.env`. Tests inject fixtures via the explicit `env` arg.
 *
 * Per Wave 2 amendment D19 (LSP L14), `GODOT_LSP_HOST` is intentionally
 * **not** parsed — the bind host is hardcoded to loopback in the spawn
 * line. Accepting the env var would invite WSL/devcontainer users to bind
 * `0.0.0.0` and expose the unauthenticated Godot LSP to the LAN.
 */

import {
  EnvParseError,
  parseBoolean,
  parseOptionalString,
} from "../shared/env.js";
import type { EnvSource } from "../shared/env.js";

/**
 * Default starting port for the upward scan. Matches DESIGN.md L147 and
 * issue #8.
 */
export const DEFAULT_LSP_PORT = 6005;

/**
 * Default number of ports tried in the upward scan before giving up.
 * Wide enough to accommodate several concurrent MCP sessions plus an open
 * editor; small enough to bound the worst-case startup latency.
 */
export const DEFAULT_PORT_SCAN_ATTEMPTS = 32;

/**
 * Default windowed reset for the spawn-cycle counter. Matches DESIGN.md
 * L150 and the Wave 2 amendment "Spawn-cycle cap reset".
 */
export const DEFAULT_SPAWN_RESET_MINUTES = 30;

/**
 * Default first-touch `publishDiagnostics` await timeout per file URI.
 * The 10s budget accommodates Godot's cold-parse-on-first-connection
 * latency observed in [godot#87410] and opencode-godot-lsp's README.
 */
export const DEFAULT_DIAGNOSTIC_FIRST_MS = 10_000;

/**
 * Default steady-state `publishDiagnostics` await timeout after the
 * first-touch budget has been consumed for a URI.
 */
export const DEFAULT_DIAGNOSTIC_STEADY_MS = 2_000;

/**
 * Default per-request timeout. Matches cclsp's 30s baseline (Wave 2 D27).
 * Per-method adapter overrides land in #13.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Default cap on consecutive spawn cycles within the reset window. Wave 2
 * amendment locks this at 3.
 */
export const DEFAULT_SPAWN_CAP = 3;

/**
 * Default throttle for the broader tracked-set stat poll, per Wave 2
 * amendment "Auto-resync mtime-shortcircuit". The current call's
 * referenced files are stat'd unconditionally; the broader set is
 * stat-checked at most once per N ms.
 */
export const DEFAULT_STAT_POLL_THROTTLE_MS = 1_000;

/**
 * Parsed shape of the `GODOT_LSP_*` env vars consumed by the LSP subsystem.
 *
 * The wider `SharedEnvConfig` carries the log level and offline-mode flags
 * that `process.ts` and `client.ts` also reference; we don't duplicate it
 * here — composition happens in the call site.
 */
export interface LspConfig {
  /**
   * Starting port for the upward scan. Parsed from `GODOT_LSP_PORT`;
   * defaults to {@link DEFAULT_LSP_PORT}.
   */
  port: number;
  /**
   * Number of ports tried before {@link LspPortUnavailableError} is thrown.
   * Not user-configurable in v1; tests pass a smaller value.
   */
  portScanAttempts: number;
  /**
   * Explicit project root from `GODOT_LSP_PROJECT_PATH`. When undefined,
   * the project detector walks up from cwd looking for `project.godot`.
   */
  projectPath: string | undefined;
  /**
   * When true, spawn headless Godot at MCP startup rather than on first
   * LSP tool call. Parsed from `GODOT_LSP_EAGER_INIT`. Default `false` for
   * backwards compatibility; documentation recommends `true` for
   * interactive agent use.
   */
  eagerInit: boolean;
  /**
   * Windowed reset for the spawn-cycle counter, in minutes. Parsed from
   * `GODOT_LSP_SPAWN_RESET_MINUTES`. If no spawn cycle has occurred in
   * this window, the counter resets regardless of handshake state.
   */
  spawnResetMinutes: number;
  /**
   * First-touch `publishDiagnostics` await timeout per URI, in ms.
   * Parsed from `GODOT_LSP_DIAGNOSTIC_FIRST_MS`.
   */
  diagnosticFirstMs: number;
  /**
   * Steady-state `publishDiagnostics` await timeout, in ms. Parsed from
   * `GODOT_LSP_DIAGNOSTIC_STEADY_MS`.
   */
  diagnosticSteadyMs: number;
  /**
   * Default per-request timeout for LSP JSON-RPC requests, in ms.
   * Not currently env-configurable; per-method adapter overrides land in
   * #13. Exposed so tests can inject a small value.
   */
  requestTimeoutMs: number;
  /**
   * Cap on consecutive spawn cycles within the reset window.
   */
  spawnCap: number;
  /**
   * Stat-poll throttle for the broader tracked-set, in ms. See Wave 2
   * amendment "Auto-resync mtime-shortcircuit".
   */
  statPollThrottleMs: number;
}

/**
 * Parse the LSP-specific env vars into a `LspConfig`. The shared env
 * config is accepted but not consulted here — call sites pass both so a
 * future cross-field rule (e.g. offline + eager LSP) has a natural home.
 *
 * @param env The environment to parse. Tests inject a fixture record;
 *   production passes `process.env`.
 */
export function parseLspEnv(env: EnvSource): LspConfig {
  const port = parsePositiveInt(
    env.GODOT_LSP_PORT,
    "GODOT_LSP_PORT",
    DEFAULT_LSP_PORT,
  );
  if (port < 1 || port > 65535) {
    throw new EnvParseError(
      `GODOT_LSP_PORT: expected an integer in [1, 65535]; got '${env.GODOT_LSP_PORT}'.`,
    );
  }

  const projectPath = parseOptionalString(env.GODOT_LSP_PROJECT_PATH);
  const eagerInit = parseBoolean(
    env.GODOT_LSP_EAGER_INIT,
    "GODOT_LSP_EAGER_INIT",
  );

  const spawnResetMinutes = parsePositiveInt(
    env.GODOT_LSP_SPAWN_RESET_MINUTES,
    "GODOT_LSP_SPAWN_RESET_MINUTES",
    DEFAULT_SPAWN_RESET_MINUTES,
  );

  const diagnosticFirstMs = parsePositiveInt(
    env.GODOT_LSP_DIAGNOSTIC_FIRST_MS,
    "GODOT_LSP_DIAGNOSTIC_FIRST_MS",
    DEFAULT_DIAGNOSTIC_FIRST_MS,
  );

  const diagnosticSteadyMs = parsePositiveInt(
    env.GODOT_LSP_DIAGNOSTIC_STEADY_MS,
    "GODOT_LSP_DIAGNOSTIC_STEADY_MS",
    DEFAULT_DIAGNOSTIC_STEADY_MS,
  );

  return {
    port,
    portScanAttempts: DEFAULT_PORT_SCAN_ATTEMPTS,
    projectPath,
    eagerInit,
    spawnResetMinutes,
    diagnosticFirstMs,
    diagnosticSteadyMs,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    spawnCap: DEFAULT_SPAWN_CAP,
    statPollThrottleMs: DEFAULT_STAT_POLL_THROTTLE_MS,
  };
}

/**
 * Parse a positive integer env var. Unset / empty / whitespace-only
 * returns `fallback`. Non-integer values, negatives, and zero throw
 * `EnvParseError`. Exported so future LSP env-var additions can share the
 * grammar.
 */
export function parsePositiveInt(
  raw: string | undefined,
  varName: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  // Reject anything that's not pure digits — `+10`, `0x10`, `10.0`, `10e2`
  // are all caught here so the env contract is the same strict grammar as
  // the shared boolean parser.
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new EnvParseError(
      `${varName}: expected a positive integer; got '${raw}'.`,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new EnvParseError(
      `${varName}: expected a positive integer; got '${raw}'.`,
    );
  }
  return value;
}
