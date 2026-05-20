/**
 * Shared env-var parsing for the godot-mcp server.
 *
 * This module is the **single source of truth** for the offline-mode contract
 * (`GODOT_MCP_OFFLINE`) and its companion override paths (`GODOT_DOCS_DB_PATH`,
 * `GODOT_MCP_MODEL_PATH`) described in docs/DESIGN.md § Configuration.
 *
 * Scope deliberately narrow: only the env vars that gate the
 * offline/airgapped story are parsed here. The full shared env layout
 * (logging level, telemetry, etc.) lands in #5; this file is intentionally
 * extensible so that PR doesn't conflict with this one — additional fields
 * are appended to `SharedEnvConfig` and `parseSharedEnv`.
 *
 * Why a typed config object instead of reading `process.env` ad-hoc:
 * - Centralized validation that fails fast at startup, not on first use.
 * - Tests can pass a fixture env without mutating `process.env`.
 * - The MCP server's `dispatch.ts` (per DESIGN.md L177) can hand the same
 *   config to every subsystem without each one re-parsing.
 */

/**
 * Sentinel error type for offline-mode contract violations.
 *
 * Distinct from generic `Error` so callers (and tests) can distinguish
 * "you misconfigured offline mode" from arbitrary fetch failures. The MCP
 * server's top-level error handler maps this to exit code 2 (user error)
 * per DESIGN.md L275, not exit code 1 (runtime failure).
 */
export class OfflineModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineModeError";
  }
}

/**
 * Parsed shape of the offline/override env-var subset.
 *
 * All fields default to "unset" semantics (false / undefined) so the
 * baseline config — no env vars set — is the happy path.
 */
export interface SharedEnvConfig {
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
   * `GODOT_DOCS_VERSION` raw value. Kept here so the offline + version
   * validation can run as a single pure function; full version-string
   * parsing (e.g. `4.5` vs `latest` vs rejection of `4.5.1`) belongs to the
   * docs subsystem and is not duplicated here.
   */
  docsVersion: string | undefined;
}

/**
 * The narrow env shape we accept. Matches `NodeJS.ProcessEnv` structurally
 * (string | undefined values) without requiring it as an import, so tests
 * can pass `{}` literally.
 */
export type EnvSource = Record<string, string | undefined>;

/**
 * Parse and validate the offline/override env vars.
 *
 * Throws `OfflineModeError` if `GODOT_MCP_OFFLINE` is set with a version
 * configuration that can't be satisfied offline (currently only
 * `GODOT_DOCS_VERSION=latest` without a `GODOT_DOCS_DB_PATH` override).
 *
 * Throws plain `Error` for malformed boolean values (e.g. `GODOT_MCP_OFFLINE=yes`)
 * to force users onto the canonical `1` / `true` spellings instead of guessing.
 *
 * @param env The environment to parse. Typically `process.env`; tests pass
 *   a fixture record. Default-parameter is intentionally omitted so callers
 *   are explicit about the source — `parseSharedEnv()` with no arg would
 *   mask test isolation bugs.
 */
export function parseSharedEnv(env: EnvSource): SharedEnvConfig {
  const offline = parseBoolean(env.GODOT_MCP_OFFLINE, "GODOT_MCP_OFFLINE");
  const docsDbPath = parsePath(env.GODOT_DOCS_DB_PATH);
  const modelPath = parsePath(env.GODOT_MCP_MODEL_PATH);
  const docsVersion = parsePath(env.GODOT_DOCS_VERSION); // empty/whitespace → undefined; same trim semantics

  const cfg: SharedEnvConfig = { offline, docsDbPath, modelPath, docsVersion };

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

  return cfg;
}

/**
 * Parse a boolean env var. Accepts canonical `1` / `true` (case-insensitive)
 * as true; canonical `0` / `false` / empty / unset as false. Throws on any
 * other value to prevent silent misconfiguration where a user writes
 * `OFFLINE=yes` and the server quietly stays online.
 */
function parseBoolean(raw: string | undefined, varName: string): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new Error(
    `${varName}: expected '1', '0', 'true', 'false', or unset; got '${raw}'.`,
  );
}

/**
 * Normalize a path-shaped env var. Returns `undefined` for unset / empty /
 * whitespace-only; otherwise the raw string (paths are platform-specific and
 * we deliberately do not normalize separators — the eventual fs call decides).
 */
function parsePath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}
