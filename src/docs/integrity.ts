/**
 * SHA-256 verification of fetched tarballs against the pinned manifest at
 * `data/godot-release-hashes.json` (DESIGN.md Wave 2 D14, supply-chain
 * seat finding H1).
 *
 * Two modes:
 *
 *   - **Pinned tag** (entry exists in manifest): mismatch is a hard fail
 *     mapped to exit code 2 at the top level.
 *   - **Unpinned tag** (no manifest entry — e.g. a freshly resolved
 *     `latest` before the manifest is updated): observed SHA is recorded
 *     in `meta.tarball_sha256` for downstream comparison; no error.
 *
 * Relationship to PR #47 / branch `chore/47-tarball-sha`
 * -----------------------------------------------------
 * #47 ships a more complete `src/docs/integrity.ts` with the override
 * env var (`GODOT_DOCS_TARBALL_HASH_OVERRIDE`) and the schema-validated
 * manifest loader. This file's shape mirrors that PR's public surface
 * (`verifyTarballSha`, `loadHashManifest`, `IntegrityError`,
 * `computeSha256`) so when #47 merges to main the call site in
 * `ingest.ts` is import-only-changed. The branch divergence is
 * acknowledged in the issue body (#6 → "Related: #47").
 *
 * What this file does not do
 * --------------------------
 * - No file I/O. Callers pass `rawJson` or a pre-parsed manifest. The
 *   build script reads the file from disk; tests pass a fixture record.
 * - No env-var parsing. The override hook will be added by #47.
 */

import * as crypto from "node:crypto";

/**
 * Top-level shape of `data/godot-release-hashes.json`. Schema is kept
 * minimal here; #47's `data/godot-release-hashes.schema.json` carries the
 * authoritative JSON Schema.
 *
 * Each tag maps to an `engine` and/or `docs` entry, each carrying a
 * SHA-256 hex digest. A tag with only one asset (e.g. observed-only
 * engine, unpinned docs) is permitted — verification falls through to
 * the unpinned path for any asset not present in the manifest.
 */
export interface HashManifest {
  tags: Record<string, ManifestTagEntry>;
}

/**
 * Per-tag entry. Both `engine` and `docs` are optional so partial
 * manifests are accepted without ceremony.
 */
export interface ManifestTagEntry {
  engine?: ManifestAssetEntry;
  docs?: ManifestAssetEntry;
}

/**
 * One pinned asset. The `sha256` field is a lowercase 64-character hex
 * digest; the validator rejects anything else with a clear message so a
 * fat-fingered manifest update is caught at parse time.
 */
export interface ManifestAssetEntry {
  sha256: string;
}

/**
 * Asset discriminator. The pipeline fetches two tarballs (godot engine
 * and godot-docs) so the union has two values.
 */
export type ManifestAsset = "engine" | "docs";

/**
 * Sentinel thrown on a pinned-manifest mismatch. Maps to exit code 2 at
 * the top level (user-error class: either a compromised tag or a stale
 * manifest — both require operator action).
 */
export class IntegrityError extends Error {
  /** The git tag whose pin failed. */
  readonly tag: string;
  /** Which asset (engine vs docs). */
  readonly asset: ManifestAsset;
  /** SHA-256 from the manifest. */
  readonly expected: string;
  /** SHA-256 actually computed from the bytes. */
  readonly actual: string;

  constructor(params: {
    tag: string;
    asset: ManifestAsset;
    expected: string;
    actual: string;
  }) {
    super(
      `SHA-256 mismatch for ${params.tag} ${params.asset}: expected ${params.expected}, got ${params.actual}. ` +
        `Either the manifest in data/godot-release-hashes.json is stale or the tarball was tampered with — refusing to ingest. ` +
        `See docs/supply-chain.md for the update procedure.`,
    );
    this.name = "IntegrityError";
    this.tag = params.tag;
    this.asset = params.asset;
    this.expected = params.expected;
    this.actual = params.actual;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IntegrityError);
    }
  }
}

