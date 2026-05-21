/**
 * Stderr-only, level-gated logger.
 *
 * stdout is reserved for the MCP JSON-RPC transport; every diagnostic goes
 * to stderr via `console.error`. Levels are
 * `silent < error < warn < info < debug` (DESIGN.md L608). A message at
 * level L is emitted iff `levelRank(currentLevel) >= levelRank(L)`.
 *
 * Output format: `[godot-mcp][subsystem] message` (DESIGN.md L210), produced
 * by `createLogger(subsystem)`. The bare module-level `logInfo / logWarn /
 * logError` shortcuts take an explicit `subsystem` arg so callers in
 * one-shot contexts (the top-level entry point) don't have to construct a
 * `Logger` first.
 *
 * Back-compat: the original `logDebug(message)` (no subsystem, legacy
 * `[DEBUG]` prefix) and the `isDebugEnabled` boolean from PR #58 are kept
 * unchanged so existing call sites in `dispatch.ts`, `godot-path.ts`,
 * `execute-operation.ts`, and `project-helpers.ts` continue to work.
 *
 * Level is initialized from `GODOT_MCP_LOG_LEVEL` at module load via the
 * env parser. Tests override via `setLogLevelForTesting()` — documented as
 * test-only because production code should never need to flip the level
 * after startup.
 */

import {
  DEFAULT_LOG_LEVEL,
  parseLogLevel,
  logLevelRank,
  type LogLevel,
} from "./env.js";

export type { LogLevel };

// Initialize once at module load. If parsing throws (bad level), surface it
// here — startup fails fast rather than running with a confusing default.
let currentLevel: LogLevel = (() => {
  try {
    return parseLogLevel(process.env.GODOT_MCP_LOG_LEVEL);
  } catch {
    // Defensive: if the env var is malformed we still want logging to work
    // for the error path that's about to surface the parse failure. The
    // top-level parseSharedEnv() call will throw the canonical error.
    return DEFAULT_LOG_LEVEL;
  }
})();

/**
 * Per-subsystem logger handle. Methods are the four user-facing levels;
 * `silent` is not a method (it's the absence of any output).
 */
export interface Logger {
  /** Emitted at log level `error` and above. */
  error(message: string): void;
  /** Emitted at log level `warn` and above. */
  warn(message: string): void;
  /** Emitted at log level `info` and above. */
  info(message: string): void;
  /** Emitted at log level `debug` only. */
  debug(message: string): void;
}

/**
 * Build a logger bound to a subsystem name. Output format:
 * `[godot-mcp][<subsystem>] <message>` on stderr, gated by the effective
 * `GODOT_MCP_LOG_LEVEL`.
 *
 * @param subsystem Short identifier like `"docs"`, `"lsp"`, `"server"`,
 *   `"dispatch"`. Appears verbatim in every line; keep it lowercase and
 *   stable across the subsystem's files for grep-ability.
 */
export function createLogger(subsystem: string): Logger {
  return {
    error(message: string): void {
      if (logLevelRank(currentLevel) >= logLevelRank("error")) {
        emit(subsystem, message);
      }
    },
    warn(message: string): void {
      if (logLevelRank(currentLevel) >= logLevelRank("warn")) {
        emit(subsystem, message);
      }
    },
    info(message: string): void {
      if (logLevelRank(currentLevel) >= logLevelRank("info")) {
        emit(subsystem, message);
      }
    },
    debug(message: string): void {
      if (logLevelRank(currentLevel) >= logLevelRank("debug")) {
        emit(subsystem, message);
      }
    },
  };
}

/**
 * Module-level shortcut for error-level emission. Equivalent to
 * `createLogger(subsystem).error(message)` but spares one-shot call sites
 * the ceremony of constructing a `Logger`.
 */
export function logError(subsystem: string, message: string): void {
  if (logLevelRank(currentLevel) >= logLevelRank("error")) {
    emit(subsystem, message);
  }
}

/** Module-level shortcut for warn-level emission. See {@link logError}. */
export function logWarn(subsystem: string, message: string): void {
  if (logLevelRank(currentLevel) >= logLevelRank("warn")) {
    emit(subsystem, message);
  }
}

/** Module-level shortcut for info-level emission. See {@link logError}. */
export function logInfo(subsystem: string, message: string): void {
  if (logLevelRank(currentLevel) >= logLevelRank("info")) {
    emit(subsystem, message);
  }
}

/**
 * Legacy `[DEBUG] <message>` emitter, preserved verbatim from PR #58 so
 * existing call sites continue to work. New code should use
 * `createLogger(subsystem).debug(...)` for the structured `[godot-mcp][<subsystem>]`
 * format.
 */
export function logDebug(message: string): void {
  if (logLevelRank(currentLevel) >= logLevelRank("debug")) {
    console.error(`[DEBUG] ${message}`);
  }
}

/**
 * Back-compat boolean. The DEBUG mode that PR #58 reads is now expressed as
 * the effective log level being `debug`. We retain the name and the
 * captured-at-load-time semantics so existing imports (e.g. in callers
 * gating expensive log construction) continue to compile and behave.
 *
 * NOTE: this is a snapshot taken at module load. `setLogLevelForTesting`
 * does not re-export a fresh value; tests that need a runtime check should
 * use `getCurrentLogLevel()` instead.
 */
export const isDebugEnabled: boolean =
  logLevelRank(currentLevel) >= logLevelRank("debug");

/**
 * Read the current effective log level. Used by tests and by subsystems
 * that need to gate expensive log-message construction (e.g. JSON
 * stringification of large payloads).
 */
export function getCurrentLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Override the effective log level. **Test-only.** Production code never
 * needs to mutate the level after startup — the env var is the only knob.
 *
 * Exported so `*.test.ts` files don't have to mutate `process.env` and
 * re-import the module to flip a level.
 */
export function setLogLevelForTesting(level: LogLevel): void {
  currentLevel = level;
}

/**
 * The single stderr write site. Centralized so the format is defined once
 * and every level path emits identical output. `console.error` writes to
 * stderr, never stdout — see module docstring.
 */
function emit(subsystem: string, message: string): void {
  console.error(`[godot-mcp][${subsystem}] ${message}`);
}
