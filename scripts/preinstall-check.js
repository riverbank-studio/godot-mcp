/* eslint-disable no-undef --
   This script runs as a `postinstall` hook directly via `node` — not through
   the TypeScript build — so it cannot rely on any compile-time setup. It uses
   Node built-in globals (`process`, `console`) that the project-wide ESLint
   config does not yet declare in `languageOptions.globals`. The eslint
   tightening tracked alongside the broader refactor (see docs/DESIGN.md) will
   add a Node env; until then, suppress at the file scope rather than
   per-line. */

/**
 * Postinstall platform preflight for `godot-mcp`.
 *
 * Why this exists: native deps (`better-sqlite3`, `sqlite-vec`,
 * `@huggingface/transformers`) lack prebuilt binaries on some platforms — most
 * notably Alpine/musl and Windows-on-ARM (see DESIGN.md § Native dependencies
 * for the full matrix). Without a preflight, users hit cryptic gyp/source-build
 * errors during `npm install`. This script runs at the *end* of install
 * (postinstall, not preinstall — see ADR note in the issue thread) and exits
 * non-zero with a remediation pointer if the platform is unsupported.
 *
 * Two-pieces design:
 *
 *   1. `checkPlatform(input)` — a *pure* function that takes
 *      `{ platform, arch, libc }` and returns `{ supported, reason?,
 *      remediation? }`. Easy to unit-test; no I/O, no env reads.
 *
 *   2. `runCli()` — the side-effecting wrapper that collects real platform
 *      info (with env-var overrides for tests + the CI intentional-failure
 *      job), prints to stderr, and `process.exit`s. Calls `checkPlatform`
 *      under the hood.
 *
 * The runtime branches off env vars `GODOT_MCP_PREFLIGHT_*` rather than
 * positional argv so npm's automatic postinstall invocation Just Works.
 *
 * ESM module: `package.json` declares `"type": "module"`. Imported by tests as
 * `import { checkPlatform } from "../scripts/preinstall-check.js"`; invoked
 * directly by npm as `node scripts/preinstall-check.js`.
 */

import { fileURLToPath } from "node:url";

// Public so DESIGN.md / docs/installation.md and the test harness can refer
// to the same source-of-truth string when describing supported platforms.
export const PLATFORM_MATRIX_URL =
  "https://github.com/riverbank-studio/godot-mcp/blob/main/docs/installation.md#supported-platforms";

/**
 * @typedef {Object} PlatformInput
 * @property {"linux"|"darwin"|"win32"|string} platform — node `process.platform`.
 * @property {"x64"|"arm64"|string} arch — node `process.arch`.
 * @property {"glibc"|"musl"|null} libc — detected libc family on Linux;
 *   `null` on non-Linux *or* when detection genuinely failed (we treat the
 *   latter as glibc, matching what `npm install` would do on a stock distro).
 */

/**
 * @typedef {Object} PlatformResult
 * @property {boolean} supported — true if all native deps have prebuilds.
 * @property {string} [reason] — human-readable summary of which dep fails
 *   where. Always present when `supported === false`.
 * @property {string} [remediation] — actionable next-step (Docker image,
 *   upstream PR link, etc.). Always present when `supported === false`.
 */

/**
 * Pure platform classifier — no I/O, no env reads.
 *
 * Decision table (kept tight on purpose; full matrix lives in
 * docs/installation.md so we have ONE place to update when prebuilds land):
 *
 *   - linux + (x64|arm64) + (glibc|null)  → supported
 *   - linux + ANY        + musl           → UNSUPPORTED (sqlite-vec PR #199)
 *   - darwin + (x64|arm64)                → supported (libc irrelevant)
 *   - win32  + x64                        → supported
 *   - win32  + arm64                      → UNSUPPORTED (sqlite-vec PR #271)
 *   - anything else                       → UNSUPPORTED (defensive default)
 *
 * @param {PlatformInput} input
 * @returns {PlatformResult}
 */
export function checkPlatform(input) {
  const { platform, arch, libc } = input;

  if (platform === "linux") {
    if (libc === "musl") {
      return {
        supported: false,
        reason:
          "Alpine / musl Linux is not supported in v1: `sqlite-vec` and " +
          "`onnxruntime-node` have no musl prebuilds " +
          "(tracked upstream at https://github.com/asg017/sqlite-vec/pull/199).",
        remediation:
          "Switch to a glibc-based image such as `node:bookworm-slim` or " +
          "`node:24-bookworm`. If you must run on Alpine, set " +
          "`GODOT_MCP_PREFLIGHT_SKIP=1` and build `sqlite-vec` from source — " +
          "this is an unsupported configuration.",
      };
    }
    if (arch === "x64" || arch === "arm64") {
      return { supported: true };
    }
    return {
      supported: false,
      reason: `Linux on ${arch} is not a supported architecture in v1.`,
      remediation:
        "Supported Linux architectures are x64 and arm64 (glibc). See " +
        PLATFORM_MATRIX_URL,
    };
  }

  if (platform === "darwin") {
    if (arch === "x64" || arch === "arm64") {
      return { supported: true };
    }
    return {
      supported: false,
      reason: `macOS on ${arch} is not a supported architecture in v1.`,
      remediation:
        "Supported macOS architectures are x64 and arm64. See " +
        PLATFORM_MATRIX_URL,
    };
  }

  if (platform === "win32") {
    if (arch === "x64") {
      return { supported: true };
    }
    if (arch === "arm64") {
      return {
        supported: false,
        reason:
          "Windows on ARM64 is not supported in v1: `sqlite-vec` has no " +
          "Windows-ARM64 prebuild (tracked upstream at " +
          "https://github.com/asg017/sqlite-vec/pull/271).",
        remediation:
          "Use an x64 Windows host, or subscribe to https://github.com/asg017/sqlite-vec/pull/271 " +
          "for upstream progress. You can also set `GODOT_MCP_PREFLIGHT_SKIP=1` " +
          "to bypass this check (unsupported configuration).",
      };
    }
    return {
      supported: false,
      reason: `Windows on ${arch} is not a supported architecture in v1.`,
      remediation:
        "Supported Windows architecture is x64. See " + PLATFORM_MATRIX_URL,
    };
  }

  return {
    supported: false,
    reason: `Platform "${platform}" is not supported. Supported platforms are linux, darwin, and win32.`,
    remediation: "See " + PLATFORM_MATRIX_URL,
  };
}

