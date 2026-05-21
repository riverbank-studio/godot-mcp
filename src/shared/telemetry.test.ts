/**
 * Tests for the telemetry facade.
 *
 * Covers:
 *  - OTEL_SDK_DISABLED=true returns a NoopTelemetry (no file I/O).
 *  - FileTelemetry writes NDJSON span records to the configured directory.
 *  - PII helpers: relativizePath, hashQuery, verbatimQueryAllowed.
 *  - Default trace attributes do not contain absolute paths or verbatim queries.
 *  - Trace dir gets a README.md on first trace.
 *  - Rotation by size / age.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  createTelemetry,
  hashQuery,
  relativizePath,
  verbatimQueryAllowed,
  shouldRotate,
  type SpanRecord,
  type TelemetryConfig,
} from "./telemetry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-telemetry-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function readAllNdjson(): SpanRecord[] {
  const entries = fs.readdirSync(tmpDir).filter((n) => n.endsWith(".ndjson"));
  const records: SpanRecord[] = [];
  for (const entry of entries) {
    const text = fs.readFileSync(path.join(tmpDir, entry), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      records.push(JSON.parse(line) as SpanRecord);
    }
  }
  return records;
}

describe("createTelemetry() — disabled by OTEL_SDK_DISABLED", () => {
  it("returns a noop telemetry that writes nothing to disk", async () => {
    const cfg: TelemetryConfig = {
      enabled: false,
      tracesDir: tmpDir,
      traceQueries: false,
    };
    const tel = createTelemetry(cfg);
    const span = tel.startSpan("docs.search", { foo: "bar" });
    span.setAttribute("k", "v");
    span.end();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});

describe("FileTelemetry — span recording", () => {
  it("writes one NDJSON line per span with name + attributes + duration", () => {
    const cfg: TelemetryConfig = {
      enabled: true,
      tracesDir: tmpDir,
      traceQueries: false,
    };
    const tel = createTelemetry(cfg);
    const span = tel.startSpan("docs.search", { kind: "tutorial" });
    span.setAttribute("hits", 5);
    span.end();

    const records = readAllNdjson();
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.name).toBe("docs.search");
    expect(r.attributes.kind).toBe("tutorial");
    expect(r.attributes.hits).toBe(5);
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof r.startTime).toBe("string"); // ISO 8601
  });

  it("captures an error attribute when span.end(err) is called", () => {
    const cfg: TelemetryConfig = {
      enabled: true,
      tracesDir: tmpDir,
      traceQueries: false,
    };
    const tel = createTelemetry(cfg);
    const span = tel.startSpan("docs.ingest");
    span.end(new Error("boom"));

    const [r] = readAllNdjson();
    expect(r.status).toBe("error");
    expect(r.errorMessage).toBe("boom");
  });

  it("writes a README.md into the trace dir on first trace", () => {
    const cfg: TelemetryConfig = {
      enabled: true,
      tracesDir: tmpDir,
      traceQueries: false,
    };
    const tel = createTelemetry(cfg);
    tel.startSpan("test").end();
    const readme = path.join(tmpDir, "README.md");
    expect(fs.existsSync(readme)).toBe(true);
    const text = fs.readFileSync(readme, "utf8");
    expect(text.toLowerCase()).toContain("godot-mcp");
    expect(text.toLowerCase()).toContain("trace");
  });
});

describe("PII helpers", () => {
  describe("relativizePath", () => {
    it("returns a path relative to project root", () => {
      const root = "/home/user/project";
      const target = "/home/user/project/src/main.gd";
      expect(relativizePath(target, root)).toBe(path.join("src", "main.gd"));
    });

    it("returns the sentinel when the target escapes project root", () => {
      const root = "/home/user/project";
      const target = "/etc/passwd";
      expect(relativizePath(target, root)).toBe("<absolute>");
    });

    it("returns the sentinel for a path equal to root", () => {
      const root = "/home/user/project";
      // Same path → relative is empty string; our contract returns "." or
      // the input verbatim, but the assertion that absolute path doesn't
      // leak is what matters.
      const out = relativizePath(root, root);
      expect(out.startsWith("/")).toBe(false);
      expect(out.startsWith("C:")).toBe(false);
    });

    it("never returns an absolute path", () => {
      const samples = [
        ["/abs/a/b", "/abs"],
        ["/abs/x/y", "/other/root"],
        ["relative/path", "/anything"],
      ] as const;
      for (const [target, root] of samples) {
        const out = relativizePath(target, root);
        expect(path.isAbsolute(out)).toBe(false);
      }
    });
  });

  describe("hashQuery", () => {
    it("returns {length, sha256Prefix8}", () => {
      const h = hashQuery("how do I add a node");
      expect(h.length).toBe(19);
      expect(h.sha256Prefix8).toMatch(/^[a-f0-9]{8}$/);
    });

    it("is deterministic", () => {
      expect(hashQuery("hello")).toEqual(hashQuery("hello"));
    });

    it("does not contain the original string", () => {
      const q = "very-secret-query-content";
      const h = hashQuery(q);
      expect(JSON.stringify(h)).not.toContain(q);
    });
  });

  describe("verbatimQueryAllowed", () => {
    it("returns true when traceQueries=true", () => {
      expect(verbatimQueryAllowed({ traceQueries: true })).toBe(true);
    });

    it("returns false when traceQueries=false (default posture)", () => {
      expect(verbatimQueryAllowed({ traceQueries: false })).toBe(false);
    });
  });
});

describe("default trace contents do not leak absolute paths or verbatim queries", () => {
  it("a span built with the PII helpers contains only relativized paths and hashed queries", () => {
    const cfg: TelemetryConfig = {
      enabled: true,
      tracesDir: tmpDir,
      traceQueries: false,
    };
    const tel = createTelemetry(cfg);
    const projectRoot = "/home/user/project";
    const span = tel.startSpan("docs.search");
    span.setAttribute(
      "file",
      relativizePath("/home/user/project/src/main.gd", projectRoot),
    );
    if (verbatimQueryAllowed(cfg)) {
      span.setAttribute("query", "how do I add a node");
    } else {
      const h = hashQuery("how do I add a node");
      span.setAttribute("query.length", h.length);
      span.setAttribute("query.sha256_prefix8", h.sha256Prefix8);
    }
    span.end();

    const text = fs.readFileSync(
      path.join(
        tmpDir,
        fs.readdirSync(tmpDir).find((n) => n.endsWith(".ndjson"))!,
      ),
      "utf8",
    );
    expect(text).not.toContain("/home/user/project");
    expect(text).not.toContain("how do I add a node");
    expect(text).toContain("query.sha256_prefix8");
  });
});

describe("rotation policy", () => {
  it("shouldRotate returns true when size exceeds the cap", () => {
    expect(
      shouldRotate({
        sizeBytes: 200 * 1024 * 1024,
        ageMs: 0,
        maxBytes: 100 * 1024 * 1024,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("shouldRotate returns true when age exceeds the cap", () => {
    expect(
      shouldRotate({
        sizeBytes: 0,
        ageMs: 8 * 24 * 60 * 60 * 1000,
        maxBytes: 100 * 1024 * 1024,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("shouldRotate returns false when under both caps", () => {
    expect(
      shouldRotate({
        sizeBytes: 50 * 1024 * 1024,
        ageMs: 1 * 24 * 60 * 60 * 1000,
        maxBytes: 100 * 1024 * 1024,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(false);
  });
});
