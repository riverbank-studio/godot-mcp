/**
 * Version resolution for the docs subsystem.
 *
 * Owns the `GODOT_DOCS_VERSION → DB-path` mapping documented in DESIGN.md
 * § Documentation subsystem → Version resolution, with the Wave 2
 * amendments inlined:
 *
 *   - `stable` (default, unset, empty) → bundled DB; **never** calls the
 *     network. Path: `data/docs-stable.db` resolved against the package
 *     root, so it works both from the in-tree checkout and after `npm
 *     publish` (where it lives at `<install>/data/docs-stable.db`).
 *   - `latest` → resolved at runtime via the GitHub Tags API (1-hour TTL,
 *     extended to 24h in CI). Filter to `*-stable` semver tags, pick the
 *     highest minor. Falls back to the cache file when offline mode is
 *     allowed and a cache hit exists.
 *   - `X.Y` (e.g. `4.5`) → cache path under the OS-appropriate cache dir.
 *     Patch (`4.5.1`), pre-release (`4.5-beta1`, `4.5-stable`), and `<4.0`
 *     values are rejected with `VersionParseError`. Godot 3.x is explicitly
 *     out of scope for v1 (DESIGN.md § Future work).
 *
 * What this module does NOT do
 * ----------------------------
 *   - No actual network I/O. The `latest` resolver lives in `latest.ts`
 *     (a separate file so it can be mocked at the import boundary) and
 *     calls back into `pickLatestStableTag` here.
 *   - No file I/O. The caller (build script or runtime fetcher) decides
 *     whether to create the cache dir, atomic-rename, etc.
 *   - No locking. `lock.ts` mediates concurrent ingest.
 *
 * Schema-version baking
 * ---------------------
 * The cache filename includes `-v{DOCS_SCHEMA_VERSION}` so old DBs from a
 * previous package version don't satisfy a cache hit after a schema
 * change. Bump `DOCS_SCHEMA_VERSION` whenever `schema.ts` changes shape.
 */

import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Re-exported from `schema.ts` so the two names are provably the same value.
 * Bumped whenever `schema.ts` changes shape — appears in the cache
 * filename so old DBs don't satisfy a cache hit after a schema migration.
 * DESIGN.md § Edge cases ("Schema-version cache pollution.").
 */
import { SCHEMA_VERSION as DOCS_SCHEMA_VERSION } from "./schema.js";
export { DOCS_SCHEMA_VERSION };

/**
 * Hard floor on supported Godot versions. 3.x has a different XML schema
 * for class references; supporting it would require a parallel parser path
 * and is parked under Future Work in DESIGN.md.
 */
export const MIN_GODOT_MAJOR = 4;

/**
 * Sentinel for parse failures on `GODOT_DOCS_VERSION`. Maps to exit code 2
 * (user-error class) per DESIGN.md L275.
 */
export class VersionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionParseError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, VersionParseError);
    }
  }
}

/**
 * Parsed shape of a `GODOT_DOCS_VERSION` value. The discriminant lets
 * callers narrow without re-parsing the raw string.
 */
export type DocsVersion =
  | { kind: "stable" }
  | { kind: "latest" }
  | { kind: "explicit"; major: number; minor: number };

/**
 * Parse a raw `GODOT_DOCS_VERSION` string. Empty / whitespace / unset
 * collapses to `stable` so the baseline config is the happy path.
 *
 * Format rules (DESIGN.md L137):
 *   - `stable` (any case) → bundled DB.
 *   - `latest` (any case) → resolve via GitHub Tags API.
 *   - `X.Y` where `X >= 4` and Y is a non-negative integer → explicit.
 *   - Patch (`X.Y.Z`), pre-release (`X.Y-beta1`, `X.Y-stable`), `<4.0`,
 *     or any other shape → `VersionParseError`.
 *
 * @throws VersionParseError on malformed values.
 */
