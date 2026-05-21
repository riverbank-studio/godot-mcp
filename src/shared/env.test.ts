/**
 * Tests for the shared env parser.
 *
 * Covers:
 *   - PR #55 offline-mode contract (preserved verbatim so #55 can rebase
 *     onto this branch without changing its test file).
 *   - New #5 fields: GODOT_MCP_LOG_LEVEL, GODOT_MCP_TRACE_QUERIES,
 *     OTEL_SDK_DISABLED.
 *   - Strict boolean grammar shared between #5 and #55.
 */

import { describe, it, expect } from "vitest";

import {
  parseSharedEnv,
  parseBoolean,
  parseOptionalString,
  parseLogLevel,
  OfflineModeError,
  EnvParseError,
  type SharedEnvConfig,
} from "./env.js";

describe("parseSharedEnv — defaults", () => {
  it("returns the unset-everywhere baseline", () => {
    const cfg = parseSharedEnv({});
    expect(cfg).toEqual({
      offline: false,
      docsDbPath: undefined,
      modelPath: undefined,
      docsVersion: undefined,
      logLevel: "info",
      traceQueries: false,
      otelDisabled: false,
    } satisfies SharedEnvConfig);
  });
});

describe("parseSharedEnv — offline-mode contract (PR #55 surface)", () => {
  it("parses GODOT_MCP_OFFLINE=1 as offline", () => {
    expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "1" }).offline).toBe(true);
  });

  it("parses GODOT_MCP_OFFLINE=true as offline", () => {
    expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "true" }).offline).toBe(true);
  });

  it("parses GODOT_MCP_OFFLINE=0 as online", () => {
    expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "0" }).offline).toBe(false);
  });

  it("rejects GODOT_MCP_OFFLINE=yes", () => {
    expect(() => parseSharedEnv({ GODOT_MCP_OFFLINE: "yes" })).toThrow(
      /GODOT_MCP_OFFLINE/,
    );
  });

  it("rejects offline+latest without override", () => {
    expect(() =>
      parseSharedEnv({
        GODOT_MCP_OFFLINE: "1",
        GODOT_DOCS_VERSION: "latest",
      }),
    ).toThrow(OfflineModeError);
  });

  it("allows offline+latest WITH GODOT_DOCS_DB_PATH override", () => {
    const cfg = parseSharedEnv({
      GODOT_MCP_OFFLINE: "1",
      GODOT_DOCS_VERSION: "latest",
      GODOT_DOCS_DB_PATH: "/abs/path.db",
    });
    expect(cfg.offline).toBe(true);
    expect(cfg.docsDbPath).toBe("/abs/path.db");
    expect(cfg.docsVersion).toBe("latest");
  });

  it("trims and normalizes empty strings to undefined", () => {
    const cfg = parseSharedEnv({
      GODOT_DOCS_DB_PATH: "   ",
      GODOT_MCP_MODEL_PATH: "",
      GODOT_DOCS_VERSION: "  4.5  ",
    });
    expect(cfg.docsDbPath).toBeUndefined();
    expect(cfg.modelPath).toBeUndefined();
    expect(cfg.docsVersion).toBe("4.5");
  });
});

describe("parseSharedEnv — log level (GODOT_MCP_LOG_LEVEL)", () => {
  it("defaults to info when unset", () => {
    expect(parseSharedEnv({}).logLevel).toBe("info");
  });

  it.each(["silent", "error", "warn", "info", "debug"] as const)(
    "accepts %s",
    (level) => {
      expect(parseSharedEnv({ GODOT_MCP_LOG_LEVEL: level }).logLevel).toBe(
        level,
      );
    },
  );

  it("accepts case-insensitive level names", () => {
    expect(parseSharedEnv({ GODOT_MCP_LOG_LEVEL: "DEBUG" }).logLevel).toBe(
      "debug",
    );
    expect(parseSharedEnv({ GODOT_MCP_LOG_LEVEL: "Warn" }).logLevel).toBe(
      "warn",
    );
  });

  it("trims whitespace", () => {
    expect(parseSharedEnv({ GODOT_MCP_LOG_LEVEL: "  info  " }).logLevel).toBe(
      "info",
    );
  });

  it("rejects an unknown level with a clear message", () => {
    expect(() => parseSharedEnv({ GODOT_MCP_LOG_LEVEL: "verbose" })).toThrow(
      /GODOT_MCP_LOG_LEVEL.*verbose/,
    );
    expect(() => parseSharedEnv({ GODOT_MCP_LOG_LEVEL: "verbose" })).toThrow(
      EnvParseError,
    );
  });

  it("treats empty string as unset (uses default)", () => {
    expect(parseSharedEnv({ GODOT_MCP_LOG_LEVEL: "" }).logLevel).toBe("info");
  });
});

