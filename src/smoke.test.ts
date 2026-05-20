// Wave 0 smoke test: not a behavioral test of any tool — just enough to make
// `npm test` exit 0 so CI has a non-trivial green signal before real tests land
// alongside the tool implementations. Asserts structural invariants of
// package.json that would otherwise only fail in the wild after publish.
//
// Deliberately avoids importing src/index.ts: that file's top-level runs the
// MCP server on import, which would hang vitest. Once #3 (Refactor src/index.ts
// into modules) lands, replace this with real unit tests against the extracted
// modules.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf-8"),
) as {
  bin?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  name?: string;
};

describe("package.json structural invariants", () => {
  it("declares the godot-mcp bin entry pointing at the built index", () => {
    expect(pkg.bin).toEqual({ "godot-mcp": "./build/index.js" });
  });

  it("ships only the build/ directory in the npm tarball", () => {
    // Anything else here would either bloat the tarball or accidentally ship
    // source/tests. If you need to ship more, extend this list deliberately.
    expect(pkg.files).toEqual(["build"]);
  });

  it("requires Node >=24 (per DESIGN.md D17 minus the soften: kept strict here)", () => {
    expect(pkg.engines?.node).toBe(">=24.0.0");
  });

  it("name is godot-mcp", () => {
    expect(pkg.name).toBe("godot-mcp");
  });
});
