/**
 * InitLatch tests — Wave 2 D8 amendment semantics.
 *
 * Acceptance from #5:
 * - `pending` → `ready`
 * - `pending` → `failed`
 * - in-flight `await()` rejection on `reset()`
 * - idempotent `resolve` / `reject` (second call throws)
 * - LSP-style respawn: `reset()` then re-`resolve()` cycle leaves `state()`
 *   consistent across all observers
 * - Docs-style: tool-handler `await()` returns a no-op after first resolution
 */

import { describe, it, expect } from "vitest";

import { createInitLatch, LatchResetError } from "./latch.js";

describe("InitLatch", () => {
  describe("pending → ready", () => {
    it("transitions state and resolves awaiters", async () => {
      const latch = createInitLatch<string>();
      expect(latch.state()).toEqual({ kind: "pending" });

      const awaited = latch.await();
      latch.resolve("ok");

      expect(latch.state()).toEqual({ kind: "ready", value: "ok" });
      await expect(awaited).resolves.toBe("ok");
    });

    it("returns the resolved value on every subsequent await()", async () => {
      const latch = createInitLatch<number>();
      latch.resolve(42);

      await expect(latch.await()).resolves.toBe(42);
      await expect(latch.await()).resolves.toBe(42);
      await expect(latch.await()).resolves.toBe(42);
    });

    it("supports void value type for gates without payload", async () => {
      const latch = createInitLatch<void>();
      const awaited = latch.await();
      latch.resolve(undefined);
      await expect(awaited).resolves.toBeUndefined();
    });
  });

  describe("pending → failed", () => {
    it("transitions state and rejects awaiters with the failure error", async () => {
      const latch = createInitLatch<string>();
      const awaited = latch.await();
      const err = new Error("ingestion blew up");
      latch.reject(err);

      expect(latch.state()).toEqual({ kind: "failed", error: err });
      await expect(awaited).rejects.toBe(err);
    });

    it("rejects subsequent await() calls with the same stored error", async () => {
      const latch = createInitLatch<string>();
      const err = new Error("nope");
      latch.reject(err);

      await expect(latch.await()).rejects.toBe(err);
      await expect(latch.await()).rejects.toBe(err);
    });
  });

  describe("idempotency: second resolve()/reject() throws", () => {
    it("throws on second resolve() while in ready state", () => {
      const latch = createInitLatch<string>();
      latch.resolve("first");
      expect(() => latch.resolve("second")).toThrow(
        /already resolved|already settled/i,
      );
    });

    it("throws on resolve() after reject()", () => {
      const latch = createInitLatch<string>();
      latch.reject(new Error("x"));
      expect(() => latch.resolve("y")).toThrow(
        /already settled|already failed/i,
      );
    });

    it("throws on second reject()", () => {
      const latch = createInitLatch<string>();
      latch.reject(new Error("first"));
      expect(() => latch.reject(new Error("second"))).toThrow(
        /already settled|already failed/i,
      );
    });

    it("throws on reject() after resolve()", () => {
      const latch = createInitLatch<string>();
      latch.resolve("ok");
      expect(() => latch.reject(new Error("late"))).toThrow(
        /already settled|already resolved/i,
      );
    });
  });

  describe("reset(): in-flight rejection + state clear", () => {
    it("rejects all in-flight awaiters with LatchResetError", async () => {
      const latch = createInitLatch<string>();

      const a = latch.await();
      const b = latch.await();
      const c = latch.await();

      latch.reset();

      await expect(a).rejects.toBeInstanceOf(LatchResetError);
      await expect(b).rejects.toBeInstanceOf(LatchResetError);
      await expect(c).rejects.toBeInstanceOf(LatchResetError);
      expect(latch.state()).toEqual({ kind: "pending" });
    });

    it("allows re-resolve after reset (LSP respawn cycle)", async () => {
      const latch = createInitLatch<string>();

      latch.resolve("first-init");
      expect(latch.state()).toEqual({ kind: "ready", value: "first-init" });

      latch.reset();
      expect(latch.state()).toEqual({ kind: "pending" });

      latch.resolve("second-init");
      expect(latch.state()).toEqual({ kind: "ready", value: "second-init" });
      await expect(latch.await()).resolves.toBe("second-init");
    });

    it("allows reject-then-reset-then-resolve cycle (docs runtime refetch recovery)", async () => {
      const latch = createInitLatch<string>();

      latch.reject(new Error("fetch failed"));
      expect(latch.state().kind).toBe("failed");

      latch.reset();
      expect(latch.state()).toEqual({ kind: "pending" });

      latch.resolve("recovered");
      expect(latch.state()).toEqual({ kind: "ready", value: "recovered" });
    });

    it("reset() while already pending is a no-op", () => {
      const latch = createInitLatch<string>();
      expect(latch.state()).toEqual({ kind: "pending" });
      latch.reset();
      expect(latch.state()).toEqual({ kind: "pending" });
    });
  });

  describe("LSP-style: state() consistent across observers after respawn", () => {
    it("multiple observers see the same lifecycle sequence", async () => {
      const latch = createInitLatch<string>();
      const observations: string[] = [];

      observations.push(`A0:${latch.state().kind}`);

      latch.resolve("v1");
      observations.push(`A1:${latch.state().kind}`);

      latch.reset();
      observations.push(`A2:${latch.state().kind}`);

      latch.reject(new Error("v2 init failed"));
      observations.push(`A3:${latch.state().kind}`);

      latch.reset();
      latch.resolve("v3");
      observations.push(`A4:${latch.state().kind}`);

      expect(observations).toEqual([
        "A0:pending",
        "A1:ready",
        "A2:pending",
        "A3:failed",
        "A4:ready",
      ]);
      await expect(latch.await()).resolves.toBe("v3");
    });
  });

  describe("docs-style: await() is effectively a no-op after first resolution", () => {
    it("await() after resolve() resolves microtask-fast", async () => {
      const latch = createInitLatch<string>();
      latch.resolve("ready");

      // The contract: once ready, await() returns a pre-resolved promise so
      // tool handlers pay no real cost calling it on every request.
      let synchronouslyResolved = false;
      void latch.await().then(() => {
        synchronouslyResolved = true;
      });
      // After one microtask flush the awaiter must already have resolved.
      await Promise.resolve();
      expect(synchronouslyResolved).toBe(true);
    });
  });
});
