/**
 * LSP correctness benchmark harness — issue #45.
 *
 * Measures whether Godot's LSP + our integration layer returns correct
 * results against the curated GDScript fixtures in
 * `benchmarks/datasets/lsp-correctness/v1/`.
 *
 * ## What this tests (distinct from #31)
 *
 * Benchmark #31 (GDScript correctness) tests *LLM behaviour* — whether an
 * agent writes correct GDScript.  **This benchmark tests the LSP + wrapper
 * layer itself**: do the tools that wrap Godot's GDScript LSP return the
 * right answers for definition / reference / hover / diagnostics /
 * document-symbols queries against hand-labeled fixture files?
 *
 * ## Dependencies
 *
 * The harness imports from `src/lsp/` (#8) and `src/tools/lsp/` (#9 and
 * its leaves).  Those PRs are in Ready-for-Review; until they merge, this
 * file will not compile against `main`.  The `tsconfig.bench.json` at the
 * repo root controls compilation for the benchmark tree so the main build
 * (`tsc`) stays clean.
 *
 * ## Live run gate
 *
 * A live run requires:
 *   - `GODOT_PATH` set to a Godot 4.3+ binary
 *   - `GODOT_LSP_PROJECT_PATH` set to (or inferrable from) the fixture
 *     project at `benchmarks/datasets/lsp-correctness/v1/fixtures/project`
 *
 * Without a live Godot instance the harness exits immediately with code 0
 * and prints a SKIP notice so CI (which has no Godot binary) stays green.
 *
 * ## Variant semantics
 *
 * | Variant            | What it measures                                              |
 * | ------------------ | ------------------------------------------------------------- |
 * | `cold_call`        | First LSP query after spawn (covers the 10-20s warmup window) |
 * | `steady_state`     | Post-warmup; the baseline correctness pass rate               |
 * | `external_edit`    | Edit a file outside the LSP then re-query; tests auto-resync  |
 * | `imprecise_position` | Query by symbol_name only (#12 symbol-based fallback)       |
 *
 * ## Output
 *
 * Results are written to `benchmarks/results/lsp-correctness/{ISO-date}.json`
 * in the schema defined by `BenchmarkResult` below.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Label schema types (mirrors labels.schema.json)
// ---------------------------------------------------------------------------

/** Supported test variant names. */
export type Variant =
  | "cold_call"
  | "steady_state"
  | "external_edit"
  | "imprecise_position";

/** A location expectation. */
export interface LocationMatcher {
  /** The result's `file` must end with this string. */
  file_suffix?: string;
  /** The result's `file` must NOT start with this prefix. */
  file_prefix_not?: string;
  /** The result's `range.start.line` must equal this 1-based line. */
  range_start_line?: number;
}

/** Union of all expectation shapes. */
export type Expectation =
  | {
      kind: "location_array";
      /** Minimum number of results required. */
      min_results?: number;
      /** At least one result must satisfy this matcher (optional). */
      any_result?: LocationMatcher;
    }
  | {
      kind: "hover_substring";
      /** The response content must contain this substring (case-insensitive). */
      substring: string;
      /** If true, an empty response is also acceptable. */
      allow_empty?: boolean;
    }
  | { kind: "hover_or_empty" }
  | {
      kind: "symbol_names_include";
      /** Every name in this list must appear in the symbols response. */
      names: string[];
    }
  | {
      kind: "diagnostics_min_severity";
      /** At least this many diagnostics must have the specified severity. */
      min_count: number;
      /** LSP severity integer (1=error, 2=warning, 3=info, 4=hint). */
      severity: number;
    }
  | {
      kind: "diagnostics_max_severity";
      /** At most this many diagnostics may have the specified severity. */
      max_count: number;
      severity: number;
    };

