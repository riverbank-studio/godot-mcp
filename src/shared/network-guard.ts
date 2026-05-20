/**
 * The single network-allowed checkpoint for the godot-mcp server.
 *
 * Every future runtime network call — GitHub Tags API resolution, codeload
 * tarball fetch, HuggingFace model download (DESIGN.md L259 / L265) — must
 * call `assertOnlineAllowed()` before issuing the request. The guard is
 * intentionally tiny; its value is being the one place that gates the
 * offline contract, so a code reviewer can grep `assertOnlineAllowed` and
 * see every site that might touch the network.
 *
 * This file deliberately does NOT issue any network calls itself. It is
 * pure policy + the path-resolution helper `resolveDocsDbPath` that
 * classifies what a caller should do given the current env config.
 *
 * Re-exports `OfflineModeError` from env.ts for ergonomic single-import
 * usage at call sites.
 */

import { OfflineModeError, type SharedEnvConfig } from "./env.js";

export { OfflineModeError };

/**
 * Subset of `SharedEnvConfig` this module needs. Lets callers synthesize a
 * minimal config without populating the full env shape — useful in narrow
 * unit tests for ingestion code that doesn't care about model paths.
 */
export type OfflineCheckable = Pick<
  SharedEnvConfig,
  "offline" | "docsDbPath" | "modelPath" | "docsVersion"
> & {
  // All fields optional so tests / call sites can build the minimal shape
  // their use case needs.
  docsDbPath?: string | undefined;
  modelPath?: string | undefined;
  docsVersion?: string | undefined;
};

/**
 * Stable identifiers for the things we might call out to. Keeping these as a
 * union (rather than `string`) lets reviewers grep call sites and prevents
 * typos like `"github_tags"` vs `"github-tags-api"` silently diverging.
 *
 * - `github-tags-api`: resolving `GODOT_DOCS_VERSION=latest` via the GitHub
 *   Tags API.
 * - `codeload-engine-tarball-fetch`: downloading `godotengine/godot` source
 *   tarballs from codeload.github.com.
 * - `codeload-docs-tarball-fetch`: downloading `godotengine/godot-docs`
 *   source tarballs from codeload.github.com.
 * - `model-download`: downloading BGE-small-en-v1.5 ONNX files from
 *   HuggingFace.
 */
export type NetworkOperation =
  | "github-tags-api"
  | "codeload-engine-tarball-fetch"
  | "codeload-docs-tarball-fetch"
  | "model-download";

/**
 * Per-operation escape-hatch hint. Lives next to the `NetworkOperation` type
 * so adding a new network-call type forces the developer to write a hint at
 * the same time.
 */
const OFFLINE_HINTS: Record<NetworkOperation, string> = {
  "github-tags-api":
    "Pin GODOT_DOCS_VERSION to a specific X.Y (not 'latest') or set GODOT_DOCS_DB_PATH to a pre-built database.",
  "codeload-engine-tarball-fetch":
    "Set GODOT_DOCS_DB_PATH to a pre-built database to skip the Godot engine tarball fetch.",
  "codeload-docs-tarball-fetch":
    "Set GODOT_DOCS_DB_PATH to a pre-built database to skip the godot-docs tarball fetch.",
  "model-download":
    "Set GODOT_MCP_MODEL_PATH to a pre-downloaded copy of the embedding model.",
};

/**
 * The single gate every network call must pass through.
 *
 * In offline mode: throws `OfflineModeError` with a message naming the
 * blocked operation and the relevant escape-hatch env var, so logs from a
 * misconfigured air-gapped install identify both the failing call site and
 * the fix.
 *
 * When not offline: no-op (returns void).
 *
 * @param cfg Parsed shared env config; only `offline` is read.
 * @param operation Stable identifier of the network operation being
 *   attempted; appears in the error message.
 */
export function assertOnlineAllowed(
  cfg: Pick<SharedEnvConfig, "offline">,
  operation: NetworkOperation,
): void {
  if (!cfg.offline) return;

  const hint = OFFLINE_HINTS[operation];
  throw new OfflineModeError(
    [
      `Network call '${operation}' blocked by GODOT_MCP_OFFLINE=1.`,
      "",
      hint,
      "",
      "See docs/installation.md § Offline installation for the full procedure.",
    ].join("\n"),
  );
}

/**
 * Classification of how the docs subsystem should source its DB given the
 * current env config. The docs subsystem (#6) owns the actual file I/O;
 * this helper just answers "what flavor of source should you use?"
 *
 * - `override`: `GODOT_DOCS_DB_PATH` is set. Load that file directly; skip
 *   version resolution. Integrity check still runs at load time (DESIGN.md
 *   L140).
 * - `bundled`: No override, no explicit version, or `version=stable`. Use
 *   the in-package bundled `data/docs-stable.db`. No network ever.
 * - `resolve-required`: An explicit `X.Y` or `latest` was requested. The
 *   docs subsystem must check the cache and — on miss — call
 *   `assertOnlineAllowed` before fetching. In offline mode this resolution
 *   is still allowed to *start* (the cache may hit); only the fetch is
 *   forbidden.
 *
 * @throws OfflineModeError if offline + version=latest + no override.
 *   Mirrors `parseSharedEnv`'s parse-time check as defense in depth for
 *   callers that synthesize a config directly without going through
 *   `parseSharedEnv`.
 */
export function resolveDocsDbPath(
  cfg: OfflineCheckable,
):
  | { kind: "override"; path: string }
  | { kind: "bundled" }
  | { kind: "resolve-required" } {
  if (cfg.docsDbPath) {
    // Override takes precedence over everything else, including offline +
    // latest — the override IS the supported air-gap escape hatch.
    return { kind: "override", path: cfg.docsDbPath };
  }

  const version = cfg.docsVersion;
  if (version === undefined || version === "stable") {
    return { kind: "bundled" };
  }

  if (cfg.offline && version === "latest") {
    throw new OfflineModeError(
      "GODOT_MCP_OFFLINE=1 + GODOT_DOCS_VERSION=latest has no satisfiable resolution: " +
        "set GODOT_DOCS_DB_PATH or change GODOT_DOCS_VERSION.",
    );
  }

  return { kind: "resolve-required" };
}
