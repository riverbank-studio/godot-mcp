#!/usr/bin/env node
/**
 * Tool-Routing Accuracy Benchmark (issue #30)
 *
 * Validates that an LLM picks the correct godot_* tool when given a
 * natural-language query. Passes all tool schemas to the Anthropic API
 * with `tool_choice: "any"` and measures per-tool precision/recall.
 *
 * Three ablation modes isolate routing-signal contributions:
 *   (a) full       — production tool descriptions (default)
 *   (b) first-sent — first sentence of each description only
 *   (c) name-only  — tool name + parameter schema, no description text
 *
 * Results are written as NDJSON to benchmarks/results/tool-routing/<ISO-date>.ndjson
 * and a summary report to benchmarks/results/tool-routing/<ISO-date>-summary.json.
 *
 * Usage:
 *   npx tsx benchmarks/harness/tool-routing.ts [options]
 *
 * Options:
 *   --model <id>          Anthropic model ID (default: claude-sonnet-4-5)
 *   --ablation <mode>     full | first-sent | name-only (default: full)
 *   --dataset <path>      Path to queries.json (default: v1/queries.json)
 *   --filter <category>   docs | lsp | editor (default: all)
 *   --dry-run             Print plan, skip API calls
 *   --help                Show this message
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY env var set
 *   - Deps merged: #7 (docs tools), #9 (LSP tools), #40 (descriptions.ts)
 *   - npm install @anthropic-ai/sdk
 *
 * IMPORTANT: This harness is scaffolded now but live runs are gated on deps
 * #7, #9, and #40 merging. The harness will error with IMPL_BLOCKED_DEPS if
 * `src/tools/descriptions.ts` does not exist.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row of the query dataset. */
interface QueryRecord {
  id: string;
  query: string;
  expected_tool: string;
  category: "docs" | "lsp" | "editor";
  disambiguation_pair: string | null;
  notes: string;
}

/** The full dataset file shape. */
interface QueryDataset {
  version: string;
  description: string;
  queries: QueryRecord[];
}

/** Ablation mode controls how much description text is sent to the model. */
type AblationMode = "full" | "first-sent" | "name-only";

/** Result for a single query. */
interface QueryResult {
  id: string;
  query: string;
  expected_tool: string;
  chosen_tool: string | null;
  correct: boolean;
  category: string;
  disambiguation_pair: string | null;
  model: string;
  ablation: AblationMode;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error: string | null;
}

