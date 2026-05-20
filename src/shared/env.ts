/**
 * Shared env-var parsing for the godot-mcp server.
 *
 * This module is the **single source of truth** for every env var documented
 * in `docs/DESIGN.md` § Configuration. Centralizing the parse here pays for
 * three things every Wave 3+ subsystem needs:
 *
 *   - Fail-fast validation at server startup — never on first use, when the
 *     error message would land in the middle of a tool call.
 *   - A single typed `SharedEnvConfig` object that `dispatch.ts` can pass to
 *     every subsystem without each one re-reading `process.env`.
 *   - Tests can inject a fixture env without mutating `process.env`.
 *
 * Relationship to PR #55 (`feat/44-offline-mode`)
 * -----------------------------------------------
 * PR #55 originally introduced `parseSharedEnv` with the four offline-mode
 * fields (`offline`, `docsDbPath`, `modelPath`, `docsVersion`) and the
 * cross-field "no offline+latest without override" invariant. Its header
 * explicitly invited #5 to extend `SharedEnvConfig` and `parseSharedEnv`
 * with logging / telemetry fields rather than introduce a parallel function.
 *
 * This file is that extension. PR #55's exports — `OfflineModeError`,
 * `SharedEnvConfig`, `EnvSource`, `parseSharedEnv` — preserve their names
 * and behavior. The new fields are appended; the existing field invariants
 * are unchanged. When PR #55 lands on main and `refactor/3-modules` is
 * rebased, the two `src/shared/env.ts` files conflict trivially and the
 * more complete (post-#5) version is the one to keep.
 *
 * `parseBoolean` and `parseOptionalString` are exported so subsystems and
 * future env-var additions can share the strict boolean grammar (`1`/`0`/
 * `true`/`false` only; anything else throws).
 */

/**
 * Sentinel error for env-config validation failures that aren't specifically
 * about offline mode. Distinct from `OfflineModeError` so the top-level
 * startup error handler can map config errors to exit code 2 (user error)
 * regardless of which knob the user got wrong.
 */
export class EnvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvParseError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, EnvParseError);
    }
  }
}

/**
 * Sentinel for offline-mode contract violations. Preserved verbatim from
 * PR #55 so its call sites (and tests) work unchanged against this file.
 *
 * Maps to exit code 2 (user error) in the top-level error handler per
 * DESIGN.md L275, not exit code 1 (runtime failure).
 */
export class OfflineModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineModeError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OfflineModeError);
    }
  }
}

/**
 * The five-level stderr log verbosity setting, parsed from
 * `GODOT_MCP_LOG_LEVEL`. Order matters: it defines the gating relation in
 * `logging.ts` (a message at level L is emitted iff
 * `levelRank(current) >= levelRank(L)`).
 */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/**
 * The default log level. Matches DESIGN.md L608.
 */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

const LOG_LEVELS: readonly LogLevel[] = [
  "silent",
  "error",
  "warn",
  "info",
  "debug",
] as const;

/**
 * Parsed shape of every env var the server consumes.
 *
 * Fields default to "unset" semantics so the baseline config — no env vars
 * set — is the happy path.
 */
export interface SharedEnvConfig {
  // --- offline-mode subset (PR #55) ------------------------------------

  /** `GODOT_MCP_OFFLINE=1` → true. Disables all runtime network calls. */
  offline: boolean;
  /**
   * `GODOT_DOCS_DB_PATH` override. When set, skips version resolution and
   * loads this `.db` file directly (schema integrity check still runs).
   */
  docsDbPath: string | undefined;
  /**
   * `GODOT_MCP_MODEL_PATH` override for the embedding model ONNX files.
   * Mirrors the `GODOT_DOCS_DB_PATH` pattern.
   */
  modelPath: string | undefined;
  /**
   * `GODOT_DOCS_VERSION` raw value. Full parsing (`4.5` vs `latest` vs
   * rejection of `4.5.1`) lives in the docs subsystem and is not duplicated
   * here.
   */
  docsVersion: string | undefined;

  // --- logging + telemetry (#5) ----------------------------------------

  /**
   * Effective stderr log level. Parsed from `GODOT_MCP_LOG_LEVEL`.
   * Defaults to `"info"`. Case-insensitive on input.
   */
  logLevel: LogLevel;
  /**
   * `GODOT_MCP_TRACE_QUERIES=1` → true. Enables verbatim capture of query
   * strings in OTel traces. Defaults to false; query strings are otherwise
   * recorded as `{length, sha256_prefix_8}` per `docs/telemetry.md`.
   */
  traceQueries: boolean;
  /**
   * Standard OTel `OTEL_SDK_DISABLED` env var. When true, the telemetry
   * facade is replaced by a noop implementation and no traces are written.
   */
  otelDisabled: boolean;
}

