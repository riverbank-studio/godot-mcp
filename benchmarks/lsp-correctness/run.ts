/**
 * LSP correctness benchmark runner — issue #45.
 *
 * Usage:
 *
 *   npx tsx benchmarks/lsp-correctness/run.ts [--variant <name>] [--label <id>]
 *
 * Options:
 *   --variant <name>   Run only this variant (cold_call | steady_state |
 *                      external_edit | imprecise_position).  Defaults to all.
 *   --label <id>       Run only the label with this id.  Defaults to all.
 *   --no-write         Skip writing the JSON result file.
 *   --timeout <ms>     Per-call timeout in ms (default 30000).
 *
 * Exit codes:
 *   0  All required labels passed (or LSP unavailable / skipped).
 *   1  One or more labels failed.
 *   2  Configuration error (bad args, labels file missing, etc.).
 *
 * ## Live-run gate
 *
 * The runner checks for `GODOT_PATH` and a reachable `project.godot` at
 * the fixture root before doing anything.  If either is absent it prints
 * a SKIP notice and exits 0 so CI stays green.  The intent is that a
 * developer with Godot installed can `npm run bench:lsp` and get real
 * results; CI gates the build on the harness *compiling*, not on live
 * Godot results.
 *
 * ## Dep isolation note
 *
 * This file imports the harness helpers but intentionally does NOT import
 * from `src/lsp/` or `src/tools/lsp/` directly — those modules require a
 * running MCP server context (ToolContext, LspProvider, etc.) that does
 * not exist in a standalone script.  Instead the runner drives tools
 * through the **MCP stdio transport**: it spawns the MCP server as a child
 * process, sends JSON-RPC `tools/call` messages over its stdin, and reads
 * responses from its stdout.  This is identical to how a real MCP host
 * (e.g. Claude Code) would use the server.
 *
 * The stdio-transport approach has an important benefit: it exercises the
 * full stack (env parsing → process manager → LSP client → tool handler)
 * without requiring the test runner to instantiate any internal class.
 * That keeps the harness valid even as the internal module boundaries
 * change during the Wave 4 / Wave 5 PR sequence.
 *
 * ## Cold-start timing
 *
 * The runner records `cold_start_seconds` as the wall-clock delta between
 * sending the first LSP tool call and receiving the first response.  This
 * value should be recorded in results and compared against the
 * `GODOT_LSP_EAGER_INIT` flag recommendation in DESIGN.md D18.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import {
  evaluate,
  loadLabels,
  resolveFixturePath,
  summarisePassRates,
  writeResult,
  type BenchmarkResult,
  type Label,
  type LabelFile,
  type LabelResult,
  type Variant,
} from "./harness.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

/** Parse a --key value pair from argv, returns undefined if not present. */
function argValue(key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const filterVariant = argValue("--variant") as Variant | undefined;
const filterLabel = argValue("--label");
const noWrite = args.includes("--no-write");
const perCallTimeoutMs = Number(argValue("--timeout") ?? "30000");

// ---------------------------------------------------------------------------
// Live-run gate
// ---------------------------------------------------------------------------

const FIXTURE_PROJECT = path.resolve(
  import.meta.dirname ?? __dirname,
  "../../datasets/lsp-correctness/v1/fixtures/project",
);

const SERVER_ENTRY = path.resolve(
  import.meta.dirname ?? __dirname,
  "../../build/index.js",
);

/**
 * Check whether we have a Godot binary and the fixture project.
 * Returns a skip reason string, or null if we should proceed.
 */
function checkLiveGate(): string | null {
  const godotPath = process.env["GODOT_PATH"];
  if (!godotPath) {
    return "GODOT_PATH not set — skipping live LSP run";
  }
  if (!fs.existsSync(godotPath)) {
    return `GODOT_PATH=${godotPath} does not exist — skipping live LSP run`;
  }
  const projectFile = path.join(FIXTURE_PROJECT, "project.godot");
  if (!fs.existsSync(projectFile)) {
    return `Fixture project.godot not found at ${projectFile} — skipping live LSP run`;
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    return `MCP server not built (${SERVER_ENTRY} missing) — run 'npm run build' first`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP stdio client
// ---------------------------------------------------------------------------

/** Minimal JSON-RPC envelope. */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Thin wrapper around an MCP server child process.  Sends JSON-RPC
 * requests over stdin and resolves with the corresponding stdout response.
 */
class McpClient {
  private child: ChildProcess;
  private pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private stderr: string[] = [];

  constructor(serverPath: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [serverPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return; // ignore non-JSON output (Godot [godot] prefixed lines, etc.)
      }
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
    });

    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString());
    });
  }

  /** Send a JSON-RPC request; resolve with the response. */
  async send(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timeout after ${timeoutMs}ms waiting for id=${id} (${method})`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  /** Call a tool and return the parsed content text. */
  async callTool(
    name: string,
    toolArgs: Record<string, unknown>,
    timeoutMs: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const resp = await this.send(
      "tools/call",
      { name, arguments: toolArgs },
      timeoutMs,
    );
    if (resp.error) {
      throw new Error(`MCP error ${resp.error.code}: ${resp.error.message}`);
    }
    // MCP tools/call result: { content: [{ type: "text", text: "..." }] }
    const content = (
      resp.result as { content?: Array<{ type: string; text?: string }> }
    )?.content;
    const text = content?.find((c) => c.type === "text")?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Terminate the server. */
  kill() {
    this.child.kill("SIGTERM");
  }

  /** Collected server stderr (for diagnostics). */
  getStderr(): string {
    return this.stderr.join("");
  }
}

// ---------------------------------------------------------------------------
// Per-label runner
// ---------------------------------------------------------------------------

/**
 * Build the tool arguments for a given label + variant.
 */
function buildArgs(
  label: Label,
  labelFile: LabelFile,
  variant: Variant,
): Record<string, unknown> {
  const absFile = resolveFixturePath(labelFile, label.file);

  // Imprecise-position variant: pass symbol_name instead of (line, character)
  if (variant === "imprecise_position" && label.symbol_name) {
    return { file: absFile, symbol_name: label.symbol_name };
  }

  const base: Record<string, unknown> = { file: absFile };
  if (label.line !== undefined) base["line"] = label.line;
  if (label.character !== undefined) base["character"] = label.character;
  return base;
}

/**
 * Apply the `external_edit` mutation to a file and return a cleanup function
 * that reverts it.
 */
function applyExternalEdit(
  absFile: string,
  edit: NonNullable<Label["external_edit"]>,
): () => void {
  const original = fs.readFileSync(absFile, "utf-8");
  const mutated = original + "\n" + edit.append_line + "\n";
  fs.writeFileSync(absFile, mutated, "utf-8");
  return () => fs.writeFileSync(absFile, original, "utf-8");
}

/**
 * Run a single label in a single variant.  Returns a `LabelResult`.
 */
async function runLabel(
  client: McpClient,
  label: Label,
  labelFile: LabelFile,
  variant: Variant,
): Promise<LabelResult> {
  const base: Omit<
    LabelResult,
    "pass" | "latency_ms" | "raw_response" | "failure_reason"
  > = {
    id: label.id,
    variant,
    tool: label.tool,
  };

  // External-edit variant: mutate file, run query, revert.
  let revert: (() => void) | undefined;
  if (variant === "external_edit" && label.external_edit) {
    const absFile = resolveFixturePath(labelFile, label.file);
    revert = applyExternalEdit(absFile, label.external_edit);
  }

  const toolArgs = buildArgs(label, labelFile, variant);
  const start = Date.now();
  let rawResponse: unknown;

  try {
    rawResponse = await client.callTool(label.tool, toolArgs, perCallTimeoutMs);
  } catch (err) {
    revert?.();
    const errMsg = String(err);
    return {
      ...base,
      pass: false,
      latency_ms: Date.now() - start,
      raw_response: errMsg,
      failure_reason: errMsg,
    };
  } finally {
    revert?.();
  }

  const latency_ms = Date.now() - start;
  const raw_response = JSON.stringify(rawResponse).slice(0, 2000);

  const evalResult = evaluate(label.expect, rawResponse);
  return {
    ...base,
    pass: evalResult.pass,
    latency_ms,
    raw_response,
    ...(evalResult.pass ? {} : { failure_reason: evalResult.reason }),
  };
}

// ---------------------------------------------------------------------------
// Warmup / initialize
// ---------------------------------------------------------------------------

/**
 * Send an MCP `initialize` handshake to the server and return the round-trip
 * time in ms.
 */
async function initialize(
  client: McpClient,
  timeoutMs: number,
): Promise<number> {
  const start = Date.now();
  await client.send(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lsp-bench", version: "1" },
    },
    timeoutMs,
  );
  return Date.now() - start;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const skipReason = checkLiveGate();
  if (skipReason) {
    console.log(`SKIP: ${skipReason}`);
    process.exit(0);
  }

  // Load labels.
  let labelFile: LabelFile;
  try {
    labelFile = loadLabels();
  } catch (err) {
    console.error(`ERROR: Failed to load labels: ${err}`);
    process.exit(2);
  }

  // Filter labels and variants.
  const labels = filterLabel
    ? labelFile.labels.filter((l) => l.id === filterLabel)
    : labelFile.labels;

  if (labels.length === 0) {
    console.error(
      `ERROR: No labels match filter (label=${filterLabel ?? "*"})`,
    );
    process.exit(2);
  }

  // Spawn MCP server.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GODOT_LSP_PROJECT_PATH: FIXTURE_PROJECT,
    // Disable eager init so we can measure cold-start explicitly.
    GODOT_LSP_EAGER_INIT: "false",
  };
  const client = new McpClient(SERVER_ENTRY, env);

  console.log("Initialising MCP server...");
  let initMs: number;
  try {
    initMs = await initialize(client, 60_000);
    console.log(`  MCP initialized in ${initMs}ms`);
  } catch (err) {
    console.error(`ERROR: MCP initialize failed: ${err}`);
    console.error("Server stderr:\n" + client.getStderr());
    client.kill();
    process.exit(2);
  }

  // ---------------------------------------------------------------------------
  // Cold-call timing: run first label marked cold_call, record latency.
  // ---------------------------------------------------------------------------

  const coldLabel = labels.find((l) => l.variants.includes("cold_call"));
  let coldStartSeconds: number | null = null;

  if (coldLabel) {
    console.log(`\nCold-call: ${coldLabel.id}`);
    const coldResult = await runLabel(
      client,
      coldLabel,
      labelFile,
      "cold_call",
    );
    coldStartSeconds = coldResult.latency_ms / 1000;
    const status = coldResult.pass ? "PASS" : "FAIL";
    console.log(
      `  ${status}  ${coldResult.latency_ms}ms` +
        (coldResult.failure_reason ? `  — ${coldResult.failure_reason}` : ""),
    );
  }

  // ---------------------------------------------------------------------------
  // Steady-state warmup: send a no-op tools/list to let the LSP settle.
  // ---------------------------------------------------------------------------

  console.log("\nWaiting for LSP steady-state (tools/list probe)...");
  try {
    await client.send("tools/list", {}, 60_000);
    console.log("  LSP ready");
  } catch {
    console.warn("  tools/list probe timed out; continuing anyway");
  }

  // ---------------------------------------------------------------------------
  // Main pass: iterate labels × variants.
  // ---------------------------------------------------------------------------

  const allResults: LabelResult[] = [];

  const variants: Variant[] = filterVariant
    ? [filterVariant]
    : ["cold_call", "steady_state", "external_edit", "imprecise_position"];

  for (const label of labels) {
    const applicableVariants = label.variants.filter((v) =>
      variants.includes(v),
    );
    for (const variant of applicableVariants) {
      // cold_call was already run above.
      if (variant === "cold_call") {
        const existing = allResults.find(
          (r) => r.id === label.id && r.variant === "cold_call",
        );
        if (!existing) {
          // Run it if not already done.
          const r = await runLabel(client, label, labelFile, variant);
          allResults.push(r);
        }
        continue;
      }

      const r = await runLabel(client, label, labelFile, variant);
      allResults.push(r);

      const status = r.pass ? "PASS" : "FAIL";
      console.log(
        `  [${variant}] ${label.id}: ${status}  ${r.latency_ms}ms` +
          (r.failure_reason ? `  — ${r.failure_reason}` : ""),
      );
    }
  }

  // If cold_call label was done earlier, fold it in.
  if (
    coldLabel &&
    !allResults.find((r) => r.id === coldLabel.id && r.variant === "cold_call")
  ) {
    // The cold result was logged separately — re-run in allResults is fine.
  }

  // ---------------------------------------------------------------------------
  // Summarise and report.
  // ---------------------------------------------------------------------------

  const passRates = summarisePassRates(allResults);

  console.log("\n=== Pass rates ===");
  let overallPass = 0;
  let overallTotal = 0;
  for (const [tool, { pass, total, rate }] of Object.entries(passRates)) {
    const pct = (rate * 100).toFixed(0);
    console.log(`  ${tool}: ${pass}/${total} (${pct}%)`);
    overallPass += pass;
    overallTotal += total;
  }
  const overallPct = overallTotal
    ? ((overallPass / overallTotal) * 100).toFixed(0)
    : "0";
  console.log(`  OVERALL: ${overallPass}/${overallTotal} (${overallPct}%)`);

  if (coldStartSeconds !== null) {
    console.log(`\nCold-start: ${coldStartSeconds.toFixed(2)}s`);
    if (coldStartSeconds >= 8) {
      console.log(
        "  ⚠  Cold-start ≥8s — consider setting GODOT_LSP_EAGER_INIT=true (DESIGN.md D18)",
      );
    }
  }

  // Detect failures.
  const failures = allResults.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.log("\n=== Failures ===");
    for (const f of failures) {
      console.log(`  [${f.variant}] ${f.id}: ${f.failure_reason}`);
    }
  }

  // Write result file.
  const runDate = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\..+/, "");
  const godotVersion = process.env["GODOT_PATH"]
    ? runDate /* placeholder; a real run would query godot --version */
    : "unknown";

  const result: BenchmarkResult = {
    run_date: runDate,
    godot_version: godotVersion,
    fixture_version: "1",
    cold_start_seconds: coldStartSeconds,
    pass_rates: passRates,
    results: allResults,
  };

  if (!noWrite) {
    const outPath = writeResult(result);
    console.log(`\nResults written to: ${outPath}`);
  }

  // Clean up.
  client.kill();

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unhandled error in benchmark runner:", err);
  process.exit(2);
});
