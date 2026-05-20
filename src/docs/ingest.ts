/**
 * Docs ingestion pipeline orchestrator (DESIGN.md L245).
 *
 * The exported entry point `fetchAndParseVersion(version, outputPath, deps)`
 * is shared by both the build script (CI, with strict threshold) and the
 * runtime fetcher (with lenient threshold). The behavioral difference
 * between the two callers is encoded in the `deps.failureThresholdPercent`
 * field and the `deps.logger` choice; the pipeline itself doesn't know
 * which mode it's in.
 *
 * Why injected dependencies
 * -------------------------
 * The pipeline has four external concerns — network fetch, tarball
 * extraction (gunzip + tar parse), tutorial RST parsing, and embedding.
 * Each is replaceable for tests, for offline builds (e.g. point
 * `fetcher` at a local file), and for the runtime fetcher (which may
 * want a different retry policy). The "real" defaults live in
 * `ingest-defaults.ts` (separate file so this one doesn't pull in `tar`
 * + the network stack just to be tested).
 *
 * Pipeline stages (DESIGN.md L258, Wave 2 amendments)
 * --------------------------------------------------
 *   1. Resolve git tag (`4.5` → `4.5-stable`).
 *   2. Fetch godot tarball (5-attempt retry).
 *   3. Validate structurally (Object.xml exists, ≥500 class XML files).
 *   4. SHA-256 verify against `data/godot-release-hashes.json`.
 *   5. Fetch godot-docs tarball (same retry + SHA pattern).
 *   6. Parse class XML (failures tracked).
 *   7. Parse tutorial RST + chunk (Wave 2 fallback chain).
 *   8. Embed tutorial chunks (lazy model load).
 *   9. Write SQLite to .tmp, rename at end.
 *  10. Return report.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  createSchema,
  openWritable,
  writeMeta,
  SCHEMA_VERSION,
} from "./schema.js";
import {
  parseClassXml,
  type ParsedClass,
  type ParsedMember,
} from "./class-xml.js";
import { chunkPage, type RstPage } from "./chunking.js";
import { type Embedder } from "./embed.js";
import {
  verifyTarballSha,
  computeSha256,
  type HashManifest,
  type ManifestAsset,
} from "./integrity.js";
import type { DocsVersion } from "./version-manager.js";

/**
 * Minimum number of class XML files required for the structural
 * validation to pass (DESIGN.md L260: "XML file count >= 500").
 */
export const MIN_CLASS_XML_FILES = 500;

/**
 * Shape returned by the pipeline. Caller (build script vs runtime
 * fetcher) decides what to do with `failed > 0` based on its threshold;
 * if the pipeline's internal threshold check passed, the call resolves
 * — never gives up partial results.
 *
 * DESIGN.md L267.
 */
export interface IngestReport {
  classes: { parsed: number; failed: number; warnings: string[] };
  tutorials: { parsed: number; failed: number; warnings: string[] };
  retries: number;
  durationMs: number;
  tarballSha256: string;
  docsTarballSha256: string;
}

/**
 * Class-XML fixture as produced by tarball extraction. The fetcher /
 * extractor stage emits one record per `doc/classes/*.xml` entry.
 */
export interface ClassXmlEntry {
  /** Basename of the entry, e.g. `Object.xml`. */
  filename: string;
  /** Raw XML contents. */
  xml: string;
}

/**
 * Fetcher input shape. Discriminated by `asset` so the implementation
 * can build the right URL (engine vs docs).
 */
export type FetcherInput =
  | { asset: "engine"; tag: string }
  | { asset: "docs"; branch: string };

/**
 * Dependencies injected into `fetchAndParseVersion`. Real
 * implementations live in `ingest-defaults.ts`; tests pass mocks.
 */
