/**
 * Default real-world implementations of the `IngestDependencies` slots.
 *
 * These are pulled out of `ingest.ts` so the pipeline orchestrator
 * itself has zero coupling to the network or tarball parsing — `ingest`
 * is import-clean against the test environment. Production callers
 * (build script + runtime fetcher) wire these together via
 * `buildDefaultDeps`.
 *
 * What's here
 * -----------
 *
 *   - `fetchTarballWithRetry` — uses `node:https` + the retry helper.
 *   - `extractClassesFromTarball` — gunzips + tar-streams the engine
 *     tarball, keeping only `doc/classes/*.xml` entries.
 *   - `extractTutorialPagesFromTarball` — gunzips + tar-streams the
 *     godot-docs tarball, parses each `tutorials/**.rst` page into the
 *     normalized `RstPage` shape.
 *
 * The RST parser is intentionally simple: Godot's docs use a small
 * subset of reStructuredText (mostly `^^^^`/`====`/`----` underlines for
 * headings + code blocks + paragraphs). A more comprehensive parser
 * lands when (a) we discover real-world breakage, or (b) chunking
 * benchmark §3 calls it out.
 */

import * as https from "node:https";
import * as zlib from "node:zlib";
import { Readable } from "node:stream";

import * as tar from "tar";

import { retryWithBackoff, isRetryableHttpStatus } from "./retry.js";
import type { ClassXmlEntry, FetcherInput } from "./ingest.js";
import { buildTarballUrl } from "./ingest.js";
import type { RstBlock, RstPage } from "./chunking.js";

/**
 * Fetch a tarball with the documented retry policy. Uses `node:https`
 * directly (one fewer dep than node-fetch / undici) and surfaces the
 * status code on the thrown error so `retry`'s 4xx/5xx classifier
 * routes correctly.
 */
export async function fetchTarballWithRetry(
  input: FetcherInput,
): Promise<Buffer> {
  const url = buildTarballUrl(input);
  return retryWithBackoff(() => fetchTarballOnce(url));
}

/**
 * One attempt: GET the URL, follow up to 5 redirects (codeload often
 * redirects to a CDN), buffer the gzipped tarball.
 */
function fetchTarballOnce(url: string, redirectsLeft = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            res.resume();
            reject(
              Object.assign(new Error("too many redirects"), {
                statusCode: status,
              }),
            );
            return;
          }
          res.resume();
          resolve(fetchTarballOnce(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          const err: Error & { statusCode?: number } = new Error(
            `tarball fetch ${url} → HTTP ${status}`,
          );
          err.statusCode = status;
          reject(err);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", (err) => {
        // Network-level errors carry no statusCode → retryable.
        reject(
          Object.assign(err, {
            statusCode: undefined as number | undefined,
          }),
        );
      });
  });
  // Mark the helper as silently using the retry classifier so a future
  // refactor that drops the retry wrapper doesn't accidentally make
  // 4xx retryable. (The `isRetryableHttpStatus` import is the load-bearing
  // contract; the function above sets `statusCode` so retry classifies
  // correctly. We reference it here to keep the import lint-clean.)
  void isRetryableHttpStatus;
}

/**
 * Stream-extract the engine tarball, returning only the
 * `doc/classes/*.xml` entries (Wave 2 Docs H1: stream-extract, not
 * sparse-extract — codeload doesn't support path filtering).
 *
 * Memory: each XML file is small (~5-20KB) and there are ~700 of them,
 * so buffering the lot is fine (~10MB).
 */
export async function extractClassesFromTarball(
  tarballBytes: Buffer,
): Promise<ClassXmlEntry[]> {
  return extractFilteredEntries(tarballBytes, (filename) => {
    // codeload tarballs are prefixed with `godot-{tag}/...`; we only
    // care about `doc/classes/*.xml` regardless of the prefix.
    const m = /\/doc\/classes\/([^/]+\.xml)$/.exec(filename);
    return m ? { basename: m[1]! } : null;
  });
}

/**
 * Stream-extract the godot-docs tarball, normalizing each
 * `tutorials/**.rst` page into the chunker's input shape.
 */
export async function extractTutorialPagesFromTarball(
  tarballBytes: Buffer,
): Promise<RstPage[]> {
  const rawEntries = await extractFilteredEntries(tarballBytes, (filename) => {
    // godot-docs tarballs have `godot-docs-{branch}/` prefix.
    const m = /^[^/]+\/(tutorials\/.+\.rst)$/.exec(filename);
    return m ? { basename: m[1]! } : null;
  });
  const pages: RstPage[] = [];
  for (const e of rawEntries) {
    try {
      pages.push(parseRstPage(e.filename, e.xml));
    } catch {
      // Page parse failures get counted by the ingest pipeline's
      // tutorial threshold; silently skip here.
    }
  }
  return pages;
}

