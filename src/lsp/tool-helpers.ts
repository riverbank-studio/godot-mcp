/**
 * Shared helpers for the seven read-only LSP leaf tools (#20–#26) and the
 * v1 advisory-write tool (`godot_preview_rename`).
 *
 * Per `docs/DESIGN.md` § Tool surface → LSP tools and § Tool-specific
 * behavior, every LSP tool has to do the same handful of things before and
 * after its `LspClient` call:
 *
 *   - **Position conversion.** Wire is 1-based (matches editor convention,
 *     DESIGN.md L490); LSP is 0-based. {@link toLspPosition} /
 *     {@link fromLspPosition} keep the conversion in one place so leaves
 *     never reinvent it (or land an off-by-one on column zero).
 *   - **Range conversion.** Half-open `[start, end)` semantics preserved
 *     through (DESIGN.md L491).
 *   - **URI ↔ path.** `client.ts` exports `filePathToUri`; this file
 *     provides the inverse {@link uriToFilePath} so tools translating LSP
 *     `Location` responses don't each reimplement percent-decoding +
 *     Windows-drive-letter handling.
 *   - **In-project guard.** DESIGN.md L425: "LSP tools validate that
 *     requested file paths are within the project root. Files outside
 *     project root → error." {@link validateFileInProject} is the
 *     canonical check.
 *   - **Error mapping.** DESIGN.md L513 error-mapping table plus the
 *     categorized-`LspUnavailableError` subclasses from `errors.ts`.
 *     {@link mapLspErrorToResponse} turns any LSP-shaped failure into an
 *     MCP error envelope with the canonical recovery hint copy.
 *   - **Context resolution + handler envelope.** {@link withLspClient}
 *     resolves the lazy `ctx.lsp` provider, fetches the project root, and
 *     wraps the handler body in a `try/catch` that maps LSP errors to MCP
 *     responses (programmer bugs — `TypeError`, etc. — are re-thrown
 *     unchanged so the surrounding observability layer can see them).
 *
 * #8's PR description deferred the **tiered recovery** (alive-check →
 * reconnect → respawn) layer. This file does NOT paper over that gap: a
 * connection drop surfaced by `LspConnectionLostError` is mapped to an
 * MCP error with the "retry the operation" hint per
 * {@link LspConnectionLostError}, not silently retried. When the
 * tiered-recovery layer lands, the retry will move into the client and
 * the leaves' user-facing behavior on transient drops will improve
 * automatically.
 */

import * as path from "node:path";

import { LspUnavailableError } from "./errors.js";
import { RequestTimeoutError } from "./queue.js";
import { createErrorResponse } from "../shared/errors.js";
import type { ToolContext, ToolResponse } from "../shared/types.js";

import type {
  DiagnosticCacheEntry,
  KnownServerCapabilities,
  LspDiagnostic,
} from "./client.js";
import type { EnqueueOptions } from "./queue.js";

export { filePathToUri } from "./client.js";

// ---------------------------------------------------------------------------
// Position / range conversion (wire 1-based ↔ LSP 0-based)
// ---------------------------------------------------------------------------

/**
 * A position on the wire (what tool callers see). 1-based per DESIGN.md
 * L490; the first character of the first line is `{ line: 1, character: 1 }`.
 */
export interface WirePosition {
  line: number;
  character: number;
}

/**
 * A position in LSP coordinates (0-based). Internal representation; never
 * surfaced to tool callers.
 */
export interface LspPosition {
  line: number;
  character: number;
}

/**
 * Convert a 1-based wire position to a 0-based LSP position. Rejects
 * non-positive line / character; the caller's schema-validation layer
 * normally catches these first but the explicit guard lets leaves keep
 * their schemas declarative and surface a uniform error on bad input.
 */
export function toLspPosition(wire: WirePosition): LspPosition {
  if (!Number.isInteger(wire.line) || wire.line < 1) {
    throw new Error(
      `line must be a 1-based integer (got ${String(wire.line)})`,
    );
  }
  if (!Number.isInteger(wire.character) || wire.character < 1) {
    throw new Error(
      `character must be a 1-based integer (got ${String(wire.character)})`,
    );
  }
  return { line: wire.line - 1, character: wire.character - 1 };
}

