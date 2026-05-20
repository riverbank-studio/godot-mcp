/**
 * Tarball integrity verification for the Godot docs ingestion pipeline (#47).
 *
 * Why this lives as a standalone module: the verification step is small,
 * pure, and dependency-light, but it sits in a security-sensitive place in
 * the ingestion pipeline (step 2.5 in DESIGN.md § Ingestion pipeline). Future
 * code in `src/docs/ingest.ts` (#6) imports {@link verifyTarballSha} as a
 * synchronous helper after each tarball download. Auto-republish CI (#11)
 * also imports {@link loadHashManifest} to read the manifest before kicking
 * off a rebuild.
 *
 * Three behaviors this helper guarantees:
 *
 *  1. **Pinned mismatch is a hard failure.** When the manifest contains an
 *     entry for the requested git tag, the observed SHA-256 must match. A
 *     mismatch throws {@link IntegrityError} with `code: TARBALL_SHA_MISMATCH`
 *     and `exitCode: 2` — caller in `index.ts` is expected to surface that
 *     as `process.exit(2)` (user-error class: it indicates either a moved /
 *     compromised upstream tag or a stale local manifest).
 *
 *  2. **Unpinned tags are not blocked.** For `latest` or any tag without a
 *     manifest entry, this helper returns the observed SHA so the caller
 *     can persist it into the DB's `meta.tarball_sha256` field. Downstream
 *     hash comparison across users / cache invalidations remains possible.
 *
 *  3. **Env override for forks.** `GODOT_DOCS_TARBALL_HASH_OVERRIDE` lets
 *     users with non-upstream tarballs pin a different SHA without editing
 *     the in-repo manifest. Format: `asset=sha256:HEX[,asset=sha256:HEX]`,
 *     where `asset` is `godot` or `godot-docs`. The override applies to the
 *     current process and replaces the manifest's expected value entirely
 *     (a malformed override is itself an integrity error, not a silent
 *     fallback to manifest — fail-loud is correct here).
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Pattern matching a `sha256:<64-hex>` digest string. */
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Resolve the canonical path to `data/godot-release-hashes.json`, working
 * in both the source tree (`src/docs/integrity.ts` → `../../data/...`) and
 * the built tree (`build/docs/integrity.js` → `../../data/...`). The
 * `scripts/build.js` step copies `data/*.json` into `build/data/` so the
 * relative layout is identical in both trees.
 *
 * Returns the first path that exists; throws {@link IntegrityError} with
 * code `MANIFEST_NOT_FOUND` if no candidate is present (which would
 * indicate a broken install — every release of this package ships the
 * manifest).
 */
export function resolveDefaultManifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // src/docs/ or build/docs/ → ../../data/godot-release-hashes.json
    resolve(here, "..", "..", "data", "godot-release-hashes.json"),
    // Fallback for atypical layouts (e.g. flattened bundlers): cwd/data/...
    resolve(process.cwd(), "data", "godot-release-hashes.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new IntegrityError(
    "MANIFEST_NOT_FOUND",
    `Cannot locate data/godot-release-hashes.json. Searched: ${candidates.join(", ")}. ` +
      "This file ships with every release; a missing manifest indicates a broken install.",
  );
}

/**
 * Per-asset key inside a manifest entry. Mirrors the two tarballs the
 * ingestion pipeline fetches (one from godotengine/godot, one from
 * godotengine/godot-docs).
 */
export type TarballAsset = "godot" | "godot-docs";

/**
 * Shape of a single entry in {@link HashManifest.versions}. Matches the
 * schema documented at data/godot-release-hashes.schema.json.
 */
export interface HashManifestEntry {
  /** SHA-256 of the godotengine/godot tarball for this tag, as `sha256:<hex>`. */
  godot: string;
  /** Branch name in godotengine/godot-docs (a branch, not a tag) — e.g. "4.5". */
  "godot-docs-branch": string;
  /** SHA-256 of the godotengine/godot-docs tarball for that branch. */
  "godot-docs": string;
}

/**
 * Parsed, validated manifest. The on-disk JSON uses git tags as top-level
 * keys (plus optional `$schema` / `$comment`); after loading we collect the
 * tag entries under `versions` for a clean iteration surface.
 */
export interface HashManifest {
  versions: Record<string, HashManifestEntry>;
}

/**
 * Result of {@link verifyTarballSha}. The caller uses `source` to decide
 * whether the SHA is trusted (pinned) or merely observed (unpinned), and
 * persists `observed` to the DB's `meta` row regardless.
 */
export interface VerifyResult {
  /** Always the SHA-256 of the bytes the caller just downloaded. */
  observed: string;
  /** The expected SHA when one was found, else `undefined`. */
  pinned: string | undefined;
  /**
   * Where the expected hash came from:
   *  - `manifest` — `data/godot-release-hashes.json`
   *  - `env-override` — `GODOT_DOCS_TARBALL_HASH_OVERRIDE`
   *  - `unpinned` — no expected hash existed; `observed` recorded for audit only
   */
  source: "manifest" | "env-override" | "unpinned";
}

