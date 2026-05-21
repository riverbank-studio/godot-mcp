/**
 * Advisory-write helpers for the v1 `godot_preview_rename` tool (#27) and
 * the v1.1 code-action tools that are deferred upstream (#28/#29 — see
 * issue #10 for the deferral rationale).
 *
 * "Advisory" means the MCP tool **computes** the edits an operation would
 * make and returns them to the agent for application via the agent's
 * native edit tools (Claude Code's `Edit`, `Write`, etc.). The MCP itself
 * never touches the user's files. This preserves Claude Code's
 * checkpoint/rewind flow and keeps the agent in control of when (and
 * whether) to apply the proposed change. DESIGN.md § "Write operations:
 * advisory pattern" is the spec; the rest of this file header is the
 * implementation-side gloss.
 *
 * The output shape is generalized via a top-level `action: { kind, ... }`
 * envelope so the v1.1 code-action tools can reuse the response shape
 * verbatim — only the discriminator and the action-specific payload
 * change. Per #10 (D25):
 *
 *   {
 *     "action": { "kind": "rename", "from": "old", "to": "new" },
 *     "edits": [
 *       {
 *         "file": "scripts/player.gd",
 *         "changes": [
 *           {
 *             "line": 23,
 *             "before": "func old(x):",
 *             "after": "func new(x):"
 *           }
 *         ]
 *       }
 *     ],
 *     "summary": { "files": 1, "locations": 1 }
 *   }
 *
 * The MCP tool gets an LSP `WorkspaceEdit` back from Godot's LSP and
 * passes it through {@link workspaceEditToAdvisory} to produce the shape
 * above. The conversion bakes in two correctness rules from DESIGN.md
 * L483-L484:
 *
 *   1. **`before` widening for `str_replace` uniqueness.** A natural
 *      line-level `before` string may match multiple lines in the file
 *      (think: `pass`, `var x = 0`, blank lines around a func). When the
 *      agent feeds that to `str_replace`, the call fails ambiguously. We
 *      pre-widen the `before` by including preceding non-blank lines until
 *      the `(before, after)` pair is unique within the file, capped at 5
 *      lines of widening. If still ambiguous, we fall back to LSP-native
 *      range coordinates and set `widened: false` on the change record so
 *      the agent can branch on the shape. See {@link widenBefore}.
 *
 *   2. **Same-line multi-edit merge.** A rename like
 *      `var x = old_name(old_name(1))` produces two LSP `TextEdit`s with
 *      disjoint ranges on the same line. The per-line `(before, after)`
 *      shape can't express two edits, so we merge them: `before` is the
 *      full original line; `after` is the line with both edits applied.
 *      See {@link mergeSameLineEdits}.
 *
 * Both rules are exercised by tests in `advisory-write.test.ts`. The
 * acceptance criteria on issue #10 explicitly call out a same-line
 * `var x = old_name(old_name(1))` fixture.
 *
 * The file content the helpers reason against is read **synchronously**
 * from a caller-supplied `readFile(uri)` callback rather than via direct
 * `fs.readFile`. Two reasons:
 *
 *   - The tool layer already has the file contents on hand: either from
 *     `DocumentTracker.contentFor(uri)` (which serves cached
 *     just-`didOpen`ed bytes) or from a fresh disk read it kicked off as
 *     part of the in-project guard. Re-reading here would double the I/O.
 *   - It makes the helpers trivial to unit-test — the test supplies a
 *     `Map<string, string>` and verifies the conversion without touching
 *     a real disk or LSP server.
 *
 * No LSP knowledge beyond the `WorkspaceEdit` JSON shape lives here. The
 * helpers do not import {@link LspClient}; the tool's handler calls
 * `client.request("textDocument/rename", ...)`, hands the result to
 * {@link workspaceEditToAdvisory}, and shapes the final envelope.
 */

import type { LspPosition, LspRange } from "./tool-helpers.js";

// ---------------------------------------------------------------------------
// LSP WorkspaceEdit shape (locally defined — we don't depend on
// `vscode-languageserver-types`)
// ---------------------------------------------------------------------------