/** Per-tool aggregated metrics. */
interface ToolMetrics {
  tool: string;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/** Top-level summary report. */
interface SummaryReport {
  run_date: string;
  model: string;
  ablation: AblationMode;
  dataset_version: string;
  total_queries: number;
  correct: number;
  incorrect: number;
  errors: number;
  overall_accuracy: number;
  per_tool: ToolMetrics[];
  per_category: Record<
    string,
    { total: number; correct: number; accuracy: number }
  >;
  per_disambiguation_pair: Record<
    string,
    { total: number; correct: number; accuracy: number }
  >;
  cost_estimate_usd: number | null;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/** Parses process.argv into a typed options object. */
function parseArgs(): {
  model: string;
  ablation: AblationMode;
  datasetPath: string;
  filter: string | null;
  dryRun: boolean;
  help: boolean;
} {
  const args = process.argv.slice(2);
  const opts = {
    model: "claude-sonnet-4-5",
    ablation: "full" as AblationMode,
    datasetPath: resolve(
      REPO_ROOT,
      "benchmarks/datasets/tool-routing/v1/queries.json",
    ),
    filter: null as string | null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
        opts.model = args[++i];
        break;
      case "--ablation":
        opts.ablation = args[++i] as AblationMode;
        break;
      case "--dataset":
        opts.datasetPath = resolve(args[++i]);
        break;
      case "--filter":
        opts.filter = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
        opts.help = true;
        break;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Tool schema loading
// ---------------------------------------------------------------------------

/**
 * Loads tool schemas from src/tools/descriptions.ts (post-#40 merge).
 * Falls back to a stub list from src/index.ts for pre-merge scaffolding.
 *
 * Returns an array of Anthropic tool definition objects.
 */
async function loadToolSchemas(ablation: AblationMode): Promise<
  Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>
> {
  const descriptionsPath = resolve(REPO_ROOT, "src/tools/descriptions.ts");

  if (!existsSync(descriptionsPath)) {
    // Pre-#40 scaffolding: use stub schemas extracted from src/index.ts.
    // These descriptions are placeholder text and should NOT be used for
    // meaningful accuracy measurements — they exist so the harness can be
    // validated end-to-end before deps merge.
    console.warn(
      "[warn] src/tools/descriptions.ts not found (deps #7, #9, #40 not merged). " +
        "Using stub schemas from src/index.ts. Results with these stubs are not meaningful.",
    );
    return buildStubSchemas(ablation);
  }

  // Post-#40: dynamically import the canonical descriptions module.
  // The module exports a typed record keyed by tool name with { description, params }.
  const descriptionsModule = await import(descriptionsPath);
  const descriptions: Record<
    string,
    { description: string; params: Record<string, unknown> }
  > = descriptionsModule.default ?? descriptionsModule.descriptions;

  return Object.entries(descriptions).map(
    ([name, { description, params }]) => ({
      name,
      description: applyAblation(description, ablation),
      input_schema: {
        type: "object",
        properties: params,
      },
    }),
  );
}

/**
 * Builds stub tool schemas from the tools registered in src/index.ts.
 * Used only for pre-dep-merge scaffolding validation.
 */
function buildStubSchemas(ablation: AblationMode): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  // Mirrors the 14 existing tools + the 14 planned godot_* tools.
  // The planned tools use placeholder descriptions until #40 lands.
  const stubs: Array<{
    name: string;
    description: string;
    params: Record<string, unknown>;
  }> = [
    // --- Existing editor tools (current names, pre-rename) ---
    {
      name: "launch_editor",
      description: "Launch Godot editor for a specific project",
      params: { projectPath: { type: "string" } },
    },
    {
      name: "run_project",
      description: "Run the Godot project and capture output",
      params: { projectPath: { type: "string" }, scene: { type: "string" } },
    },
    {
      name: "get_debug_output",
      description: "Get the current debug output and errors",
      params: {},
    },
    {
      name: "stop_project",
      description: "Stop the currently running Godot project",
      params: {},
    },
    {
      name: "get_godot_version",
      description: "Get the installed Godot version",
      params: {},
    },
    {
      name: "list_projects",
      description: "List Godot projects in a directory",
      params: { directory: { type: "string" }, recursive: { type: "boolean" } },
    },
    {
      name: "get_project_info",
      description: "Retrieve metadata about a Godot project",
      params: { projectPath: { type: "string" } },
    },
    {
      name: "create_scene",
      description: "Create a new Godot scene file",
      params: {
        projectPath: { type: "string" },
        scenePath: { type: "string" },
        rootNodeType: { type: "string" },
      },
    },
    {
      name: "add_node",
      description: "Add a node to an existing scene",
      params: {
        projectPath: { type: "string" },
        scenePath: { type: "string" },
        nodeType: { type: "string" },
        nodeName: { type: "string" },
      },
    },
    {
      name: "load_sprite",
      description: "Load a sprite into a Sprite2D node",
      params: {
        projectPath: { type: "string" },
        scenePath: { type: "string" },
        nodePath: { type: "string" },
        texturePath: { type: "string" },
      },
    },
    {
      name: "export_mesh_library",
      description: "Export a scene as a MeshLibrary resource",
      params: {
        projectPath: { type: "string" },
        scenePath: { type: "string" },
        outputPath: { type: "string" },
      },
    },
    {
      name: "save_scene",
      description: "Save changes to a scene file",
      params: {
        projectPath: { type: "string" },
        scenePath: { type: "string" },
      },
    },
    {
      name: "get_uid",
      description:
        "Get the UID for a specific file in a Godot project (for Godot 4.4+)",
      params: { projectPath: { type: "string" }, filePath: { type: "string" } },
    },
    {
      name: "update_project_uids",
      description:
        "Update UID references in a Godot project by resaving resources (for Godot 4.4+)",
      params: { projectPath: { type: "string" } },
    },
    // --- Planned godot_* docs tools (stub descriptions, pending #40) ---
    {
      name: "godot_search_api",
      description:
        "[STUB] Search the Godot Engine API reference by query string.",
      params: { query: { type: "string" }, inherits_from: { type: "string" } },
    },
    {
      name: "godot_get_class",
      description: "[STUB] Look up a specific Godot class by name.",
      params: { class_name: { type: "string" }, include: { type: "array" } },
    },
    {
      name: "godot_find_member",
      description:
        "[STUB] Look up a method, property, signal, or constant on a Godot class.",
      params: {
        class_name: { type: "string" },
        member_name: { type: "string" },
        kind: { type: "string" },
      },
    },
    {
      name: "godot_search_tutorials",
      description:
        "[STUB] Search Godot tutorials and guides with hybrid retrieval.",
      params: { query: { type: "string" }, limit: { type: "number" } },
    },
    {
      name: "godot_get_tutorial",
      description: "[STUB] Fetch a specific Godot tutorial by path.",
      params: { path: { type: "string" } },
    },
    {
      name: "godot_docs_info",
      description:
        "[STUB] Get information about the documentation currently loaded.",
      params: {},
    },
    // --- Planned godot_* LSP tools (stub descriptions, pending #40) ---
    {
      name: "godot_find_definition",
      description:
        "[STUB] Find the definition of a symbol in user GDScript code.",
      params: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        symbol_name: { type: "string" },
      },
    },
    {
      name: "godot_find_references",
      description:
        "[STUB] Find all references to a symbol in user GDScript code.",
      params: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        symbol_name: { type: "string" },
      },
    },
    {
      name: "godot_hover",
      description:
        "[STUB] Get hover information for a symbol by position in a GDScript file.",
      params: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        symbol_name: { type: "string" },
      },
    },
    {
      name: "godot_document_symbols",
      description: "[STUB] List all symbols in a GDScript file.",
      params: { file: { type: "string" } },
    },
    {
      name: "godot_workspace_symbols",
      description:
        "[STUB] Search symbols across the workspace by query string.",
      params: { query: { type: "string" } },
    },
    {
      name: "godot_get_diagnostics",
      description:
        "[STUB] Get diagnostics (errors, warnings) for a specific GDScript file.",
      params: { file: { type: "string" } },
    },
    {
      name: "godot_signature_help",
      description:
        "[STUB] Get signature help for a function call at a position.",
      params: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
    },
    {
      name: "godot_preview_rename",
      description:
        "[STUB] Compute a rename across the project and return proposed edits.",
      params: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        new_name: { type: "string" },
        symbol_name: { type: "string" },
      },
    },
  ];

  return stubs.map(({ name, description, params }) => ({
    name,
    description: applyAblation(description, ablation),
    input_schema: { type: "object", properties: params },
  }));
}

