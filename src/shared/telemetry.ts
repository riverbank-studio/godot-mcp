/**
 * Local-file telemetry facade.
 *
 * Implements the contract from `docs/DESIGN.md` § Logging and telemetry and
 * the PII rules from `docs/telemetry.md`:
 *
 *   - Spans are written as NDJSON to `$XDG_DATA_HOME/godot-mcp/traces/`
 *     (and the OS-equivalent on macOS / Windows).
 *   - Rotation: the active file rolls when its size exceeds 100 MB or its
 *     age exceeds 7 days, whichever comes first.
 *   - File paths are recorded **relative to project root**, never absolute.
 *   - Query strings default to `{length, sha256Prefix8}`. Verbatim capture
 *     requires `GODOT_MCP_TRACE_QUERIES=1`.
 *   - On first trace, a `README.md` is written into the trace directory
 *     explaining what's in there.
 *   - `OTEL_SDK_DISABLED=true` fully disables telemetry (returns a
 *     `NoopTelemetry`).
 *
 * Why a minimal in-tree facade, not `@opentelemetry/sdk-node`
 * ---------------------------------------------------------
 * The acceptance criteria call for OTel-shaped semantics and honor the
 * standard `OTEL_SDK_DISABLED` env var, but there are no in-tree span
 * producers yet — they all land in Wave 3+. Adding the full OTel SDK now
 * means ten-plus transitive deps for zero current value. The public API
 * here (`startSpan`, `Span.setAttribute`, `Span.end`) is intentionally a
 * subset of `@opentelemetry/api`'s `Tracer` / `Span` shape so that a
 * follow-up PR can swap `FileTelemetry` for an OTel-backed implementation
 * without changing a single call site.
 *
 * Provenance: design rationale recorded in `docs/notes/5-shared-infra.md`
 * Decision 2.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { logWarn } from "./logging.js";

/**
 * The rotation caps from DESIGN.md L628. Exported so tests can pass smaller
 * values; production callers should leave the defaults alone.
 */
export const TRACE_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const TRACE_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The narrow `SharedEnvConfig` subset this module needs to decide whether
 * to attach a verbatim query string vs a hashed digest. Declared
 * structurally so callers can pass a sub-record without importing the full
 * env type.
 */
export interface TraceQueryGate {
  traceQueries: boolean;
}

/**
 * Configuration for the telemetry facade. Constructed at startup from the
 * parsed `SharedEnvConfig` and the resolved traces directory.
 */
export interface TelemetryConfig {
  /**
   * Master switch — `false` returns a `NoopTelemetry` regardless of other
   * settings. Wired from `!cfg.otelDisabled` at startup.
   */
  enabled: boolean;
  /**
   * Directory where NDJSON span files land. Resolved via
   * `resolveTracesDir()`; tests pass a tmpdir.
   */
  tracesDir: string;
  /**
   * Mirrors `SharedEnvConfig.traceQueries`. Stored on the config so the
   * helper `verbatimQueryAllowed` can be called from anywhere that has the
   * config without re-reading env.
   */
  traceQueries: boolean;
  /** Override the size cap. Tests only. */
  maxBytes?: number;
  /** Override the age cap. Tests only. */
  maxAgeMs?: number;
}

/**
 * The shape of one NDJSON record. Mirrors the OTel span attributes we'd
 * record if we were using the SDK; keeping the schema documented here makes
 * `docs/telemetry.md` the single source of truth for downstream parsers.
 */
export interface SpanRecord {
  /** Operation name, e.g. `"docs.ingest.fetch"`. */
  name: string;
  /** ISO 8601 timestamp of span start, in UTC. */
  startTime: string;
  /** Wall-clock duration in milliseconds (`endTime - startTime`). */
  durationMs: number;
  /** Either `"ok"` (default) or `"error"` (when `span.end(err)` is called). */
  status: "ok" | "error";
  /** Set only when `span.end(err)` is called. */
  errorMessage?: string;
  /** Attribute bag attached via `startSpan(name, attrs)` and `span.setAttribute()`. */
  attributes: Record<string, AttributeValue>;
}

/**
 * Permitted attribute value types. Matches OTel's accepted types so a later
 * migration to `@opentelemetry/api` is mechanical.
 */
export type AttributeValue = string | number | boolean | null;

/**
 * One in-flight span. The interface is a subset of `@opentelemetry/api`'s
 * `Span` so future migration to the OTel SDK is mechanical.
 */
export interface Span {
  /** Attach a key/value to this span. Last write wins. */
  setAttribute(key: string, value: AttributeValue): void;
  /**
   * End the span. When `error` is provided, the span is marked
   * `status="error"` and the error's message is captured (stack is not, to
   * avoid leaking absolute paths from V8 frame info).
   */
  end(error?: Error): void;
}