/**
 * The narrow env shape we accept. Matches `NodeJS.ProcessEnv` structurally
 * (string | undefined values) without requiring it as an import, so tests
 * can pass `{}` literally.
 */
export type EnvSource = Record<string, string | undefined>;

/**
 * Parse and validate every env var the server consumes.
 *
 * Failure modes:
 *   - `OfflineModeError` for the cross-field offline+latest invariant.
 *   - `EnvParseError` for malformed values (bad boolean spelling, unknown
 *     log level).
 *
 * @param env The environment to parse. Typically `process.env`; tests pass
 *   a fixture record. Default-parameter is intentionally omitted so callers
 *   are explicit about the source — `parseSharedEnv()` with no arg would
 *   mask test isolation bugs.
 */
export function parseSharedEnv(env: EnvSource): SharedEnvConfig {
  const offline = parseBoolean(env.GODOT_MCP_OFFLINE, "GODOT_MCP_OFFLINE");
  const docsDbPath = parseOptionalString(env.GODOT_DOCS_DB_PATH);
  const modelPath = parseOptionalString(env.GODOT_MCP_MODEL_PATH);
  const docsVersion = parseOptionalString(env.GODOT_DOCS_VERSION);

  const logLevel = parseLogLevel(env.GODOT_MCP_LOG_LEVEL);
  const traceQueries = parseBoolean(
    env.GODOT_MCP_TRACE_QUERIES,
    "GODOT_MCP_TRACE_QUERIES",
  );
  const otelDisabled = parseBoolean(env.OTEL_SDK_DISABLED, "OTEL_SDK_DISABLED");

  // Cross-field validation: in offline mode, GODOT_DOCS_VERSION=latest is
  // unsatisfiable unless GODOT_DOCS_DB_PATH supplies a pre-built DB.
  // (X.Y is *allowed* at parse time because the cache might already hold it;
  // only the actual fetch attempt is forbidden, and that gate lives in
  // network-guard.ts.)
  if (offline && docsVersion === "latest" && !docsDbPath) {
    throw new OfflineModeError(
      [
        "GODOT_MCP_OFFLINE=1 is incompatible with GODOT_DOCS_VERSION=latest.",
        "",
        "`latest` requires a GitHub Tags API call to resolve, which is",
        "forbidden in offline mode. Choose one:",
        "",
        "  1. Unset GODOT_MCP_OFFLINE (allow the network call).",
        "  2. Pin GODOT_DOCS_VERSION to a specific X.Y you already have cached",
        "     (e.g. `GODOT_DOCS_VERSION=4.5`).",
        "  3. Point GODOT_DOCS_DB_PATH at a pre-built .db file (skips version",
        "     resolution entirely; see docs/installation.md § Offline installation).",
        "  4. Unset GODOT_DOCS_VERSION (uses the bundled `stable` DB; never",
        "     calls the network).",
      ].join("\n"),
    );
  }

  return {
    offline,
    docsDbPath,
    modelPath,
    docsVersion,
    logLevel,
    traceQueries,
    otelDisabled,
  };
}

/**
 * Parse a boolean env var. Accepts canonical `1` / `true` (case-insensitive)
 * as true; canonical `0` / `false` / empty / unset as false. Throws on any
 * other value to prevent silent misconfiguration where a user writes
 * `OFFLINE=yes` and the server quietly stays online.
 *
 * Exported so other modules and future env-var additions share the same
 * strict grammar without having to reimplement it.
 */
export function parseBoolean(
  raw: string | undefined,
  varName: string,
): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new EnvParseError(
    `${varName}: expected '1', '0', 'true', 'false', or unset; got '${raw}'.`,
  );
}

/**
 * Normalize an optional string env var. Returns `undefined` for unset /
 * empty / whitespace-only; otherwise the trimmed string. Used for both
 * path-shaped vars (where the OS handles separator normalisation) and
 * plain string vars like `GODOT_DOCS_VERSION`.
 */
export function parseOptionalString(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse `GODOT_MCP_LOG_LEVEL`. Case-insensitive; whitespace-trimmed; empty /
 * unset returns the default. Unknown level → `EnvParseError`.
 */
export function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  const v = raw.trim().toLowerCase();
  if (v === "") return DEFAULT_LOG_LEVEL;
  if ((LOG_LEVELS as readonly string[]).includes(v)) {
    return v as LogLevel;
  }
  throw new EnvParseError(
    `GODOT_MCP_LOG_LEVEL: expected one of ${LOG_LEVELS.join(", ")}; got '${raw}'.`,
  );
}

/**
 * Sort order for the five levels: silent (0) < error (1) < warn (2) <
 * info (3) < debug (4). A message at level L is emitted iff the effective
 * level's rank is >= L's rank. `logging.ts` consumes this.
 */
export function logLevelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}