describe("parseSharedEnv — trace queries (GODOT_MCP_TRACE_QUERIES)", () => {
  it("defaults to false when unset", () => {
    expect(parseSharedEnv({}).traceQueries).toBe(false);
  });

  it("parses 1 as true", () => {
    expect(parseSharedEnv({ GODOT_MCP_TRACE_QUERIES: "1" }).traceQueries).toBe(
      true,
    );
  });

  it("parses true (case insensitive) as true", () => {
    expect(
      parseSharedEnv({ GODOT_MCP_TRACE_QUERIES: "TRUE" }).traceQueries,
    ).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(() => parseSharedEnv({ GODOT_MCP_TRACE_QUERIES: "yes" })).toThrow(
      /GODOT_MCP_TRACE_QUERIES/,
    );
  });
});

describe("parseSharedEnv — OTel disabled (OTEL_SDK_DISABLED)", () => {
  it("defaults to false when unset", () => {
    expect(parseSharedEnv({}).otelDisabled).toBe(false);
  });

  it("parses true as disabled", () => {
    expect(parseSharedEnv({ OTEL_SDK_DISABLED: "true" }).otelDisabled).toBe(
      true,
    );
  });

  it("parses 1 as disabled", () => {
    expect(parseSharedEnv({ OTEL_SDK_DISABLED: "1" }).otelDisabled).toBe(true);
  });

  it("parses false as enabled", () => {
    expect(parseSharedEnv({ OTEL_SDK_DISABLED: "false" }).otelDisabled).toBe(
      false,
    );
  });

  it("rejects garbage values", () => {
    expect(() => parseSharedEnv({ OTEL_SDK_DISABLED: "off" })).toThrow(
      /OTEL_SDK_DISABLED/,
    );
  });
});

describe("parseBoolean", () => {
  it("accepts canonical truthy spellings", () => {
    expect(parseBoolean("1", "X")).toBe(true);
    expect(parseBoolean("true", "X")).toBe(true);
    expect(parseBoolean("TRUE", "X")).toBe(true);
  });

  it("accepts canonical falsy spellings + unset", () => {
    expect(parseBoolean("0", "X")).toBe(false);
    expect(parseBoolean("false", "X")).toBe(false);
    expect(parseBoolean("FALSE", "X")).toBe(false);
    expect(parseBoolean(undefined, "X")).toBe(false);
    expect(parseBoolean("", "X")).toBe(false);
    expect(parseBoolean("   ", "X")).toBe(false);
  });

  it("rejects everything else by var name", () => {
    expect(() => parseBoolean("yes", "MY_VAR")).toThrow(/MY_VAR.*yes/);
  });
});

describe("parseOptionalString", () => {
  it("trims and normalizes empty / whitespace to undefined", () => {
    expect(parseOptionalString(undefined)).toBeUndefined();
    expect(parseOptionalString("")).toBeUndefined();
    expect(parseOptionalString("   ")).toBeUndefined();
    expect(parseOptionalString("  hello  ")).toBe("hello");
  });
});

describe("parseLogLevel", () => {
  it("returns the default when unset", () => {
    expect(parseLogLevel(undefined)).toBe("info");
  });

  it("throws EnvParseError on unknown level", () => {
    expect(() => parseLogLevel("trace")).toThrow(EnvParseError);
  });
});
