/**
 * Tests for the stderr logger.
 *
 * Levels are silent < error < warn < info < debug. A message at level L is
 * emitted iff the effective level rank is >= L's rank.
 *
 * `setLogLevelForTesting` is the test-only escape hatch the module exports so
 * we don't have to mutate process.env / re-import.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  createLogger,
  logDebug,
  logInfo,
  logWarn,
  logError,
  setLogLevelForTesting,
  type LogLevel,
} from "./logging.js";

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  stderrSpy.mockRestore();
  setLogLevelForTesting("info");
});

function lastLine(): string {
  const calls = stderrSpy.mock.calls;
  return calls.length === 0 ? "" : String(calls[calls.length - 1][0]);
}

describe("createLogger() output format", () => {
  it("uses [godot-mcp][subsystem] message format", () => {
    setLogLevelForTesting("info");
    const log = createLogger("docs");
    log.info("hello");
    expect(lastLine()).toBe("[godot-mcp][docs] hello");
  });

  it("works for every level when level=debug", () => {
    setLogLevelForTesting("debug");
    const log = createLogger("lsp");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      "[godot-mcp][lsp] e",
      "[godot-mcp][lsp] w",
      "[godot-mcp][lsp] i",
      "[godot-mcp][lsp] d",
    ]);
  });
});

describe("level gating", () => {
  const allLevels = [
    "silent",
    "error",
    "warn",
    "info",
    "debug",
  ] as const as readonly LogLevel[];

  it("silent emits nothing at any level", () => {
    setLogLevelForTesting("silent");
    const log = createLogger("x");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("error emits error only", () => {
    setLogLevelForTesting("error");
    const log = createLogger("x");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(["[godot-mcp][x] e"]);
  });

  it("warn emits error+warn", () => {
    setLogLevelForTesting("warn");
    const log = createLogger("x");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(["[godot-mcp][x] e", "[godot-mcp][x] w"]);
  });

  it("info emits error+warn+info", () => {
    setLogLevelForTesting("info");
    const log = createLogger("x");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      "[godot-mcp][x] e",
      "[godot-mcp][x] w",
      "[godot-mcp][x] i",
    ]);
  });

  it("debug emits everything", () => {
    setLogLevelForTesting("debug");
    const log = createLogger("x");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      "[godot-mcp][x] e",
      "[godot-mcp][x] w",
      "[godot-mcp][x] i",
      "[godot-mcp][x] d",
    ]);
  });

  it("all five levels are recognized", () => {
    for (const lvl of allLevels) {
      setLogLevelForTesting(lvl);
      // Just verify it doesn't throw — gating behavior is covered above.
      const log = createLogger("x");
      log.error("ping");
    }
  });
});

describe("module-level shortcuts (back-compat)", () => {
  it("logDebug emits with [DEBUG] prefix when level=debug (legacy format preserved)", () => {
    setLogLevelForTesting("debug");
    logDebug("hello");
    expect(lastLine()).toBe("[DEBUG] hello");
  });

  it("logDebug emits nothing at level=info", () => {
    setLogLevelForTesting("info");
    logDebug("hello");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("logInfo/logWarn/logError module shortcuts emit with [godot-mcp][<subsystem>] format when given a subsystem", () => {
    setLogLevelForTesting("info");
    logInfo("server", "running");
    logWarn("server", "watch out");
    logError("server", "boom");
    const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      "[godot-mcp][server] running",
      "[godot-mcp][server] watch out",
      "[godot-mcp][server] boom",
    ]);
  });
});