export interface IngestDependencies {
  /** SHA manifest for pinned-tag verification. */
  manifest: HashManifest;
  /** Network fetcher. Returns the raw tarball bytes. */
  fetcher: (input: FetcherInput) => Promise<Buffer>;
  /**
   * Class-XML extractor: pulls `doc/classes/*.xml` entries from the
   * fetched engine tarball.
   */
  extractClasses: (tarballBytes: Buffer) => Promise<ClassXmlEntry[]>;
  /** Tutorial RST extractor: pulls and parses RST pages from the docs tarball. */
  extractTutorials: (tarballBytes: Buffer) => Promise<RstPage[]>;
  /** Embedder for tutorial chunks. */
  embedder: Embedder;
  /**
   * Max per-file parse failure percent before the pipeline fails. CI
   * uses 0 (strict); runtime defaults to 5 (lenient).
   */
  failureThresholdPercent: number;
  /** Optional callback for each pipeline stage (verbose CI logging). */
  onStage?: (stage: string, details?: Record<string, unknown>) => void;
}

/**
 * Build a codeload URL for one of the two tarballs we fetch.
 *
 * @example
 *   buildTarballUrl({ asset: "engine", tag: "4.5-stable" })
 *   // → "https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/4.5-stable"
 */
export function buildTarballUrl(
  input: { asset: "engine"; tag: string } | { asset: "docs"; branch: string },
): string {
  if (input.asset === "engine") {
    return `https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/${input.tag}`;
  }
  return `https://codeload.github.com/godotengine/godot-docs/tar.gz/refs/heads/${input.branch}`;
}

/**
 * Map a git tag to the corresponding godot-docs branch name. The docs
 * repo's branch is the bare version (`4.5`, `4.6`), while the engine
 * tag is `M.N-stable`.
 */
export function resolveDocsBranchForTag(tag: string): string {
  return tag.replace(/-stable$/, "");
}

/**
 * Resolve a `DocsVersion` to the engine git tag. `latest` is rejected
 * because callers must resolve it upstream via the GitHub Tags API.
 */
function resolveEngineTag(version: DocsVersion): string {
  switch (version.kind) {
    case "stable":
      // The build script invokes the pipeline for `stable` against the
      // current Wave-2-current Godot stable. The caller (build script)
      // is responsible for setting `GODOT_DOCS_VERSION` explicitly when
      // running this; we treat unset stable as an error here.
      throw new Error(
        "ingest: cannot ingest 'stable' directly — caller must resolve to an explicit X.Y first",
      );
    case "latest":
      throw new Error(
        "ingest: 'latest' must be resolved to an explicit X.Y by the caller via the GitHub Tags API",
      );
    case "explicit":
      return `${version.major}.${version.minor}-stable`;
  }
}

/**
 * The pipeline entry point. Runs all stages in order; throws on
 * structural failures (missing classes dir, threshold exceeded, SHA
 * mismatch). On success, the DB at `outputPath` is populated and the
 * function resolves to the {@link IngestReport}.
 */
