/**
 * Tests for the docs-tools shared response helpers.
 *
 * DESIGN.md § Documentation subsystem → Error handling:
 *   - "Class not found, member not found, tutorial not found → MCP error
 *      with `suggestions` array containing similar names (cheap FTS5
 *      lookup)."
 *
 * The shape is shared across #15 (godot_get_class), #16 (godot_find_member),
 * and #18 (godot_get_tutorial), so it lives here rather than being
 * duplicated three times.
 */

import { describe, it, expect } from "vitest";

import {
  docsNotFoundResponse,
  docsErrorResponse,
  docsResultResponse,
} from "./responses.js";

describe("docsNotFoundResponse", () => {
  it("returns isError: true with the message in the first content block", () => {
    const r = docsNotFoundResponse("Class 'Noed' not found", []);
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({
      type: "text",
      text: "Class 'Noed' not found",
    });
  });

  it("includes the suggestions array as a JSON content block (machine-parseable)", () => {
    const r = docsNotFoundResponse("Class 'Noed' not found", [
      "Node",
      "Node2D",
    ]);
    // The structured payload lets agents act on the suggestion list
    // programmatically without scraping prose.
    const payload = r.content.find((c) => c.text.startsWith("{"));
    expect(payload).toBeDefined();
    expect(JSON.parse(payload!.text)).toEqual({
      suggestions: ["Node", "Node2D"],
    });
  });

  it("does not emit a suggestions block when there are none", () => {
    const r = docsNotFoundResponse("Class 'Noed' not found", []);
    // Single content block (the message), no suggestions JSON.
    expect(r.content).toHaveLength(1);
  });

  it("emits suggestions with `did you mean` hint on case mismatch (Wave 4 design)", () => {
    // Case-insensitive lookup hit but case mismatch: caller passes the
    // canonical name as the single suggestion; the response surfaces a
    // human-readable "did you mean" hint alongside the machine payload.
    const r = docsNotFoundResponse(
      "Class 'NODE' not found (case-sensitive)",
      ["Node"],
      { didYouMean: "Node" },
    );
    expect(r.content[1]!.text).toContain("did you mean");
    expect(r.content[1]!.text).toContain("Node");
    // The machine-readable suggestions JSON still appears.
    const payload = r.content.find(
      (c) => c.text.startsWith("{") && c.text.includes("suggestions"),
    );
    expect(payload).toBeDefined();
  });
});

describe("docsErrorResponse", () => {
  it("returns isError: true with the operator's recovery hints", () => {
    const r = docsErrorResponse("Docs DB unavailable", [
      "Ensure GODOT_DOCS_VERSION is set correctly",
      "Try restarting the server",
    ]);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("Docs DB unavailable");
    expect(r.content[1]!.text).toContain("Possible solutions");
  });
});

describe("docsResultResponse", () => {
  it("encodes the payload as a JSON content block", () => {
    const payload = { results: [{ name: "Node", score: 1.5 }], hint: "" };
    const r = docsResultResponse(payload);
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(JSON.parse(r.content[0]!.text)).toEqual(payload);
  });
});
