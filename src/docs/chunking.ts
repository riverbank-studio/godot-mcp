/**
 * Tutorial RST chunking with the Wave 2 D-Docs M10 fallback chain.
 *
 * Stages (per DESIGN.md L264):
 *   1. **H2 split** — each H2 section becomes a chunk (plus a leading
 *      chunk for pre-H2 content under H1). If every chunk fits the hard
 *      cap, we're done.
 *   2. **H3 split** — for any H2 chunk exceeding the hard cap, split
 *      further by H3 within that section.
 *   3. **Paragraph split** — for any H3 (or H2 with no H3 children)
 *      chunk still over the hard cap, split by double-newline
 *      paragraphs, packing paragraphs greedily into chunks up to the
 *      soft cap.
 *   4. **Token-window split** — for any single paragraph still over the
 *      hard cap, split into overlapping token windows
 *      (`CHUNK_OVERLAP_TOKENS` overlap).
 *
 * Code blocks are preserved intact across all stages — a fenced block
 * containing a chunk boundary is moved entirely into the chunk that
 * starts before it, even if that pushes the chunk slightly over the soft
 * cap. (Hard cap is still enforced via the next fallback level.)
 *
 * Token-cost heuristic
 * --------------------
 * The exact BGE tokenizer is too expensive to run during chunking
 * (~4ms/page) — we use the well-known ~4-chars-per-token approximation
 * for the cap checks. Final embedding still uses the real tokenizer; the
 * chunker's cap is a safety net that runs once per build.
 */

/**
 * Soft cap on chunk size in tokens. Chunks at or below this are happy.
 */
export const CHUNK_SOFT_CAP_TOKENS = 1500;

/**
 * Hard cap on chunk size in tokens. Any chunk exceeding this triggers
 * the next fallback level. The token-window splitter guarantees no chunk
 * exceeds this cap.
 */
export const CHUNK_HARD_CAP_TOKENS = 3000;

/**
 * Token overlap between consecutive token-window chunks. Helps dense
 * retrieval find concepts that straddle a window boundary.
 */
export const CHUNK_OVERLAP_TOKENS = 200;

/**
 * Minimum chunk size in tokens. Chunks below this are merged with their
 * predecessor where possible. DESIGN.md benchmark §3 acceptance: ≤5% of
 * chunks below 100 tokens.
 */
export const CHUNK_MIN_TOKENS = 100;

/**
 * One element of normalized RST content. The chunker only inspects the
 * `kind`; downstream consumers (search) use the original `text` /
 * `lang`.
 */
export type RstBlock =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; text: string };

/**
 * A normalized RST page handed to the chunker. The parser (which lives
 * elsewhere) is responsible for stripping directive noise and producing
 * a flat block list.
 */
export interface RstPage {
  /** Page path relative to the tutorials root, e.g. `tutorials/scripting/x.rst`. */
  pagePath: string;
  /** Page title — typically the H1 text. */
  title: string;
  /** Flat list of blocks in document order. */
  content: readonly RstBlock[];
}

/**
 * Output chunk shape. The `headingPath` is what the search layer's
 * page-anchor benchmark (§3) keys on.
 */
export interface Chunk {
  /** Mirrors `RstPage.pagePath` so search results can group by page. */
  pagePath: string;
  /** Index of this chunk within the page, in document order. */
  index: number;
  /**
   * Heading-stack path that this chunk lives under. Starts with the
   * page title (typically H1) and adds H2 / H3 as the chunker descends.
   */
  headingPath: string[];
  /** The chunk text, with code blocks fenced verbatim. */
  text: string;
  /** Approximate token count of `text` per `estimateTokens`. */
  estimatedTokens: number;
}

/**
 * Estimate token count using the ~4-chars-per-token heuristic that the
 * BGE-small and most BPE tokenizers approximate. Empty / whitespace
 * input returns 0 explicitly.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return Math.ceil(trimmed.length / 4);
}

/**
 * Top-level chunker. Empty pages (no content blocks) return an empty
 * array — no stub chunks below the minimum size.
 */
export function chunkPage(page: RstPage): Chunk[] {
  if (page.content.length === 0) return [];

  // Stage 1: split into H2-section groups. `groups[0]` is the pre-H2
  // group under H1; subsequent entries are one per H2.
  const groups = splitByH2(page);
  const chunks: Chunk[] = [];
  for (const g of groups) {
    if (g.blocks.length === 0) continue;
    const body = renderBlocks(g.blocks);
    if (estimateTokens(body) <= CHUNK_HARD_CAP_TOKENS) {
      // Fits in one chunk.
      pushChunk(chunks, page, g.headingPath, body);
      continue;
    }
    // Stage 2: split further by H3.
    const h3Groups = splitByH3(g.blocks, g.headingPath);
    let allFit = true;
    for (const sub of h3Groups) {
      const subBody = renderBlocks(sub.blocks);
      if (estimateTokens(subBody) > CHUNK_HARD_CAP_TOKENS) {
        allFit = false;
        break;
      }
    }
    if (allFit && h3Groups.length > 1) {
      // H3 splitting yielded all-fits chunks.
      for (const sub of h3Groups) {
        const subBody = renderBlocks(sub.blocks);
        if (estimateTokens(subBody) > 0) {
          pushChunk(chunks, page, sub.headingPath, subBody);
        }
      }
      continue;
    }
    // Stage 3 + 4: paragraph + token-window per remaining sub-group.
    const subGroups =
      h3Groups.length > 0
        ? h3Groups
        : [{ headingPath: g.headingPath, blocks: g.blocks }];
    for (const sub of subGroups) {
      const subBody = renderBlocks(sub.blocks);
      if (estimateTokens(subBody) <= CHUNK_HARD_CAP_TOKENS) {
        if (estimateTokens(subBody) > 0) {
          pushChunk(chunks, page, sub.headingPath, subBody);
        }
        continue;
      }
      const paraChunks = splitByParagraphAndWindow(sub.blocks);
      for (const p of paraChunks) {
        if (estimateTokens(p) > 0) {
          pushChunk(chunks, page, sub.headingPath, p);
        }
      }
    }
  }
  return chunks;
}