/**
 * Convert a 0-based LSP position to a 1-based wire position. Inverse of
 * {@link toLspPosition}; the function is total because every non-negative
 * LSP position is a valid wire position.
 */
export function fromLspPosition(lsp: LspPosition): WirePosition {
  return { line: lsp.line + 1, character: lsp.character + 1 };
}

/**
 * Wire-side LSP range. `[start, end)` half-open per DESIGN.md L491.
 */
export interface WireRange {
  start: WirePosition;
  end: WirePosition;
}

/**
 * LSP-side range. `[start, end)` half-open.
 */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/**
 * Convert a wire-side range to LSP coordinates. Both endpoints are
 * converted independently; half-open semantics survive verbatim because
 * each endpoint's offset is uniform.
 */
export function toLspRange(wire: WireRange): LspRange {
  return { start: toLspPosition(wire.start), end: toLspPosition(wire.end) };
}

/**
 * Convert an LSP range to wire coordinates. Inverse of {@link toLspRange}.
 */
export function fromLspRange(lsp: LspRange): WireRange {
  return { start: fromLspPosition(lsp.start), end: fromLspPosition(lsp.end) };
}

// ---------------------------------------------------------------------------
// URI <-> path
// ---------------------------------------------------------------------------

/**
 * Inverse of {@link filePathToUri}. Decodes a `file://` URI back to a
 * filesystem path:
 *
 *   - `file:///C:/foo/bar.gd` → `C:/foo/bar.gd`
 *   - `file:///home/u/p.gd`   → `/home/u/p.gd`
 *   - percent-encoded characters are decoded.
 *
 * URIs that are not `file://` (e.g. `gdscript://@GlobalScope`,
 * `godot://Node`) are returned unchanged so the caller can detect
 * synthetic / built-in-symbol URIs by prefix. Empty input returns empty.
 *
 * Path separators are always returned as forward slashes for
 * cross-platform stability. Callers that need native separators should
 * apply `path.normalize()` themselves.
 */
export function uriToFilePath(uri: string): string {
  if (uri === "") return "";
  if (!uri.startsWith("file://")) {
    // Synthetic or non-file scheme — pass through so callers can branch
    // on the URI prefix without re-introspecting our return value.
    return uri;
  }
  // Drop the scheme; `file:///C:/...` and `file:///home/...` both become
  // `/C:/...` and `/home/...` respectively after the literal strip.
  let p = uri.slice("file://".length);
  // Percent-decode. `decodeURIComponent` rejects malformed escapes; we
  // wrap in try/catch so a malformed URI gets returned as-is rather than
  // exploding the response path.
  try {
    p = decodeURIComponent(p);
  } catch {
    // Leave `p` as-is; the caller will see the still-escaped form.
  }
  // Windows drive letters: `/C:/foo` → `C:/foo`. The leading slash is a
  // URI artifact, not part of the path.
  if (/^\/[A-Za-z]:\//.test(p)) {
    p = p.slice(1);
  }
  return p;
}

// ---------------------------------------------------------------------------
// In-project guard
// ---------------------------------------------------------------------------

/**
 * Throw if `filePath` is not within `projectRoot`. Returns the
 * forward-slash-normalized absolute form of the file path on success so
 * callers can store one canonical value.
 *
 * The check is purely lexical — `path.relative` after `path.resolve`. It
 * does not resolve symlinks; the symlink case is documented in DESIGN.md
 * but left out of v1 (the cost of an extra `realpath` per request isn't
 * justified by the rarity of someone deliberately symlinking a script
 * outside the project root). A leaf tool can layer that on its own.
 */
export function validateFileInProject(
  filePath: string,
  projectRoot: string,
): string {
  const absRoot = path.resolve(projectRoot);
  const absFile = path.resolve(filePath);
  // path.relative returns "" when absFile === absRoot, "..", "../foo" etc.
  // for escapes, or "foo/bar" for paths inside. The escape detector is
  // therefore "relative starts with `..` followed by a separator or end".
  const rel = path.relative(absRoot, absFile);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    // Inside or equal to the root. Return forward-slash form for
    // cross-platform stability; the caller is free to denormalize.
    return absFile.replace(/\\/g, "/");
  }
  throw new Error(
    `File path is outside the project root: ${absFile} (root: ${absRoot})`,
  );
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Render an error of any LSP-related shape as an MCP error response. The
 * mapping mirrors DESIGN.md L513:
 *
 *   - `LspUnavailableError` subclasses → the categorized hint copy from
 *     `errors.ts` plus the `reason` tag.
 *   - `RequestTimeoutError` (from {@link RequestTimeoutError}) → the
 *     timeout message with a retry hint.
 *   - JSON-RPC errors with a numeric `.code` field — `-32601` becomes a
 *     "method not supported" envelope, others pass through.
 *   - Anything else → a generic envelope echoing `String(err)`.
 *
 * The function never throws. Non-`Error` inputs are stringified so a
 * `throw "oops"` inside a handler still produces a clean envelope.
 */