/** A single labeled fixture entry. */
export interface Label {
  /** Unique slug for reporting. */
  id: string;
  /** Tool name to invoke. */
  tool: string;
  /** Human description of what this label tests. */
  description: string;
  /** Path to the GDScript file, relative to `fixture_root`. */
  file: string;
  /** 1-based line (for position-based tools). */
  line?: number;
  /** 1-based character offset (for position-based tools). */
  character?: number;
  /** Symbol name for the #12 imprecise-position fallback. */
  symbol_name?: string;
  /** External-edit spec for the `external_edit` variant. */
  external_edit?: { append_line: string };
  /** Ground truth. */
  expect: Expectation;
  /** Optional human note. */
  note?: string;
  /** Which test variants this label participates in. */
  variants: Variant[];
}

/** The top-level labels.json structure. */
export interface LabelFile {
  version: string;
  godot_version_min: string;
  fixture_root: string;
  labels: Label[];
}

// ---------------------------------------------------------------------------
// Result schema
// ---------------------------------------------------------------------------

/** Outcome of evaluating a single label in a single variant. */
export interface LabelResult {
  /** Label `id`. */
  id: string;
  variant: Variant;
  tool: string;
  /** Did the result satisfy the expectation? */
  pass: boolean;
  /** Wall-clock ms for the tool call (excludes LSP spawn time). */
  latency_ms: number;
  /** The raw tool response (truncated to 2000 chars if large). */
  raw_response: string;
  /** Human-readable failure reason when pass=false. */
  failure_reason?: string;
}

/** Top-level run result written to benchmarks/results/. */
export interface BenchmarkResult {
  run_date: string;
  godot_version: string;
  fixture_version: "1";
  /** Seconds from Godot LSP spawn to first successful `initialize` response. */
  cold_start_seconds: number | null;
  /** Per-tool pass-rate summary. */
  pass_rates: Record<string, { pass: number; total: number; rate: number }>;
  results: LabelResult[];
}

// ---------------------------------------------------------------------------
// Expectation evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a parsed tool response against a label's `expect` spec.
 *
 * Returns `{ pass: true }` on success or `{ pass: false, reason: string }`
 * on failure.  The function is pure — no I/O — so it is unit-testable in
 * isolation.
 */