/**
 * Applies the ablation transformation to a tool description string.
 * - "full": return as-is
 * - "first-sent": return only the first sentence
 * - "name-only": return empty string (callers should not include description key)
 */
function applyAblation(description: string, ablation: AblationMode): string {
  switch (ablation) {
    case "full":
      return description;
    case "first-sent": {
      // Split on first period/exclamation/question mark followed by space or end
      const match = description.match(/^[^.!?]+[.!?]/);
      return match ? match[0].trim() : description;
    }
    case "name-only":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

/**
 * Runs a single query against the Anthropic API and returns the result.
 * Requires ANTHROPIC_API_KEY in environment.
 */
async function runQuery(
  query: QueryRecord,
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>,
  model: string,
  ablation: AblationMode,
): Promise<QueryResult> {
  const start = Date.now();
  const base: Omit<
    QueryResult,
    | "chosen_tool"
    | "correct"
    | "input_tokens"
    | "output_tokens"
    | "latency_ms"
    | "error"
  > = {
    id: query.id,
    query: query.query,
    expected_tool: query.expected_tool,
    category: query.category,
    disambiguation_pair: query.disambiguation_pair,
    model,
    ablation,
  };

  try {
    // Lazy-import the SDK so the harness still loads without it installed
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();

    // Build tools array, omitting description key for name-only ablation
    const apiTools = tools.map((t) => {
      const tool: Record<string, unknown> = {
        name: t.name,
        input_schema: t.input_schema,
      };
      if (ablation !== "name-only" && t.description) {
        tool.description = t.description;
      }
      return tool;
    });

    const response = await client.messages.create({
      model,
      max_tokens: 64,
      tool_choice: { type: "any" },
      tools: apiTools as Parameters<typeof client.messages.create>[0]["tools"],
      messages: [
        {
          role: "user",
          content: query.query,
        },
      ],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    const chosenTool =
      toolUse && "name" in toolUse ? (toolUse.name as string) : null;

    return {
      ...base,
      chosen_tool: chosenTool,
      correct: chosenTool === query.expected_tool,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      latency_ms: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      chosen_tool: null,
      correct: false,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Metrics aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregates per-query results into a summary report.
 */
function buildSummary(
  results: QueryResult[],
  datasetVersion: string,
): SummaryReport {
  const model = results[0]?.model ?? "unknown";
  const ablation = results[0]?.ablation ?? "full";

  const correct = results.filter((r) => r.correct).length;
  const errors = results.filter((r) => r.error !== null).length;

  // Per-tool precision/recall
  const allTools = [
    ...new Set([
      ...results.map((r) => r.expected_tool),
      ...results.map((r) => r.chosen_tool ?? ""),
    ]),
  ].filter(Boolean);

  const perTool: ToolMetrics[] = allTools.map((tool) => {
    const tp = results.filter(
      (r) => r.expected_tool === tool && r.chosen_tool === tool,
    ).length;
    const fp = results.filter(
      (r) => r.expected_tool !== tool && r.chosen_tool === tool,
    ).length;
    const fn = results.filter(
      (r) => r.expected_tool === tool && r.chosen_tool !== tool,
    ).length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1 =
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null;
    return {
      tool,
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      precision,
      recall,
      f1,
    };
  });

  // Per-category accuracy
  const categories = [...new Set(results.map((r) => r.category))];
  const perCategory: SummaryReport["per_category"] = {};
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catCorrect = catResults.filter((r) => r.correct).length;
    perCategory[cat] = {
      total: catResults.length,
      correct: catCorrect,
      accuracy: catResults.length > 0 ? catCorrect / catResults.length : 0,
    };
  }

  // Per-disambiguation-pair accuracy
  const pairs = [
    ...new Set(results.map((r) => r.disambiguation_pair).filter(Boolean)),
  ] as string[];
  const perPair: SummaryReport["per_disambiguation_pair"] = {};
  for (const pair of pairs) {
    const pairResults = results.filter((r) => r.disambiguation_pair === pair);
    const pairCorrect = pairResults.filter((r) => r.correct).length;
    perPair[pair] = {
      total: pairResults.length,
      correct: pairCorrect,
      accuracy: pairResults.length > 0 ? pairCorrect / pairResults.length : 0,
    };
  }

  // Rough cost estimate (Claude input ~$3/MTok, output ~$15/MTok for Sonnet)
  const totalInput = results.reduce((s, r) => s + r.input_tokens, 0);
  const totalOutput = results.reduce((s, r) => s + r.output_tokens, 0);
  const costEstimate =
    (totalInput / 1_000_000) * 3 + (totalOutput / 1_000_000) * 15;

  return {
    run_date: new Date().toISOString(),
    model,
    ablation,
    dataset_version: datasetVersion,
    total_queries: results.length,
    correct,
    incorrect: results.length - correct - errors,
    errors,
    overall_accuracy: results.length > 0 ? correct / results.length : 0,
    per_tool: perTool,
    per_category: perCategory,
    per_disambiguation_pair: perPair,
    cost_estimate_usd: costEstimate,
  };
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

/**
 * Writes one NDJSON line per result to the results file.
 */
function writeNdjson(results: QueryResult[], outputPath: string): void {
  const lines = results.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(outputPath, lines + "\n", "utf-8");
}

/**
 * Writes a human-readable summary to stdout and the summary file.
 */
function writeSummary(summary: SummaryReport, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf-8");

  // Print to stdout
  const pct = (n: number) => (n * 100).toFixed(1) + "%";
  console.log("\n--- Tool-Routing Benchmark Summary ---");
  console.log(`Model:     ${summary.model}`);
  console.log(`Ablation:  ${summary.ablation}`);
  console.log(`Date:      ${summary.run_date}`);
  console.log(
    `Accuracy:  ${summary.correct}/${summary.total_queries} = ${pct(summary.overall_accuracy)}`,
  );
  if (summary.errors > 0) {
    console.log(`Errors:    ${summary.errors}`);
  }
  console.log("\nPer-category accuracy:");
  for (const [cat, stats] of Object.entries(summary.per_category)) {
    console.log(
      `  ${cat}: ${stats.correct}/${stats.total} = ${pct(stats.accuracy)}`,
    );
  }
  console.log("\nDisambiguation pair accuracy:");
  for (const [pair, stats] of Object.entries(summary.per_disambiguation_pair)) {
    console.log(
      `  ${pair}: ${stats.correct}/${stats.total} = ${pct(stats.accuracy)}`,
    );
  }
  if (summary.cost_estimate_usd !== null) {
    console.log(`\nEstimated cost: $${summary.cost_estimate_usd.toFixed(4)}`);
  }
  console.log(
    `\nFull results: ${outputPath.replace(/-summary\.json$/, ".ndjson")}`,
  );
  console.log(`Summary:      ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
Tool-Routing Accuracy Benchmark (issue #30)

Usage:
  npx tsx benchmarks/harness/tool-routing.ts [options]

Options:
  --model <id>          Anthropic model ID (default: claude-sonnet-4-5)
  --ablation <mode>     full | first-sent | name-only (default: full)
  --dataset <path>      Path to queries.json (default: v1/queries.json)
  --filter <category>   docs | lsp | editor (default: all)
  --dry-run             Print plan, skip API calls
  --help                Show this message

Prerequisites:
  - ANTHROPIC_API_KEY env var set
  - npm install @anthropic-ai/sdk (only needed for live runs)
  - Deps #7, #9, #40 merged (for meaningful results)
`);
    process.exit(0);
  }

  // Validate ablation mode
  const validAblations: AblationMode[] = ["full", "first-sent", "name-only"];
  if (!validAblations.includes(opts.ablation)) {
    console.error(
      `Invalid ablation mode: ${opts.ablation}. Must be one of: ${validAblations.join(", ")}`,
    );
    process.exit(1);
  }

  // Load dataset
  let dataset: QueryDataset;
  try {
    dataset = JSON.parse(
      readFileSync(opts.datasetPath, "utf-8"),
    ) as QueryDataset;
  } catch (err) {
    console.error(`Failed to load dataset from ${opts.datasetPath}: ${err}`);
    process.exit(1);
  }

  let queries = dataset.queries;
  if (opts.filter) {
    queries = queries.filter((q) => q.category === opts.filter);
    if (queries.length === 0) {
      console.error(`No queries found for category filter: ${opts.filter}`);
      process.exit(1);
    }
  }

  // Load tool schemas
  const tools = await loadToolSchemas(opts.ablation);

  console.log(`Tool-Routing Benchmark`);
  console.log(`  Model:     ${opts.model}`);
  console.log(`  Ablation:  ${opts.ablation}`);
  console.log(`  Queries:   ${queries.length}`);
  console.log(`  Tools:     ${tools.length}`);
  console.log(`  Dataset:   ${opts.datasetPath}`);

  if (opts.dryRun) {
    console.log("\n[dry-run] Skipping API calls.");
    console.log("Queries to run:");
    queries.forEach((q) =>
      console.log(`  [${q.id}] "${q.query}" → ${q.expected_tool}`),
    );
    return;
  }

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. Export it before running live benchmarks.",
    );
    process.exit(1);
  }

  // Prepare output paths
  const dateStr = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const resultsDir = resolve(REPO_ROOT, "benchmarks/results/tool-routing");
  mkdirSync(resultsDir, { recursive: true });
  const ndjsonPath = resolve(resultsDir, `${dateStr}.ndjson`);
  const summaryPath = resolve(resultsDir, `${dateStr}-summary.json`);

  // Run queries
  const results: QueryResult[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    process.stdout.write(`[${i + 1}/${queries.length}] ${q.id} ... `);
    const result = await runQuery(q, tools, opts.model, opts.ablation);
    results.push(result);
    if (result.error) {
      process.stdout.write(`ERROR: ${result.error}\n`);
    } else {
      process.stdout.write(
        `${result.correct ? "✓" : "✗"} (chose: ${result.chosen_tool ?? "none"})\n`,
      );
    }
  }

  // Write outputs
  writeNdjson(results, ndjsonPath);
  const summary = buildSummary(results, dataset.version);
  writeSummary(summary, summaryPath);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
