/**
 * LSP error-type tests.
 *
 * Asserts the contract from `docs/DESIGN.md` § Spawn failures and the Wave 2
 * amendment "Spawn-cycle cap reset" verbatim — the locked recovery-hint
 * strings are part of the public API surface tools consume.
 */

import { describe, it, expect } from "vitest";

import {
  LspBinaryNotFoundError,
  LspConnectionLostError,
  LspHandshakeFailedError,
  LspHandshakeTimeoutError,
  LspPortUnavailableError,
  LspProjectNotFoundError,
  LspProjectPathInvalidError,
  LspSpawnCapExhaustedError,
  LspSpawnFailedError,
  LspUnavailableError,
} from "./errors.js";

describe("LspUnavailableError hierarchy", () => {
  it("every subclass is an instance of LspUnavailableError", () => {
    const all: LspUnavailableError[] = [
      new LspBinaryNotFoundError("nope"),
      new LspProjectNotFoundError("/x"),
      new LspProjectPathInvalidError("/x", "not a dir"),
      new LspPortUnavailableError(6005, 32),
      new LspSpawnFailedError("EACCES"),
      new LspHandshakeTimeoutError(30000),
      new LspHandshakeFailedError("bad version"),
      new LspSpawnCapExhaustedError(3),
      new LspConnectionLostError("ECONNRESET"),
    ];
    for (const e of all) {
      expect(e).toBeInstanceOf(LspUnavailableError);
      expect(e).toBeInstanceOf(Error);
      expect(typeof e.reason).toBe("string");
      expect(typeof e.recoveryHint).toBe("string");
      expect(e.recoveryHint.length).toBeGreaterThan(0);
    }
  });

  it("LspBinaryNotFoundError surfaces the DESIGN.md L403 recovery hint", () => {
    const err = new LspBinaryNotFoundError("/no/such/path");
    expect(err.reason).toBe("binary_not_found");
    expect(err.recoveryHint).toBe("Set `GODOT_PATH` to your Godot binary.");
    expect(err.message).toContain("/no/such/path");
  });

  it("LspProjectPathInvalidError surfaces the DESIGN.md L404 recovery hint", () => {
    const err = new LspProjectPathInvalidError("/x", "not a dir");
    expect(err.reason).toBe("project_path_invalid");
    expect(err.recoveryHint).toBe("No `project.godot` found at `/x`.");
  });

  it("LspPortUnavailableError surfaces the DESIGN.md L405 recovery hint", () => {
    const err = new LspPortUnavailableError(6005, 32);
    expect(err.reason).toBe("port_unavailable");
    expect(err.recoveryHint).toBe(
      "Could not bind any port in range; check for runaway Godot processes.",
    );
    // Message contains the scanned range so log readers can see the budget.
    expect(err.message).toContain("6005");
    expect(err.message).toContain("6036");
  });

  it("LspSpawnCapExhaustedError carries the locked Wave 2 D12 recovery copy", () => {
    const err = new LspSpawnCapExhaustedError(3);
    expect(err.reason).toBe("spawn_cap_exhausted");
    // The exact string is part of the issue #8 acceptance criteria.
    expect(err.recoveryHint).toBe(
      "Restart MCP server (the LSP has exhausted its spawn budget for this session). If this happens repeatedly, check for runaway Godot processes.",
    );
  });

  it("LspProjectNotFoundError mentions the starting directory", () => {
    const err = new LspProjectNotFoundError("/home/user/project");
    expect(err.reason).toBe("project_not_found");
    expect(err.message).toContain("/home/user/project");
  });

  it("LspHandshakeTimeoutError reports the elapsed budget", () => {
    const err = new LspHandshakeTimeoutError(30_000);
    expect(err.reason).toBe("handshake_timeout");
    expect(err.message).toContain("30000");
  });

  it("LspConnectionLostError exposes the connection_lost reason", () => {
    const err = new LspConnectionLostError("ECONNRESET");
    expect(err.reason).toBe("connection_lost");
    expect(err.message).toContain("ECONNRESET");
  });

  it("each subclass sets `name` to its constructor name for stack readability", () => {
    expect(new LspBinaryNotFoundError("x").name).toBe("LspBinaryNotFoundError");
    expect(new LspProjectNotFoundError("/x").name).toBe(
      "LspProjectNotFoundError",
    );
    expect(new LspProjectPathInvalidError("/x", "d").name).toBe(
      "LspProjectPathInvalidError",
    );
    expect(new LspPortUnavailableError(1, 1).name).toBe(
      "LspPortUnavailableError",
    );
    expect(new LspSpawnFailedError("x").name).toBe("LspSpawnFailedError");
    expect(new LspHandshakeTimeoutError(1).name).toBe(
      "LspHandshakeTimeoutError",
    );
    expect(new LspHandshakeFailedError("x").name).toBe(
      "LspHandshakeFailedError",
    );
    expect(new LspSpawnCapExhaustedError(3).name).toBe(
      "LspSpawnCapExhaustedError",
    );
    expect(new LspConnectionLostError("x").name).toBe("LspConnectionLostError");
  });
});