export function parseDocsVersion(raw: string | undefined): DocsVersion {
  if (raw === undefined) return { kind: "stable" };
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "stable" };

  const lower = trimmed.toLowerCase();
  if (lower === "stable") return { kind: "stable" };
  if (lower === "latest") return { kind: "latest" };

  // Reject pre-release / patch / stable-suffixed up front so the error
  // message can name the specific shape rather than fall through to
  // "not a recognized version."
  if (/-/.test(trimmed)) {
    throw new VersionParseError(
      `GODOT_DOCS_VERSION='${raw}': pre-release / suffix forms (e.g. '4.5-beta1', '4.5-stable') are not supported. Use 'stable', 'latest', or 'X.Y'.`,
    );
  }

  // X.Y.Z (patch) — explicitly rejected per Wave 2 acceptance.
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    throw new VersionParseError(
      `GODOT_DOCS_VERSION='${raw}': patch versions (X.Y.Z) are not supported. Use the X.Y form (e.g. '4.5').`,
    );
  }

  const m = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (!m) {
    throw new VersionParseError(
      `GODOT_DOCS_VERSION='${raw}': expected 'stable', 'latest', or 'X.Y' (e.g. '4.5').`,
    );
  }
  const major = Number.parseInt(m[1]!, 10);
  const minor = Number.parseInt(m[2]!, 10);
  if (major < MIN_GODOT_MAJOR) {
    throw new VersionParseError(
      `GODOT_DOCS_VERSION='${raw}': Godot 3.x not supported in v1; minimum is ${MIN_GODOT_MAJOR}.0.`,
    );
  }
  return { kind: "explicit", major, minor };
}

/**
 * Inputs to `resolveCacheBaseDir`. Broken out as a record so tests can
 * synthesize a fixture environment without mutating `process.env` or
 * stubbing `os.*`.
 */
export interface CacheBaseDirInputs {
  /** `os.platform()` value. */
  platform: NodeJS.Platform;
  /** Environment record; only `XDG_CACHE_HOME` and `LOCALAPPDATA` are read. */
  env: Record<string, string | undefined>;
  /** `os.homedir()` value. */
  homedir: string;
}

/**
 * Resolve the platform-appropriate cache base directory for docs DBs:
 *
 *   - Linux: `$XDG_CACHE_HOME/godot-mcp/docs/`, falling back to
 *     `~/.cache/godot-mcp/docs/` per the XDG Base Directory spec.
 *   - macOS: `~/Library/Caches/godot-mcp/docs/`.
 *   - Windows: `%LOCALAPPDATA%/godot-mcp/docs/`, falling back to
 *     `~/AppData/Local/godot-mcp/docs/`.
 *
 * The directory is **not** created here — the caller (ingestion / runtime
 * fetcher) creates it lazily before writing.
 */
export function resolveCacheBaseDir(inputs: CacheBaseDirInputs): string {
  const { platform, env, homedir } = inputs;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    const base =
      local && local !== "" ? local : path.join(homedir, "AppData", "Local");
    return path.join(base, "godot-mcp", "docs");
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Caches", "godot-mcp", "docs");
  }
  // Linux + every other POSIX: XDG.
  const xdg = env.XDG_CACHE_HOME?.trim();
  const base = xdg && xdg !== "" ? xdg : path.join(homedir, ".cache");
  return path.join(base, "godot-mcp", "docs");
}

/**
 * Resolve the cache DB path for an `explicit` (or post-`latest`-resolution)
 * version. Filename embeds the schema version so a schema migration
 * invalidates stale caches without manual cleanup.
 *
 * @param version An `explicit` DocsVersion. (`stable` uses
 *   `resolveBundledDbPath`; `latest` must be resolved to `explicit`
 *   before reaching this helper.)
 */
export function resolveCacheDbPath(
  version: Extract<DocsVersion, { kind: "explicit" }>,
  envOverride?: Partial<CacheBaseDirInputs>,
): string {
  const baseDir = resolveCacheBaseDir({
    platform: envOverride?.platform ?? os.platform(),
    env: envOverride?.env ?? process.env,
    homedir: envOverride?.homedir ?? os.homedir(),
  });
  const filename = `docs-${version.major}.${version.minor}-v${DOCS_SCHEMA_VERSION}.db`;
  return path.join(baseDir, filename);
}

/**
 * Resolve the path to the bundled `data/docs-stable.db` artifact. Resolved
 * relative to the package root so it works both from the in-tree checkout
 * (where `import.meta.url` points to `src/docs/version-manager.ts` in dev
 * or `build/docs/version-manager.js` after `npm run build`) and from the
 * installed npm package layout.
 *
 * The lookup walks **up** from this file: `<root>/build/docs/...js` →
 * `<root>` (two parents up), then `<root>/data/docs-stable.db`. In dev
 * (when running via vitest from `src/docs/...ts`) the same two-level walk
 * lands at the repo root, where `data/` lives alongside `src/`.
 */
