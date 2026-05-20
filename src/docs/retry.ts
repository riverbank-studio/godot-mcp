/**
 * Exponential-backoff retry helper used by the docs ingestion network
 * fetchers (codeload tarball, GitHub Tags API). Pulled out of `ingest.ts`
 * so the backoff schedule lives in one tested place that's reusable from
 * `latest.ts` and any future fetcher.
 *
 * Schedule (DESIGN.md L259):
 *   - 5 attempts total (1 initial + 4 retries).
 *   - Backoff: 1s, 2s, 4s, 8s, 16s (exponential base 2).
 *   - Jitter: +/- 25% per interval.
 *   - Per-interval cap: 30s.
 *   - Overall ceiling: 60s of cumulative sleep — once `now() - start`
 *     would exceed the ceiling after the next sleep, give up rather than
 *     spend the budget on a sleep we know won't help.
 *   - 4xx HTTP statuses are not retried (likely user error, e.g. a typo
 *     in the tag name); 5xx + network errors retry.
 */

/**
 * Sentinel error thrown when the retry budget is exhausted. Wraps the
 * final inner error via `cause` so callers can inspect the underlying
 * failure without losing the retry context.
 *
 * Distinguished from a vanilla failure so the top-level ingest handler
 * can map "5 attempts all failed" to a different exit code (network
 * failure → exit 1) than "4xx, gave up immediately" (user error → exit 2)
 * — that mapping lives in `ingest.ts`, not here.
 */
export class RetryGiveUpError extends Error {
  /** The last inner error encountered before giving up. */
  readonly attempts: number;

  constructor(message: string, attempts: number, cause: unknown) {
    super(message);
    this.name = "RetryGiveUpError";
    this.attempts = attempts;
    // Node `Error` supports a `cause` field on construction; we set it via
    // the property here to preserve compatibility with older `Error`
    // constructors in test contexts.
    (this as { cause?: unknown }).cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RetryGiveUpError);
    }
  }
}

/**
 * Clock interface — passed in so tests can use a deterministic
 * `now/sleep/random` trio instead of real timers. Production callers omit
 * the field and get `realClock`.
 */
export interface RetryClock {
  /** Wall-clock-ish millisecond reading; only delta matters. */
  now(): number;
  /** Async sleep. Tests' fake sleeps return immediately and advance `now`. */
  sleep(ms: number): Promise<void>;
  /** Uniform `[0, 1)`. Tests inject a constant to make jitter predictable. */
  random(): number;
}

/**
 * Real-time clock. Uses `Date.now()` and `setTimeout`. Hidden behind the
 * interface so `retryWithBackoff` never imports timers directly.
 */
export const realClock: RetryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * Options for `retryWithBackoff`. All fields have defaults matching
 * DESIGN.md L259.
 */
export interface RetryOptions {
  /** Max number of attempts (1 initial + N-1 retries). Default 5. */
  maxAttempts?: number;
  /** Per-interval cap in ms. Default 30000. */
  perIntervalCapMs?: number;
  /** Overall cumulative-sleep ceiling in ms. Default 60000. */
  overallCeilingMs?: number;
  /** Clock fixture. Default `realClock`. */
  clock?: RetryClock;
  /**
   * When true, the call resolves to `{value, attempts}` instead of bare
   * `value`. Callers that need to populate `retries` in the ingest report
   * (DESIGN.md L267) use this to avoid an out-of-band counter.
   */
  collectStats?: boolean;
}

/**
 * Compute the backoff for a given (1-indexed) attempt number with a
 * specific random sample. Exported so tests can pin the random value and
 * assert the exact ms.
 *
 * Formula: `base = 1000 * 2^(attempt-1)`, then jitter
 * `multiplier = 1 + (random - 0.5) * 0.5` (uniform +/-25%), then cap at
 * `perIntervalCapMs`.
 */
export function computeBackoffMs(
  attempt: number,
  random: number,
  perIntervalCapMs = 30000,
): number {
  const base = 1000 * Math.pow(2, attempt - 1);
  const jitter = 1 + (random - 0.5) * 0.5; // +/-25%
  return Math.min(Math.round(base * jitter), perIntervalCapMs);
}

/**
 * Classify an HTTP status code (or `undefined` for network-level errors)
 * as retryable. 5xx and network errors retry; 4xx and other client-side
 * conditions do not.
 *
 * Operations report status via `statusCode` on their thrown error:
 *
 *   ```ts
 *   throw Object.assign(new Error("bad response"), { statusCode: 503 });
 *   ```
 */
export function isRetryableHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Generic shape of an error that the retry helper can classify. The
 * `statusCode` field is the convention used across the docs subsystem;
 * operations that throw vanilla `Error`s are treated as network failures
 * (retryable).
 */
interface RetryableError {
  statusCode?: number;
}

/**
 * Retry an async operation with exponential backoff. Two call shapes:
 *
 *   - `retryWithBackoff(op)` resolves to `op`'s return value.
 *   - `retryWithBackoff(op, {collectStats: true})` resolves to
 *     `{value, attempts}` so the caller can record `retries = attempts-1`
 *     in the ingest report.
 *
 * Throws `RetryGiveUpError` when the budget is exhausted. Throws the
 * inner error verbatim when it's classified as non-retryable (e.g. 4xx)
 * so the caller's `catch` doesn't have to unwrap.
 */
export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  options: RetryOptions & { collectStats: true },
): Promise<{ value: T; attempts: number }>;
export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  options?: RetryOptions,
): Promise<T>;
export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T | { value: T; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? 5;
  const perIntervalCapMs = options.perIntervalCapMs ?? 30000;
  const overallCeilingMs = options.overallCeilingMs ?? 60000;
  const clock = options.clock ?? realClock;

  const start = clock.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await op();
      if (options.collectStats) return { value, attempts: attempt };
      return value;
    } catch (err) {
      lastError = err;
      const status = (err as RetryableError | null)?.statusCode;
      if (!isRetryableHttpStatus(status)) {
        // Non-retryable — re-throw verbatim. Callers distinguish this
        // from a budget-exhaustion via the error type.
        throw err;
      }
      if (attempt === maxAttempts) break;
      const sleepMs = computeBackoffMs(
        attempt,
        clock.random(),
        perIntervalCapMs,
      );
      const elapsed = clock.now() - start;
      if (elapsed + sleepMs > overallCeilingMs) {
        // The next sleep alone would push us past the ceiling. Give up
        // now rather than burn budget on a sleep we know won't yield
        // another attempt.
        break;
      }
      await clock.sleep(sleepMs);
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new RetryGiveUpError(
    `Retry budget exhausted after ${maxAttempts} attempt(s): ${message}`,
    maxAttempts,
    lastError,
  );
}
