/**
 * Single-slot active-process registry backing `run_project`/`stop_project`/
 * `get_debug_output`. The MCP server tracks one running Godot project at a
 * time; this class encapsulates the "kill the prior process before storing a
 * new one" contract so handlers can stay declarative.
 */

import type { GodotProcess, IActiveProcessRegistry } from "./types.js";

export class ActiveProcessRegistry implements IActiveProcessRegistry {
  private current: GodotProcess | null = null;

  /**
   * Get the currently-tracked process handle, or null if none.
   */
  get(): GodotProcess | null {
    return this.current;
  }

  /**
   * Store a new process handle, killing any prior handle first. The kill is
   * fire-and-forget; we do not wait for the OS to confirm the child exited.
   */
  set(handle: GodotProcess): void {
    if (this.current) {
      try {
        this.current.process.kill();
      } catch {
        // Ignore: the prior process may already have exited. The new handle
        // is what callers care about; failing here would surprise the caller.
      }
    }
    this.current = handle;
  }

  /**
   * Drop the handle without killing the process. Used from the `exit` listener
   * the spawner registers.
   */
  clear(): void {
    this.current = null;
  }

  /**
   * Kill the active process if any, then clear the slot.
   */
  kill(): void {
    if (this.current) {
      try {
        this.current.process.kill();
      } catch {
        // Ignore; process may have exited.
      }
      this.current = null;
    }
  }
}
