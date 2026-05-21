# Module layout notes for #3

Three layouts were considered for splitting `src/index.ts` into the structure
required by [DESIGN.md § Architecture → Module organization](../DESIGN.md#module-organization)
and the auto-discovery registry mandated by
[orchestration-plan.md § 7](../orchestration-plan.md#7-hotspot-mitigation-auto-discovery-registry).

## Alternative A — keep `GodotServer` class, extract handlers as methods

Move every handler into a per-area mixin/companion class while keeping the
big `GodotServer` god-class as the entry point.

- **Pro:** smallest mechanical churn; `this.executeOperation` etc. keep working.
- **Con:** the class stays a god-object; per-tool PRs from Wave 4 would still
  collide on it; the per-area files would have to import the whole server type
  to type their `this` parameter, defeating the point of the split.

Rejected.

## Alternative B — free-function handlers + `ToolContext` + per-area registries (chosen)

- `src/shared/*` holds the previously-private helpers as free functions taking a
  small `ToolContext` value (godot-path resolver, logger, `executeOperation`,
  `activeProcessRegistry`).
- Each `src/tools/<area>-tools.ts` exports an array of `ToolDefinition` objects
  (`{ name, description, inputSchema, handler }`) plus a `registerXxxTool(def)`
  function that appends to the array. The array shape is what Wave 4 per-tool
  PRs target — they create a new file under e.g. `src/tools/docs/<name>.ts`
  and call `registerDocsTool({...})`, touching nothing else.
- `src/dispatch.ts` composes all area arrays into one and wires the MCP
  `ListTools` / `CallTool` handlers against the composed table.
- `src/index.ts` is reduced to: build context, create server, call dispatch,
  run transport.

### Why this fits

1. Maps 1:1 onto the DESIGN.md target tree.
2. Implements the auto-discovery registry from orchestration §7 today,
   so Wave 4 per-tool PRs (the 14 leaf docs/LSP tool PRs) have zero
   conflict surface on `dispatch.ts`.
3. `executeOperation` is a free function in `src/shared/execute-operation.ts`
   that takes the godot-path resolver and the operations-script path from the
   context — the two-path execution model (CLI exec vs. bundled GDScript via
   `godot_operations.gd`) survives unchanged. The `scripts/build.js` step still
   copies `src/scripts/godot_operations.gd` into `build/scripts/`; the only
   thing that moves is the consumer indirection.

### Trade-off accepted

Context-threading is verbose (every handler signature gets a `ctx` arg).
The alternative — globals — would make tests harder; the verbosity is the
price of keeping each handler independently testable.

## Alternative C — class per area extending an abstract `ToolModule`

`EditorTools`, `SceneTools`, `ProjectTools` each extend an abstract base that
holds the registry. Pleasant OO grouping, but DESIGN.md doesn't require it,
per-tool PRs would have to mutate the module class instead of registering a
definition (defeats §7), and there's no clear reason to spend the indirection
budget here. Rejected.

## Files created by this refactor

```
src/
├── index.ts                            # entry: build ctx, create server, dispatch, run
├── dispatch.ts                         # ListTools + CallTool wiring against composed registry
├── tools/
│   ├── index.ts                        # composes editor/scene/project arrays
│   ├── editor-tools.ts                 # launch_editor, run_project, stop_project,
│   │                                   # get_debug_output, get_godot_version
│   ├── scene-tools.ts                  # create_scene, add_node, load_sprite,
│   │                                   # export_mesh_library, save_scene
│   └── project-tools.ts                # list_projects, get_project_info,
│                                       # get_uid, update_project_uids
├── shared/
│   ├── types.ts                        # ToolDefinition, ToolContext, OperationParams,
│   │                                   # GodotServerConfig, GodotProcess
│   ├── godot-path.ts                   # detect/validate/set godot binary path
│   ├── params.ts                       # snake_case ↔ camelCase normalization
│   ├── validation.ts                   # validatePath, validateClassName
│   ├── errors.ts                       # createErrorResponse
│   ├── logging.ts                      # logDebug
│   ├── execute-operation.ts            # the bundled-GDScript execution path
│   ├── process-registry.ts             # ActiveProcessRegistry for run_project lifecycle
│   ├── project-helpers.ts              # findGodotProjects, getProjectStructureAsync,
│   │                                   # isGodot44OrLater
│   └── server.ts                       # GodotServer class (lifecycle: setup, run, cleanup)
├── docs/                               # placeholder for the docs subsystem (#6, #7-infra)
└── lsp/                                # placeholder for the LSP subsystem (#8, #9-infra)
```

`src/docs/` and `src/lsp/` each contain a `.gitkeep`; the index/dispatch don't
import from them yet. They exist so Wave 3+ branches can `cd` into a real
directory.

## What this PR explicitly does not do

- Tool names stay as-is (no `godot_` prefix). That's #4.
- No new tools; no behavior change.
- No new tests for tools beyond verifying the registry shape and dispatch
  routing — the smoke test from Wave 0 stays as-is.
- No introduction of `descriptions.ts` (#40).
- `src/docs/` and `src/lsp/` placeholders only — no module code lands here.
