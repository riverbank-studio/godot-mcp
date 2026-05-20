/**
 * Headless Godot LSP process management.
 *
 * Implements `docs/DESIGN.md` § LSP subsystem → Process management with the
 * Wave 2 amendments folded in:
 *
 *   - Spawn command: `godot --editor --headless --lsp-port {port} --path {project}`.
 *     `--editor` MUST precede `--headless` — research item from `lsp-specialist.md`
 *     flagged that some Godot versions parse argv order-sensitively.
 *   - Lazy by default; eager init is a higher-layer concern (the client
 *     calls `spawn()` when configured to).
 *   - Port selection: upward scan from `LspConfig.port`.
 *   - stdout/stderr piped to MCP's stderr with `[godot]` prefix; at `info`
 *     level only warn/error lines flow through, at `debug` everything
 *     (Wave 2 D24).
 *   - Shutdown: SIGINT, SIGTERM, and normal exit handlers kill the child.
 *   - Spawn-cycle cap (default 3) with reset on successful handshake and
 *     windowed reset via `spawnResetMinutes` (Wave 2 D12).
 *
 * The process manager is **standalone**: it does NOT speak LSP. It owns
 * the child process and the chosen port; the client layer handles JSON-RPC
 * over the resulting TCP connection. This split makes the manager
 * testable without a real Godot binary (the spawn function is injectable).
 */

