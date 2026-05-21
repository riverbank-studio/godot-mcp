/**
 * Lazy document tracking with mtime/size-shortcircuited auto-resync.
 *
 * Implements `docs/DESIGN.md` § Document tracking and the Wave 2 amendment
 * "Auto-resync mtime-shortcircuit (D11)":
 *
 *   - **didOpen timing:** Lazy. When a tool call references a file,
 *     `didOpen` if not already tracked.
 *   - **File filtering:** Only `.gd` and `.gdshader` files. Other types are
 *     silently ignored.
 *   - **Auto-resync:** before any LSP query, `fs.stat` each tracked file
 *     referenced by the current call PLUS any tracked file whose stat
 *     (mtime+size) has changed since the last sync check. Only files whose
 *     stat changed are re-read and emitted as `didChange`.
 *   - The broader tracked-set is stat-checked at most once per
 *     {@link LspConfig.statPollThrottleMs} ms via a shared timestamp.
 *
 * This module is **standalone**: it does I/O on the local filesystem and
 * emits events describing what `didOpen` / `didChange` should be sent.
 * Wiring those events to the LSP wire happens in `client.ts`. Splitting
 * the responsibilities keeps the tracker testable without an LSP harness.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The two file extensions Godot's LSP cares about. Anything else is
 * ignored: per DESIGN.md L432, "only `.gd` and `.gdshader` files."
 */
export const TRACKED_EXTENSIONS: readonly string[] = [".gd", ".gdshader"];

/**
 * The minimal subset of `fs.Stats` we depend on. Declared structurally so
 * tests can pass a `{ mtimeMs, size }` literal without constructing a real
 * `Stats` object.
 */
export interface StatLike {
  mtimeMs: number;
  size: number;
}

/**
 * One tracked open document. The text content isn't retained between
 * syncs — we re-read on stat change. Keeping content out of memory avoids
 * an unbounded memory cap for very large projects (DESIGN.md L433).
 */
interface TrackedDocument {
  /** Absolute filesystem path. */
  filePath: string;
  /** Last-observed `(mtimeMs, size)` pair from `fs.stat`. */
  lastStat: StatLike;
  /**
   * Monotonic version counter. Incremented on every `didChange` emission;
   * passed through to the LSP wire so Godot's server can correlate.
   */
  version: number;
  /**
   * True after the first successful `publishDiagnostics` await for this
   * URI in the session. Used by the diagnostic await tier (10s first
   * touch, 2s subsequent) — owned here so the lifetime matches the
   * tracked-open set.
   */
  diagnosticsTouched: boolean;
}

/**
 * One event the tracker emits to the LSP wire layer. The event type maps
 * 1:1 to an LSP notification the client will send.
 */
export type DocumentEvent =
  | {
      kind: "didOpen";
      filePath: string;
      version: number;
      text: string;
    }
  | {
      kind: "didChange";
      filePath: string;
      version: number;
      text: string;
    };

/**
 * Filesystem ops the tracker depends on. Production wires this to
 * `node:fs`; tests inject an in-memory fake.
 */
export interface DocumentFs {
  /** Synchronous stat; returns `null` if the file is missing or unreadable. */
  statSync(filePath: string): StatLike | null;
  /** Synchronous read; throws on missing file. */
  readFileSync(filePath: string): string;
}

/**
 * Default {@link DocumentFs} wrapping `node:fs`.
 */
export function nodeFs(): DocumentFs {
  return {
    statSync(filePath: string): StatLike | null {
      try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) return null;
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    },
    readFileSync(filePath: string): string {
      return fs.readFileSync(filePath, "utf8");
    },
  };
}

/**
 * Construction options for {@link DocumentTracker}. Tests inject `now()`
 * and `fs` to keep the throttle deterministic without real wall-clock.
 */
export interface DocumentTrackerOptions {
  /** Stat-poll throttle in ms for the broader tracked-set sweep. */
  statPollThrottleMs: number;
  /** Filesystem accessor. Defaults to {@link nodeFs} in production. */
  fs?: DocumentFs;
  /** Wall-clock source in ms. Defaults to `Date.now`. Tests inject. */
  now?: () => number;
}

/**
 * Lazy `didOpen` tracker + auto-resync engine. One instance per LSP
 * connection. On disconnect/respawn the tracker is **discarded** — Godot's
 * LSP loses document state on its side, so the next reference re-opens
 * from scratch.
 */
export class DocumentTracker {
  private readonly fs: DocumentFs;
  private readonly now: () => number;
  private readonly statPollThrottleMs: number;
  private readonly tracked = new Map<string, TrackedDocument>();
  /** Wall-clock of the most recent broader-set stat sweep. 0 == never. */
  private lastSweepAt = 0;

  constructor(opts: DocumentTrackerOptions) {
    this.fs = opts.fs ?? nodeFs();
    this.now = opts.now ?? Date.now;
    this.statPollThrottleMs = opts.statPollThrottleMs;
  }

