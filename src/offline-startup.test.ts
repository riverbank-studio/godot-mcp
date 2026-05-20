/**
 * Integration tests for startup CLI flags and offline-mode short-circuit.
 *
 * Acceptance criteria:
 * - `--version` and `--help` exit 0 immediately without hanging on stdio.
 * - `GODOT_MCP_OFFLINE=1 + GODOT_DOCS_VERSION=latest` exits 2 with the
 *   expected error message (issue #44 acceptance criterion).
 *
 * We spawn the built `build/index.js` and verify exit codes + output. We do
 * NOT import `src/index.ts` because importing it runs the MCP server on stdio
 * and would hang vitest (same reason the smoke test calls out).
 *
 * Build prerequisite: `npm run build` must have run before this test. The
 * test skips with a clear message if `build/index.js` is missing so a
 * fresh checkout running `npm test` cold doesn't appear broken.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const buildIndex = join(here, "..", "build", "index.js");

const describeOrSkip = existsSync(buildIndex) ? describe : describe.skip;

describeOrSkip("CLI flags (--version / --help)", () => {
  it("--version exits 0 and prints 'godot-mcp <version>'", () => {
    const result = spawnSync(process.execPath, [buildIndex, "--version"], {
      encoding: "utf-8",
      timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^godot-mcp \d+\.\d+/);
  });

  it("-v is an alias for --version", () => {
    const result = spawnSync(process.execPath, [buildIndex, "-v"], {
      encoding: "utf-8",
      timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^godot-mcp \d+\.\d+/);
  });

  it("--help exits 0 and prints usage text", () => {
    const result = spawnSync(process.execPath, [buildIndex, "--help"], {
      encoding: "utf-8",
      timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: godot-mcp/);
    expect(result.stdout).toMatch(/GODOT_MCP_OFFLINE/);
  });

  it("-h is an alias for --help", () => {
    const result = spawnSync(process.execPath, [buildIndex, "-h"], {
      encoding: "utf-8",
      timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: godot-mcp/);
  });
});

describeOrSkip("offline-mode startup short-circuit", () => {
  it("GODOT_MCP_OFFLINE=1 + GODOT_DOCS_VERSION=latest exits with code 2", () => {
    const result = spawnSync(process.execPath, [buildIndex], {
      env: {
        ...process.env,
        GODOT_MCP_OFFLINE: "1",
        GODOT_DOCS_VERSION: "latest",
        // Force strict path validation off so the test doesn't fall into the
        // separate exit-1 path for a missing Godot binary before our exit-2
        // check runs.
      },
      encoding: "utf-8",
      timeout: 15000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Offline-mode configuration error/);
    expect(result.stderr).toMatch(/GODOT_MCP_OFFLINE/);
    expect(result.stderr).toMatch(/GODOT_DOCS_VERSION/);
  });

  it("GODOT_MCP_OFFLINE=yes (malformed boolean) exits with code 2", () => {
    const result = spawnSync(process.execPath, [buildIndex], {
      env: { ...process.env, GODOT_MCP_OFFLINE: "yes" },
      encoding: "utf-8",
      timeout: 15000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/GODOT_MCP_OFFLINE/);
  });
});