export function mapLspErrorToResponse(err: unknown): ToolResponse {
  if (err instanceof LspUnavailableError) {
    return createErrorResponse(`LSP ${err.reason}: ${err.message}`, [
      err.recoveryHint,
    ]);
  }
  if (err instanceof RequestTimeoutError) {
    return createErrorResponse(err.message, [
      `Retry the operation; consider increasing the per-request timeout for ${err.method} if persistent.`,
    ]);
  }
  if (typeof err === "object" && err !== null) {
    // JSON-RPC error shape — `vscode-jsonrpc` rejects with an Error whose
    // `code` is the JSON-RPC code. Branch on the documented mapping.
    const code = (err as { code?: number }).code;
    const message = (err as { message?: string }).message ?? String(err);
    if (code === -32601) {
      return createErrorResponse(
        `Operation not supported by Godot's LSP: ${message}`,
        [
          "This LSP capability isn't advertised by Godot's GDScript server. Check `godot --version`.",
        ],
      );
    }
    if (typeof code === "number") {
      return createErrorResponse(`LSP server error (${code}): ${message}`, []);
    }
    if (err instanceof Error) {
      return createErrorResponse(err.message, []);
    }
  }
  return createErrorResponse(String(err), []);
}

// ---------------------------------------------------------------------------
// Client provider + handler envelope
// ---------------------------------------------------------------------------

/**
 * The subset of the {@link import("./client.js").LspClient} API the leaf
 * tools need. Declared structurally so tests can stub without
 * constructing the real client (which requires a process manager,
 * document tracker, queue, and live TCP socket).
 *
 * Only **read-only** capabilities are listed — the advisory-write
 * `godot_preview_rename` tool routes through `request()` like everything
 * else.
 */
export interface LspClientLike {
  /**
   * Send an LSP request through the priority queue. See
   * {@link import("./client.js").LspClient.request} for the contract.
   */
  request<TResult>(
    method: string,
    params: unknown,
    referencedFiles?: readonly string[],
    enqueueOpts?: Partial<EnqueueOptions>,
  ): Promise<TResult>;
  /** Send an LSP notification. */
  notify(method: string, params: unknown): Promise<void>;
  /**
   * Get cached diagnostics for `filePath` with the tiered-await semantics
   * documented on the real client.
   */
  getDiagnostics(filePath: string): Promise<{
    diagnostics: LspDiagnostic[];
    partial: boolean;
  }>;
  /** Server capabilities from the most recent successful handshake. */
  serverCapabilities(): Readonly<KnownServerCapabilities>;
  /**
   * Project root the client is operating against, or null if not yet
   * available. Leaves never need to resolve the root themselves; the
   * provider hands the validated value through.
   */
  projectRoot?(): string | null;
}

/**
 * The lazy provider stored on {@link ToolContext.lsp}. The indirection
 * exists for three reasons:
 *
 *   1. **Init failure tolerance.** DESIGN.md L218: "LSP init failure →
 *      server stays up, LSP tools return errors, other tools work." A
 *      thrown `LspUnavailableError` from `get()` surfaces the categorized
 *      failure to the tool layer; the server stays up because we never
 *      threw at construction.
 *   2. **Lazy connect.** The eager-init flag aside, the client itself is
 *      lazy on first `request()`. The provider just hands the singleton
 *      handle back; it doesn't trigger a connect.
 *   3. **Testability.** Per-tool tests can supply a tiny stub matching
 *      this interface without booting the real subsystem.
 */
