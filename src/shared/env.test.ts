/**
 * Tests for shared env-var parsing — offline mode + pre-built DB / model
 * override paths.
 *
 * These are pure-function tests: parseSharedEnv() takes a NodeJS.ProcessEnv-
 * shaped record and returns a validated config object. No file-system or
 * network side effects. Path-existence validation lives elsewhere (it's
 * deferred until first use so a misconfigured override doesn't crash startup
 * on a code path that never reads it).
 */

import { describe, it, expect } from "vitest";
import { parseSharedEnv, OfflineModeError } from "./env.js";

describe("parseSharedEnv", () => {
  describe("GODOT_MCP_OFFLINE", () => {
    it("defaults to offline=false when unset", () => {
      const cfg = parseSharedEnv({});
      expect(cfg.offline).toBe(false);
    });

    it("parses '1' as offline=true", () => {
      const cfg = parseSharedEnv({ GODOT_MCP_OFFLINE: "1" });
      expect(cfg.offline).toBe(true);
    });

    it("parses 'true' as offline=true (case-insensitive)", () => {
      expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "true" }).offline).toBe(true);
      expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "TRUE" }).offline).toBe(true);
      expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "True" }).offline).toBe(true);
    });

    it("parses '0', 'false', empty, and undefined as offline=false", () => {
      expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "0" }).offline).toBe(false);
      expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "false" }).offline).toBe(
        false,
      );
      expect(parseSharedEnv({ GODOT_MCP_OFFLINE: "" }).offline).toBe(false);
      expect(parseSharedEnv({ GODOT_MCP_OFFLINE: undefined }).offline).toBe(
        false,
      );
    });

    it("rejects ambiguous truthy strings to avoid silent misconfiguration", () => {
      // "yes", "on", "y", random strings: not accepted. Forces users to learn
      // the canonical "1" / "true" rather than guessing.
      expect(() => parseSharedEnv({ GODOT_MCP_OFFLINE: "yes" })).toThrow(
        /GODOT_MCP_OFFLINE/,
      );
      expect(() => parseSharedEnv({ GODOT_MCP_OFFLINE: "on" })).toThrow(
        /GODOT_MCP_OFFLINE/,
      );
      expect(() => parseSharedEnv({ GODOT_MCP_OFFLINE: "y" })).toThrow(
        /GODOT_MCP_OFFLINE/,
      );
    });
  });

  describe("GODOT_DOCS_DB_PATH", () => {
    it("is undefined when unset", () => {
      expect(parseSharedEnv({}).docsDbPath).toBeUndefined();
    });

    it("captures the raw path string verbatim", () => {
      const cfg = parseSharedEnv({ GODOT_DOCS_DB_PATH: "/var/lib/godot.db" });
      expect(cfg.docsDbPath).toBe("/var/lib/godot.db");
    });

    it("treats empty string as unset (trimmed)", () => {
      expect(
        parseSharedEnv({ GODOT_DOCS_DB_PATH: "" }).docsDbPath,
      ).toBeUndefined();
      expect(
        parseSharedEnv({ GODOT_DOCS_DB_PATH: "   " }).docsDbPath,
      ).toBeUndefined();
    });

    it("preserves Windows paths with drive letters and backslashes", () => {
      const cfg = parseSharedEnv({
        GODOT_DOCS_DB_PATH: "C:\\Users\\me\\docs.db",
      });
      expect(cfg.docsDbPath).toBe("C:\\Users\\me\\docs.db");
    });
  });

  describe("GODOT_MCP_MODEL_PATH", () => {
    it("is undefined when unset", () => {
      expect(parseSharedEnv({}).modelPath).toBeUndefined();
    });

    it("captures the raw path string verbatim", () => {
      const cfg = parseSharedEnv({
        GODOT_MCP_MODEL_PATH: "/opt/models/bge-small",
      });
      expect(cfg.modelPath).toBe("/opt/models/bge-small");
    });

    it("treats empty / whitespace-only as unset", () => {
      expect(
        parseSharedEnv({ GODOT_MCP_MODEL_PATH: "" }).modelPath,
      ).toBeUndefined();
      expect(
        parseSharedEnv({ GODOT_MCP_MODEL_PATH: "  " }).modelPath,
      ).toBeUndefined();
    });
  });

  describe("GODOT_DOCS_VERSION + offline interaction (validation)", () => {
    it("offline + GODOT_DOCS_VERSION=latest → throws OfflineModeError", () => {
      // Per DESIGN.md L243: "GODOT_MCP_OFFLINE=1 short-circuits this: latest
      // errors out". Validation surfaces during parse so startup fails fast.
      expect(() =>
        parseSharedEnv({
          GODOT_MCP_OFFLINE: "1",
          GODOT_DOCS_VERSION: "latest",
        }),
      ).toThrow(OfflineModeError);
    });

    it("offline error message names both env vars + points at DB_PATH override", () => {
      try {
        parseSharedEnv({
          GODOT_MCP_OFFLINE: "1",
          GODOT_DOCS_VERSION: "latest",
        });
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(OfflineModeError);
        const msg = (e as Error).message;
        expect(msg).toMatch(/GODOT_MCP_OFFLINE/);
        expect(msg).toMatch(/GODOT_DOCS_VERSION/);
        expect(msg).toMatch(/GODOT_DOCS_DB_PATH/);
      }
    });

    it("offline + GODOT_DOCS_VERSION=stable → no error (bundled DB needs no fetch)", () => {
      // 'stable' is the bundled default and never makes network calls.
      expect(() =>
        parseSharedEnv({
          GODOT_MCP_OFFLINE: "1",
          GODOT_DOCS_VERSION: "stable",
        }),
      ).not.toThrow();
    });

    it("offline + unset version → no error (defaults to stable/bundled)", () => {
      expect(() => parseSharedEnv({ GODOT_MCP_OFFLINE: "1" })).not.toThrow();
    });

    it("offline + GODOT_DOCS_VERSION=X.Y is permitted at parse time", () => {
      // X.Y permitted at parse time — fetch attempt is the failure point. The
      // ingestion code checks the cache first; only on miss does it fail.
      // Validating cache hits here would couple env parsing to disk I/O.
      expect(() =>
        parseSharedEnv({
          GODOT_MCP_OFFLINE: "1",
          GODOT_DOCS_VERSION: "4.5",
        }),
      ).not.toThrow();
    });

    it("offline + DB_PATH override + version=latest is allowed (override wins)", () => {
      // GODOT_DOCS_DB_PATH skips version resolution entirely per DESIGN.md
      // L140, so 'latest' is irrelevant when an override is supplied.
      expect(() =>
        parseSharedEnv({
          GODOT_MCP_OFFLINE: "1",
          GODOT_DOCS_VERSION: "latest",
          GODOT_DOCS_DB_PATH: "/opt/docs.db",
        }),
      ).not.toThrow();
    });

    it("non-offline + latest → no error (network fetch allowed)", () => {
      expect(() =>
        parseSharedEnv({ GODOT_DOCS_VERSION: "latest" }),
      ).not.toThrow();
    });
  });

  describe("camelCase mirror for downstream consumers", () => {
    it("returns a shape with explicit, typed fields (not raw env)", () => {
      const cfg = parseSharedEnv({
        GODOT_MCP_OFFLINE: "1",
        GODOT_DOCS_DB_PATH: "/x.db",
        GODOT_MCP_MODEL_PATH: "/m",
      });
      expect(cfg).toMatchObject({
        offline: true,
        docsDbPath: "/x.db",
        modelPath: "/m",
      });
    });
  });
});