/**
 * Detect libc family on Linux without taking a runtime dependency.
 *
 * `process.report.getReport().header.glibcVersionRuntime` is populated by
 * Node when the binary was linked against glibc, and is absent (or empty)
 * when linked against musl. This is the same heuristic the `detect-libc`
 * package uses internally, minus the file-system probes — sufficient for our
 * fail-fast purpose and avoids adding a dep that itself has to be installed
 * before the postinstall hook can run.
 *
 * @returns {"glibc"|"musl"|null}
 */
function detectLibc() {
  if (process.platform !== "linux") return null;
  try {
    const header = process.report?.getReport?.()?.header;
    if (!header || typeof header !== "object") {
      // Node didn't give us a report at all (very old Node, or a sandbox
      // that disables process.report). Fall through to null and let the
      // caller treat it as best-effort — DESIGN intentionally favors
      // false-negative (let install proceed) over false-positive (block
      // a working machine) when detection genuinely can't run.
      return null;
    }
    // `glibcVersionRuntime` is the same field detect-libc uses. Node
    // populates it (as a non-empty string) only when the running binary
    // was linked against glibc; on musl Node builds the field is either
    // absent or an empty string. Treat *both* as musl — the previous
    // "assume glibc on missing field" behavior misclassified Alpine
    // (where the field is omitted entirely) as glibc, defeating the
    // whole preflight on the platform we most need to block.
    const v = /** @type {{glibcVersionRuntime?: string}} */ (header)
      .glibcVersionRuntime;
    return typeof v === "string" && v.length > 0 ? "glibc" : "musl";
  } catch {
    return null;
  }
}

/**
 * Resolve the effective platform tuple for this process, honoring test/CI
 * override env vars. Overrides exist solely so the CI matrix's
 * intentional-failure job (and our unit tests) can exercise the
 * unsupported-platform code path without standing up a real Alpine container.
 *
 * @returns {PlatformInput}
 */
function resolveInput() {
  return {
    platform:
      process.env.GODOT_MCP_PREFLIGHT_OVERRIDE_PLATFORM || process.platform,
    arch: process.env.GODOT_MCP_PREFLIGHT_OVERRIDE_ARCH || process.arch,
    libc:
      process.env.GODOT_MCP_PREFLIGHT_OVERRIDE_LIBC !== undefined
        ? process.env.GODOT_MCP_PREFLIGHT_OVERRIDE_LIBC || null
        : detectLibc(),
  };
}

/**
 * Side-effecting CLI wrapper. Reads env, calls `checkPlatform`, prints, exits.
 *
 * Exit-code contract:
 *
 *   - supported platform                   → exit 0, silent.
 *   - GODOT_MCP_PREFLIGHT_SKIP=1           → exit 0, silent (escape hatch).
 *   - unsupported + CI=true                → exit 0 with stderr WARNING (so
 *                                            matrix jobs can observe the
 *                                            failure-mode without aborting).
 *   - unsupported + CI unset/falsy         → exit 1 with stderr ERROR.
 */
export function runCli() {
  if (process.env.GODOT_MCP_PREFLIGHT_SKIP === "1") {
    return;
  }

  const input = resolveInput();
  const result = checkPlatform(input);
  if (result.supported) {
    return;
  }

  const inCi = process.env.CI === "true";
  const prefix = inCi
    ? "[godot-mcp preflight] WARNING:"
    : "[godot-mcp preflight] ERROR:";
  const lines = [
    `${prefix} unsupported platform detected (platform=${input.platform} arch=${input.arch} libc=${input.libc ?? "n/a"}).`,
    "",
    `Reason: ${result.reason}`,
    "",
    `Remediation: ${result.remediation}`,
    "",
    `Supported platform matrix: ${PLATFORM_MATRIX_URL}`,
  ];
  if (inCi) {
    lines.push(
      "",
      "CI environment detected (CI=true) — continuing despite unsupported platform " +
        "so the matrix job can observe the failure mode. In a non-CI install, " +
        "this would have failed with exit 1.",
    );
  } else {
    lines.push(
      "",
      "To bypass this check (unsupported configuration), set GODOT_MCP_PREFLIGHT_SKIP=1.",
    );
  }
  process.stderr.write(lines.join("\n") + "\n");

  if (!inCi) {
    process.exit(1);
  }
}

// Run main only when invoked directly as `node scripts/preinstall-check.js`,
// not when imported by the test file.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  // Windows: pathToFileURL on argv[1] doesn't match a naive `file://` prefix
  // because Node uses three slashes for absolute Windows paths
  // (file:///C:/...). Compare via fileURLToPath instead.
  (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);

if (isDirectInvocation) {
  runCli();
}