/**
 * One LSP `TextEdit` — a range to replace and the replacement text.
 * Mirrors the LSP spec; declared locally so this file doesn't pick up a
 * `vscode-languageserver-types` dep just for two interfaces.
 */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/**
 * The subset of LSP's `WorkspaceEdit` we care about: the `changes` map
 * keyed by file URI. Godot's LSP returns this shape for `textDocument/rename`
 * (it doesn't use `documentChanges`, which would carry version info).
 *
 * If a future Godot release starts emitting `documentChanges`, extend
 * this interface and add a normalization step at the top of
 * {@link workspaceEditToAdvisory}; the rest of the pipeline operates on
 * `(uri, TextEdit[])` pairs.
 */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
}

// ---------------------------------------------------------------------------
// Public response shape (DESIGN.md § "Write operations: advisory pattern")
// ---------------------------------------------------------------------------

/**
 * The top-level `action` discriminator. v1 only emits `kind: "rename"`;
 * the v1.1 code-action tools will add `kind: "code_action"` (and any
 * other kinds the LSP exposes) without changing the response envelope.
 *
 * Declared as a discriminated union so TypeScript can narrow callers on
 * `action.kind`. Extra kinds extend the union here; the helpers in this
 * file don't read the action at all (it's passed through verbatim).
 */
export type AdvisoryAction =
  | { kind: "rename"; from: string; to: string }
  | { kind: "code_action"; title: string; [key: string]: unknown };

/**
 * Per-line change record in the advisory response.
 *
 * Two variants:
 *   - **Line-level** (the common case): `line`, `before`, `after`. When
 *     `widened` is `true`, `before` includes one or more preceding
 *     non-blank lines so it matches uniquely; the agent feeds the whole
 *     `before` to `str_replace` as the haystack.
 *   - **Range-fallback**: when widening can't make `before` unique within
 *     5 lines, we drop to LSP coordinates: `range` carries 0-based LSP
 *     positions, `newText` carries the replacement, and `widened` is
 *     `false`. The agent applies these via a structural edit rather than
 *     `str_replace`.
 *
 * Per DESIGN.md L483: "The agent should be able to consume either shape
 * without an error-recovery branch." Both variants are present in the
 * same response array; the agent branches on whether `range` is set.
 */
export type AdvisoryChange =
  | {
      /** 1-based line number of the topmost line covered by `before`. */
      line: number;
      /**
       * The original text the agent feeds to `str_replace` as the
       * haystack. Equals the original line when `widened` is `false`;
       * equals `<preceding lines>\n<original line>` when `widened` is
       * `true`.
       */
      before: string;
      /**
       * The replacement text. Same line count as `before` — only the
       * trailing line carries the edited content; preceding widening
       * lines are reproduced verbatim.
       */
      after: string;
      /**
       * `true` when `before` was widened past the natural single line to
       * achieve uniqueness; `false` when the natural single line was
       * already unique. Always present on the line-level variant so the
       * agent can branch without `undefined` checks.
       */
      widened: boolean;
    }
  | {
      /** 1-based line number — convenience for grouping in the UI. */
      line: number;
      /** 0-based LSP range, half-open `[start, end)`. */
      range: LspRange;
      /** The replacement text. */
      newText: string;
      /** Always `false` on the range-fallback variant. */
      widened: false;
    };

/**
 * Per-file group of changes in the advisory response.
 */
export interface AdvisoryEdit {
  /**
   * Forward-slash filesystem path relative to the project root (or
   * absolute if the URI resolves outside the root, though tools should
   * have rejected that earlier via {@link validateFileInProject}).
   */
  file: string;
  /** One change per affected line, ordered by ascending `line`. */
  changes: AdvisoryChange[];
}

/**
 * The summary block. Helps the agent decide whether to confirm with the
 * user before applying (e.g. "this rename touches 47 files — sure?").
 */
export interface AdvisorySummary {
  /** Number of files in `edits`. */
  files: number;
  /** Total count of change records across all files. */
  locations: number;
}

/**
 * The full advisory-write response envelope. Tools wrap this in their
 * `ToolResponse` JSON via `JSON.stringify`.
 */
export interface AdvisoryWriteResponse {
  action: AdvisoryAction;
  edits: AdvisoryEdit[];
  summary: AdvisorySummary;
}

// ---------------------------------------------------------------------------
// Same-line multi-edit merge
// ---------------------------------------------------------------------------