/**
 * The tracer-shaped facade subsystems consume.
 */
export interface Telemetry {
  /**
   * Start a span. `attributes` are the initial attribute bag; more can be
   * attached via `span.setAttribute` before `span.end()`.
   */
  startSpan(name: string, attributes?: Record<string, AttributeValue>): Span;
}

/**
 * Resolve the directory where NDJSON span files land, honoring the
 * platform-appropriate "data" location:
 *
 *   - Linux: `$XDG_DATA_HOME/godot-mcp/traces/` (falling back to
 *     `~/.local/share/godot-mcp/traces/` per the XDG Base Directory spec).
 *   - macOS: `~/Library/Application Support/godot-mcp/traces/`.
 *   - Windows: `%LOCALAPPDATA%/godot-mcp/traces/`.
 *
 * The directory is **not** created here; `createTelemetry` does that lazily
 * on first span so a noop telemetry never touches disk.
 */
export function resolveTracesDir(env: NodeJS.ProcessEnv = process.env): string {
  const platform = os.platform();
  if (platform === "win32") {
    const base =
      env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "godot-mcp", "traces");
  }
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "godot-mcp",
      "traces",
    );
  }
  // Linux + every other POSIX: XDG.
  const xdg =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== ""
      ? env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "godot-mcp", "traces");
}

/**
 * Build a telemetry instance from the resolved config. Returns a
 * `NoopTelemetry` when `cfg.enabled` is false; otherwise a `FileTelemetry`
 * that writes NDJSON to `cfg.tracesDir`.
 */
export function createTelemetry(cfg: TelemetryConfig): Telemetry {
  if (!cfg.enabled) {
    return new NoopTelemetry();
  }
  return new FileTelemetry(cfg);
}

/**
 * Telemetry implementation used when `OTEL_SDK_DISABLED=true`. All methods
 * are pure no-ops; no I/O, no allocations beyond the empty span object.
 */
class NoopTelemetry implements Telemetry {
  startSpan(): Span {
    return NOOP_SPAN;
  }
}

const NOOP_SPAN: Span = {
  setAttribute(): void {
    /* no-op */
  },
  end(): void {
    /* no-op */
  },
};

/**
 * Telemetry implementation that writes NDJSON span records to a rotating
 * file under the configured traces dir.
 */
class FileTelemetry implements Telemetry {
  private readonly cfg: TelemetryConfig;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  /** Lazily created on first span so a server that never traces leaves disk alone. */
  private activeFile: { path: string; createdAt: number } | null = null;
  /** Track first-trace state so we only write the README once per process. */
  private readmeWritten = false;

  constructor(cfg: TelemetryConfig) {
    this.cfg = cfg;
    this.maxBytes = cfg.maxBytes ?? TRACE_FILE_MAX_BYTES;
    this.maxAgeMs = cfg.maxAgeMs ?? TRACE_FILE_MAX_AGE_MS;
  }

  startSpan(name: string, attributes?: Record<string, AttributeValue>): Span {
    const start = Date.now();
    const record: SpanRecord = {
      name,
      startTime: new Date(start).toISOString(),
      durationMs: 0,
      status: "ok",
      attributes: { ...(attributes ?? {}) },
    };

    // Capture the writer via a bound function instead of aliasing `this`
    // (no-this-alias lints flag the latter). The closure keeps the writer
    // alive for the lifetime of the returned span, which is what we want.
    const write = (r: SpanRecord) => this.writeRecord(r);
    return {
      setAttribute(key: string, value: AttributeValue): void {
        record.attributes[key] = value;
      },
      end(error?: Error): void {
        record.durationMs = Date.now() - start;
        if (error) {
          record.status = "error";
          record.errorMessage = error.message;
        }
        write(record);
      },
    };
  }

