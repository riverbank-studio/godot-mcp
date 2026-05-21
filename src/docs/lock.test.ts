/**
 * Tests for `lock` — the diagnostic lock-file format helper
 * (DESIGN.md L280: pid, nonce, startedAt, heartbeatAt).
 *
 * The OS-level lock (`flock`/`LockFileEx`) is not unit-tested here — it
 * needs cross-process coordination; integration tests live in #11/CI.
 * What IS tested is the diagnostic-file shape, heartbeat update, and the
 * "is this writer stale?" predicate.
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildLockFileContent,
  parseLockFileContent,
  isWriterStale,
  HEARTBEAT_INTERVAL_MS,
  STALE_HEARTBEAT_THRESHOLD_MS,
  type LockDiagnostic,
} from "./lock.js";

describe("lock-file format", () => {
  it("buildLockFileContent emits parseable JSON with the four fields", () => {
    const diag: LockDiagnostic = {
      pid: 12345,
      nonce: "abc123def456",
      startedAt: "2026-05-20T18:00:00.000Z",
      heartbeatAt: "2026-05-20T18:00:00.000Z",
    };
    const content = buildLockFileContent(diag);
    const parsed = JSON.parse(content) as LockDiagnostic;
    expect(parsed).toEqual(diag);
  });

  it("parseLockFileContent round-trips a buildLockFileContent record", () => {
    const diag: LockDiagnostic = {
      pid: 99,
      nonce: "0123456789abcdef",
      startedAt: "2026-05-20T18:00:00.000Z",
      heartbeatAt: "2026-05-20T18:00:05.000Z",
    };
    const parsed = parseLockFileContent(buildLockFileContent(diag));
    expect(parsed).toEqual(diag);
  });

  it("parseLockFileContent throws on malformed JSON", () => {
    expect(() => parseLockFileContent("not json")).toThrow();
  });

  it("parseLockFileContent throws on missing fields", () => {
    expect(() => parseLockFileContent('{"pid": 1}')).toThrow(
      /nonce|heartbeat|startedAt/,
    );
  });
});

describe("isWriterStale", () => {
  it("returns true when the heartbeat is older than the threshold", () => {
    const diag: LockDiagnostic = {
      pid: 1,
      nonce: "x",
      startedAt: "2026-05-20T18:00:00.000Z",
      heartbeatAt: "2026-05-20T18:00:00.000Z",
    };
    const now = new Date("2026-05-20T18:02:00.000Z").getTime();
    expect(isWriterStale(diag, now)).toBe(true);
  });

  it("returns false when the heartbeat is recent", () => {
    const diag: LockDiagnostic = {
      pid: 1,
      nonce: "x",
      startedAt: "2026-05-20T18:00:00.000Z",
      heartbeatAt: "2026-05-20T18:00:55.000Z",
    };
    const now = new Date("2026-05-20T18:01:00.000Z").getTime();
    expect(isWriterStale(diag, now)).toBe(false);
  });

  it("uses STALE_HEARTBEAT_THRESHOLD_MS as the boundary", () => {
    const now = Date.now();
    const recentDiag: LockDiagnostic = {
      pid: 1,
      nonce: "x",
      startedAt: new Date(now).toISOString(),
      heartbeatAt: new Date(
        now - (STALE_HEARTBEAT_THRESHOLD_MS - 1000),
      ).toISOString(),
    };
    expect(isWriterStale(recentDiag, now)).toBe(false);
    const staleDiag: LockDiagnostic = {
      ...recentDiag,
      heartbeatAt: new Date(
        now - (STALE_HEARTBEAT_THRESHOLD_MS + 1000),
      ).toISOString(),
    };
    expect(isWriterStale(staleDiag, now)).toBe(true);
  });
});

describe("heartbeat interval invariants", () => {
  it("HEARTBEAT_INTERVAL_MS matches the design (5s)", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(5000);
  });

  it("STALE_HEARTBEAT_THRESHOLD_MS is the design's 60s", () => {
    expect(STALE_HEARTBEAT_THRESHOLD_MS).toBe(60000);
  });

  it("the stale threshold is at least 10x the heartbeat interval", () => {
    // If a writer misses up to 11 consecutive heartbeats (GC pause, slow
    // disk), we should not reclaim — design margin per L280.
    expect(STALE_HEARTBEAT_THRESHOLD_MS).toBeGreaterThanOrEqual(
      10 * HEARTBEAT_INTERVAL_MS,
    );
  });
});

describe("writeLockDiagnostic (filesystem integration)", () => {
  it("writes a valid JSON file at the given path", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
    const lockPath = path.join(tmpdir, "docs-4.5.lock");
    try {
      const { writeLockDiagnostic } = await import("./lock.js");
      writeLockDiagnostic(lockPath, {
        pid: 7,
        nonce: "n",
        startedAt: "2026-05-20T00:00:00.000Z",
        heartbeatAt: "2026-05-20T00:00:00.000Z",
      });
      const content = fs.readFileSync(lockPath, "utf8");
      const parsed = parseLockFileContent(content);
      expect(parsed.pid).toBe(7);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

describe("startHeartbeat", () => {
  it("invokes the writer at the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const { startHeartbeat } = await import("./lock.js");
      const write = vi.fn();
      const stop = startHeartbeat({
        write,
        intervalMs: 50,
      });
      vi.advanceTimersByTime(125);
      expect(write).toHaveBeenCalledTimes(2);
      stop();
      vi.advanceTimersByTime(100);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