/**
 * Apply a set of disjoint LSP `TextEdit`s to a single line of text,
 * returning the post-edit line. The edits MUST all reference the same
 * line (caller's responsibility — `workspaceEditToAdvisory` partitions
 * by line before calling this). Multi-line edits are not supported here;
 * those go through the range-fallback branch.
 *
 * Order-independence: the function sorts edits by `start.character`
 * descending and applies them right-to-left so earlier edits don't
 * invalidate later edits' character offsets. Overlapping edits throw —
 * the LSP spec disallows them, and a server that violates it would
 * silently produce garbage if we tried to "be helpful".
 *
 * @param lineText - The original line content (no trailing newline).
 * @param edits - All `TextEdit`s touching this line, in any order. Each
 *   edit's `range.start.line` and `range.end.line` must equal the
 *   line's 0-based index.
 * @returns The line text after applying every edit.
 */
export function mergeSameLineEdits(
  lineText: string,
  edits: readonly LspTextEdit[],
): string {
  if (edits.length === 0) return lineText;
  // Sort descending by start character so we splice from the right; this
  // keeps earlier (smaller-offset) ranges' indices valid while we work.
  const sorted = [...edits].sort(
    (a, b) => b.range.start.character - a.range.start.character,
  );
  // Disjointness check: after the sort, each edit's `end.character` must
  // be `<=` the previous edit's `start.character`. If not, the server
  // sent overlapping edits — surface the failure rather than guessing.
  for (let i = 1; i < sorted.length; i++) {
    const later = sorted[i - 1];
    const earlier = sorted[i];
    if (earlier.range.end.character > later.range.start.character) {
      throw new Error(
        `Overlapping LSP TextEdits on the same line: ` +
          `[${String(earlier.range.start.character)}, ${String(earlier.range.end.character)}) ` +
          `and [${String(later.range.start.character)}, ${String(later.range.end.character)})`,
      );
    }
  }
  let out = lineText;
  for (const edit of sorted) {
    const start = edit.range.start.character;
    const end = edit.range.end.character;
    out = out.slice(0, start) + edit.newText + out.slice(end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// `before` widening for str_replace uniqueness
// ---------------------------------------------------------------------------

/**
 * Maximum number of preceding non-blank lines to prepend to a non-unique
 * `before` string before giving up and falling back to LSP-native range
 * coordinates. DESIGN.md L483: "up to 5 lines of widening".
 */
export const MAX_WIDEN_LINES = 5;

/**
 * The result of {@link widenBefore}. Discriminated on `kind`:
 *
 *   - `unique` — the `(before, after)` pair matches `fileText` exactly
 *     once. `widened` is `true` iff one or more preceding lines were
 *     prepended.
 *   - `ambiguous` — even after {@link MAX_WIDEN_LINES} preceding lines
 *     the pair still matches more than once. The caller should fall back
 *     to range-coordinate output.
 */
export type WidenResult =
  | { kind: "unique"; before: string; after: string; widened: boolean }
  | { kind: "ambiguous" };

/**
 * Walk up the file from `lineIdx` until the `(before, after)` pair
 * matches exactly once. Stops after {@link MAX_WIDEN_LINES} of widening.
 *
 * Widening prepends **non-blank** preceding lines only — blank lines are
 * skipped over when picking the next line to add, because including a
 * blank line rarely helps disambiguate (you typically have many blank
 * lines repeated verbatim in any reasonably-sized file). The blank lines
 * themselves are included in the eventually-prepended block so the
 * resulting `before` is byte-identical to a substring of the file.
 *
 * @param lines - The file split on `\n`. Trailing-newline semantics: if
 *   the file ends with a newline, `lines.at(-1)` is `""`. The caller
 *   produces this via `fileText.split("\n")`.
 * @param lineIdx - 0-based index of the change line.
 * @param fileText - The raw file content. Used for uniqueness checks
 *   (`indexOf` / `lastIndexOf`); we don't reconstruct from `lines`
 *   because that would have to re-join and could disagree on trailing
 *   newlines.
 * @param naturalBefore - The single-line `before` (i.e. `lines[lineIdx]`).
 * @param naturalAfter - The single-line `after` (post-edit `lines[lineIdx]`).
 */
export function widenBefore(
  lines: readonly string[],
  lineIdx: number,
  fileText: string,
  naturalBefore: string,
  naturalAfter: string,
): WidenResult {
  // Tight first-pass: is the natural single line already unique?
  if (isUnique(fileText, naturalBefore)) {
    return {
      kind: "unique",
      before: naturalBefore,
      after: naturalAfter,
      widened: false,
    };
  }
  // Walk upward. Each iteration adds the next preceding line to the
  // `before` prefix (whether blank or not). Loop counts only non-blank
  // additions toward MAX_WIDEN_LINES so a file with many blank lines
  // doesn't exhaust the budget on whitespace.
  let nonBlankAdded = 0;
  let cursor = lineIdx - 1;
  let beforePrefix = "";
  let afterPrefix = "";
  while (cursor >= 0 && nonBlankAdded < MAX_WIDEN_LINES) {
    const prependLine = lines[cursor];
    // Prepend the line plus the joining newline.
    beforePrefix = prependLine + "\n" + beforePrefix;
    afterPrefix = prependLine + "\n" + afterPrefix;
    if (prependLine.trim() !== "") {
      nonBlankAdded++;
      // Only check uniqueness on a non-blank addition. Adding a blank
      // line alone never helps and would waste an indexOf scan.
      const candidate = beforePrefix + naturalBefore;
      if (isUnique(fileText, candidate)) {
        return {
          kind: "unique",
          before: candidate,
          after: afterPrefix + naturalAfter,
          widened: true,
        };
      }
    }
    cursor--;
  }
  // Hit the top of the file (cursor < 0) or maxed out — either way we
  // can't disambiguate via widening alone.
  return { kind: "ambiguous" };
}

/**
 * Is `needle` a unique substring of `haystack`? Implemented via two
 * `indexOf` calls rather than a regex to avoid escaping concerns when
 * `needle` contains regex metacharacters (very common in code: `()`,
 * `[]`, `.`, etc.).
 */
function isUnique(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  const first = haystack.indexOf(needle);
  if (first === -1) return false;
  return haystack.indexOf(needle, first + 1) === -1;
}

// ---------------------------------------------------------------------------
// WorkspaceEdit → AdvisoryWriteResponse
// ---------------------------------------------------------------------------

/**
 * Options for {@link workspaceEditToAdvisory}.
 */
export interface WorkspaceEditToAdvisoryOptions {
  /** The top-level action envelope to embed in the response. */
  action: AdvisoryAction;
  /**
   * Synchronous file-content lookup keyed by URI. The tool layer feeds
   * this either from the {@link DocumentTracker} cache or from a fresh
   * disk read. Missing URIs throw — the tool should have validated each
   * URI exists before calling this helper.
   *
   * Sync because the lookup is on a hot tool-handler path and the
   * surrounding code is already inside an `async` handler envelope; an
   * extra Promise per file just adds noise.
   */
  readFile: (uri: string) => string;
  /**
   * Convert an LSP URI (`file://...`) to the per-file display path used
   * in the response. The tool typically wires this to `uriToFilePath`
   * from `tool-helpers.ts`, optionally followed by a "make relative to
   * project root" pass.
   */
  resolveFilePath: (uri: string) => string;
}

/**
 * Convert an LSP `WorkspaceEdit` into the advisory-write response shape.
 *
 * Pipeline per file:
 *   1. Partition the edits by 0-based line.
 *   2. For each line, run {@link mergeSameLineEdits} to compute the
 *      post-edit line text.
 *   3. If the edit spans multiple lines (start.line !== end.line), emit
 *      a range-fallback change record — line-level `(before, after)`
 *      doesn't apply.
 *   4. Otherwise, call {@link widenBefore} on the natural single-line
 *      `(before, after)`. On `unique`, emit a line-level record. On
 *      `ambiguous`, emit a range-fallback record.
 *   5. Sort the per-file changes by ascending `line` for deterministic
 *      output (some LSPs return edits in arbitrary order).
 *
 * Files are also emitted in sorted-by-URI order so the response is
 * byte-stable across LSP-internal iteration-order quirks.
 */
export function workspaceEditToAdvisory(
  workspaceEdit: LspWorkspaceEdit,
  opts: WorkspaceEditToAdvisoryOptions,
): AdvisoryWriteResponse {
  const edits: AdvisoryEdit[] = [];
  let locationCount = 0;
  const changes = workspaceEdit.changes ?? {};
  const uris = Object.keys(changes).sort();
  for (const uri of uris) {
    const fileEdits = changes[uri];
    if (!fileEdits || fileEdits.length === 0) continue;
    const fileText = opts.readFile(uri);
    const lines = fileText.split("\n");
    // Partition by start.line. Multi-line edits go into a `multiLine`
    // bucket because they don't merge with the same-line per-line shape.
    const byLine = new Map<number, LspTextEdit[]>();
    const multiLine: LspTextEdit[] = [];
    for (const ed of fileEdits) {
      if (ed.range.start.line !== ed.range.end.line) {
        multiLine.push(ed);
        continue;
      }
      const list = byLine.get(ed.range.start.line) ?? [];
      list.push(ed);
      byLine.set(ed.range.start.line, list);
    }
    const lineIdxs = [...byLine.keys()].sort((a, b) => a - b);
    const fileChanges: AdvisoryChange[] = [];
    for (const lineIdx of lineIdxs) {
      const lineEdits = byLine.get(lineIdx);
      if (!lineEdits) continue; // unreachable; satisfies the type checker
      const originalLine = lines[lineIdx] ?? "";
      const editedLine = mergeSameLineEdits(originalLine, lineEdits);
      const widen = widenBefore(
        lines,
        lineIdx,
        fileText,
        originalLine,
        editedLine,
      );
      if (widen.kind === "unique") {
        fileChanges.push({
          line: lineIdx + 1,
          before: widen.before,
          after: widen.after,
          widened: widen.widened,
        });
      } else {
        // Ambiguous after widening — fall back to range coordinates.
        // We collapse the merged same-line edits back into one
        // range-fallback record by emitting the union range and the
        // post-merge `editedLine` as `newText`. The agent applies it as
        // a single replacement.
        const merged = mergeRangeUnion(lineEdits);
        fileChanges.push({
          line: lineIdx + 1,
          range: merged,
          newText: editedLine.slice(
            merged.start.character,
            // Compute the length the post-merge slice should be: the
            // original-range span plus the net length delta from each
            // edit. Concretely: `editedLine` has the post-edit content
            // exactly where `lineEdits` rewrote `originalLine`, so we
            // can carve out the post-edit substring at the same start
            // offset, ending at `start + (original-span + delta)`.
            merged.start.character +
              spanLengthAfterEdits(lineEdits, originalLine),
          ),
          widened: false,
        });
      }
    }
    for (const ed of multiLine) {
      fileChanges.push({
        line: ed.range.start.line + 1,
        range: ed.range,
        newText: ed.newText,
        widened: false,
      });
    }
    // Stable sort by `line` for deterministic output.
    fileChanges.sort((a, b) => a.line - b.line);
    locationCount += fileChanges.length;
    edits.push({ file: opts.resolveFilePath(uri), changes: fileChanges });
  }
  return {
    action: opts.action,
    edits,
    summary: { files: edits.length, locations: locationCount },
  };
}

/**
 * Union of disjoint same-line `TextEdit` ranges into the smallest
 * covering range. Used in the range-fallback branch when widening can't
 * disambiguate: we collapse the same-line edits into one replacement so
 * the agent applies a single splice rather than coordinating multiple.
 */
function mergeRangeUnion(edits: readonly LspTextEdit[]): LspRange {
  if (edits.length === 0) {
    throw new Error("mergeRangeUnion called with zero edits");
  }
  let start: LspPosition = edits[0].range.start;
  let end: LspPosition = edits[0].range.end;
  for (const ed of edits) {
    if (
      ed.range.start.line < start.line ||
      (ed.range.start.line === start.line &&
        ed.range.start.character < start.character)
    ) {
      start = ed.range.start;
    }
    if (
      ed.range.end.line > end.line ||
      (ed.range.end.line === end.line && ed.range.end.character > end.character)
    ) {
      end = ed.range.end;
    }
  }
  return { start, end };
}

/**
 * Compute the total character length of the post-edit slice that covers
 * the union range of `edits` in `originalLine`. Equals
 * `(union-end - union-start)` plus the sum of `(newText.length - (end -
 * start))` per edit.
 */
function spanLengthAfterEdits(
  edits: readonly LspTextEdit[],
  originalLine: string,
): number {
  const union = mergeRangeUnion(edits);
  let delta = 0;
  for (const ed of edits) {
    delta +=
      ed.newText.length - (ed.range.end.character - ed.range.start.character);
  }
  // The original union span length in the original line:
  const originalSpan =
    union.end.character - union.start.character > originalLine.length
      ? originalLine.length - union.start.character
      : union.end.character - union.start.character;
  return originalSpan + delta;
}
