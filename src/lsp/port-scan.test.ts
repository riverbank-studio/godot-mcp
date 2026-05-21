/**
 * Tests for the upward port scan + bind probe.
 *
 * The scan is driven by an injectable probe so the test is deterministic
 * — no flaky real-port probing. A separate test exercises the real
 * `isPortFree` probe against an in-process server.
 */

import * as net from "node:net";

import { describe, expect, it } from "vitest";

import { LspPortUnavailableError } from "./errors.js";
import { findAvailablePort, isPortFree, LOOPBACK_HOST } from "./port-scan.js";

describe("findAvailablePort", () => {
  it("returns the first free port from the scan range", async () => {
    const probe = (port: number) => Promise.resolve(port === 6007);
    const port = await findAvailablePort(6005, 8, probe);
    expect(port).toBe(6007);
  });

  it("returns the start port when it is immediately free", async () => {
    const probe = () => Promise.resolve(true);
    const port = await findAvailablePort(6005, 8, probe);
    expect(port).toBe(6005);
  });

  it("throws LspPortUnavailableError when no port in the range is free", async () => {
    const probe = () => Promise.resolve(false);
    await expect(findAvailablePort(6005, 4, probe)).rejects.toBeInstanceOf(
      LspPortUnavailableError,
    );
  });

  it("threads attempts through to the error so the message is faithful", async () => {
    const probe = () => Promise.resolve(false);
    try {
      await findAvailablePort(6005, 16, probe);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as LspPortUnavailableError;
      expect(e.message).toContain("6005");
      expect(e.message).toContain(String(6005 + 16 - 1));
    }
  });

  it("does not exceed the 65535 upper bound", async () => {
    // 32 attempts starting at 65535 would walk into invalid territory. We
    // verify the scan reports cleanly when the start is at the high end.
    const probe = () => Promise.resolve(false);
    await expect(findAvailablePort(65535, 8, probe)).rejects.toBeInstanceOf(
      LspPortUnavailableError,
    );
  });
});

describe("isPortFree (real TCP bind probe)", () => {
  it("reports an in-use port as busy", async () => {
    // Bind a server to a port and verify the probe says false. Using port 0
    // lets the OS pick an unused one for us.
    const server = await new Promise<net.Server>((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.once("listening", () => resolve(s));
      s.listen(0, LOOPBACK_HOST);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("unexpected server address shape");
      }
      const busyPort = address.port;
      const free = await isPortFree(busyPort);
      expect(free).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a free port as free", async () => {
    // Pick a free port by listening with 0 then closing immediately.
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.once("listening", () => {
        const addr = s.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("unexpected server address shape"));
          return;
        }
        const p = addr.port;
        s.close(() => resolve(p));
      });
      s.listen(0, LOOPBACK_HOST);
    });
    const free = await isPortFree(port);
    expect(free).toBe(true);
  });
});
