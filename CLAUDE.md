# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps
npm run build        # tsc, then scripts/build.js (chmod + copy GDScript assets)
npm run watch        # tsc --watch — does NOT copy GDScript assets; run build for a runnable bundle
npm run inspector    # launch MCP Inspector against build/index.js (interactive tool debugging)
```

## Architecture

This codebase is mid-redesign — read [docs/DESIGN.md](docs/DESIGN.md) before starting any non-trivial work. It defines the target module layout, the `godot_` tool-name prefix rename, and two upcoming subsystems (docs and LSP) that all new tools should be built against.

### The two-path execution model (non-obvious)

Tools fall into two buckets that work very differently:

1. **Direct CLI invocations** shell out to Godot via `execFileAsync(godotPath, [...args])` or `spawn(...)`. Arguments are always passed as arrays — never string-concatenated — to avoid shell injection. The codebase deliberately uses `execFile`, not `exec`.

2. **Bundled GDScript operations** funnel through `executeOperation(operation, params, projectPath)`, which runs:

   ```
   godot --headless --path <project> --script src/scripts/godot_operations.gd <operation> <JSON-encoded params>
   ```

   The single GDScript file [src/scripts/godot_operations.gd](src/scripts/godot_operations.gd) parses `operation` and dispatches via a `match` statement to the in-Godot implementation. Adding a new complex operation means adding a TypeScript handler that calls `executeOperation('your_op', params, ...)`, **and** a new branch in the GDScript's `match operation:` block. Do not introduce one-off temporary `.gd` scripts — extend `godot_operations.gd`.

The build step (`scripts/build.js`) exists specifically to copy `godot_operations.gd` into `build/scripts/`. `npm run watch` does not run this copy step, so watch-mode rebuilds may execute a stale GDScript bundle.

### Godot path resolution

`detectGodotPath()` resolves in this order: explicit config arg → `GODOT_PATH` env var → OS-specific platform defaults. Results are cached. Validation is two-tier: a sync existence check during construction, and a real `--version` invocation deferred until first use. `strictPathValidation` toggles whether construction fails fast or defers errors.

### Parameter naming

The server accepts both snake_case and camelCase keys for tool args. When adding tool params, register them in both directions of the mapping so external callers can use either style.

### Process lifecycle for `godot_run_project`

A single running project is tracked via an `activeProcess` handle (process + output/error buffer arrays). `godot_run_project` spawns and stores; `godot_get_debug_output` reads the buffers; `godot_stop_project` kills the handle. No support for multiple concurrent runs.