import {
  spawn as nativeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

import { createLogger, getCurrentLogLevel } from "../shared/logging.js";

import type { LspConfig } from "./config.js";
import { LspSpawnCapExhaustedError, LspSpawnFailedError } from "./errors.js";
import { findAvailablePort } from "./port-scan.js";

/** Subsystem name used for stderr log lines. */
const SUBSYSTEM = "lsp";

/**
 * Lines from Godot's stdout/stderr that should propagate at `info` level.
 * Anything not matching is filtered out at `info` and below; everything
 * passes at `debug` (with the leak warning per DESIGN.md L617).
 */
const WARN_ERROR_PATTERN = /\b(ERROR|WARN(?:ING)?|FATAL)\b/i;

/**
 * Construction options for the spawn manager. Tests inject `spawn` and
 * `now` to keep things deterministic.
 */
export interface LspProcessManagerOptions {
  /** Parsed LSP env config. The manager consults `port`, `portScanAttempts`,
   *  `spawnCap`, and `spawnResetMinutes`. */
  config: LspConfig;
  /** Absolute path to the Godot binary. Resolved by the caller (`GodotPathResolver`). */
  godotPath: string;
  /** Absolute path to the project root (validated by `project-detect.ts`). */
  projectPath: string;
  /**
   * Child-process spawner. Defaults to `child_process.spawn`. Tests inject
   * a fake that returns a `ChildProcess`-shaped mock.
   */
  spawn?: typeof nativeSpawn;
  /**
   * Port-availability probe. Defaults to the TCP bind probe in
   * `port-scan.ts`. Tests inject a deterministic stub.
   */
  portProbe?: (port: number) => Promise<boolean>;
  /** Wall-clock source. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * If true, register `SIGINT` / `SIGTERM` / `beforeExit` handlers on
   * `process`. Defaults to true in production. Tests pass `false` to keep
   * the global event-emitter clean across test files.
   */
  installExitHandlers?: boolean;
}

/**
 * Information about an in-flight headless Godot process.
 */
export interface LspProcessHandle {
  /** The chosen TCP port the child is listening on. */
  port: number;
  /** Direct handle to the Node child process. The client doesn't use this
   *  for I/O — TCP is the data path — but kill/wait operations land here. */
  child: ChildProcess;
  /**
   * Resolves when the child exits. `code` is null when killed by signal;
   * `signal` is the signal name in that case. The promise never rejects;
   * abnormal exits surface through `code` / `signal`.
   */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Public surface of the spawn manager. The class enforces three things:
 *   - One live process at a time (sequenced spawn calls).
 *   - Spawn-cycle cap with windowed reset (Wave 2 D12).
 *   - Bookkeeping for the on-successful-handshake reset rule.
 */
export class LspProcessManager {
  private readonly opts: LspProcessManagerOptions;
  private readonly logger = createLogger(SUBSYSTEM);
  private active: LspProcessHandle | null = null;
  /** Number of spawn cycles within the current reset window. */
  private spawnCount = 0;
  /** Wall-clock of the most recent spawn attempt. 0 == never. */
  private lastSpawnAt = 0;
  /** Set true when `markCapExhausted` has fired; the LSP is dead-for-session. */
  private capExhausted = false;
  /** Removable exit handlers; tracked so {@link dispose} can detach them. */
  private exitHandlers: Array<{ event: string; handler: () => void }> = [];

  constructor(opts: LspProcessManagerOptions) {
    this.opts = opts;
    if (opts.installExitHandlers !== false) {
      this.installExitHandlers();
    }
  }

  /**
   * Spawn a fresh headless Godot. Increments the spawn-cycle counter and
   * throws {@link LspSpawnCapExhaustedError} if the cap has been hit
   * within the active reset window.
   *
   * The returned handle is also stored as `active` for {@link kill} and
   * exit-cleanup paths. Calling `spawn()` while a process is active first
   * tears down the existing handle.
   */
  async spawn(): Promise<LspProcessHandle> {
    if (this.capExhausted) {
      throw new LspSpawnCapExhaustedError(this.opts.config.spawnCap);
    }
    this.maybeResetWindow();
    if (this.spawnCount >= this.opts.config.spawnCap) {
      this.capExhausted = true;
      throw new LspSpawnCapExhaustedError(this.opts.config.spawnCap);
    }

    if (this.active) {
      this.killActive();
    }

    this.spawnCount += 1;
    this.lastSpawnAt = this.now();
    this.logger.info(
      `spawning headless Godot (cycle ${this.spawnCount}/${this.opts.config.spawnCap})`,
    );

    const port = await findAvailablePort(
      this.opts.config.port,
      this.opts.config.portScanAttempts,
      this.opts.portProbe,
    );

    // Argv order matters: `--editor` MUST come before `--headless` per
    // the LSP specialist review's open question. The path/port flags
    // can follow in any order but we keep a canonical layout for grep.
    const args = [
      "--editor",
      "--headless",
      "--lsp-port",
      String(port),
      "--path",
      this.opts.projectPath,
    ];

    const spawnFn = this.opts.spawn ?? nativeSpawn;
    const spawnOpts: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      // Detach is intentionally **false**: we want the child tied to our
      // process group so OS-level cleanup catches it if we die abruptly.
      detached: false,
    };

    let child: ChildProcess;
    try {
      child = spawnFn(this.opts.godotPath, args, spawnOpts);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new LspSpawnFailedError(detail);
    }

    this.attachStdioForwarders(child);

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => {
        this.logger.info(
          `headless Godot exited (code=${code} signal=${signal})`,
        );
        if (this.active && this.active.child === child) {
          this.active = null;
        }
        resolve({ code, signal });
      });
      // `error` events fire when the spawn itself failed asynchronously
      // (e.g. ENOENT after the call returned). We translate to a
      // synthetic exit so callers don't have to handle both shapes.
      child.once("error", (err) => {
        this.logger.error(`headless Godot error: ${err.message}`);
        if (this.active && this.active.child === child) {
          this.active = null;
        }
        resolve({ code: null, signal: null });
      });
    });

    const handle: LspProcessHandle = { port, child, exited };
    this.active = handle;
    return handle;
  }

  /**
   * Called by the client layer once a handshake succeeds. Resets the
   * spawn-cycle counter per Wave 2 amendment D12 ("one good connection
   * clears the budget").
   */
  noteHandshakeSuccess(): void {
    if (this.spawnCount > 0) {
      this.logger.debug(
        `handshake succeeded; resetting spawn counter from ${this.spawnCount}`,
      );
    }
    this.spawnCount = 0;
  }

  /**
   * The current spawn-cycle counter value. Exposed for telemetry and
   * tests; the client layer should not gate behavior on this — call
   * {@link spawn} and catch {@link LspSpawnCapExhaustedError} instead.
   */
  spawnCycleCount(): number {
    return this.spawnCount;
  }

  /**
   * Whether the cap has been hit and LSP is permanently unavailable for
   * the session.
   */
  isCapExhausted(): boolean {
    return this.capExhausted;
  }

  /**
   * Current active handle, or null if no process is live.
   */
  current(): LspProcessHandle | null {
    return this.active;
  }

  /**
   * The absolute project path the manager is configured to spawn against.
   * Surfaced for the client's `initialize` handshake (`rootUri` /
   * `workspaceFolders`).
   */
  projectPath(): string {
    return this.opts.projectPath;
  }

  /**
   * The Godot binary path the manager is configured to spawn. Surfaced for
   * diagnostics / telemetry; the spawn line is otherwise the only consumer.
   */
  godotPath(): string {
    return this.opts.godotPath;
  }

  /**
   * Kill the active child if any. Idempotent.
   */
  kill(): void {
    if (this.active) {
      this.killActive();
    }
  }

  /**
   * Stop the manager: kill the active child and remove all registered
   * process-exit handlers. Called from the top-level `cleanup()` path.
   */
  dispose(): void {
    this.kill();
    for (const { event, handler } of this.exitHandlers) {
      try {
        process.off(event as NodeJS.Signals | "beforeExit", handler);
      } catch {
        // Best-effort: removal failures don't affect correctness.
      }
    }
    this.exitHandlers = [];
  }

  /**
   * If the active reset window has rolled, zero the spawn counter so the
   * next call to {@link spawn} starts fresh. Internal.
   */
  private maybeResetWindow(): void {
    if (this.spawnCount === 0) return;
    const elapsedMs = this.now() - this.lastSpawnAt;
    const windowMs = this.opts.config.spawnResetMinutes * 60_000;
    if (elapsedMs >= windowMs) {
      this.logger.debug(
        `spawn reset window elapsed (${elapsedMs}ms ≥ ${windowMs}ms); zeroing counter`,
      );
      this.spawnCount = 0;
    }
  }

  /**
   * Forward Godot's stdout/stderr to MCP's stderr with `[godot]` prefix.
   * At log level `info` and below, only lines matching
   * {@link WARN_ERROR_PATTERN} get through; `debug` forwards everything.
   * Wave 2 D24.
   */
  private attachStdioForwarders(child: ChildProcess): void {
    const debug = getCurrentLogLevel() === "debug";
    const forward = (chunk: Buffer | string, label: string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line === "") continue;
        if (!debug && !WARN_ERROR_PATTERN.test(line)) continue;
        // Write directly to stderr — bypassing the leveled logger so the
        // `[godot]` prefix and the raw line shape land verbatim.
        process.stderr.write(`[godot][${label}] ${line}\n`);
      }
    };
    if (child.stdout) {
      child.stdout.on("data", (chunk) => forward(chunk, "out"));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => forward(chunk, "err"));
    }
  }

  /**
   * Register SIGINT/SIGTERM/beforeExit handlers that kill the child.
   * Removed by {@link dispose}.
   */
  private installExitHandlers(): void {
    const handler = () => this.kill();
    const events: Array<"SIGINT" | "SIGTERM" | "beforeExit"> = [
      "SIGINT",
      "SIGTERM",
      "beforeExit",
    ];
    for (const event of events) {
      // Node's typings don't permit `process.on('beforeExit', () => void)`
      // and `process.on('SIGINT', () => void)` in one signature; both are
      // accepted at runtime so we cross the line with `as never`.
      process.on(event as never, handler as never);
      this.exitHandlers.push({ event, handler });
    }
  }

  /**
   * Best-effort kill of the active child. Errors swallowed — the OS may
   * have reaped the process already.
   */
  private killActive(): void {
    if (!this.active) return;
    const { child } = this.active;
    try {
      if (!child.killed) {
        child.kill();
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.debug(`kill failed (likely already exited): ${detail}`);
    }
    this.active = null;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