/**
 * Compute the SHA-256 digest of a buffer as a lowercase 64-char hex
 * string. Trivial helper, exported so callers (and tests) don't have to
 * re-import `node:crypto` everywhere.
 */
export function computeSha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Result of a verification attempt:
 *
 *   - `verified=true, pinned=true`: SHA matched a manifest entry.
 *   - `verified=false, pinned=false`: no manifest entry; observed SHA
 *     returned for `meta.tarball_sha256` recording.
 *   - `verified=false, pinned=true`: never returned — that case throws
 *     `IntegrityError` instead.
 */
export interface VerificationResult {
  /** True iff the SHA matched a manifest pin. */
  verified: boolean;
  /** True iff there was a manifest entry to compare against. */
  pinned: boolean;
  /** The actual computed SHA. Always populated. */
  sha256: string;
}

/**
 * Verify a tarball's SHA-256 against the manifest. Throws
 * `IntegrityError` on mismatch; returns the observed digest otherwise.
 *
 * @param data Raw tarball bytes.
 * @param params Manifest, the git tag (e.g. `4.5-stable`), and which
 *   asset to verify against (`engine` vs `docs`).
 */
export function verifyTarballSha(
  data: Buffer,
  params: { manifest: HashManifest; tag: string; asset: ManifestAsset },
): VerificationResult {
  const actual = computeSha256(data);
  const entry = params.manifest.tags[params.tag]?.[params.asset];
  if (!entry) {
    return { verified: false, pinned: false, sha256: actual };
  }
  if (entry.sha256.toLowerCase() !== actual) {
    throw new IntegrityError({
      tag: params.tag,
      asset: params.asset,
      expected: entry.sha256.toLowerCase(),
      actual,
    });
  }
  return { verified: true, pinned: true, sha256: actual };
}

/**
 * Parse a raw JSON string into a `HashManifest`. Validates structural
 * shape and rejects malformed SHA strings up front so a typo in the
 * manifest fails at load time rather than at verification time.
 *
 * The mirror function in #47 also accepts a file path; this minimal
 * version takes only the raw JSON so it has zero I/O surface. The build
 * script reads the file with `fs.readFileSync` and passes the result.
 */
export function loadHashManifest(input: { rawJson: string }): HashManifest {
  const parsed: unknown = JSON.parse(input.rawJson);
  if (!isObject(parsed)) {
    throw new Error("hash-manifest: top-level value must be a JSON object");
  }
  if (!("tags" in parsed) || !isObject(parsed.tags)) {
    throw new Error("hash-manifest: missing or non-object 'tags' field");
  }
  const out: HashManifest = { tags: {} };
  for (const [tag, rawEntry] of Object.entries(parsed.tags)) {
    if (!isObject(rawEntry)) {
      throw new Error(`hash-manifest: tag '${tag}' must map to an object`);
    }
    const entry: ManifestTagEntry = {};
    if ("engine" in rawEntry) {
      entry.engine = parseAssetEntry(rawEntry.engine, tag, "engine");
    }
    if ("docs" in rawEntry) {
      entry.docs = parseAssetEntry(rawEntry.docs, tag, "docs");
    }
    out.tags[tag] = entry;
  }
  return out;
}

/**
 * Validate one asset record. Pulls the SHA out, normalizes to lowercase,
 * and enforces the 64-hex-char invariant. Anything else throws.
 */
function parseAssetEntry(
  raw: unknown,
  tag: string,
  asset: ManifestAsset,
): ManifestAssetEntry {
  if (!isObject(raw) || typeof raw.sha256 !== "string") {
    throw new Error(
      `hash-manifest: tag '${tag}' asset '${asset}': missing or non-string sha256 field`,
    );
  }
  const sha = raw.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(
      `hash-manifest: tag '${tag}' asset '${asset}': sha256 must be a 64-char hex string, got '${raw.sha256}'`,
    );
  }
  return { sha256: sha };
}

/**
 * Narrow `unknown` to `Record<string, unknown>`. Local helper — the
 * codebase has several of these; we keep this one private to avoid
 * coupling integrity to a shared utils module.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
