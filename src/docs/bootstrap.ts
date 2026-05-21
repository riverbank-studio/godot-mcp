/**
 * Docs runtime bootstrap — server-startup wiring that takes the parsed
 * env config and a fresh {@link DocsRuntime} and either opens the DB or
 * fails the runtime with a precise diagnostic.
 *
 * Scope (Phase 1 of #7-infra)
 * ---------------------------
 *
 * The bootstrap handles the three sources resolvable purely from
 * environment + filesystem state:
 *
 *   - `override` — `GODOT_DOCS_DB_PATH` env var points at a `.db` file.
 *   - `bundled`  — `GODOT_DOCS_VERSION` is unset/`stable`; bootstrap
 *     opens the in-package `data/docs-stable.db`.
 *   - `cache-hit` — `GODOT_DOCS_VERSION=X.Y`; bootstrap opens the
 *     `$XDG_CACHE_HOME/godot-mcp/docs/docs-X.Y-vN.db` file if present.
 *
 * The two sources requiring a network fetch — `latest` (requires the
 * GitHub Tags API) and cache miss (requires the docs ingestion pipeline)
 * — are intentionally NOT handled here. Wiring those in is a separate
 * PR (the "docs runtime fetcher"), filed against the cross-subsystem-
 * independence requirements in DESIGN.md L276. This bootstrap fails the
 * runtime in those cases with a message that points the user at the
 * supported configuration knobs.
 *
 * Why a separate file from `runtime.ts`
 * -------------------------------------
 *
 * The runtime itself is a pure data structure (latch + source descriptor)
 * — it doesn't know about env vars, the filesystem, or `parseDocsVersion`.
 * Keeping the bootstrap separate means the runtime stays trivial to
 * test, and the bootstrap can grow new sources without disturbing
 * runtime invariants.
 *
 * Failure-mode contract
 * ---------------------
 *
 * Every code path through the bootstrap either calls `initialize()`
 * exactly once (success) or `fail()` exactly once (any non-success).
 * The runtime is never left in `pending` state on return. This is
 * load-bearing: tool handlers `await runtime.getDb()`, and a hanging
 * latch would mean docs tools never respond.
 */

import * as fs from "node:fs";

import type { DocsRuntime, DocsSourceKind } from "./runtime.js";
import { openReadOnly } from "./schema.js";
import {
  parseDocsVersion,
  resolveBundledDbPath,
  resolveCacheDbPath,
  resolveDocsSource,
  VersionParseError,
} from "./version-manager.js";

/**
 * Narrow shape of the env config that the bootstrap consumes. Declared
 * as a `Pick`-equivalent to keep the bootstrap decoupled from the full
 * `SharedEnvConfig` — tests can construct fixtures without populating
 * unrelated logging/telemetry fields.
 *
 * The two `*Override` fields are test-only hooks for hermetic tests
 * (avoiding dependency on `os.homedir()` or the package's actual
 * `data/docs-stable.db`). Production calls leave them unset; the
 * bootstrap resolves real paths via the version-manager helpers.
 */
export interface DocsBootstrapInputs {
  offline: boolean;
  docsDbPath: string | undefined;
  docsVersion: string | undefined;
  /** Test-only: override the resolved `data/docs-stable.db` lookup. */
  bundledPathOverride?: string;
  /** Test-only: override the resolved cache-DB lookup for explicit X.Y. */
  cachePathOverride?: string;
}

/**
 * Initialize a {@link DocsRuntime} from env config. Synchronous because
 * better-sqlite3's `open` is sync — the function returns once the
 * runtime is settled (ready or failed).
 *
 * Pre-condition: `runtime.state().kind === "pending"`. Calling the
 * bootstrap against a runtime that's already settled throws (via the
 * latch's idempotency check).
 */