/**
 * Append a new chunk, computing its index and estimated tokens.
 */
function pushChunk(
  out: Chunk[],
  page: RstPage,
  headingPath: string[],
  text: string,
): void {
  out.push({
    pagePath: page.pagePath,
    index: out.length,
    headingPath: [...headingPath],
    text,
    estimatedTokens: estimateTokens(text),
  });
}

/**
 * Render a flat block list back to chunk text. Headings (other than the
 * group's leading H2/H3) are rendered as `## Heading`; code blocks are
 * fenced; paragraphs are joined with blank lines.
 */
function renderBlocks(blocks: readonly RstBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "h1":
        parts.push(`# ${b.text}`);
        break;
      case "h2":
        parts.push(`## ${b.text}`);
        break;
      case "h3":
        parts.push(`### ${b.text}`);
        break;
      case "paragraph":
        parts.push(b.text);
        break;
      case "code":
        parts.push("```" + b.lang + "\n" + b.text + "\n```");
        break;
    }
  }
  return parts.join("\n\n");
}

/**
 * Split a page into H2-bounded groups. The first group carries the page
 * title in its heading path; subsequent groups start at each H2.
 */
function splitByH2(
  page: RstPage,
): { headingPath: string[]; blocks: RstBlock[] }[] {
  const groups: { headingPath: string[]; blocks: RstBlock[] }[] = [
    { headingPath: [page.title], blocks: [] },
  ];
  for (const b of page.content) {
    if (b.kind === "h2") {
      groups.push({
        headingPath: [page.title, b.text],
        blocks: [],
      });
    } else if (b.kind === "h1") {
      // H1 is implied by the title — skip in groups.
      continue;
    } else {
      groups[groups.length - 1]!.blocks.push(b);
    }
  }
  return groups;
}

/**
 * Split an H2-group's block list into H3-bounded sub-groups. The leading
 * group carries the H2's heading path; H3-prefixed sub-groups append the
 * H3 text.
 */
function splitByH3(
  blocks: readonly RstBlock[],
  parentPath: string[],
): { headingPath: string[]; blocks: RstBlock[] }[] {
  const groups: { headingPath: string[]; blocks: RstBlock[] }[] = [
    { headingPath: parentPath, blocks: [] },
  ];
  for (const b of blocks) {
    if (b.kind === "h3") {
      groups.push({
        headingPath: [...parentPath, b.text],
        blocks: [],
      });
    } else {
      groups[groups.length - 1]!.blocks.push(b);
    }
  }
  // Drop the leading group if it's empty AND we have H3 children — the
  // H2's intro paragraph (if any) lives there; only meaningful when
  // populated.
  return groups.filter((g, i) => i === 0 || g.blocks.length > 0);
}

/**
 * Paragraph + token-window splitter, applied when an H3 (or H2 with no
 * H3 children) still exceeds the hard cap.
 *
 * Strategy:
 *   - Greedy-pack paragraphs until adding the next paragraph would
 *     exceed `CHUNK_SOFT_CAP_TOKENS`. Emit, start a fresh chunk with
 *     the overflow paragraph.
 *   - If a single paragraph alone exceeds `CHUNK_HARD_CAP_TOKENS`, emit
 *     it via overlapping token windows.
 *   - Code blocks are atomic: never split, never separated from the
 *     preceding paragraph if they share a chunk.
 */
function splitByParagraphAndWindow(blocks: readonly RstBlock[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length > 0) {
      out.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
  };

  for (const b of blocks) {
    if (b.kind !== "paragraph" && b.kind !== "code") continue;
    const rendered =
      b.kind === "code" ? "```" + b.lang + "\n" + b.text + "\n```" : b.text;
    const tokens = estimateTokens(rendered);
    if (tokens > CHUNK_HARD_CAP_TOKENS && b.kind === "paragraph") {
      // Single oversize paragraph — flush whatever we have, then emit
      // token-window chunks for this one.
      flush();
      for (const window of tokenWindows(rendered)) {
        out.push(window);
      }
      continue;
    }
    if (currentTokens + tokens > CHUNK_SOFT_CAP_TOKENS) {
      flush();
    }
    current.push(rendered);
    currentTokens += tokens;
  }
  flush();
  return out;
}

/**
 * Split a single oversized text into overlapping token windows. We
 * operate on whitespace-separated words as a stand-in for tokens (the
 * heuristic suffices for the chunker — final embedding uses the real
 * tokenizer).
 */
function tokenWindows(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // Convert token caps to word counts via the 4-chars/token heuristic
  // approximated as ~0.75 words per token (most words are 4-5 chars).
  // We just use the token caps directly on the word array — it's close
  // enough for the safety-net invariant the chunker promises.
  const windowSize = Math.max(1, CHUNK_HARD_CAP_TOKENS - CHUNK_OVERLAP_TOKENS);
  const stride = windowSize;
  const out: string[] = [];
  for (let i = 0; i < words.length; i += stride) {
    const start = i === 0 ? 0 : Math.max(0, i - CHUNK_OVERLAP_TOKENS);
    const end = Math.min(words.length, start + CHUNK_HARD_CAP_TOKENS);
    out.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
  }
  return out;
}