  /**
   * Returns true when `filePath` has an extension Godot's LSP cares
   * about. Case-insensitive — the LSP doesn't distinguish `.gd` from
   * `.GD` on Windows, and neither do we.
   */
  static isTracked(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return TRACKED_EXTENSIONS.includes(ext);
  }

  /**
   * Sync state for an LSP call that references `referencedFiles`. Returns
   * the events the wire layer must emit (in order) before the LSP request
   * goes out.
   *
   * Algorithm (DESIGN.md L435 + Wave 2 D11):
   *   1. The current call's referenced files are stat'd unconditionally
   *      and `didOpen` / `didChange` emitted as needed.
   *   2. The broader tracked-set is stat-swept at most once per
   *      {@link statPollThrottleMs} ms; any file whose `(mtimeMs, size)`
   *      changed emits `didChange`.
   *
   * Files outside the tracked-extension set are silently ignored.
   */
  syncReferenced(referencedFiles: readonly string[]): DocumentEvent[] {
    const events: DocumentEvent[] = [];

    // 1. Unconditional stat for the current call's referenced files.
    const referenced = new Set<string>();
    for (const raw of referencedFiles) {
      if (!DocumentTracker.isTracked(raw)) continue;
      const abs = path.resolve(raw);
      referenced.add(abs);
      const ev = this.syncOne(abs);
      if (ev) events.push(ev);
    }

    // 2. Broader tracked-set sweep, throttled. Skip any file already
    //    handled in step 1 — repeating its stat is pointless.
    const t = this.now();
    if (t - this.lastSweepAt >= this.statPollThrottleMs) {
      this.lastSweepAt = t;
      for (const abs of this.tracked.keys()) {
        if (referenced.has(abs)) continue;
        const ev = this.diffOne(abs);
        if (ev) events.push(ev);
      }
    }
    return events;
  }

  /**
   * Whether `filePath` is currently in the tracked-open set.
   */
  isOpen(filePath: string): boolean {
    return this.tracked.has(path.resolve(filePath));
  }

  /**
   * Mark `filePath` as having received its first `publishDiagnostics` push
   * in the session. Subsequent awaits use the steady-state timeout.
   * Returns the previous value so the client can branch on first-touch
   * without a second lookup.
   */
  markDiagnosticsTouched(filePath: string): boolean {
    const abs = path.resolve(filePath);
    const doc = this.tracked.get(abs);
    if (!doc) return false;
    const prev = doc.diagnosticsTouched;
    doc.diagnosticsTouched = true;
    return prev;
  }

  /**
   * True iff `filePath` has already had its first `publishDiagnostics`
   * await in the session. Surfaced so the client can pick the correct
   * timeout tier (10s first-touch vs 2s steady-state) before issuing the
   * diagnostic-await race.
   */
  diagnosticsTouched(filePath: string): boolean {
    const abs = path.resolve(filePath);
    return this.tracked.get(abs)?.diagnosticsTouched ?? false;
  }

  /**
   * Drop all tracked state. Called when the LSP connection is torn down;
   * the next reference will re-`didOpen` from scratch.
   */
  reset(): void {
    this.tracked.clear();
    this.lastSweepAt = 0;
  }

  /**
   * Open or diff one file. Returns the event the wire must send, or
   * `null` when nothing needs doing (file unchanged, or it doesn't exist
   * and was never opened).
   */
  private syncOne(absPath: string): DocumentEvent | null {
    const stat = this.fs.statSync(absPath);
    const existing = this.tracked.get(absPath);
    if (!stat) {
      // File doesn't exist. If it was tracked, drop it; the caller is
      // expected to surface a tool-level error for the missing file.
      if (existing) this.tracked.delete(absPath);
      return null;
    }
    if (!existing) {
      // First reference — emit didOpen.
      const text = this.fs.readFileSync(absPath);
      this.tracked.set(absPath, {
        filePath: absPath,
        lastStat: { mtimeMs: stat.mtimeMs, size: stat.size },
        version: 1,
        diagnosticsTouched: false,
      });
      return {
        kind: "didOpen",
        filePath: absPath,
        version: 1,
        text,
      };
    }
    // Already tracked — diff and possibly emit didChange.
    return this.diffOne(absPath);
  }

  /**
   * For an already-tracked file: if its stat has drifted from the
   * last-known, re-read and emit `didChange`. Otherwise null.
   */
  private diffOne(absPath: string): DocumentEvent | null {
    const existing = this.tracked.get(absPath);
    if (!existing) return null;
    const stat = this.fs.statSync(absPath);
    if (!stat) {
      // File vanished. Drop tracking; tool layer surfaces the error.
      this.tracked.delete(absPath);
      return null;
    }
    if (
      stat.mtimeMs === existing.lastStat.mtimeMs &&
      stat.size === existing.lastStat.size
    ) {
      return null;
    }
    const text = this.fs.readFileSync(absPath);
    existing.lastStat = { mtimeMs: stat.mtimeMs, size: stat.size };
    existing.version += 1;
    return {
      kind: "didChange",
      filePath: absPath,
      version: existing.version,
      text,
    };
  }
}
