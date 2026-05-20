/**
 * Tests for `parseLspEnv` and the helper integer parser.
 */

import { describe, it, expect } from "vitest";

import { EnvParseError } from "../shared/env.js";

import {
  DEFAULT_DIAGNOSTIC_FIRST_MS,
  DEFAULT_DIAGNOSTIC_STEADY_MS,
  DEFAULT_LSP_PORT,
  DEFAULT_PORT_SCAN_ATTEMPTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SPAWN_CAP,
  DEFAULT_SPAWN_RESET_MINUTES,
  DEFAULT_STAT_POLL_THROTTLE_MS,
  parseLspEnv,
  parsePositiveInt,
} from "./config.js";

describe("parseLspEnv", () => {
  it("returns documented defaults on an empty env", () => {
    const cfg = parseLspEnv({});
    expect(cfg).toEqual({
      port: DEFAULT_LSP_PORT,
      portScanAttempts: DEFAULT_PORT_SCAN_ATTEMPTS,
      projectPath: undefined,
      eagerInit: false,
      spawnResetMinutes: DEFAULT_SPAWN_RESET_MINUTES,
      diagnosticFirstMs: DEFAULT_DIAGNOSTIC_FIRST_MS,
      diagnosticSteadyMs: DEFAULT_DIAGNOSTIC_STEADY_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      spawnCap: DEFAULT_SPAWN_CAP,
      statPollThrottleMs: DEFAULT_STAT_POLL_THROTTLE_MS,
    });
  });

  it("parses GODOT_LSP_PORT and GODOT_LSP_PROJECT_PATH", () => {
    const cfg = parseLspEnv({
      GODOT_LSP_PORT: "6010",
      GODOT_LSP_PROJECT_PATH: "/home/user/proj",
    });
    expect(cfg.port).toBe(6010);
    expect(cfg.projectPath).toBe("/home/user/proj");
  });

  it("parses GODOT_LSP_EAGER_INIT via the shared strict boolean grammar", () => {
    expect(parseLspEnv({ GODOT_LSP_EAGER_INIT: "1" }).eagerInit).toBe(true);
    expect(parseLspEnv({ GODOT_LSP_EAGER_INIT: "true" }).eagerInit).toBe(true);
    expect(parseLspEnv({ GODOT_LSP_EAGER_INIT: "0" }).eagerInit).toBe(false);
    expect(parseLspEnv({ GODOT_LSP_EAGER_INIT: "false" }).eagerInit).toBe(
      false,
    );
  });

  it("throws EnvParseError on a non-canonical boolean spelling", () => {
    expect(() => parseLspEnv({ GODOT_LSP_EAGER_INIT: "yes" })).toThrow(
      EnvParseError,
    );
  });

  it("parses GODOT_LSP_SPAWN_RESET_MINUTES", () => {
    const cfg = parseLspEnv({ GODOT_LSP_SPAWN_RESET_MINUTES: "5" });
    expect(cfg.spawnResetMinutes).toBe(5);
  });

  it("parses the diagnostic await tier env vars", () => {
    const cfg = parseLspEnv({
      GODOT_LSP_DIAGNOSTIC_FIRST_MS: "15000",
      GODOT_LSP_DIAGNOSTIC_STEADY_MS: "500",
    });
    expect(cfg.diagnosticFirstMs).toBe(15_000);
    expect(cfg.diagnosticSteadyMs).toBe(500);
  });

  it("rejects out-of-range ports", () => {
    expect(() => parseLspEnv({ GODOT_LSP_PORT: "0" })).toThrow(EnvParseError);
    expect(() => parseLspEnv({ GODOT_LSP_PORT: "99999" })).toThrow(
      EnvParseError,
    );
  });

  it("treats whitespace-only project path as undefined", () => {
    const cfg = parseLspEnv({ GODOT_LSP_PROJECT_PATH: "   " });
    expect(cfg.projectPath).toBeUndefined();
  });
});

describe("parsePositiveInt", () => {
  it("returns the fallback on unset / empty / whitespace", () => {
    expect(parsePositiveInt(undefined, "X", 42)).toBe(42);
    expect(parsePositiveInt("", "X", 42)).toBe(42);
    expect(parsePositiveInt("   ", "X", 42)).toBe(42);
  });

  it("parses a positive integer", () => {
    expect(parsePositiveInt("17", "X", 42)).toBe(17);
    expect(parsePositiveInt("  17  ", "X", 42)).toBe(17);
  });

  it("rejects non-digit values", () => {
    expect(() => parsePositiveInt("abc", "X", 1)).toThrow(EnvParseError);
    expect(() => parsePositiveInt("1.5", "X", 1)).toThrow(EnvParseError);
    expect(() => parsePositiveInt("-1", "X", 1)).toThrow(EnvParseError);
    expect(() => parsePositiveInt("0x10", "X", 1)).toThrow(EnvParseError);
  });

  it("rejects zero", () => {
    expect(() => parsePositiveInt("0", "X", 1)).toThrow(EnvParseError);
  });
});