export function resolveBundledDbPath(): string {
  // import.meta.url → file path. Walk up two levels: `docs/` → `src|build/` → root.
  const thisFile = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(thisFile), "..", "..");
  return path.join(root, "data", "docs-stable.db");
}

/**
 * Subset of a GitHub Tags API entry. Only the `name` field is used; the
 * full API also returns `commit`, `zipball_url`, etc. — declared
 * structurally so callers can pass through whatever shape they have.
 */
export interface GithubTagRef {
  name: string;
}

/**
 * Internal: pre-compiled regex that matches `M.N-stable` tags. We
 * deliberately reject patch tags (`M.N.P-stable`) because v1 doesn't
 * support patch versions — design constraint, not a parser limitation.
 */
const STABLE_TAG_RE = /^(\d+)\.(\d+)-stable$/;

/**
 * Filter a list of GitHub tag refs to `M.N-stable` (no patch, no
 * pre-release) and return the highest semver. Returns `null` when the
 * list contains no usable tags (the caller decides whether to surface
 * that as a cache fallback or a hard fail).
 *
 * Numeric comparison on `major` then `minor` — string comparison is wrong
 * here because `4.10-stable` would sort before `4.5-stable`.
 */
export function pickLatestStableTag(
  tags: readonly GithubTagRef[],
): string | null {
  let best: { major: number; minor: number; name: string } | null = null;
  for (const t of tags) {
    const m = STABLE_TAG_RE.exec(t.name);
    if (!m) continue;
    const major = Number.parseInt(m[1]!, 10);
    const minor = Number.parseInt(m[2]!, 10);
    if (major < MIN_GODOT_MAJOR) continue;
    if (
      best === null ||
      major > best.major ||
      (major === best.major && minor > best.minor)
    ) {
      best = { major, minor, name: t.name };
    }
  }
  return best?.name ?? null;
}

/**
 * Configuration drawn from the shared env config that `resolveDocsSource`
 * needs. Declared as a narrow Pick so callers don't have to populate the
 * full `SharedEnvConfig`.
 */
export interface DocsSourceInputs {
  offline: boolean;
  dbPathOverride: string | undefined;
}

/**
 * Discriminated union describing how the docs subsystem should source its
 * DB given the parsed version and shared env config:
 *
 *   - `bundled`: the in-package `data/docs-stable.db`. No network ever.
 *   - `override`: `GODOT_DOCS_DB_PATH` is set. Load directly; integrity
 *     check still runs.
 *   - `explicit-cache`: an explicit `X.Y` was requested. Caller checks
 *     `cachePath` for a hit; on miss, kicks off the ingest pipeline.
 *   - `latest-resolve`: `latest` was requested. Caller runs the GitHub
 *     Tags API resolver, then re-enters as `explicit-cache`.
 */
export type DocsSource =
  | { kind: "bundled"; path: string }
  | { kind: "override"; path: string }
  | {
      kind: "explicit-cache";
      version: Extract<DocsVersion, { kind: "explicit" }>;
      cachePath: string;
    }
  | { kind: "latest-resolve" };

/**
 * Classify the docs source given the parsed version and shared env. Pure
 * function — does no I/O. Mirrors `resolveDocsDbPath` in network-guard
 * but resolves the actual paths instead of returning the lower-resolution
 * `{kind: "resolve-required"}` sentinel.
 *
 * `GODOT_DOCS_DB_PATH` wins over everything else (it's the supported
 * air-gap escape hatch per DESIGN.md L140).
 */
export function resolveDocsSource(
  version: DocsVersion,
  inputs: DocsSourceInputs,
): DocsSource {
  if (inputs.dbPathOverride) {
    return { kind: "override", path: inputs.dbPathOverride };
  }
  switch (version.kind) {
    case "stable":
      return { kind: "bundled", path: resolveBundledDbPath() };
    case "explicit":
      return {
        kind: "explicit-cache",
        version,
        cachePath: resolveCacheDbPath(version),
      };
    case "latest":
      // The cross-field offline+latest check is done in `parseSharedEnv`
      // and `resolveDocsDbPath`; by the time we get here, either we're
      // online or there's an override (handled above).
      return { kind: "latest-resolve" };
  }
}