export function bootstrapDocsRuntime(
  runtime: DocsRuntime,
  inputs: DocsBootstrapInputs,
): void {
  // Step 1: parse `GODOT_DOCS_VERSION`. Reject malformed shapes early
  // with a precise error message (e.g. patch versions, pre-releases).
  let parsedVersion;
  try {
    parsedVersion = parseDocsVersion(inputs.docsVersion);
  } catch (err) {
    if (err instanceof VersionParseError) {
      runtime.fail(err);
      return;
    }
    runtime.fail(
      err instanceof Error ? err : new Error(`docs bootstrap: ${String(err)}`),
    );
    return;
  }

  // Step 2: classify the source. The version-manager's classifier is a
  // pure function — no I/O — so we can decide the next action based on
  // its return value without committing to a code path.
  const source = resolveDocsSource(parsedVersion, {
    offline: inputs.offline,
    dbPathOverride: inputs.docsDbPath,
  });

  switch (source.kind) {
    case "override":
      openSourceOrFail(runtime, "override", inputs.docsDbPath!);
      return;

    case "bundled": {
      const bundledPath = inputs.bundledPathOverride ?? resolveBundledDbPath();
      openSourceOrFail(runtime, "bundled", bundledPath);
      return;
    }

    case "explicit-cache": {
      const cachePath =
        inputs.cachePathOverride ?? resolveCacheDbPath(source.version);
      if (!fs.existsSync(cachePath)) {
        runtime.fail(
          new Error(
            [
              `docs bootstrap: no cached DB at '${cachePath}' for ` +
                `GODOT_DOCS_VERSION='${inputs.docsVersion}'.`,
              "",
              "Phase 1 of the docs subsystem (epic #7-infra) only opens",
              "existing DB files. Runtime ingestion of a missing cache is",
              "handled by a separate PR (DESIGN.md § Documentation",
              "subsystem → Ingestion pipeline).",
              "",
              "Workarounds:",
              "  - Unset GODOT_DOCS_VERSION to fall back to the bundled DB.",
              "  - Set GODOT_DOCS_DB_PATH to a pre-built `.db` file.",
            ].join("\n"),
          ),
        );
        return;
      }
      openSourceOrFail(runtime, "cache", cachePath);
      return;
    }

    case "latest-resolve": {
      runtime.fail(
        new Error(
          [
            "docs bootstrap: GODOT_DOCS_VERSION='latest' is not supported in",
            "Phase 1 of the docs subsystem (epic #7-infra). The GitHub Tags",
            "API resolver lives in the separate runtime-fetcher PR.",
            "",
            "Use one of:",
            "  - GODOT_DOCS_VERSION=stable (or unset; default).",
            "  - GODOT_DOCS_VERSION=X.Y with a pre-built cache file.",
            "  - GODOT_DOCS_DB_PATH=<path to .db>.",
          ].join("\n"),
        ),
      );
      return;
    }
  }
}

/**
 * Attempt to open `path` as a read-only docs DB and `initialize()` the
 * runtime against the resulting handle. On any error (file missing,
 * not a SQLite DB, schema mismatch), the runtime is `fail()`ed with a
 * source-typed error message.
 *
 * The integrity-check step that DESIGN.md L140 calls out for the
 * override path is intentionally left as a TODO for #7 — Phase 1's
 * concern is purely opening the file. Schema-shape verification lives
 * in `integrity.ts` and the runtime fetcher wires it in.
 */
function openSourceOrFail(
  runtime: DocsRuntime,
  kind: DocsSourceKind,
  path: string,
): void {
  if (!fs.existsSync(path)) {
    const verb =
      kind === "override"
        ? "GODOT_DOCS_DB_PATH points to a missing file"
        : kind === "bundled"
          ? "bundled docs DB is missing from the package"
          : "cached docs DB is missing";
    runtime.fail(new Error(`docs bootstrap: ${verb}: '${path}'.`));
    return;
  }
  try {
    const db = openReadOnly(path);
    runtime.initialize({ db, source: kind, path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.fail(
      new Error(
        `docs bootstrap: failed to open ${kind} docs DB at '${path}': ${msg}`,
      ),
    );
  }
}