export interface LspProvider {
  /**
   * Return the live client handle. Throws an `LspUnavailableError`
   * subclass when the subsystem is permanently unavailable for this
   * session (e.g. spawn-cap exhausted, project path invalid). Synchronous
   * by design — the caller is on a tool-handler hot path and a
   * synchronous fast-path keeps the error mapping in one place.
   */
  get(): LspClientLike;
  /**
   * Return the validated project root the client is anchored to. Null if
   * the subsystem failed before reaching project-detection. Synchronous
   * for the same reason as {@link get}.
   */
  projectRoot(): string | null;
}

/**
 * The bundle a leaf-tool handler receives from {@link withLspClient}. The
 * shape is deliberately small so unit tests can construct one inline.
 */
export interface LspToolContext {
  /** The live (or stubbed) client. */
  client: LspClientLike;
  /** Validated absolute project root. Guaranteed non-null when present. */
  projectRoot: string;
}

/**
 * Synchronous resolution of `ctx.lsp` into an {@link LspToolContext}. Used
 * by {@link withLspClient} but exposed independently so tests can assert
 * each failure branch without a handler closure.
 *
 * Returns a discriminated `ok` / `error` result; `error` carries a
 * pre-built `ToolResponse` so the caller can return it without further
 * shaping.
 */
export function resolveLspContext(
  ctx: ToolContext,
):
  | { kind: "ok"; client: LspClientLike; projectRoot: string }
  | { kind: "error"; response: ToolResponse } {
  if (!ctx.lsp) {
    return {
      kind: "error",
      response: createErrorResponse("LSP subsystem is not configured.", [
        "Ensure `GODOT_PATH` points to a Godot 4.x binary and `GODOT_LSP_PROJECT_PATH` (or cwd-detected `project.godot`) is set.",
      ]),
    };
  }
  let client: LspClientLike;
  try {
    // `ToolContext.lsp.get` is typed `unknown` at the seam to avoid a
    // `shared → lsp` import cycle; the cast lands here so the leaves
    // and helpers see the structural shape they actually use.
    client = ctx.lsp.get() as LspClientLike;
  } catch (err) {
    return { kind: "error", response: mapLspErrorToResponse(err) };
  }
  const projectRoot = ctx.lsp.projectRoot();
  if (projectRoot === null) {
    return {
      kind: "error",
      response: createErrorResponse(
        "LSP subsystem is not configured: no project root resolved.",
        [
          "Set `GODOT_LSP_PROJECT_PATH` to your Godot project directory, or start the server from inside a project tree (the auto-detector walks up looking for `project.godot`).",
        ],
      ),
    };
  }
  return { kind: "ok", client, projectRoot };
}

/**
 * Run a leaf-tool handler body against the live LSP client, mapping any
 * categorized failure to an MCP error envelope.
 *
 * Catch behavior:
 *   - `LspUnavailableError` (any subclass) → mapped via
 *     {@link mapLspErrorToResponse}.
 *   - `RequestTimeoutError` → mapped via {@link mapLspErrorToResponse}.
 *   - Anything else → re-thrown unchanged. Programmer-bug paths (e.g.
 *     `TypeError`, `RangeError`) need to surface uncaught so the
 *     surrounding observability layer can see them; quietly returning a
 *     "something went wrong" envelope would mask correctness issues.
 *
 * Tiered-recovery deferral note (per #8 PR description): a
 * {@link LspConnectionLostError} that arrives mid-request would, with
 * the deferred recovery layer, trigger a respawn-then-retry cycle. In its
 * absence we surface the categorized error with the "retry the
 * operation" hint. Tools should NOT silently retry; the user-facing
 * behavior is uniform until #8's follow-up lands.
 */
export async function withLspClient(
  ctx: ToolContext,
  handler: (lsp: LspToolContext) => Promise<ToolResponse>,
): Promise<ToolResponse> {
  const resolved = resolveLspContext(ctx);
  if (resolved.kind === "error") {
    return resolved.response;
  }
  try {
    return await handler({
      client: resolved.client,
      projectRoot: resolved.projectRoot,
    });
  } catch (err) {
    if (
      err instanceof LspUnavailableError ||
      err instanceof RequestTimeoutError
    ) {
      return mapLspErrorToResponse(err);
    }
    throw err;
  }
}

// Re-export the diagnostic shape so leaves can import everything from
// this barrel rather than reaching back into `client.js`.
export type { DiagnosticCacheEntry, LspDiagnostic };
