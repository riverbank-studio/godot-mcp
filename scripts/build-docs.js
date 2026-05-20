/* eslint-disable no-undef --
   Node built-ins (`console`, `process`) are legitimately used here; the
   ESLint flat config doesn't yet expose a Node `languageOptions.globals`
   block. Tracked alongside scripts/build.js's identical suppression. */
/**
 * Entry point for `npm run build:docs`.
 *
 * Runs the docs ingestion pipeline against the version named by
 * `GODOT_DOCS_VERSION` (or `4.6` as the default CI target) and writes
 * the resulting DB to `data/docs-stable.db` (or wherever
 * `--output` points).
 *
 * Why a separate script
 * ---------------------
 * `npm run build` produces the TypeScript bundle; the docs DB build is
 * heavier (network + ~30s parse + embed) and shouldn't gate every
 * `npm run build` invocation. CI runs `build:docs` only on releases and
 * on PRs that touch `src/docs/**`.
 *
 * Real-world fetcher
 * ------------------
 * The default `fetcher` here is `fetchTarballWithRetry` from
 * `ingest-defaults.ts`, which uses `node:https` + the retry helper.
 * Tests in `ingest.test.ts` exercise the orchestration with a mock
 * fetcher; this script is the single integration point that hits the
 * real network.
 *
 * Embedder choice
 * ---------------
 * The script defaults to `createStubEmbedder` so the build is fast and
 * works on every CI runner without the `@huggingface/transformers`
 * native dep. Setting `GODOT_DOCS_USE_REAL_EMBEDDER=1` enables the
 * real embedder once it's wired in (issue #6 leaves the real embedder
 * stub-implemented; the BGE-small-en-v1.5 integration is finished in
 * the docs-tools subsystem PRs #14-19 which need real embeddings to
 * exercise hybrid retrieval).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchAndParseVersion } from "../build/docs/ingest.js";
import {
  fetchTarballWithRetry,
  extractClassesFromTarball,
  extractTutorialPagesFromTarball,
} from "../build/docs/ingest-defaults.js";
import { createStubEmbedder } from "../build/docs/embed.js";
import { parseDocsVersion } from "../build/docs/version-manager.js";
import { loadHashManifest } from "../build/docs/integrity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// Parse args. Minimal — no full argv parser.
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const versionRaw = arg("--version", process.env.GODOT_DOCS_VERSION ?? "4.6");
const outputPath = arg(
  "--output",
  path.join(repoRoot, "data", "docs-stable.db"),
);
const thresholdRaw = arg(
  "--threshold",
  process.env.GODOT_DOCS_FAILURE_THRESHOLD_PERCENT ??
    (process.env.CI ? "0" : "5"),
);
const failureThresholdPercent = Number.parseInt(thresholdRaw, 10);
if (!Number.isFinite(failureThresholdPercent)) {
  console.error(`build:docs: invalid --threshold value: ${thresholdRaw}`);
  process.exit(2);
}

// Parse the version. `latest` triggers a Tags API call which we don't
// implement here yet; CI pins to an explicit X.Y for now.
let version;
try {
  version = parseDocsVersion(versionRaw);
} catch (err) {
  console.error(
    `build:docs: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
}
if (version.kind === "stable" || version.kind === "latest") {
  // Build script always works against an explicit version; `stable`
  // means "use the build's current target" which we treat as
  // GODOT_DOCS_VERSION required for build:docs (CI workflow sets it).
  console.error(
    "build:docs: pass --version X.Y (e.g. --version 4.5) or set GODOT_DOCS_VERSION. 'stable' / 'latest' are not yet supported by this script.",
  );
  process.exit(2);
}

// Load the SHA manifest. If the file isn't present (e.g. before #47
// lands), we run with an empty manifest — verifyTarballSha then records
// the observed SHA without asserting against pins.
const manifestPath = path.join(repoRoot, "data", "godot-release-hashes.json");
let manifest = { tags: {} };
if (fs.existsSync(manifestPath)) {
  try {
    manifest = loadHashManifest({
      rawJson: fs.readFileSync(manifestPath, "utf8"),
    });
  } catch (err) {
    console.error(
      `build:docs: failed to load ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
}

const embedder = createStubEmbedder();

console.error(
  `[build:docs] starting ingestion for ${version.major}.${version.minor} → ${outputPath} (threshold=${failureThresholdPercent}%)`,
);

try {
  const report = await fetchAndParseVersion(version, outputPath, {
    manifest,
    fetcher: fetchTarballWithRetry,
    extractClasses: extractClassesFromTarball,
    extractTutorials: extractTutorialPagesFromTarball,
    embedder,
    failureThresholdPercent,
    onStage(stage, details) {
      const suffix = details ? " " + JSON.stringify(details) : "";
      console.error(`[build:docs] ${stage}${suffix}`);
    },
  });

  console.error(
    `[build:docs] done: classes=${report.classes.parsed} (${report.classes.failed} failed), tutorials=${report.tutorials.parsed} (${report.tutorials.failed} failed), durationMs=${report.durationMs}`,
  );
  console.error(`[build:docs] tarball SHA: ${report.tarballSha256}`);
  console.error(`[build:docs] docs tarball SHA: ${report.docsTarballSha256}`);
} catch (err) {
  console.error(
    `[build:docs] FATAL: ${err instanceof Error ? err.message : String(err)}`,
  );
  // Exit-code conventions per DESIGN.md L275: 2 for user error
  // (validation, SHA mismatch), 1 for runtime failure (network).
  const name = err instanceof Error ? err.name : "";
  if (
    name === "VersionParseError" ||
    name === "IntegrityError" ||
    /threshold/.test(err instanceof Error ? err.message : "")
  ) {
    process.exit(2);
  }
  process.exit(1);
}
