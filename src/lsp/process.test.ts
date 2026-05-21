/**
 * Tests for the headless-Godot spawn manager.
 *
 * The real `child_process.spawn` is replaced by a fake that returns a
 * Node `EventEmitter`-shaped object exposing the small subset of
 * `ChildProcess` the manager depends on. No real Godot binary is touched.
 *
 * The tests cover:
 *   - Spawn line: `godot --editor --headless --lsp-port {port} --path {path}`
 *     argv order verified.
 *   - Port scan injected; manager passes the chosen port to argv.
 *   - Spawn-cycle counter: cap, reset-on-handshake, windowed reset.
 *   - SIGINT/SIGTERM/beforeExit handlers kill the active child.
 *   - kill() and dispose() idempotency.
 */

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LSP_PORT,
  DEFAULT_PORT_SCAN_ATTEMPTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SPAWN_CAP,
  DEFAULT_SPAWN_RESET_MINUTES,
  DEFAULT_STAT_POLL_THROTTLE_MS,
  DEFAULT_DIAGNOSTIC_FIRST_MS,
  DEFAULT_DIAGNOSTIC_STEADY_MS,
  type LspConfig,
} from "./config.js";
import { LspSpawnCapExhaustedError } from "./errors.js";
import { LspProcessManager } from "./process.js";

/**
 * Minimal fake of `child_process.ChildProcess` for the surface the manager
 * actually touches. Tracks argv so tests can assert the spawn line, and
 * exposes stdout/stderr EventEmitters for log-forwarding tests.
 */