export function evaluate(
  expect: Expectation,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolResponse: any,
): { pass: true } | { pass: false; reason: string } {
  switch (expect.kind) {
    case "location_array": {
      if (!Array.isArray(toolResponse)) {
        return {
          pass: false,
          reason: `Expected array, got ${typeof toolResponse}`,
        };
      }
      const minResults = expect.min_results ?? 0;
      if (toolResponse.length < minResults) {
        return {
          pass: false,
          reason: `Expected ≥${minResults} results, got ${toolResponse.length}`,
        };
      }
      if (expect.any_result) {
        const matcher = expect.any_result;
        const satisfied = toolResponse.some(
          (loc: { file?: string; range?: { start?: { line?: number } } }) => {
            if (matcher.file_suffix && !loc.file?.endsWith(matcher.file_suffix))
              return false;
            if (
              matcher.file_prefix_not &&
              loc.file?.startsWith(matcher.file_prefix_not)
            )
              return false;
            if (
              matcher.range_start_line !== undefined &&
              loc.range?.start?.line !== matcher.range_start_line
            )
              return false;
            return true;
          },
        );
        if (!satisfied) {
          return {
            pass: false,
            reason: `No result matched the location matcher: ${JSON.stringify(matcher)}`,
          };
        }
      }
      return { pass: true };
    }

    case "hover_substring": {
      // Response may be an empty object `{}` or `{ content, range?, truncated? }`.
      const isEmpty =
        toolResponse == null ||
        (typeof toolResponse === "object" &&
          Object.keys(toolResponse).length === 0);
      if (isEmpty) {
        return expect.allow_empty
          ? { pass: true }
          : { pass: false, reason: "Hover returned empty response" };
      }
      const contentStr = JSON.stringify(toolResponse).toLowerCase();
      if (!contentStr.includes(expect.substring.toLowerCase())) {
        return {
          pass: false,
          reason: `Hover response did not contain "${expect.substring}"`,
        };
      }
      return { pass: true };
    }

    case "hover_or_empty":
      // Any response (including empty) is acceptable.
      return { pass: true };

    case "symbol_names_include": {
      // godot_document_symbols returns { symbols: [...], truncated: bool }
      const symbols: Array<{ name?: string }> = Array.isArray(toolResponse)
        ? toolResponse
        : (toolResponse?.symbols ?? []);
      const symbolNames = new Set(symbols.map((s) => s.name ?? ""));
      const missing = expect.names.filter((n) => !symbolNames.has(n));
      if (missing.length > 0) {
        return {
          pass: false,
          reason: `Missing symbols: ${missing.join(", ")}`,
        };
      }
      return { pass: true };
    }

    case "diagnostics_min_severity": {
      const diags: Array<{ severity?: number }> = Array.isArray(toolResponse)
        ? toolResponse
        : (toolResponse?.diagnostics ?? []);
      const matching = diags.filter((d) => d.severity === expect.severity);
      if (matching.length < expect.min_count) {
        return {
          pass: false,
          reason: `Expected ≥${expect.min_count} diagnostics with severity ${expect.severity}, got ${matching.length}`,
        };
      }
      return { pass: true };
    }

    case "diagnostics_max_severity": {
      const diags: Array<{ severity?: number }> = Array.isArray(toolResponse)
        ? toolResponse
        : (toolResponse?.diagnostics ?? []);
      const matching = diags.filter((d) => d.severity === expect.severity);
      if (matching.length > expect.max_count) {
        return {
          pass: false,
          reason: `Expected ≤${expect.max_count} diagnostics with severity ${expect.severity}, got ${matching.length}`,
        };
      }
      return { pass: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Label loader
// ---------------------------------------------------------------------------

/** Absolute directory of this file, compatible with ESM and vitest transforms. */
function thisDir(): string {
  // import.meta.url is reliable under vitest's ESM transform.
  if (typeof import.meta.url === "string") {
    return path.dirname(fileURLToPath(import.meta.url));
  }
  // CJS / __dirname fallback.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__dirname ?? process.cwd();
}

const LABELS_PATH = path.resolve(
  thisDir(),
  "../datasets/lsp-correctness/v1/labels/labels.json",
);

/**
 * Load and return the label file from the canonical path.
 */
export function loadLabels(): LabelFile {
  const raw = fs.readFileSync(LABELS_PATH, "utf-8");
  return JSON.parse(raw) as LabelFile;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const FIXTURE_BASE = path.resolve(thisDir(), "../datasets/lsp-correctness/v1");

/**
 * Resolve a label's `file` field to an absolute path.  The field is
 * relative to `labels.json` → sibling `fixture_root` (which is itself
 * relative to the labels directory).
 */
export function resolveFixturePath(
  labelFile: LabelFile,
  relativeFile: string,
): string {
  const root = path.resolve(FIXTURE_BASE, "labels", labelFile.fixture_root);
  return path.resolve(root, relativeFile);
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

const RESULTS_DIR = path.resolve(thisDir(), "../results/lsp-correctness");

/**
 * Write `result` to `benchmarks/results/lsp-correctness/{ISO-date}.json`.
 * Creates the directory if it doesn't exist.
 */
export function writeResult(result: BenchmarkResult): string {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `${result.run_date}.json`;
  const outPath = path.join(RESULTS_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Pass-rate summary
// ---------------------------------------------------------------------------

/**
 * Compute per-tool pass rates from a flat list of label results.
 */
export function summarisePassRates(
  results: LabelResult[],
): BenchmarkResult["pass_rates"] {
  const byTool: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    if (!byTool[r.tool]) byTool[r.tool] = { pass: 0, total: 0 };
    byTool[r.tool].total++;
    if (r.pass) byTool[r.tool].pass++;
  }
  const out: BenchmarkResult["pass_rates"] = {};
  for (const [tool, counts] of Object.entries(byTool)) {
    out[tool] = {
      ...counts,
      rate: counts.total === 0 ? 0 : counts.pass / counts.total,
    };
  }
  return out;
}
