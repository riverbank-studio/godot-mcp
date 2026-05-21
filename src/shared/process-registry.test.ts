/**
 * Tests for the active-process registry that backs `run_project` / `stop_project`
 * / `get_debug_output`. Only one running project is tracked at a time — the
 * registry replaces (and kills) any prior handle when a new project starts.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

import { ActiveProcessRegistry } from "./process-registry.js";

/**
 * Build a fake child-process handle good enough for the registry's contract.
 */
function fakeProcess(): { kill: ReturnType<typeof vi.fn> } & EventEmitter {
  const p = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
  };
  p.kill = vi.fn();
  return p;
}

describe("ActiveProcessRegistry", () => {
  it("starts empty", () => {
    const r = new ActiveProcessRegistry();
    expect(r.get()).toBeNull();
  });

  it("set() stores the handle and get() returns it", () => {
    const r = new ActiveProcessRegistry();
    const p = fakeProcess();
    r.set({ process: p, output: [], errors: [] });
    expect(r.get()?.process).toBe(p);
  });

  it("set() kills any pre-existing process before replacing it", () => {
    const r = new ActiveProcessRegistry();
    const first = fakeProcess();
    r.set({ process: first, output: [], errors: [] });
    const second = fakeProcess();
    r.set({ process: second, output: [], errors: [] });
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(r.get()?.process).toBe(second);
  });

  it("clear() drops the handle without killing", () => {
    const r = new ActiveProcessRegistry();
    const p = fakeProcess();
    r.set({ process: p, output: [], errors: [] });
    r.clear();
    expect(r.get()).toBeNull();
    expect(p.kill).not.toHaveBeenCalled();
  });

  it("kill() kills and clears", () => {
    const r = new ActiveProcessRegistry();
    const p = fakeProcess();
    r.set({ process: p, output: [], errors: [] });
    r.kill();
    expect(p.kill).toHaveBeenCalledTimes(1);
    expect(r.get()).toBeNull();
  });
});
