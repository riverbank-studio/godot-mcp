/**
 * InitLatch — a typed one-shot promise with lifecycle states, designed for
 * use by every subsystem that needs init gating + recovery (docs, LSP).
 *
 * Source: `docs/DESIGN.md` § Architecture → Shared infrastructure,
 * Wave 2 amendment D8 documented inline in #5.
 *
 * The primitive differs from a plain `Promise<T>` in three load-bearing ways
 * that downstream Wave 3+ subsystems rely on:
 *
 *  1. **Synchronous state introspection** via `state()`. LSP's `unavailable`
 *     surface tests `state().kind === "failed"` without awaiting anything; a
 *     plain promise has no equivalent.
 *  2. **`reset()` for respawn / refetch retry.** LSP respawns and docs
 *     runtime-refetch both need to clear a settled latch back to pending and
 *     accept a fresh `resolve` or `reject`. With a plain promise the holder
 *     would have to swap the entire instance and notify every consumer; here
 *     consumers re-call `await()` on the same handle.
 *  3. **In-flight rejection on reset** with the sentinel `LatchResetError`.
 *     Callers awaiting the previous lifecycle can distinguish "the latch was
 *     reset out from under me" from a real `reject(error)` they were waiting
 *     for, so cancel-handling and error-reporting don't conflate.
 *
 * Settlement (`resolve` / `reject`) is **strictly idempotent**: the second
 * call throws synchronously. This surfaces double-init bugs immediately
 * rather than letting them hide as silent no-ops. After `reset()` the arming
 * is cleared and the latch can be settled again.
 */

/**
 * Sentinel thrown to in-flight `await()` callers when `reset()` is called.
 * Callers can `instanceof LatchResetError` to distinguish reset-cancellation
 * from a real failure they were awaiting via `reject`.
 */
export class LatchResetError extends Error {
  constructor(message = "InitLatch was reset while await() was pending") {
    super(message);
    this.name = "LatchResetError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LatchResetError);
    }
  }
}

/**
 * The full lifecycle state of an `InitLatch<T>`. Returned by `state()` for
 * synchronous introspection.
 */
export type LatchState<T> =
  | { kind: "pending" }
  | { kind: "ready"; value: T }
  | { kind: "failed"; error: Error };

/**
 * The public API of an `InitLatch<T>`. See module docstring for the rationale
 * behind the lifecycle semantics; the per-method JSDoc here is the contract.
 */
export interface InitLatch<T> {
  /**
   * Snapshot the current state. Returns a fresh discriminated union value
   * each call so callers cannot accidentally mutate latch internals.
   */
  state(): LatchState<T>;

  /**
   * Wait for the latch to settle.
   *
   * - `pending`  → returns a promise that settles when the next `resolve`,
   *   `reject`, or `reset` happens. `reset` rejects with `LatchResetError`.
   * - `ready`    → returns a pre-resolved promise carrying the stored value.
   * - `failed`   → returns a pre-rejected promise carrying the stored error.
   */
  await(): Promise<T>;

  /**
   * Transition `pending` → `ready` with `value`. Throws if the latch is
   * already settled (i.e. `state().kind !== "pending"`). Call `reset()` first
   * to re-arm.
   */
  resolve(value: T): void;

  /**
   * Transition `pending` → `failed` with `error`. Throws if the latch is
   * already settled. Call `reset()` first to re-arm.
   */
  reject(error: Error): void;

  /**
   * Clear the settled state back to `pending`. Any in-flight `await()`
   * promises from before the reset reject with `LatchResetError`. New
   * `await()` calls after `reset()` wait on the next settlement.
   *
   * Calling `reset()` while already pending is a no-op (no waiters to reject
   * and no state to change).
   */
  reset(): void;
}

/**
 * Construct a new latch in the `pending` state. The factory is preferred over
 * a class so callers can't accidentally subclass — the invariants are
 * load-bearing.
 */
export function createInitLatch<T>(): InitLatch<T> {
  // Internal state — the discriminated union the latch exposes via `state()`.
  let current: LatchState<T> = { kind: "pending" };

  // Pending awaiters' deferred resolvers, populated by `await()`. Cleared on
  // each settlement so `reset()` only rejects the most recent generation.
  type Deferred = {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  };
  let waiters: Deferred[] = [];

  const latch: InitLatch<T> = {
    state() {
      // Return-by-value: copy the discriminant + payload so callers cannot
      // mutate latch internals through the returned reference.
      switch (current.kind) {
        case "pending":
          return { kind: "pending" };
        case "ready":
          return { kind: "ready", value: current.value };
        case "failed":
          return { kind: "failed", error: current.error };
      }
    },

    await() {
      // Fast path: already-settled latches return pre-settled promises so
      // tool handlers that `await latch.await()` on every call pay no
      // measurable cost after first ready (docs-style usage).
      if (current.kind === "ready") {
        return Promise.resolve(current.value);
      }
      if (current.kind === "failed") {
        return Promise.reject(current.error);
      }
      return new Promise<T>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },

    resolve(value: T) {
      if (current.kind !== "pending") {
        throw new Error(
          `InitLatch.resolve(): latch is already settled (kind=${current.kind}). Call reset() to re-arm.`,
        );
      }
      current = { kind: "ready", value };
      const toNotify = waiters;
      waiters = [];
      for (const w of toNotify) {
        w.resolve(value);
      }
    },

    reject(error: Error) {
      if (current.kind !== "pending") {
        throw new Error(
          `InitLatch.reject(): latch is already settled (kind=${current.kind}). Call reset() to re-arm.`,
        );
      }
      current = { kind: "failed", error };
      const toNotify = waiters;
      waiters = [];
      for (const w of toNotify) {
        w.reject(error);
      }
    },

    reset() {
      // No-op if we're already pending and have no waiters. (Pending with
      // waiters is technically reachable but rare; rejecting them with
      // LatchResetError keeps the contract uniform.)
      if (current.kind === "pending" && waiters.length === 0) {
        return;
      }
      current = { kind: "pending" };
      const toNotify = waiters;
      waiters = [];
      const err = new LatchResetError();
      for (const w of toNotify) {
        w.reject(err);
      }
    },
  };

  return latch;
}