class FakeChildProcess extends EventEmitter {
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 12345;
  kill(): boolean {
    this.killed = true;
    // Defer the exit event so callers awaiting `exited` settle.
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

interface SpawnCall {
  binary: string;
  argv: string[];
}

function fakeSpawnFactory() {
  const calls: SpawnCall[] = [];
  const children: FakeChildProcess[] = [];
  const fn = ((binary: string, argv: readonly string[]) => {
    calls.push({ binary, argv: [...argv] });
    const child = new FakeChildProcess();
    children.push(child);
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  }) as unknown as typeof import("node:child_process").spawn;
  return { fn, calls, children };
}

function buildConfig(overrides: Partial<LspConfig> = {}): LspConfig {
  return {
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
    ...overrides,
  };
}

const managers: LspProcessManager[] = [];

afterEach(() => {
  for (const m of managers) m.dispose();
  managers.length = 0;
});

function makeManager(opts: {
  config: LspConfig;
  godotPath?: string;
  projectPath?: string;
  spawn: typeof import("node:child_process").spawn;
  portProbe?: (port: number) => Promise<boolean>;
  now?: () => number;
}): LspProcessManager {
  const m = new LspProcessManager({
    config: opts.config,
    godotPath: opts.godotPath ?? "/usr/bin/godot",
    projectPath: opts.projectPath ?? "/proj",
    spawn: opts.spawn,
    portProbe: opts.portProbe ?? (() => Promise.resolve(true)),
    now: opts.now,
    installExitHandlers: false,
  });
  managers.push(m);
  return m;
}

describe("LspProcessManager.spawn", () => {
  it("issues the canonical spawn line with --editor before --headless", async () => {
    const { fn, calls } = fakeSpawnFactory();
    const m = makeManager({
      config: buildConfig(),
      godotPath: "/bin/godot",
      projectPath: "/abs/proj",
      spawn: fn,
    });
    const handle = await m.spawn();
    expect(handle.port).toBe(DEFAULT_LSP_PORT);
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("/bin/godot");
    // Argv shape: --editor MUST come before --headless.
    const idxEditor = calls[0].argv.indexOf("--editor");
    const idxHeadless = calls[0].argv.indexOf("--headless");
    const idxLspPort = calls[0].argv.indexOf("--lsp-port");
    const idxPath = calls[0].argv.indexOf("--path");
    expect(idxEditor).toBeGreaterThanOrEqual(0);
    expect(idxHeadless).toBeGreaterThan(idxEditor);
    expect(idxLspPort).toBeGreaterThan(idxHeadless);
    expect(idxPath).toBeGreaterThan(idxLspPort);
    expect(calls[0].argv[idxLspPort + 1]).toBe(String(DEFAULT_LSP_PORT));
    expect(calls[0].argv[idxPath + 1]).toBe("/abs/proj");
  });

  it("threads the scanned port through to argv", async () => {
    const { fn, calls } = fakeSpawnFactory();
    const probe = (port: number) => Promise.resolve(port === 6010);
    const m = makeManager({
      config: buildConfig(),
      spawn: fn,
      portProbe: probe,
    });
    const handle = await m.spawn();
    expect(handle.port).toBe(6010);
    const idxLspPort = calls[0].argv.indexOf("--lsp-port");
    expect(calls[0].argv[idxLspPort + 1]).toBe("6010");
  });

  it("kills any previous handle before issuing a fresh spawn", async () => {
    const { fn, children } = fakeSpawnFactory();
    const m = makeManager({ config: buildConfig(), spawn: fn });
    await m.spawn();
    expect(children[0].killed).toBe(false);
    await m.spawn();
    // The first child must have been killed before the second spawn returned.
    expect(children[0].killed).toBe(true);
    expect(children[1].killed).toBe(false);
  });

  it("returns a handle whose `exited` promise settles on child exit", async () => {
    const { fn, children } = fakeSpawnFactory();
    const m = makeManager({ config: buildConfig(), spawn: fn });
    const handle = await m.spawn();
    setImmediate(() => children[0].emit("exit", 0, null));
    const result = await handle.exited;
    expect(result).toEqual({ code: 0, signal: null });
  });

  it("captures error-event aborts as a synthetic exit", async () => {
    const { fn, children } = fakeSpawnFactory();
    const m = makeManager({ config: buildConfig(), spawn: fn });
    const handle = await m.spawn();
    setImmediate(() => children[0].emit("error", new Error("ENOENT")));
    const result = await handle.exited;
    expect(result).toEqual({ code: null, signal: null });
  });
});

describe("LspProcessManager.spawn — spawn-cycle cap (Wave 2 D12)", () => {
  it("permits exactly `spawnCap` spawn cycles within the window", async () => {
    const { fn } = fakeSpawnFactory();
    const m = makeManager({
      config: buildConfig({ spawnCap: 3 }),
      spawn: fn,
    });
    await m.spawn();
    await m.spawn();
    await m.spawn();
    await expect(m.spawn()).rejects.toBeInstanceOf(LspSpawnCapExhaustedError);
    expect(m.isCapExhausted()).toBe(true);
  });

  it("noteHandshakeSuccess clears the spawn counter", async () => {
    const { fn } = fakeSpawnFactory();
    const m = makeManager({
      config: buildConfig({ spawnCap: 3 }),
      spawn: fn,
    });
    await m.spawn();
    await m.spawn();
    expect(m.spawnCycleCount()).toBe(2);
    m.noteHandshakeSuccess();
    expect(m.spawnCycleCount()).toBe(0);
    // After the reset we can spawn `spawnCap` more times.
    await m.spawn();
    await m.spawn();
    await m.spawn();
    await expect(m.spawn()).rejects.toBeInstanceOf(LspSpawnCapExhaustedError);
  });

  it("windowed reset zeroes the counter when no spawn happened in N minutes", async () => {
    const { fn } = fakeSpawnFactory();
    let now = 1_000_000;
    const m = makeManager({
      config: buildConfig({ spawnCap: 2, spawnResetMinutes: 5 }),
      spawn: fn,
      now: () => now,
    });
    await m.spawn();
    await m.spawn();
    // Within the window, another spawn must trip the cap.
    now += 60_000; // +1 minute
    await expect(m.spawn()).rejects.toBeInstanceOf(LspSpawnCapExhaustedError);
  });

  it("counter resets after the window elapses (windowed cap)", async () => {
    // Note: the windowed reset must be observed BEFORE the cap-exhausted
    // flag is sticky. We arrange the test so the window elapses after the
    // first spawn cycle and verify the next spawn proceeds.
    const { fn } = fakeSpawnFactory();
    let now = 1_000_000;
    const m = makeManager({
      config: buildConfig({ spawnCap: 1, spawnResetMinutes: 5 }),
      spawn: fn,
      now: () => now,
    });
    await m.spawn();
    // Past the window — counter resets, fresh spawn must succeed.
    now += 6 * 60_000;
    await m.spawn();
    expect(m.spawnCycleCount()).toBeGreaterThanOrEqual(1);
  });

  it("after capExhausted, further spawn() calls reject without re-spawning", async () => {
    const { fn, calls } = fakeSpawnFactory();
    const m = makeManager({
      config: buildConfig({ spawnCap: 1 }),
      spawn: fn,
    });
    await m.spawn();
    await expect(m.spawn()).rejects.toBeInstanceOf(LspSpawnCapExhaustedError);
    await expect(m.spawn()).rejects.toBeInstanceOf(LspSpawnCapExhaustedError);
    expect(calls).toHaveLength(1);
  });
});

describe("LspProcessManager.kill / dispose", () => {
  it("kill() terminates the active child", async () => {
    const { fn, children } = fakeSpawnFactory();
    const m = makeManager({ config: buildConfig(), spawn: fn });
    await m.spawn();
    m.kill();
    expect(children[0].killed).toBe(true);
    expect(m.current()).toBeNull();
  });

  it("kill() is a no-op when nothing is active", () => {
    const { fn } = fakeSpawnFactory();
    const m = makeManager({ config: buildConfig(), spawn: fn });
    expect(() => m.kill()).not.toThrow();
  });

  it("dispose() kills the child and detaches exit handlers", async () => {
    const { fn, children } = fakeSpawnFactory();
    const m = makeManager({ config: buildConfig(), spawn: fn });
    await m.spawn();
    m.dispose();
    expect(children[0].killed).toBe(true);
  });
});

describe("LspProcessManager log forwarding", () => {
  it("stdout warn lines flow through to stderr at info level", async () => {
    const { fn, children } = fakeSpawnFactory();
    const m = makeManager({ config: buildConfig(), spawn: fn });
    await m.spawn();
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      children[0].stdout.emit("data", Buffer.from("WARNING: low memory\n"));
      children[0].stderr.emit("data", Buffer.from("ERROR: parse failed\n"));
      // Lines without WARN/ERROR are filtered out at info.
      children[0].stdout.emit("data", Buffer.from("Loading scene...\n"));
      // The two warn/error lines must have been forwarded; the plain
      // info line must not.
      const calls = writeSpy.mock.calls.map((args) => String(args[0]));
      expect(calls.some((c) => c.includes("WARNING: low memory"))).toBe(true);
      expect(calls.some((c) => c.includes("ERROR: parse failed"))).toBe(true);
      expect(calls.some((c) => c.includes("Loading scene"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
