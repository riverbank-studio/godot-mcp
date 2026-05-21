/**
 * Tests for `retry` — exponential-backoff helper with jitter, 4xx no-retry,
 * 5xx + network retry, and overall ceiling enforcement (DESIGN.md L259).
 */

import { describe, it, expect, vi } from "vitest";

import {
  retryWithBackoff,
  RetryGiveUpError,
  isRetryableHttpStatus,
  computeBackoffMs,
  type RetryClock,
} from "./retry.js";

/**
 * Build a deterministic clock fixture: `now()` is monotonically advanced
 * by recorded sleeps, and `random()` returns a fixed value so jitter is
 * predictable.
 */
function makeClock(opts: { random?: number } = {}): RetryClock & {
  sleeps: number[];
  elapsed: () => number;
} {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    random: () => opts.random ?? 0.5,
    sleeps,
    elapsed: () => nowMs,
  };
}

describe("computeBackoffMs", () => {
  it("produces 1/2/4/8/16s baseline for attempts 1..5", () => {
    // With random=0.5, jitter multiplier = 1.0 (centered).
    expect(computeBackoffMs(1, 0.5)).toBe(1000);
    expect(computeBackoffMs(2, 0.5)).toBe(2000);
    expect(computeBackoffMs(3, 0.5)).toBe(4000);
    expect(computeBackoffMs(4, 0.5)).toBe(8000);
    expect(computeBackoffMs(5, 0.5)).toBe(16000);
  });

  it("caps each interval at 30s", () => {
    // attempt 6 would be 32000ms uncapped.
    expect(computeBackoffMs(6, 0.5)).toBe(30000);
    expect(computeBackoffMs(7, 0.5)).toBe(30000);
  });

  it("applies +-25% jitter via the random function", () => {
    // random=0 → -25% (full negative jitter).
    expect(computeBackoffMs(1, 0)).toBe(750);
    // random=1 → +25% (full positive jitter).
    expect(computeBackoffMs(1, 1)).toBe(1250);
  });
});

describe("isRetryableHttpStatus", () => {
  it("treats 5xx as retryable", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  it("treats 4xx as not retryable", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
    expect(isRetryableHttpStatus(499)).toBe(false);
  });

  it("treats network errors (no status) as retryable", () => {
    expect(isRetryableHttpStatus(undefined)).toBe(true);
  });
});

describe("retryWithBackoff", () => {
  it("returns on first success without sleeping", async () => {
    const clock = makeClock();
    const op = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(op, { clock });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("retries up to 5 attempts on retryable error", async () => {
    const clock = makeClock();
    const err = Object.assign(new Error("boom"), { statusCode: 503 });
    const op = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(op, { clock });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    // Two sleeps before the successful third attempt: 1s and 2s (with random=0.5 → no jitter).
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after maxAttempts (default 5) with the last error wrapped", async () => {
    const clock = makeClock();
    const err = Object.assign(new Error("upstream-fail"), { statusCode: 502 });
    const op = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(op, { clock })).rejects.toThrow(
      RetryGiveUpError,
    );
    expect(op).toHaveBeenCalledTimes(5);
    // Four sleeps before the final attempt (between attempts 1→2, 2→3, 3→4, 4→5).
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it("does not retry 4xx errors", async () => {
    const clock = makeClock();
    const err = Object.assign(new Error("not-found"), { statusCode: 404 });
    const op = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(op, { clock })).rejects.toThrow(/not-found/);
    expect(op).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("aborts when the overall ceiling would be exceeded", async () => {
    // 60s ceiling: by attempt 5 the cumulative sleep is 1+2+4+8 = 15s; the
    // ceiling kicks in for longer runs (set artificially low here).
    const clock = makeClock();
    const err = Object.assign(new Error("retry me"), { statusCode: 503 });
    const op = vi.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(op, { clock, overallCeilingMs: 2500 }),
    ).rejects.toThrow(RetryGiveUpError);
    // First attempt + 1s sleep (1000ms) → second attempt fails → 2s sleep
    // would push elapsed to 3000ms, exceeding the 2500ms ceiling, so abort.
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("treats undefined statusCode (network error) as retryable", async () => {
    const clock = makeClock();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(op, { clock });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("counts retry attempts in the result-with-stats variant", async () => {
    const clock = makeClock();
    const err = Object.assign(new Error("flaky"), { statusCode: 503 });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    const { value, attempts } = await retryWithBackoff(op, {
      clock,
      collectStats: true,
    });
    expect(value).toBe("ok");
    expect(attempts).toBe(2);
  });
});