/**
 * Error codes thrown by this module. Stable strings — auto-republish CI
 * (#11) is allowed to match on them.
 */
export type IntegrityErrorCode =
  | "TARBALL_SHA_MISMATCH"
  | "MANIFEST_MALFORMED"
  | "MANIFEST_NOT_FOUND"
  | "OVERRIDE_MALFORMED";

/**
 * Thrown for any integrity-related failure. `exitCode` is what the top-level
 * CLI handler should pass to `process.exit()`. All mismatches and bad-config
 * cases are user-error-class (exit 2) per DESIGN.md § Failure semantics.
 */
export class IntegrityError extends Error {
  public readonly code: IntegrityErrorCode;
  public readonly exitCode: number;
  /** Optional: the git tag being verified, when applicable. */
  public readonly tag?: string;
  /** Optional: the tarball asset being verified, when applicable. */
  public readonly asset?: TarballAsset;
  /** Optional: the SHA we expected to see. */
  public readonly expected?: string;
  /** Optional: the SHA we actually computed. */
  public readonly observed?: string;

  /**
   * @param code - Stable machine-readable error code.
   * @param message - Human-readable explanation for stderr.
   * @param details - Optional diagnostic context attached to the error.
   */
  constructor(
    code: IntegrityErrorCode,
    message: string,
    details: {
      tag?: string;
      asset?: TarballAsset;
      expected?: string;
      observed?: string;
    } = {},
  ) {
    super(message);
    this.name = "IntegrityError";
    this.code = code;
    // Per DESIGN.md: tarball SHA mismatch is user-error-class (exit 2),
    // not runtime-failure (exit 1). The user-actionable fix is either to
    // update data/godot-release-hashes.json (if upstream re-tagged) or to
    // investigate a possibly-compromised upstream.
    this.exitCode = 2;
    this.tag = details.tag;
    this.asset = details.asset;
    this.expected = details.expected;
    this.observed = details.observed;
  }
}

/**
 * Read and validate the manifest at `manifestPath`. Returns a normalized
 * {@link HashManifest} with all tag entries collected under `versions`.
 *
 * @throws {@link IntegrityError} with code `MANIFEST_NOT_FOUND` if the file
 *   does not exist, or `MANIFEST_MALFORMED` if JSON parsing fails or any
 *   entry violates the schema (bad SHA format, missing required keys, etc.).
 */
export function loadHashManifest(manifestPath: string): HashManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (err) {
    const cause = err as NodeJS.ErrnoException;
    throw new IntegrityError(
      "MANIFEST_NOT_FOUND",
      `Cannot read Godot release hash manifest at ${manifestPath}: ${cause.message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new IntegrityError(
      "MANIFEST_MALFORMED",
      `Manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IntegrityError(
      "MANIFEST_MALFORMED",
      `Manifest at ${manifestPath} must be a JSON object`,
    );
  }

  // Top-level keys are either git tags (e.g. "4.5-stable") or one of the
  // tolerated meta keys ("$schema", "$comment"). Anything else with a
  // tag-shaped key gets validated; meta keys are skipped.
  const versions: Record<string, HashManifestEntry> = {};
  const obj = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("$")) continue;
    // Tag keys look like `4.5-stable`, `4.6.1-stable`, `4.5-rc1`, etc.
    // The schema's regex is permissive; we keep it loose here and rely on
    // the schema file for stricter human review.
    if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?-[a-z0-9]+$/.test(key)) {
      throw new IntegrityError(
        "MANIFEST_MALFORMED",
        `Manifest key '${key}' is not a recognized Godot tag pattern`,
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new IntegrityError(
        "MANIFEST_MALFORMED",
        `Manifest entry for '${key}' must be an object`,
      );
    }
    const entry = value as Record<string, unknown>;
    const godotSha = entry["godot"];
    const docsBranch = entry["godot-docs-branch"];
    const docsSha = entry["godot-docs"];
    if (typeof godotSha !== "string" || !SHA256_PATTERN.test(godotSha)) {
      throw new IntegrityError(
        "MANIFEST_MALFORMED",
        `Manifest entry for '${key}' has invalid 'godot' SHA (must match ${SHA256_PATTERN})`,
      );
    }
    if (typeof docsSha !== "string" || !SHA256_PATTERN.test(docsSha)) {
      throw new IntegrityError(
        "MANIFEST_MALFORMED",
        `Manifest entry for '${key}' has invalid 'godot-docs' SHA (must match ${SHA256_PATTERN})`,
      );
    }
    if (typeof docsBranch !== "string" || docsBranch.length === 0) {
      throw new IntegrityError(
        "MANIFEST_MALFORMED",
        `Manifest entry for '${key}' has missing or empty 'godot-docs-branch'`,
      );
    }
    versions[key] = {
      godot: godotSha,
      "godot-docs-branch": docsBranch,
      "godot-docs": docsSha,
    };
  }

  return { versions };
}

