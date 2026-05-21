/**
 * Lock-file helpers for cross-process ingestion mutex (DESIGN.md L280).
 *
 * The **actual** mutual-exclusion is an OS advisory lock (`flock` on
 * POSIX, `LockFileEx` on Windows) acquired before any of the helpers
 * here run. The on-disk `docs-{version}.lock` file is **diagnostic only**:
 * its contents (`{pid, nonce, startedAt, heartbeatAt}`) make liveness
 * observable for forensic debugging and stale-writer detection.
 *
 * Why split the concerns
 * ----------------------
 * The OS-level lock is what guarantees safety; the file is what gives
 * operators a way to answer "is the writer alive?" without poking at
 * `/proc` or task manager. This module owns only the file's format,
 * the heartbeat loop, and the staleness predicate — the OS lock
 * acquisition is performed by `ingest.ts` and is unit-tested at the
 * integration level (cross-process invocation), not here.
 */

import * as fs from "node:fs";

/**
 * Heartbeat interval (DESIGN.md L280: "every 5 seconds"). The writer
 * touches `heartbeatAt` at this cadence so observers can detect a hung
 * writer.
 */
export const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Threshold for considering a writer hung. A writer whose last
 * heartbeat is more than this long ago is reclaimable (after OS-lock
 * acquisition + nonce verification). Set to 12 missed heartbeats so a
 * brief GC pause or slow disk doesn't trigger reclaim.
 */
export const STALE_HEARTBEAT_THRESHOLD_MS = 60000;

/**
 * Lock-file diagnostic shape. The OS lock is the source of truth; this
 * record exists for observability.
 */
export interface LockDiagnostic {
  /** Writer process PID. Subject to PID reuse on long-running systems. */
  pid: number;
  /**
   * 16+ char random hex string. Used by the reclaim path to detect
   * Windows PID-reuse: a reclaimer acquires the OS lock then verifies
   * the file's nonce hasn't changed (which would mean another writer
   * grabbed the lock between observation and reclaim).
   */
  nonce: string;
  /** ISO 8601 UTC timestamp of writer start. */
  startedAt: string;
  /** ISO 8601 UTC timestamp of the last heartbeat. Updated every 5s. */
  heartbeatAt: string;
}

/**
 * Serialize a diagnostic record to the on-disk format (pretty-printed
 * JSON so a `cat` reveals the four fields at a glance).
 */
export function buildLockFileContent(diag: LockDiagnostic): string {
  return JSON.stringify(diag, null, 2) + "\n";
}

/**
 * Parse a lock-file content string back into a diagnostic record. The
 * function is strict: missing or wrong-typed fields throw rather than
 * silently default, because a malformed lock file is itself a signal
 * (something other than this codebase wrote there).
 */
export function parseLockFileContent(raw: string): LockDiagnostic {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) {
    throw new Error("lock-file: top-level must be a JSON object");
  }
  const pid = parsed.pid;
  const nonce = parsed.nonce;
  const startedAt = parsed.startedAt;
  const heartbeatAt = parsed.heartbeatAt;
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    throw new Error("lock-file: pid must be an integer");
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("lock-file: nonce must be a non-empty string");
  }
  if (typeof startedAt !== "string") {
    throw new Error("lock-file: startedAt must be an ISO 8601 string");
  }
  if (typeof heartbeatAt !== "string") {
    throw new Error("lock-file: heartbeatAt must be an ISO 8601 string");
  }
  return { pid, nonce, startedAt, heartbeatAt };
}

/**
 * "Is this writer hung?" predicate. Returns true when the diagnostic's
 * heartbeat is older than {@link STALE_HEARTBEAT_THRESHOLD_MS} relative
 * to `now`.
 *
 * The reclaim path follows up by:
 *   1. Acquiring the OS lock (which will succeed iff the writer is
 *      truly dead — OS locks are released on process exit).
 *   2. Verifying the on-disk nonce hasn't changed since observation.
 *      Mismatch means another reclaimer (or a fresh writer) grabbed
 *      the lock first; we bail out and re-observe.
 */
export function isWriterStale(diag: LockDiagnostic, now: number): boolean {
  const heartbeatMs = Date.parse(diag.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return true;
  return now - heartbeatMs > STALE_HEARTBEAT_THRESHOLD_MS;
}

/**
 * Write a diagnostic record to disk. Uses `writeFileSync` (atomic on
 * POSIX for sub-PIPE_BUF writes; the lock file is tiny) so a partial
 * write can't be observed.
 *
 * The caller (heartbeat loop) re-invokes this every
 * `HEARTBEAT_INTERVAL_MS` to update `heartbeatAt`.
 */
export function writeLockDiagnostic(
  lockPath: string,
  diag: LockDiagnostic,
): void {
  fs.writeFileSync(lockPath, buildLockFileContent(diag), { encoding: "utf8" });
}

/**
 * Inputs to `startHeartbeat`. The `write` callback is invoked at each
 * tick to refresh the heartbeat; the caller owns the lock-file path and
 * the diagnostic record's other fields so this helper doesn't have to
 * carry them.
 */
export interface HeartbeatOptions {
  /** Tick callback. Typically rewrites the lock file with an updated `heartbeatAt`. */
  write(): void;
  /** Interval in ms. Defaults to {@link HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
}

/**
 * Start the heartbeat timer. Returns a `stop()` function that cancels
 * the interval. The first heartbeat fires after `intervalMs` — callers
 * who need an immediate first write should do it before calling this.
 *
 * `setInterval` is `unref`'d so the heartbeat doesn't keep the process
 * alive after the ingest completes.
 */
export function startHeartbeat(opts: HeartbeatOptions): () => void {
  const interval = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const handle = setInterval(opts.write, interval);
  // `unref` is best-effort — node 24 has it on all timer handles.
  if (typeof (handle as NodeJS.Timeout).unref === "function") {
    (handle as NodeJS.Timeout).unref();
  }
  return () => clearInterval(handle);
}

/**
 * Narrow `unknown` to a JSON object.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