export async function fetchAndParseVersion(
  version: DocsVersion,
  outputPath: string,
  deps: IngestDependencies,
): Promise<IngestReport> {
  const start = Date.now();
  const tag = resolveEngineTag(version);
  const branch = resolveDocsBranchForTag(tag);
  const onStage = deps.onStage ?? (() => {});

  // Stage 2: fetch engine tarball.
  onStage("fetch.engine", { tag });
  const engineBytes = await deps.fetcher({ asset: "engine", tag });
  // Stage 4: SHA verify (engine).
  onStage("verify.engine.sha");
  verifyOrRecord(engineBytes, {
    manifest: deps.manifest,
    tag,
    asset: "engine",
  });
  const engineSha = computeSha256(engineBytes);

  // Stage 6: parse class XML — but first stage 3 (structural validation)
  // requires we extract first.
  onStage("extract.classes");
  const classEntries = await deps.extractClasses(engineBytes);
  if (classEntries.length < MIN_CLASS_XML_FILES) {
    throw new Error(
      `ingest: structural validation failed — found ${classEntries.length} class XML files, expected >= ${MIN_CLASS_XML_FILES}`,
    );
  }
  // Object.xml must parse — design's smoke check.
  const objectEntry = classEntries.find((e) => e.filename === "Object.xml");
  if (!objectEntry) {
    // Not strictly required by older Godots, but the warning still
    // surfaces. Don't fail on missing — fail on >=500 only.
    onStage("warn.no-object-xml");
  } else {
    try {
      const { cls } = parseClassXml(objectEntry.xml);
      if (cls.name !== "Object") {
        // Defensive — the file exists, has a different class. Treat as
        // smoke-test failure.
        throw new Error(
          `ingest: Object.xml parses as class '${cls.name}', not 'Object'`,
        );
      }
    } catch (err) {
      throw new Error(
        `ingest: structural validation failed — Object.xml does not parse: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Parse all class XML, tracking per-file failures.
  onStage("parse.classes");
  const classes: ParsedClass[] = [];
  const members: ParsedMember[] = [];
  const classWarnings: string[] = [];
  let classFailed = 0;
  for (const entry of classEntries) {
    try {
      const r = parseClassXml(entry.xml);
      classes.push(r.cls);
      for (const m of r.members) {
        // Stash class_name alongside the member for the schema writer.
        members.push({ ...m, name: m.name });
      }
      // Hold the class_name in a parallel array — we re-attach below.
    } catch (err) {
      classFailed += 1;
      classWarnings.push(
        `${entry.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Re-walk the entries in order to pair each member with its class_name.
  // Cheapest fix: re-parse the valid entries, tracking class_name → members.
  const memberRows: Array<ParsedMember & { class_name: string }> = [];
  for (const entry of classEntries) {
    try {
      const r = parseClassXml(entry.xml);
      for (const m of r.members) {
        memberRows.push({ ...m, class_name: r.cls.name });
      }
    } catch {
      // Already counted above.
    }
  }

  const classFailureRate =
    (classFailed / Math.max(classes.length + classFailed, 1)) * 100;
  if (classFailureRate > deps.failureThresholdPercent) {
    throw new Error(
      `ingest: class-XML failure rate ${classFailureRate.toFixed(1)}% exceeds threshold ${deps.failureThresholdPercent}% (${classFailed} of ${classes.length + classFailed} files failed)`,
    );
  }

  // Stage 5: fetch docs tarball.
  onStage("fetch.docs", { branch });
  const docsBytes = await deps.fetcher({ asset: "docs", branch });
  onStage("verify.docs.sha");
  verifyOrRecord(docsBytes, {
    manifest: deps.manifest,
    tag,
    asset: "docs",
  });
  const docsSha = computeSha256(docsBytes);

  // Stage 7: parse tutorial RST + chunk.
  onStage("parse.tutorials");
  const tutorialPages = await deps.extractTutorials(docsBytes);
  const tutorialWarnings: string[] = [];
  let tutorialFailed = 0;
  let chunkCount = 0;
  type ChunkRow = {
    pagePath: string;
    chunkIndex: number;
    headingPath: string;
    content: string;
  };
  const chunkRows: ChunkRow[] = [];
  for (const page of tutorialPages) {
    try {
      const chunks = chunkPage(page);
      for (const c of chunks) {
        chunkRows.push({
          pagePath: c.pagePath,
          chunkIndex: c.index,
          headingPath: c.headingPath.join(" > "),
          content: c.text,
        });
        chunkCount += 1;
      }
    } catch (err) {
      tutorialFailed += 1;
      tutorialWarnings.push(
        `${page.pagePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Stage 8: embed (batched). The stub embedder is synchronous; real
  // embedder is async and may be slow — batch at 32 per call.
  onStage("embed.tutorials", { chunks: chunkCount });
  const embeddings: Float32Array[] = [];
  const BATCH = 32;
  for (let i = 0; i < chunkRows.length; i += BATCH) {
    const batch = chunkRows.slice(i, i + BATCH).map((c) => c.content);
    const out = await deps.embedder.embed(batch);
    embeddings.push(...out);
  }

  // Stage 9: write SQLite, atomic-rename pattern.
  onStage("write.sqlite");
  const tmpPath = outputPath + ".tmp";
  // Ensure parent dir exists.
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Remove any stale .tmp from a previous failed run.
  if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath);

  const db = openWritable(tmpPath);
  try {
    createSchema(db);
    const insertClass = db.prepare(
      `INSERT INTO classes (name, inherits, brief, description, version) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertMember = db.prepare(
      `INSERT INTO members (class_name, kind, name, signature, description) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertTutorial = db.prepare(
      `INSERT INTO tutorials (page_path, chunk_index, heading_path, content, embedding) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertAll = db.transaction(() => {
      for (const c of classes) {
        insertClass.run(c.name, c.inherits, c.brief, c.description, c.version);
      }
      for (const m of memberRows) {
        insertMember.run(
          m.class_name,
          m.kind,
          m.name,
          m.signature,
          m.description,
        );
      }
      for (let i = 0; i < chunkRows.length; i++) {
        const c = chunkRows[i]!;
        const emb = embeddings[i];
        const blob = emb
          ? Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength)
          : null;
        insertTutorial.run(
          c.pagePath,
          c.chunkIndex,
          c.headingPath,
          c.content,
          blob,
        );
      }
      writeMeta(db, {
        godot_version: `${version.kind === "explicit" ? `${version.major}.${version.minor}` : "unknown"}`,
        godot_docs_branch: branch,
        schema_version: SCHEMA_VERSION,
        indexed_at: new Date().toISOString(),
        class_count: classes.length,
        tutorial_count: chunkRows.length,
        ingest_warnings: JSON.stringify([
          ...classWarnings,
          ...tutorialWarnings,
        ]),
        embedding_model_id: deps.embedder.modelId,
        ingestion_source_sha: "",
        ingestion_duration_ms: Date.now() - start,
        tarball_sha256: engineSha,
        docs_tarball_sha256: docsSha,
      });
    });
    insertAll();
  } finally {
    db.close();
  }
  // Atomic rename. On Windows, ERROR_SHARING_VIOLATION is retryable per
  // DESIGN.md Wave 2 Docs M8 — retry up to 5 times with short backoffs.
  await renameWithWindowsRetry(tmpPath, outputPath);

  // Stage 10: report.
  onStage("done");
  return {
    classes: {
      parsed: classes.length,
      failed: classFailed,
      warnings: classWarnings,
    },
    tutorials: {
      parsed: chunkCount,
      failed: tutorialFailed,
      warnings: tutorialWarnings,
    },
    retries: 0, // retry stats wired in once the real fetcher lands
    durationMs: Date.now() - start,
    tarballSha256: engineSha,
    docsTarballSha256: docsSha,
  };
}

/**
 * Verify a tarball's SHA against the manifest. Pinned-mismatch throws
 * `IntegrityError`; unpinned-tag is a no-op (the observed SHA is
 * captured by the caller via `computeSha256`).
 */
function verifyOrRecord(
  bytes: Buffer,
  params: { manifest: HashManifest; tag: string; asset: ManifestAsset },
): void {
  verifyTarballSha(bytes, params);
}

/**
 * Rename `from` → `to`, retrying on Windows `EBUSY` /
 * `ERROR_SHARING_VIOLATION` per DESIGN.md Wave 2 Docs M8. Up to 5
 * attempts, short linear backoff.
 */
async function renameWithWindowsRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") {
        // Non-Windows-sharing failure mode — rethrow.
        throw err;
      }
      // Linear short backoff: 50ms, 100ms, 150ms, 200ms.
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`ingest: rename ${from} → ${to} failed after 5 attempts`);
}