/**
 * Parse the `GODOT_DOCS_TARBALL_HASH_OVERRIDE` env var into a per-asset map.
 *
 * Accepted format: `asset=sha256:HEX[,asset=sha256:HEX]`. Whitespace around
 * commas and `=` is tolerated to be forgiving of shell quoting.
 *
 * @returns A map from asset name to expected SHA. Empty map if the env var
 *   is unset. Throws {@link IntegrityError} on any malformed entry — silent
 *   fallback to manifest would defeat the point of the override.
 */
function parseHashOverride(): Partial<Record<TarballAsset, string>> {
  const raw = process.env.GODOT_DOCS_TARBALL_HASH_OVERRIDE;
  if (!raw) return {};
  const result: Partial<Record<TarballAsset, string>> = {};
  const pairs = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (pairs.length === 0) {
    throw new IntegrityError(
      "OVERRIDE_MALFORMED",
      "GODOT_DOCS_TARBALL_HASH_OVERRIDE is set but empty after trimming",
    );
  }
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new IntegrityError(
        "OVERRIDE_MALFORMED",
        `GODOT_DOCS_TARBALL_HASH_OVERRIDE entry '${pair}' must be of the form 'asset=sha256:HEX'`,
      );
    }
    const asset = pair.slice(0, eq).trim();
    const sha = pair.slice(eq + 1).trim();
    if (asset !== "godot" && asset !== "godot-docs") {
      throw new IntegrityError(
        "OVERRIDE_MALFORMED",
        `GODOT_DOCS_TARBALL_HASH_OVERRIDE asset '${asset}' must be 'godot' or 'godot-docs'`,
      );
    }
    if (!SHA256_PATTERN.test(sha)) {
      throw new IntegrityError(
        "OVERRIDE_MALFORMED",
        `GODOT_DOCS_TARBALL_HASH_OVERRIDE value for '${asset}' must match ${SHA256_PATTERN}`,
      );
    }
    result[asset] = sha;
  }
  return result;
}

/**
 * Arguments to {@link verifyTarballSha}.
 */
export interface VerifyTarballShaArgs {
  /** Raw bytes of the tarball the caller just downloaded. */
  tarball: Buffer;
  /** The git tag the tarball was fetched for (e.g. "4.5-stable"). */
  tag: string;
  /** Which of the two assets is being verified. */
  asset: TarballAsset;
  /** Parsed manifest (typically the result of {@link loadHashManifest}). */
  manifest: HashManifest;
}

/**
 * Verify a downloaded tarball against the hash manifest (or env override).
 *
 * Step 2.5 of DESIGN.md § Ingestion pipeline. Call sites:
 *  - `src/docs/ingest.ts` (#6) after each `codeload.github.com` download
 *  - Auto-republish CI (#11) as part of the gated update workflow
 *
 * @returns {@link VerifyResult} — caller persists `observed` to
 *   `meta.tarball_sha256` regardless of whether the tag was pinned.
 * @throws {@link IntegrityError} on pinned mismatch or override mismatch.
 *   Construction-time configuration errors (malformed override) also throw
 *   from here so the failure surfaces at the same call site.
 */
export function verifyTarballSha(args: VerifyTarballShaArgs): VerifyResult {
  const { tarball, tag, asset, manifest } = args;
  const observed =
    "sha256:" + createHash("sha256").update(tarball).digest("hex");

  // Env override takes precedence over manifest, so users with forks can
  // pin a custom hash without editing the in-repo manifest. Parse-failure
  // here is itself an integrity error: silently falling back to the manifest
  // would let a malformed override mask the user's intent to verify.
  const override = parseHashOverride();
  const overrideSha = override[asset];
  if (overrideSha !== undefined) {
    if (overrideSha !== observed) {
      throw new IntegrityError(
        "TARBALL_SHA_MISMATCH",
        `Tarball SHA-256 mismatch for ${asset}@${tag}: expected ${overrideSha} (from GODOT_DOCS_TARBALL_HASH_OVERRIDE), observed ${observed}`,
        { tag, asset, expected: overrideSha, observed },
      );
    }
    return { observed, pinned: overrideSha, source: "env-override" };
  }

  // Manifest path: look up the tag, then the per-asset key.
  const entry = manifest.versions[tag];
  const manifestSha = entry?.[asset];
  if (manifestSha === undefined) {
    // Unpinned (latest / runtime fetch / partial entry). Caller records the
    // observed SHA in meta.tarball_sha256 so downstream compromise becomes
    // detectable by cross-user / cross-cache comparison.
    return { observed, pinned: undefined, source: "unpinned" };
  }

  if (manifestSha !== observed) {
    throw new IntegrityError(
      "TARBALL_SHA_MISMATCH",
      `Tarball SHA-256 mismatch for ${asset}@${tag}: expected ${manifestSha} (from data/godot-release-hashes.json), observed ${observed}. ` +
        "Either the upstream tag has moved (compromised / re-tagged) or the local manifest is stale. " +
        "If you trust the new tarball, update data/godot-release-hashes.json after manual review.",
      { tag, asset, expected: manifestSha, observed },
    );
  }

  return { observed, pinned: manifestSha, source: "manifest" };
}