  private writeRecord(record: SpanRecord): void {
    try {
      this.ensureDir();
      this.ensureReadme();
      const filePath = this.currentFilePath();
      // Append a single NDJSON line. `appendFileSync` is the cheapest path
      // that's atomic on POSIX for sub-PIPE_BUF writes; one span record is
      // well under 4 KB.
      fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    } catch (err) {
      // Telemetry failures must never crash the server. Surface once via
      // the warn channel so a misconfigured traces dir is visible.
      const msg = err instanceof Error ? err.message : String(err);
      logWarn("telemetry", `failed to write span: ${msg}`);
    }
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.cfg.tracesDir)) {
      fs.mkdirSync(this.cfg.tracesDir, { recursive: true });
    }
  }

  private ensureReadme(): void {
    if (this.readmeWritten) return;
    const readmePath = path.join(this.cfg.tracesDir, "README.md");
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, READMME_CONTENTS, "utf8");
    }
    this.readmeWritten = true;
  }

  private currentFilePath(): string {
    // Rotate when the active file would exceed the size or age cap.
    if (this.activeFile) {
      const sizeBytes = (() => {
        try {
          return fs.statSync(this.activeFile.path).size;
        } catch {
          // File missing (e.g. user deleted it mid-run): force a new one.
          return Number.POSITIVE_INFINITY;
        }
      })();
      const ageMs = Date.now() - this.activeFile.createdAt;
      if (
        shouldRotate({
          sizeBytes,
          ageMs,
          maxBytes: this.maxBytes,
          maxAgeMs: this.maxAgeMs,
        })
      ) {
        this.activeFile = null;
      }
    }
    if (!this.activeFile) {
      // Filename encodes UTC date + UTC time + a short nonce. The nonce
      // prevents collisions when rotation triggers within the same second.
      const now = new Date();
      const stamp =
        now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "") +
        "-" +
        crypto.randomBytes(3).toString("hex");
      this.activeFile = {
        path: path.join(this.cfg.tracesDir, `godot-mcp-${stamp}.ndjson`),
        createdAt: Date.now(),
      };
    }
    return this.activeFile.path;
  }
}

/**
 * Rotation decision, factored out so tests can exercise the policy without
 * a real filesystem.
 */
export function shouldRotate(params: {
  sizeBytes: number;
  ageMs: number;
  maxBytes: number;
  maxAgeMs: number;
}): boolean {
  return params.sizeBytes >= params.maxBytes || params.ageMs >= params.maxAgeMs;
}

// ---------------------------------------------------------------------------
// PII helpers
// ---------------------------------------------------------------------------

/**
 * The sentinel returned by `relativizePath` when the target would escape
 * the project root (or is unrelatable). Used instead of the absolute path
 * so traces never reveal home directories or unrelated locations.
 */
export const ABSOLUTE_PATH_SENTINEL = "<absolute>";

/**
 * Render `target` relative to `projectRoot`, returning a value that is
 * **never absolute** and **never escapes via `..`**. Use the result as the
 * value of any path-shaped span attribute.
 *
 * If `target` is outside `projectRoot`, or if the inputs aren't both
 * absolute, returns {@link ABSOLUTE_PATH_SENTINEL}. The intent is privacy,
 * not full path-arithmetic — when in doubt, the sentinel is the safe answer.
 */
export function relativizePath(target: string, projectRoot: string): string {
  if (!path.isAbsolute(target) || !path.isAbsolute(projectRoot)) {
    return ABSOLUTE_PATH_SENTINEL;
  }
  const rel = path.relative(projectRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return ABSOLUTE_PATH_SENTINEL;
  }
  // An empty relative (target === root) is rendered as "." which is
  // non-absolute and PII-safe.
  return rel === "" ? "." : rel;
}

/**
 * The default capture form for a query string. Returns `{length,
 * sha256Prefix8}`; the original string is not recoverable from the digest.
 */
export function hashQuery(query: string): {
  length: number;
  sha256Prefix8: string;
} {
  const digest = crypto
    .createHash("sha256")
    .update(query, "utf8")
    .digest("hex");
  return { length: query.length, sha256Prefix8: digest.slice(0, 8) };
}

/**
 * Single gate every call site should ask before attaching a verbatim query
 * string to a span. Returns true only when the user opted into verbatim
 * capture via `GODOT_MCP_TRACE_QUERIES=1`.
 */
export function verbatimQueryAllowed(cfg: TraceQueryGate): boolean {
  return cfg.traceQueries === true;
}

const READMME_CONTENTS = `# godot-mcp trace files

This directory is written to by godot-mcp's OpenTelemetry-compatible
telemetry facade. Each \`godot-mcp-*.ndjson\` file is a newline-delimited
sequence of span records; one record per line, parseable with any JSON tool.

## Contents

- **File paths** are relative to the project root. Absolute paths never appear.
- **Query strings** are recorded as \`{length, sha256_prefix_8}\` by default.
  Setting \`GODOT_MCP_TRACE_QUERIES=1\` switches to verbatim capture.
- **Source-line snippets** are never recorded.

## Rotation

Files roll when they exceed 100 MB or 7 days, whichever comes first. Old
files are not deleted automatically — you can remove them at any time.

## Disabling

Set \`OTEL_SDK_DISABLED=true\` to disable telemetry entirely. Nothing in
this directory will be touched.

## Schema

See \`docs/telemetry.md\` in the godot-mcp repository for the full
attribute schema and the privacy posture.
`;
