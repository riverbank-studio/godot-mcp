/**
 * Tests for the advisory-write helpers — the conversion pipeline that
 * turns an LSP `WorkspaceEdit` into the agent-facing
 * {@link AdvisoryWriteResponse} shape used by `godot_preview_rename`
 * (#27) and the deferred code-action tools.
 *
 * Coverage:
 *   - `mergeSameLineEdits` — disjoint edits, single edit, overlapping
 *     edits, right-to-left application order.
 *   - `widenBefore` — natural-unique short-circuit, single-line widen,
 *     skip-blank widening, hit-cap ambiguous, hit-top-of-file ambiguous.
 *   - `workspaceEditToAdvisory` — single-file rename, multi-file rename,
 *     same-line multi-edit merge (acceptance fixture for #10), widening
 *     emission, range-fallback emission, multi-line edit pass-through.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_WIDEN_LINES,
  mergeSameLineEdits,
  widenBefore,
  workspaceEditToAdvisory,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "./advisory-write.js";

// ---------------------------------------------------------------------------
// mergeSameLineEdits
// ---------------------------------------------------------------------------

describe("mergeSameLineEdits", () => {
  it("returns the line unchanged when there are no edits", () => {
    expect(mergeSameLineEdits("    self.old(x)", [])).toBe("    self.old(x)");
  });

  it("applies a single edit", () => {
    const edit: LspTextEdit = {
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 12 },
      },
      newText: "new",
    };
    // "    self.old(x)" -> "    self.new(x)"
    expect(mergeSameLineEdits("    self.old(x)", [edit])).toBe(
      "    self.new(x)",
    );
  });

  it("merges two disjoint edits on the same line, regardless of input order", () => {
    // The #10 acceptance fixture: `var x = old_name(old_name(1))`.
    const line = "var x = old_name(old_name(1))";
    //                   ^^^^^^^^         ^^^^^^^^
    //                   8...16           17...25
    const e1: LspTextEdit = {
      range: {
        start: { line: 0, character: 8 },
        end: { line: 0, character: 16 },
      },
      newText: "new_name",
    };
    const e2: LspTextEdit = {
      range: {
        start: { line: 0, character: 17 },
        end: { line: 0, character: 25 },
      },
      newText: "new_name",
    };
    const expected = "var x = new_name(new_name(1))";
    expect(mergeSameLineEdits(line, [e1, e2])).toBe(expected);
    // Order independence: feeding the edits backwards must produce the
    // same result.
    expect(mergeSameLineEdits(line, [e2, e1])).toBe(expected);
  });

  it("throws on overlapping edits rather than guessing", () => {
    const e1: LspTextEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      newText: "AAAAA",
    };
    const e2: LspTextEdit = {
      range: {
        start: { line: 0, character: 3 },
        end: { line: 0, character: 8 },
      },
      newText: "BBBBB",
    };
    expect(() => mergeSameLineEdits("abcdefgh", [e1, e2])).toThrow(/Overlap/);
  });

  it("handles edits where newText is shorter than the replaced range", () => {
    const edit: LspTextEdit = {
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 20 },
      },
      newText: "x",
    };
    // "var really_long_name = 1" — chars 4..20 cover `really_long_name`.
    expect(mergeSameLineEdits("var really_long_name = 1", [edit])).toBe(
      "var x = 1",
    );
  });
});

// ---------------------------------------------------------------------------
// widenBefore
// ---------------------------------------------------------------------------

describe("widenBefore", () => {
  it("short-circuits when the natural line is already unique", () => {
    const fileText = ["func foo():", "    pass", "", "func bar():", ""].join(
      "\n",
    );
    const lines = fileText.split("\n");
    const res = widenBefore(
      lines,
      3,
      fileText,
      "func bar():",
      "func renamed():",
    );
    expect(res).toEqual({
      kind: "unique",
      before: "func bar():",
      after: "func renamed():",
      widened: false,
    });
  });

  it("widens by one preceding line when the natural line is ambiguous", () => {
    // Two `pass` lines, but they follow different func definitions.
    const fileText = [
      "func foo():",
      "    pass",
      "",
      "func bar():",
      "    pass",
      "",
    ].join("\n");
    const lines = fileText.split("\n");
    // Renaming the `pass` on line index 4 — natural `    pass` matches twice.
    // After widening one line up (`func bar():`), the pair is unique.
    const res = widenBefore(lines, 4, fileText, "    pass", "    PASS");
    expect(res.kind).toBe("unique");
    if (res.kind === "unique") {
      expect(res.before).toBe("func bar():\n    pass");
      expect(res.after).toBe("func bar():\n    PASS");
      expect(res.widened).toBe(true);
    }
  });

  it("skips over blank lines when counting widen budget", () => {
    // The line immediately above the target is blank; we widen past it
    // (the blank itself is included in `before` but doesn't consume the
    // MAX_WIDEN_LINES budget).
    const fileText = [
      "func first():",
      "    pass",
      "",
      "    pass", // line 3 — what we rename
      "",
      "    pass", // line 5 — duplicate of line 3's `    pass`
    ].join("\n");
    const lines = fileText.split("\n");
    const res = widenBefore(lines, 3, fileText, "    pass", "    PASS");
    // `    pass` appears 3x naturally. Widening by one non-blank line
    // (`func first():`) plus the intervening blank gives a unique prefix.
    expect(res.kind).toBe("unique");
    if (res.kind === "unique") {
      expect(res.widened).toBe(true);
      // before includes the blank between func and target
      expect(res.before).toBe("func first():\n    pass\n\n    pass");
    }
  });

  it("returns ambiguous when even MAX_WIDEN_LINES of widening can't disambiguate", () => {
    // Build a file where the rename target's surrounding context is
    // identical for far more than MAX_WIDEN_LINES of widening.
    const block = ["a", "b", "c", "d", "e", "f", "g", "TARGET"].join("\n");
    const fileText = [block, block].join("\n");
    const lines = fileText.split("\n");
    // The second TARGET is at line index 15 (0-based).
    const res = widenBefore(lines, 15, fileText, "TARGET", "RENAMED");
    expect(res).toEqual({ kind: "ambiguous" });
  });

  it("returns ambiguous when widening runs out of preceding lines", () => {
    // The target is the first non-blank line in the file, so there are
    // no preceding non-blank lines to widen into. With more than one
    // occurrence of the natural line, the helper must give up.
    const fileText = ["dup", "", "dup"].join("\n");
    const lines = fileText.split("\n");
    const res = widenBefore(lines, 0, fileText, "dup", "DUP");
    expect(res).toEqual({ kind: "ambiguous" });
  });

  it("MAX_WIDEN_LINES is exported and equals 5 per DESIGN.md", () => {
    expect(MAX_WIDEN_LINES).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// workspaceEditToAdvisory
// ---------------------------------------------------------------------------

describe("workspaceEditToAdvisory", () => {
  it("converts a single-file single-line rename to the line-level shape", () => {
    const fileText = ["func foo():", "    pass", "", "func bar():", ""].join(
      "\n",
    );
    const ws: LspWorkspaceEdit = {
      changes: {
        "file:///proj/player.gd": [
          {
            range: {
              start: { line: 0, character: 5 },
              end: { line: 0, character: 8 },
            },
            newText: "renamed",
          },
        ],
      },
    };
    const res = workspaceEditToAdvisory(ws, {
      action: { kind: "rename", from: "foo", to: "renamed" },
      readFile: () => fileText,
      resolveFilePath: () => "player.gd",
    });
    expect(res.action).toEqual({
      kind: "rename",
      from: "foo",
      to: "renamed",
    });
    expect(res.summary).toEqual({ files: 1, locations: 1 });
    expect(res.edits).toHaveLength(1);
    expect(res.edits[0].file).toBe("player.gd");
    expect(res.edits[0].changes).toEqual([
      {
        line: 1,
        before: "func foo():",
        after: "func renamed():",
        widened: false,
      },
    ]);
  });

  it("merges same-line multi-edits into one change record (acceptance fixture #10)", () => {
    // The acceptance test from #10: `var x = old_name(old_name(1))` rename.
    const fileText = [
      "func wrapper():",
      "    var x = old_name(old_name(1))",
      "    return x",
    ].join("\n");
    const ws: LspWorkspaceEdit = {
      changes: {
        "file:///proj/foo.gd": [
          {
            range: {
              start: { line: 1, character: 12 },
              end: { line: 1, character: 20 },
            },
            newText: "new_name",
          },
          {
            range: {
              start: { line: 1, character: 21 },
              end: { line: 1, character: 29 },
            },
            newText: "new_name",
          },
        ],
      },
    };
    const res = workspaceEditToAdvisory(ws, {
      action: { kind: "rename", from: "old_name", to: "new_name" },
      readFile: () => fileText,
      resolveFilePath: () => "foo.gd",
    });
    // Acceptance: exactly one change record per line, both occurrences
    // rewritten in `after`.
    expect(res.edits).toHaveLength(1);
    expect(res.edits[0].changes).toHaveLength(1);
    const change = res.edits[0].changes[0];
    expect(change.line).toBe(2);
    if ("after" in change) {
      expect(change.before).toBe("    var x = old_name(old_name(1))");
      expect(change.after).toBe("    var x = new_name(new_name(1))");
      expect(change.widened).toBe(false);
    } else {
      throw new Error("expected line-level change shape, got range-fallback");
    }
  });

  it("emits widened: true when the natural line is ambiguous", () => {
    const fileText = [
      "func first():",
      "    pass",
      "",
      "func second():",
      "    pass", // line 4 — same content as line 1
      "",
    ].join("\n");
    // Pretend we're renaming a function called `pass` (contrived but
    // exercises the widening branch on the second occurrence).
    const ws: LspWorkspaceEdit = {
      changes: {
        "file:///proj/dup.gd": [
          {
            range: {
              start: { line: 4, character: 4 },
              end: { line: 4, character: 8 },
            },
            newText: "PASS",
          },
        ],
      },
    };
    const res = workspaceEditToAdvisory(ws, {
      action: { kind: "rename", from: "pass", to: "PASS" },
      readFile: () => fileText,
      resolveFilePath: () => "dup.gd",
    });
    expect(res.edits[0].changes).toHaveLength(1);
    const change = res.edits[0].changes[0];
    if (!("after" in change)) {
      throw new Error("expected line-level change shape, got range-fallback");
    }
    expect(change.widened).toBe(true);
    // The widened `before` must include the preceding non-blank line.
    expect(change.before).toMatch(/func second\(\):/);
    expect(change.before.endsWith("    pass")).toBe(true);
    expect(change.after.endsWith("    PASS")).toBe(true);
  });

  it("falls back to range coordinates when widening can't disambiguate", () => {
    // Two identical blocks; the rename target's context is fully
    // duplicated above and below, so even max widening fails.
    const block = ["a", "b", "c", "d", "e", "f", "g", "TARGET"].join("\n");
    const fileText = [block, block].join("\n");
    const ws: LspWorkspaceEdit = {
      changes: {
        "file:///proj/dup.gd": [
          {
            range: {
              start: { line: 15, character: 0 },
              end: { line: 15, character: 6 },
            },
            newText: "RENAMED",
          },
        ],
      },
    };
    const res = workspaceEditToAdvisory(ws, {
      action: { kind: "rename", from: "TARGET", to: "RENAMED" },
      readFile: () => fileText,
      resolveFilePath: () => "dup.gd",
    });
    const change = res.edits[0].changes[0];
    expect("range" in change).toBe(true);
    if ("range" in change) {
      expect(change.widened).toBe(false);
      expect(change.range.start).toEqual({ line: 15, character: 0 });
      expect(change.range.end).toEqual({ line: 15, character: 6 });
      expect(change.newText).toBe("RENAMED");
    }
  });

  it("emits a range-fallback record for multi-line edits", () => {
    // A multi-line edit (e.g. a rename that crosses a line boundary,
    // unusual but legal in LSP) can't be expressed as line-level.
    const fileText = ["line0", "line1", "line2"].join("\n");
    const ws: LspWorkspaceEdit = {
      changes: {
        "file:///proj/m.gd": [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 5 },
            },
            newText: "REPLACED",
          },
        ],
      },
    };
    const res = workspaceEditToAdvisory(ws, {
      action: { kind: "rename", from: "x", to: "REPLACED" },
      readFile: () => fileText,
      resolveFilePath: () => "m.gd",
    });
    const change = res.edits[0].changes[0];
    expect("range" in change).toBe(true);
    if ("range" in change) {
      expect(change.range.start).toEqual({ line: 0, character: 0 });
      expect(change.range.end).toEqual({ line: 1, character: 5 });
      expect(change.newText).toBe("REPLACED");
      expect(change.widened).toBe(false);
    }
  });

  it("groups changes across multiple files and sorts deterministically", () => {
    const aText = "func foo():\n    pass\n";
    const bText = "func foo():\n    pass\n";
    const ws: LspWorkspaceEdit = {
      changes: {
        // Deliberately out-of-order keys to verify sorting.
        "file:///proj/b.gd": [
          {
            range: {
              start: { line: 0, character: 5 },
              end: { line: 0, character: 8 },
            },
            newText: "bar",
          },
        ],
        "file:///proj/a.gd": [
          {
            range: {
              start: { line: 0, character: 5 },
              end: { line: 0, character: 8 },
            },
            newText: "bar",
          },
        ],
      },
    };
    const res = workspaceEditToAdvisory(ws, {
      action: { kind: "rename", from: "foo", to: "bar" },
      readFile: (uri) => (uri.endsWith("a.gd") ? aText : bText),
      resolveFilePath: (uri) => uri.replace("file:///proj/", ""),
    });
    expect(res.summary).toEqual({ files: 2, locations: 2 });
    expect(res.edits.map((e) => e.file)).toEqual(["a.gd", "b.gd"]);
  });

  it("returns an empty response when the WorkspaceEdit has no changes", () => {
    const res = workspaceEditToAdvisory(
      {},
      {
        action: { kind: "rename", from: "x", to: "y" },
        readFile: () => "",
        resolveFilePath: () => "n/a",
      },
    );
    expect(res).toEqual({
      action: { kind: "rename", from: "x", to: "y" },
      edits: [],
      summary: { files: 0, locations: 0 },
    });
  });

  it("passes through a code_action style action verbatim (forward-compat)", () => {
    // The action envelope is opaque to the helpers; verify the v1.1
    // kind round-trips intact.
    const res = workspaceEditToAdvisory(
      {},
      {
        action: { kind: "code_action", title: "Extract function", extra: 42 },
        readFile: () => "",
        resolveFilePath: () => "n/a",
      },
    );
    expect(res.action).toEqual({
      kind: "code_action",
      title: "Extract function",
      extra: 42,
    });
  });

  it("sorts changes within a file by ascending line", () => {
    const fileText = [
      "var foo = 1", // line 0
      "var bar = 2",
      "var foo = 3", // line 2
      "var bar = 4",
      "var foo = 5", // line 4
    ].join("\n");
    const ws: LspWorkspaceEdit = {
      changes: {
        "file:///proj/s.gd": [
          // Out-of-order list — the helper sorts.
          {
            range: {
              start: { line: 4, character: 4 },
              end: { line: 4, character: 7 },
            },
            newText: "FOO",
          },
          {
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 7 },
            },
            newText: "FOO",
          },
          {
            range: {
              start: { line: 2, character: 4 },
              end: { line: 2, character: 7 },
            },
            newText: "FOO",
          },
        ],
      },
    };
    const res = workspaceEditToAdvisory(ws, {
      action: { kind: "rename", from: "foo", to: "FOO" },
      readFile: () => fileText,
      resolveFilePath: () => "s.gd",
    });
    expect(res.edits[0].changes.map((c) => c.line)).toEqual([1, 3, 5]);
  });
});