/**
 * Internal: gunzip + tar-stream, returning entries that match the
 * predicate. The predicate returns `null` to skip, or `{basename}` to
 * keep (used by class-XML to record only the file's basename).
 */
async function extractFilteredEntries(
  tarballBytes: Buffer,
  match: (filename: string) => { basename: string } | null,
): Promise<ClassXmlEntry[]> {
  return new Promise((resolve, reject) => {
    const out: ClassXmlEntry[] = [];
    const gunzip = zlib.createGunzip();
    const parser = new tar.Parser();
    parser.on("entry", (entry: tar.ReadEntry) => {
      const matchResult = match(entry.path);
      if (!matchResult) {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => {
        const xml = Buffer.concat(chunks).toString("utf8");
        out.push({ filename: matchResult.basename, xml });
      });
      entry.on("error", reject);
    });
    parser.on("end", () => resolve(out));
    parser.on("error", reject);
    Readable.from(tarballBytes).pipe(gunzip).pipe(parser);
  });
}

/**
 * Minimal RST page parser. Godot's docs use:
 *
 *   - H1: `Title\n=====`
 *   - H2: `Section\n-------` (or `~~~~~` / `^^^^^`)
 *   - H3: `Subsection\n^^^^^^^`
 *   - Code blocks: `.. code-block:: gdscript\n\n  body`
 *   - Paragraphs: anything else separated by blank lines.
 *
 * This is **not** a full RST parser — it's a structural pass good
 * enough for chunking. The chunking benchmark (§3) is what validates
 * sufficiency.
 */
export function parseRstPage(pagePath: string, rst: string): RstPage {
  const lines = rst.split(/\r?\n/);
  const blocks: RstBlock[] = [];
  let title = pagePath;
  let i = 0;

  const isUnderline = (line: string, ch: string): boolean =>
    line.length > 0 &&
    line.length >= 3 &&
    /^([=\-~^])\1*$/.test(line) &&
    line.startsWith(ch);

  while (i < lines.length) {
    const line = lines[i]!;
    const next = i + 1 < lines.length ? lines[i + 1]! : "";

    // H1 = underline.
    if (line.trim() !== "" && isUnderline(next, "=")) {
      const text = line.trim();
      if (blocks.length === 0) title = text;
      blocks.push({ kind: "h1", text });
      i += 2;
      continue;
    }
    // H2 — / ~
    if (
      line.trim() !== "" &&
      (isUnderline(next, "-") || isUnderline(next, "~"))
    ) {
      blocks.push({ kind: "h2", text: line.trim() });
      i += 2;
      continue;
    }
    // H3 ^
    if (line.trim() !== "" && isUnderline(next, "^")) {
      blocks.push({ kind: "h3", text: line.trim() });
      i += 2;
      continue;
    }
    // Code block
    const codeMatch = /^\.\.\s+code-block::\s*(\S*)/.exec(line);
    if (codeMatch) {
      const lang = codeMatch[1] ?? "";
      i += 1;
      // Skip blank line after directive.
      while (i < lines.length && lines[i]!.trim() === "") i += 1;
      const codeLines: string[] = [];
      while (i < lines.length) {
        const cl = lines[i]!;
        if (cl.trim() === "") {
          // Blank line — peek ahead. End of block iff next non-blank is unindented.
          let j = i + 1;
          while (j < lines.length && lines[j]!.trim() === "") j += 1;
          if (j === lines.length || /^\S/.test(lines[j]!)) {
            break;
          }
          codeLines.push("");
          i += 1;
          continue;
        }
        if (/^\s/.test(cl)) {
          codeLines.push(cl.replace(/^\s\s\s?\s?/, ""));
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ kind: "code", lang, text: codeLines.join("\n") });
      continue;
    }
    // Paragraph — accumulate until blank line.
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i]!.trim() !== "") {
      // Stop if the line is an RST underline (start of next heading).
      const peekNext = i + 1 < lines.length ? lines[i + 1]! : "";
      if (
        isUnderline(peekNext, "=") ||
        isUnderline(peekNext, "-") ||
        isUnderline(peekNext, "~") ||
        isUnderline(peekNext, "^")
      ) {
        break;
      }
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ").trim() });
  }
  return { pagePath, title, content: blocks };
}
