/**
 * Tests for the postinstall platform preflight.
 *
 * The script under test is `scripts/preinstall-check.js` — plain JS so it can
 * run during `npm install` without a TypeScript step. The script exports a
 * pure `checkPlatform()` function that the runnable entry point calls; tests
 * exercise that pure function with explicit inputs rather than mocking
 * `process.platform` (which is read-only and brittle to override).
 *
 * Outcome contract (encoded as test cases below):
 *
 *   - Supported tuples return `{ supported: true }`.
 *   - Unsupported tuples return `{ supported: false, reason, remediation }`
 *     so the caller can print a useful message before exiting non-zero.
 *   - In CI (`env.CI === "true"`) the runnable wrapper degrades exit-1 to a
 *     warning so a matrix job can capture the failure-mode without aborting
 *     — that behavior lives in `runCli()`, tested separately.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkPlatform,
  type PlatformInput,
} from "../scripts/preinstall-check.js";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "scripts", "preinstall-check.js");

/** Convenience: build a PlatformInput with sensible defaults. */
function input(overrides: Partial<PlatformInput> = {}): PlatformInput {
  return {
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    ...overrides,
  };
}

describe("checkPlatform — supported tuples", () => {
  it("Linux x64 glibc is supported", () => {
    expect(checkPlatform(input()).supported).toBe(true);
  });

  it("Linux arm64 glibc is supported", () => {
    expect(checkPlatform(input({ arch: "arm64" })).supported).toBe(true);
  });

  it("macOS x64 is supported", () => {
    expect(
      checkPlatform(input({ platform: "darwin", arch: "x64", libc: null }))
        .supported,
    ).toBe(true);
  });

  it("macOS arm64 is supported", () => {
    expect(
      checkPlatform(input({ platform: "darwin", arch: "arm64", libc: null }))
        .supported,
    ).toBe(true);
  });

  it("Windows x64 is supported", () => {
    expect(
      checkPlatform(input({ platform: "win32", arch: "x64", libc: null }))
        .supported,
    ).toBe(true);
  });
});

describe("checkPlatform — unsupported tuples", () => {
  it("Linux x64 musl (Alpine) is unsupported with Alpine-specific remediation", () => {
    const r = checkPlatform(input({ libc: "musl" }));
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/musl|alpine/i);
    expect(r.remediation).toMatch(/bookworm|debian|glibc|docker/i);
  });

  it("Linux arm64 musl is unsupported", () => {
    const r = checkPlatform(input({ arch: "arm64", libc: "musl" }));
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/musl|alpine/i);
  });

  it("Windows arm64 is unsupported with sqlite-vec PR pointer", () => {
    const r = checkPlatform(
      input({ platform: "win32", arch: "arm64", libc: null }),
    );
    expect(r.supported).toBe(false);
    // Reason mentions Windows-ARM; remediation links the upstream PR so users
    // can subscribe rather than reopen the same install issue here.
    expect(r.reason).toMatch(/windows.*arm|arm.*windows/i);
    expect(r.remediation).toMatch(/sqlite-vec.*pull\/271|pull\/271/);
  });

  it("Unknown platform falls through to unsupported (defensive default)", () => {
    const r = checkPlatform(
      // @ts-expect-error — intentionally invalid to test the default branch
      input({ platform: "freebsd", arch: "x64", libc: null }),
    );
    expect(r.supported).toBe(false);
  });
});

describe("checkPlatform — libc detection contract", () => {
  it("treats libc=null on Linux as glibc (best-effort)", () => {
    // When detect-libc / process.report can't determine libc on Linux we
    // optimistically assume glibc. The CI matrix exercises the real Alpine
    // path; this just locks the local-dev fall-through behavior.
    expect(checkPlatform(input({ libc: null })).supported).toBe(true);
  });

  it("ignores libc on non-Linux platforms", () => {
    // libc on darwin/win32 is meaningless; assert that even a spurious 'musl'
    // value does not flip darwin to unsupported.
    expect(
      checkPlatform(input({ platform: "darwin", arch: "arm64", libc: "musl" }))
        .supported,
    ).toBe(true);
  });
});

describe("preinstall-check.js — CLI behavior", () => {
  // These tests spawn the actual script with env vars that the script's
  // override-hook reads (GODOT_MCP_PREFLIGHT_OVERRIDE_*). The override hook
  // exists exclusively for tests + the CI matrix's intentional-failure job.

  it("exits 0 on a supported platform", () => {
    const r = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        CI: "",
        GODOT_MCP_PREFLIGHT_OVERRIDE_PLATFORM: "linux",
        GODOT_MCP_PREFLIGHT_OVERRIDE_ARCH: "x64",
        GODOT_MCP_PREFLIGHT_OVERRIDE_LIBC: "glibc",
      },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
  });

  it("exits non-zero on Alpine/musl when CI is not set", () => {
    const r = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        CI: "",
        GODOT_MCP_PREFLIGHT_OVERRIDE_PLATFORM: "linux",
        GODOT_MCP_PREFLIGHT_OVERRIDE_ARCH: "x64",
        GODOT_MCP_PREFLIGHT_OVERRIDE_LIBC: "musl",
      },
      encoding: "utf-8",
    });
    expect(r.status).not.toBe(0);
    // Message goes to stderr so npm surfaces it.
    expect(r.stderr).toMatch(/musl|alpine/i);
    expect(r.stderr).toMatch(/bookworm|glibc|docker/i);
  });

  it("exits 0 with a warning when CI=true on an unsupported platform", () => {
    // The CI degradation is the key contract: a matrix job that intentionally
    // runs the script on musl must observe the failure message without
    // aborting the whole `npm install` and starving the matrix of signal.
    const r = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        CI: "true",
        GODOT_MCP_PREFLIGHT_OVERRIDE_PLATFORM: "linux",
        GODOT_MCP_PREFLIGHT_OVERRIDE_ARCH: "x64",
        GODOT_MCP_PREFLIGHT_OVERRIDE_LIBC: "musl",
      },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/warning/i);
    expect(r.stderr).toMatch(/musl|alpine/i);
  });

  it("respects GODOT_MCP_PREFLIGHT_SKIP=1 (escape hatch)", () => {
    // Some downstream packagers (Nix, Homebrew bottles, distro maintainers)
    // need a way to bypass the preflight entirely without forking. The skip
    // flag exits 0 silently regardless of platform.
    const r = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        CI: "",
        GODOT_MCP_PREFLIGHT_SKIP: "1",
        GODOT_MCP_PREFLIGHT_OVERRIDE_PLATFORM: "linux",
        GODOT_MCP_PREFLIGHT_OVERRIDE_ARCH: "x64",
        GODOT_MCP_PREFLIGHT_OVERRIDE_LIBC: "musl",
      },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
  });
});
