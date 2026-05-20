# godot-mcp: Design Document

## Overview

This document describes the architecture and design of the `godot-mcp` MCP server, a fork of [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp). The fork extends the existing editor/scene control tools with two new capability areas:

1. **Documentation retrieval** — search and lookup over Godot's class reference and tutorials.
2. **Language Server Protocol integration** — code intelligence via Godot's built-in GDScript LSP.

The three capability areas (editor control, docs, LSP) are designed to coexist in a single MCP server installation but operate independently. They share configuration conventions and infrastructure where useful but otherwise have isolated lifecycles, failure modes, and operational characteristics.

This document is intentionally organized so each capability area can be implemented and shipped as a separate PR sequence. The order of work is: rename existing tools → docs subsystem → LSP subsystem.

## Goals and non-goals

### Goals

- Give AI coding agents reliable, version-aware access to Godot's API documentation, eliminating the most common source of GDScript hallucination.
- Give agents LSP-grade code intelligence on user GDScript code (definitions, references, diagnostics, hover, rename suggestions).
- Single installation: one MCP server, one config, all Godot tooling in one place.
- Fast startup on the common path; honest, debuggable failures on the uncommon paths.
- Preserve Claude Code's checkpoint/rewind behavior for any agent file edits.

### Non-goals

- Multi-language LSP support (cclsp and lsp-mcp cover the generic case).
- Godot 3.x support (deferred; see Future Work).
- Modifying user code automatically from this MCP (writes are advisory).
- Replacing Godot's editor for visual scene/asset work (this is a CLI tool).

## Related work

Several projects in this space informed the design:

- **james2doyle/godot-docs-mcp** — Cloudflare Workers MCP serving Godot docs by parsing the docs site's client-side search index. Read-only, hosted.
- **tkmct/godot-doc-mcp** — Offline stdio MCP parsing the official Godot XML class docs.
- **Coding-Solo/godot-mcp** — The base fork. Provides editor launch, scene manipulation, project introspection. No docs, no LSP.
- **ktnyt/cclsp** — Universal LSP-to-MCP bridge with symbol-based resolution. Reference implementation for LSP wrapping.
- **tritlo/lsp-mcp** — Low-level LSP-to-MCP server with resource subscriptions for diagnostics.
- **MasuRii/opencode-godot-lsp** — Stdio-to-TCP bridge for Godot LSP in OpenCode. Reference for handling Godot's TCP-only LSP.

The docs subsystem most closely parallels `tkmct/godot-doc-mcp` in approach (offline XML parsing) but adds tutorial indexing, version management, and hybrid search. The LSP subsystem most closely parallels `cclsp` but is purpose-built for Godot's TCP transport and integrated with the rest of the MCP rather than running as a separate process.

LSP exposure to coding agents currently happens via two mechanisms: Claude Code Plugins (the official mechanism, supports 11 mainstream languages, no GDScript) and MCP wrappers around LSPs (the cclsp pattern). This MCP uses the MCP-wrapper pattern since GDScript is not in Claude Code's official plugin set.

## Tool surface

All tools use the flat `godot_` prefix. This is a one-time rename for existing tools and a naming convention for new tools.

### Existing tools (renamed)

These already exist in the upstream fork. The rename is a single PR before any new work.

| Old name              | New name                    |
| --------------------- | --------------------------- |
| `launch_editor`       | `godot_launch_editor`       |
| `run_project`         | `godot_run_project`         |
| `stop_project`        | `godot_stop_project`        |
| `get_debug_output`    | `godot_get_debug_output`    |
| `get_godot_version`   | `godot_get_version`         |
| `list_projects`       | `godot_list_projects`       |
| `get_project_info`    | `godot_get_project_info`    |
| `create_scene`        | `godot_create_scene`        |
| `add_node`            | `godot_add_node`            |
| `load_sprite`         | `godot_load_sprite`         |
| `export_mesh_library` | `godot_export_mesh_library` |
| `save_scene`          | `godot_save_scene`          |
| `get_uid`             | `godot_get_uid`             |
| `update_project_uids` | `godot_update_project_uids` |

The `get_godot_version` → `godot_get_version` change drops a redundant "godot" in the action verb.

### Documentation tools (6)

1. **`godot_search_api`** — Search the Godot Engine API reference. Supports optional `inherits_from` and `category` filters. Empty query with no filters is an error.
2. **`godot_get_class`** — Look up a specific Godot class by name. Returns full structured record with optional `include` parameter for subset selection (methods, properties, signals, constants, description, inheritance).
3. **`godot_get_member`** — Look up a specific method, property, signal, or constant on a class. Returns array of matches when `kind` is unspecified (cross-kind name collisions return all hits).
4. **`godot_search_tutorials`** — Search Godot's tutorials and guides (prose docs). Hybrid lexical + dense retrieval.
5. **`godot_get_tutorial`** — Fetch a specific tutorial by path returned from `godot_search_tutorials`.
6. **`godot_docs_info`** — Get information about the documentation currently loaded (version, source, indexed_at, class count, tutorial count, ingestion warnings).

### LSP tools (10)

Read-only operations:

7. **`godot_find_definition`** — Find definition of a symbol at a position.
8. **`godot_find_references`** — Find all references to a symbol at a position.
9. **`godot_hover`** — Get hover information (signature, docs) for a symbol at a position.
10. **`godot_document_symbols`** — List all symbols in a file. Caps at 500 symbols with `truncated` flag for larger files.
11. **`godot_workspace_symbols`** — Search symbols across the workspace by query string.
12. **`godot_get_diagnostics`** — Get diagnostics for a specific file. Awaits pending diagnostics push if a `didChange` was just sent.
13. **`godot_signature_help`** — Get signature help for a function call at a position. Returns empty (not error) when out of context.

Advisory write operations — return proposed edits without applying them, so the agent can apply via its native edit tools and preserve Claude Code's checkpoint/rewind:

14. **`godot_preview_rename`** — Compute a rename across the project. Returns edits as `{file, line, before, after}` triples ready for `str_replace`.
15. **`godot_code_actions`** — List available code actions at a range.
16. **`godot_preview_code_action`** — Compute the edits for a specific code action. Same response shape as `godot_preview_rename`.

### Tool descriptions

Tool descriptions are written for the agent, not for human documentation. Two cross-cutting principles:

- Each description's first sentence is the primary routing signal — written to disambiguate from peers.
- Search-style tools include a "prefer this over guessing from prior knowledge" line, leveraging the agent's tendency to consult docs when prompted.

Disambiguation pairs to maintain in the descriptions:

- `godot_search_api` vs `godot_search_tutorials` — "API signatures" vs "how-to questions."
- `godot_search_api` vs `godot_get_class` — "find by query" vs "look up by name."
- `godot_get_class` vs `godot_get_member` — "explore a class" vs "exact details on one member."

## Configuration

All configuration via environment variables. No config file.

### Documentation subsystem

| Variable                               | Default                   | Purpose                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GODOT_DOCS_VERSION`                   | `stable`                  | Which Godot version's docs to serve. Accepts `stable`, `latest`, or `X.Y` (e.g., `4.5`). Patch versions and pre-releases rejected. Godot 3.x not supported in v1 — versions `<4.0` rejected (see Future Work). |
| `GODOT_DOCS_FAILURE_THRESHOLD_PERCENT` | `5` at runtime, `0` in CI | Maximum percentage of files allowed to fail parsing before ingestion fails.                                                                                                                                    |

### LSP subsystem

| Variable                 | Default     | Purpose                                                                  |
| ------------------------ | ----------- | ------------------------------------------------------------------------ |
| `GODOT_LSP_HOST`         | `127.0.0.1` | Host for LSP connection.                                                 |
| `GODOT_LSP_PORT`         | `6005`      | Starting port for headless Godot LSP. Scans upward if in use.            |
| `GODOT_LSP_PROJECT_PATH` | auto-detect | Project root. Auto-detect walks up from cwd looking for `project.godot`. |
| `GODOT_LSP_EAGER_INIT`   | `false`     | Spawn headless Godot at MCP startup instead of on first LSP call.        |

### Shared

| Variable              | Default             | Purpose                                                                                          |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `GODOT_PATH`          | inherited from fork | Path to Godot binary. Used for both editor launch (existing tools) and headless LSP spawn (new). |
| `GODOT_MCP_LOG_LEVEL` | `info`              | Stderr log verbosity. Levels: `silent`, `error`, `warn`, `info`, `debug`.                        |
| `OTEL_SDK_DISABLED`   | unset               | Standard OTel env var. Set to `true` to disable telemetry instrumentation entirely.              |

## Architecture

### Module organization

The existing single-file `src/index.ts` is refactored into modules as the first PR. New work lands in this structure:

```
src/
├── index.ts                # server setup, top-level entry
├── dispatch.ts             # tool name → handler routing
├── tools/
│   ├── editor-tools.ts     # existing: launch, run, debug
│   ├── scene-tools.ts      # existing: create_scene, add_node, etc.
│   ├── project-tools.ts    # existing: list, get_info, uid
│   ├── docs-tools.ts       # new
│   └── lsp-tools.ts        # new
├── docs/
│   ├── ingest.ts           # fetch + parse (shared by build script and runtime)
│   ├── version-manager.ts  # env var → DB path resolution
│   ├── schema.ts           # SQLite schema, Drizzle definitions
│   └── search.ts           # FTS5 + hybrid search implementation
├── lsp/
│   ├── client.ts           # vscode-jsonrpc-based LSP client
│   ├── process.ts          # headless Godot spawn/lifecycle
│   ├── documents.ts        # didOpen tracking, auto-resync
│   └── adapter.ts          # Godot-specific LSP quirk workarounds
└── shared/
    ├── env.ts              # env var parsing and validation
    ├── logging.ts          # stderr logger
    └── telemetry.ts        # OTel setup
```

Each subsystem registers its tools through `dispatch.ts`. Tools are flat — no nested categories.

### Shared infrastructure

- **Latch pattern.** Both docs and LSP use the same one-shot promise primitive to gate tool calls during initialization. See subsystem sections for usage.
- **Env var parsing.** Centralized validation, fails fast on bad values.
- **Logging.** Stderr-only, level-gated. Format: `[godot-mcp][subsystem] message`.
- **Telemetry.** OpenTelemetry traces written to local files (`$XDG_DATA_HOME/godot-mcp/traces/`). Rotation cap at 100MB or 7 days, whichever comes first. Disabled via standard OTel env vars.

### Cross-subsystem independence

The three subsystems (editor tools, docs, LSP) have **separate latches** and **independent failure modes**:

- Docs fails on init → server crashes (docs is core value).
- LSP fails on init → server stays up, LSP tools return errors, other tools work.
- Editor tools don't have init failures (no startup work).

This means a misconfigured LSP doesn't prevent the agent from using docs, and a docs network failure doesn't break editor tools.

## Documentation subsystem

### Version resolution

Resolution happens at startup, synchronously:

1. Read `GODOT_DOCS_VERSION`. Unset or `stable` → use bundled DB. Skip steps 2-5.
2. Validate format. Bad format → exit 2 with clear message.
3. Compute cache file name: `docs-{version}-v{schema}.db` under OS cache dir.
4. If `version` is `latest`:
   - Check `latest-resolution.json` cache with 1-hour TTL.
   - On cache miss, fetch GitHub Tags API for `godotengine/godot`, filter to `*-stable` semver tags, pick highest. Cache result.
   - Rate limit: unauthenticated API is 60/hr; the TTL prevents thrashing.
5. Cache hit + integrity check passes → use cached DB.
6. Cache miss → kick off async fetch + parse (see below); latch starts unresolved.

`stable` (the default) never makes network calls. `latest` always resolves dynamically (subject to 1-hour cache).

### Ingestion pipeline

The shared `fetchAndParseVersion(version, outputPath)` function is used by both the build script (CI, with `GODOT_DOCS_FAILURE_THRESHOLD_PERCENT=0`) and the runtime fetcher (with the default threshold). Callers differ in:

|             | Build script (CI)             | Runtime fetcher |
| ----------- | ----------------------------- | --------------- |
| Threshold   | 0                             | 5               |
| Output path | `data/docs-stable.db` in repo | OS cache dir    |
| Logging     | Verbose                       | Concise         |
| Await       | Synchronous                   | Async via latch |

Pipeline stages:

1. **Resolve git tag.** `4.5` → `4.5-stable`. `latest` already resolved upstream.
2. **Fetch godot tarball.** `https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/{tag}`. Sparse extract: only `doc/classes/`. Retries: 5 attempts, exponential backoff (1s/2s/4s/8s/16s, ±25% jitter, 30s cap, 60s overall ceiling). 4xx failures do not retry (likely user error like a typo); 5xx and network errors do.
3. **Validate structurally.** `doc/classes/` exists; XML file count ≥ 500; `Object.xml` parses to a recognizable class structure. Structural failure → treat as fetch failure for retry purposes.
4. **Fetch godot-docs tarball.** Same retry/validation pattern for `https://codeload.github.com/godotengine/godot-docs/tar.gz/refs/heads/{docs_branch}`. Branch mapping: `4.5-stable` → `4.5`. If version-specific branch 404s, fall back to `stable` branch.
5. **Parse class XML.** Each file produces a class record + member records. Failures tracked.
6. **Parse tutorial RST.** Chunk by H2 heading; soft cap 1500 tokens, hard cap 3000; H3-split on overflow; cross-references stored as metadata, not inline-expanded; code blocks remain with surrounding prose. Failures tracked.
7. **Embed tutorial chunks.** Use bundled model (sentence-transformers MiniLM-L6, ~80MB, ~384-dim output). Batched to avoid memory spikes.
8. **Write to SQLite.** Atomic — build to `.tmp`, rename at end. Schema includes WAL mode for read concurrency.
9. **Report.** Return `{classes: {parsed, failed, warnings}, tutorials: {parsed, failed, warnings}, retries, durationMs}` to caller. Caller decides pass/fail based on threshold.

#### Failure semantics

- **Network retry budget per endpoint:** 5 attempts.
- **Structural validation failure:** retried as a fetch failure (truncated tarballs are the common cause).
- **Per-file parse failures:** counted, compared against `GODOT_DOCS_FAILURE_THRESHOLD_PERCENT` across all files. CI sets to 0 (strict), runtime defaults to 5 (lenient).
- **Top-level structural failures** (missing `doc/classes/` directory, malformed tarball): fail hard, don't count toward threshold.
- **Total failure → `process.exit(1)`** with a clear stderr message. Different exit codes for user error (bad version: exit 2) vs runtime failure (network: exit 1).

#### Concurrency

A lock file in the cache dir (`docs-{version}.lock`) mediates concurrent ingestion across MCP instances. Lock contains PID + creation timestamp. Other processes:

- Find lock → check if PID alive AND mtime within 5 minutes → if yes, wait up to 60s for lock release, else reclaim.
- After acquiring lock, re-check cache (another process may have completed) before fetching.

### Storage

#### Schema overview

Defer detailed table design to implementation. Decisions already made:

- **Single `members` table with `kind` column** (method, property, signal, constant, annotation), not separate tables per kind. Unified queries are easier; null-column cost is small.
- **Normalized inheritance** — `classes.inherits` stores immediate parent only. Walk via recursive CTE at query time. Denormalize only if benchmarks prove necessary.
- **`sqlite-vec` extension for tutorial embeddings.** Cleaner queries than flat BLOB.
- **Single-row `meta` table** with `godot_version`, `godot_docs_branch`, `schema_version`, `indexed_at` (ISO 8601 UTC), `class_count`, `tutorial_count`, `ingest_warnings` (JSON).
- **WAL mode enabled.** Improves concurrent read performance for the read-only post-ingestion case.
- **Cross-kind member name uniqueness not enforced.** Even if a class can't have a method and property with the same name in practice, the schema permits it.

#### ORM choice

Use Drizzle ORM with prepared statements once Drizzle 1.0 ships (currently on RC3). Fallback plan: if Drizzle 1.0 slips past a reasonable date, use `better-sqlite3` directly with hand-written prepared statements. ORM is for ergonomics on the normal tables; FTS5 queries and `sqlite-vec` calls go through raw SQL with bound parameters in either case (Drizzle doesn't model these as first-class).

### Search

#### Class reference

Pure FTS5 over `classes` (name, brief) and `members` (name, signature, description). BM25 weighting weights name fields ~3x description.

Empty query with structured filters returns the filtered set ordered by name. Empty query with no filters returns an error: "Provide at least a query, `inherits_from` filter, or `category` filter."

#### Tutorials

Hybrid retrieval:

- **Lexical layer:** FTS5 over tutorial chunks (title, heading_path, content). Title and heading_path weighted higher than content.
- **Dense layer:** embedding similarity via `sqlite-vec`.
- **Fusion:** Reciprocal Rank Fusion (RRF) with k=60.

Embedding model loads lazily on first tutorial search (~1s cold-start cost). Subsequent queries fast.

### Concurrency model

Pure latch. A single one-shot promise gates docs tool calls during initialization:

- **Bundled DB:** latch resolved synchronously at startup. No async path.
- **Cache hit:** latch resolved synchronously after integrity check (`SELECT COUNT(*) FROM classes LIMIT 1`). No async path.
- **Cache miss:** latch starts unresolved. Background fetch + parse runs. On success, latch resolves with the open connection. On failure, latch rejects and `process.exit(1)`.

Tool handlers `await` the latch before querying. After first resolution, `await` is a no-op.

No "indexing in progress" response shape. No status field in `godot_docs_info`. Tool calls block on the latch until ready or until the server dies. This is acceptable because indexing is fast (typically <30s) and well below MCP client timeout limits.

### Error handling

Standard MCP error responses for normal failures:

- Class not found, member not found, tutorial not found → MCP error with `suggestions` array containing similar names (cheap FTS5 lookup).
- Invalid arguments (empty class name, negative limit) → MCP error "invalid argument."
- Class name case mismatch (`node` instead of `Node`) → case-insensitive lookup with a "did you mean `Node`?" suggestion.

Server-level errors (DB connection lost, file corruption detected at runtime): MCP internal error.

## LSP subsystem

### Implementation approach

Write the LSP client using `vscode-jsonrpc` (Microsoft's JSON-RPC library, supports any duplex transport including TCP) for the protocol layer. Implement LSP semantics (document state, diagnostics cache, capability handshake) ourselves. Do not depend on `cclsp` or `lsp-mcp` as packages — they are MCP servers, not libraries.

Before implementation, study `ktnyt/cclsp` and `tritlo/lsp-mcp` source code thoroughly. Especially worth understanding:

- cclsp's `LSPClient` in `src/lsp-client.ts` (process management, request correlation, capability handshake)
- cclsp's adapter pattern for Vue/Pyright (the shape of per-server workarounds)
- lsp-mcp's `publishDiagnostics` buffering and resource subscriptions

Borrow concepts (symbol-based resolution, per-server adapter pattern), not code.

### Process management

#### Spawn lifecycle

- **When to spawn:** Lazy by default, on first LSP tool call. Eager via `GODOT_LSP_EAGER_INIT=true`.
- **Spawn command:** `godot --editor --headless --lsp-port {port} --path {project_path}`. Binary location from `GODOT_PATH`.
- **Port selection:** Scan upward from `GODOT_LSP_PORT` for the first available port. Avoids conflict with the user's existing editor if one is running.
- **Why isolated processes:** Each MCP session has its own headless Godot. Coexistence with the user's editor (and any IDE clients attached to it) is a first-class supported scenario. Godot's LSP is historically single-client per process, so attaching to the user's existing instance could kick off their IDE.
- **stdout/stderr:** Pipe to MCP's stderr with a `[godot]` prefix.
- **Shutdown:** Exit/signal handlers (SIGINT, SIGTERM, normal exit) kill the child Godot. Crashes (SIGKILL, OOM) leak one process per crash — documented in troubleshooting as a manual cleanup item.

#### Death detection and recovery

- `child_process.spawn`, listen for `'exit'` event.
- On death: mark LSP unavailable, next tool call triggers respawn.
- **Tiered recovery on connection drop:**
  1. Check if process is alive (PID check + exit event).
  2. If alive: 3 TCP reconnect attempts with 1s/2s/4s backoff.
  3. If dead, hung (handshake times out), or all reconnects fail: kill remaining process, respawn, fresh handshake. Counts as one spawn cycle.
  4. Cap spawn cycles per session at 3. After that, mark LSP permanently unavailable for the session.
- **Document state is lost on respawn.** Pending requests reject with connection error. Tracked-open documents need `didOpen` redone on next reference. Handled automatically by the lazy didOpen pattern.

#### Spawn failures

Distinct error categories with specific remediation in the message:

- Binary not found → "Set `GODOT_PATH` to your Godot binary."
- Project path invalid → "No `project.godot` found at `{path}`."
- Port unavailable after upward scan → "Could not bind any port in range; check for runaway Godot processes."

### Connection lifecycle

- **Connect:** Lazy on first LSP tool call (or eager via `GODOT_LSP_EAGER_INIT`).
- **Handshake:** Standard LSP `initialize` / `initialized`. Capabilities advertised:
  - `textDocumentSync.openClose: true`
  - `textDocumentSync.change: 1` (full sync, not incremental)
  - No workspace edits, no will-save, no semantic tokens.
- **Liveness:** TCP-level only. No application-level keepalive.
- **Reconnection:** See tiered recovery above.
- **Pending requests on drop:** Reject all in-flight with connection error.
- **Idle disconnection:** Never.

### Project association

- **Auto-detect:** Walk up from MCP server's cwd looking for `project.godot`. Stop at filesystem root. Cache result for the session.
- **No project found:** Error at first LSP call with explicit message: "no `project.godot` found in cwd or ancestors; set `GODOT_LSP_PROJECT_PATH` explicitly."
- **Path validation:** Exists, is directory, contains `project.godot`, is readable. Fail fast on first LSP call.
- **Re-init mid-session:** Not supported. Project path locked at first LSP call. Restart MCP to change.
- **Cross-project queries:** LSP tools validate that requested file paths are within the project root. Files outside project root → error.

### Document tracking

- **didOpen timing:** Lazy. When a tool call references a file, didOpen if not already tracked.
- **Tracked-open set:** A Set of file URIs per LSP connection. Avoids duplicate didOpens from concurrent calls.
- **didClose:** Never explicitly. Godot's LSP handles many open documents fine.
- **File filtering:** Only `.gd` and `.gdshader` files. Other file types not synced.
- **Size cap:** None in v1. If real-world usage exposes memory issues, add `GODOT_LSP_MAX_FILE_KB`.
- **Non-existent files:** Tool returns error, don't didOpen a phantom path.
- **Auto-resync before queries:** Before any LSP query, re-read tracked files from disk; if content differs from last-sent, send `didChange`. Catches external edits (including via Claude Code's native edit tools) without requiring explicit sync.

### Diagnostics

- **Push-driven cache.** Godot's LSP pushes `publishDiagnostics`; we cache per file URI; cache replaces on each new push.
- **`godot_get_diagnostics(file)` semantics:**
  1. Auto-resync triggers `didChange` if disk content differs.
  2. If `didChange` was sent, await the next `publishDiagnostics` for that URI with a 2s timeout.
  3. Return cached diagnostics.
- **Scope:** Per-file. Required `file` parameter. No workspace-wide diagnostics tool in v1.
- **Unopened files:** No diagnostics returned. Agent must reference via a tool that triggers didOpen.
- **Response format:** Array of `{severity, line, character, end_line, end_character, message, source, code}`. Standard flattened LSP shape.
- **Buffer:** Indefinitely until server shutdown. Memory cost trivial.
- **No TTL.** Cache freshness is maintained by `didChange`-triggered push cycles; TTL would add no correctness and would waste work.

### Write operations: advisory pattern

All write-related tools (`godot_preview_rename`, `godot_code_actions`, `godot_preview_code_action`) return proposed edits without applying them. The agent applies edits via its native edit tools (Claude Code's `Edit`, `Write`, etc.), preserving the checkpoint/rewind flow.

Response shape for edit-returning tools:

```json
{
  "rename": { "from": "old_name", "to": "new_name" },
  "edits": [
    {
      "file": "scripts/player.gd",
      "changes": [
        {
          "line": 23,
          "before": "func old_name(x):",
          "after": "func new_name(x):"
        },
        {
          "line": 47,
          "before": "    self.old_name(1)",
          "after": "    self.new_name(1)"
        }
      ]
    }
  ],
  "summary": { "files": 3, "locations": 7 }
}
```

The MCP does the LSP query, position-to-text resolution, and file reads. The agent receives clean before/after pairs ready for `str_replace`. If the file content shifts between MCP compute and agent apply, `str_replace` fails cleanly and the agent can re-run the preview against fresh state.

### Tool-specific behavior

- **Position handling:** Agents see 1-based line and character (matches editor convention). Internally converted to 0-based for LSP. Documented in tool descriptions.
- **Range semantics:** LSP half-open ranges `[start, end)` preserved through to tool responses. Documented.
- **Multiple definitions:** Return array, agent disambiguates.
- **Zero results:** Empty array, not error.
- **Hover format:** Pass through LSP's `MarkupContent` (markdown). Truncate at 5000 chars to bound payload.
- **`workspace_symbols` query:** Substring, case-insensitive. Passed through to LSP server.
- **`document_symbols` large file:** Cap response at 500 symbols with `truncated: true` flag.
- **`signature_help` out of context:** Empty result, not error.

### Concurrency

- **Single TCP connection** to Godot's LSP per MCP session.
- **Request serialization:** Single-flight queue. Requests sent one at a time, matched to responses by JSON-RPC `id`.
- **Per-request timeout:** 10 seconds default.
- **Latch primitive** gates LSP tool calls during init (same one-shot promise pattern as docs).

### Error mapping

JSON-RPC standard errors → MCP errors:

| Code                                      | Meaning        | MCP response                                           |
| ----------------------------------------- | -------------- | ------------------------------------------------------ |
| `-32700`                                  | ParseError     | MCP internal error (our bug)                           |
| `-32600`                                  | InvalidRequest | MCP internal error (our bug)                           |
| `-32601`                                  | MethodNotFound | MCP error: "operation not supported by Godot's LSP"    |
| `-32602`                                  | InvalidParams  | MCP internal error (our bug)                           |
| `-32603`                                  | InternalError  | Pass through with server's message                     |
| `-32099..-32000`                          | ServerError    | Pass through with server's message                     |
| LSP `RequestCancelled`, `ContentModified` | Lifecycle      | Pass through with context                              |
| `ECONNREFUSED`, `EPIPE`                   | Connection     | MCP error: "Godot LSP unavailable" with reconnect hint |

### Initialization failure semantics

Departure from the docs subsystem: **LSP init failure does not crash the server.** Reasoning:

- Docs is the core MCP value; without docs, the server is largely pointless. Crash is honest.
- LSP is opt-in. Misconfigured LSP (bad project path, missing Godot binary) shouldn't prevent docs and editor tools from working.

On init failure:

- Log prominently to stderr (visible at startup if `GODOT_LSP_EAGER_INIT=true`).
- Mark LSP as unavailable for the session.
- LSP tool calls return clean "LSP unavailable: {reason}" errors.
- Other tools continue working.
- No retry on failed init. User restarts MCP after fixing config.

## Distribution and release

### Bundled docs DB

The npm package ships with `data/docs-stable.db` for the current Godot stable version at publish time. Built in CI via `npm run build:docs` (which calls the same `fetchAndParseVersion` function used at runtime). The `data/` directory is gitignored; the DB is regenerated in CI before publish via a `prepublishOnly` script.

Consequences:

- Anyone running `npm install` gets immediate docs functionality.
- The bundled `stable` lags Godot's actual current stable by however long it takes to cut a new package release.
- Users who need to track Godot's current stable use `GODOT_DOCS_VERSION=latest`.

### Embedding model

Bundled in the package (~80MB). Total npm package size approximately 150MB. Above typical but under any hard limits. README will note install size.

### Native dependencies

- `better-sqlite3` — SQLite client (native).
- `sqlite-vec` — vector extension.
- `@xenova/transformers` — ONNX runtime for embedding inference (native).

All three have prebuilds for x64/arm64 Linux/macOS/Windows. Tested install matrix in CI.

### Node version

Pin minimum Node version to 24 in `package.json` `engines`. Older Node versions are out of date; Node 24 is the current active LTS line at time of writing.

### Auto-republish on Godot release (future)

A CI pipeline could auto-rebuild and republish the package when Godot publishes a new release. Concerns to address before implementing:

- **Supply chain risk.** Compromised Godot tag → compromised package. Needs pinned action versions, scoped permissions, manual approval step.
- **Reproducibility.** Build must be deterministic.
- **Version skew.** Auto-bumps could surprise users with pinned workflows.
- **Rollback.** Need a clear path to a previous version if a Godot release breaks parsing.

Deferred to post-v1.

## Logging and telemetry

Two separate concerns:

### Stderr logging (`GODOT_MCP_LOG_LEVEL`)

Operational, human-readable. Levels: `silent | error | warn | info | debug`. Default `info`.

Examples:

- `info`: "Building docs index for Godot 4.5. This is a one-time setup..."
- `warn`: "LSP connection dropped, attempting reconnect (2/3)"
- `error`: "FATAL: Could not load docs for GODOT_DOCS_VERSION=4.55"
- `debug`: Per-request LSP messages, per-file ingestion progress.

### OTel telemetry (`OTEL_SDK_DISABLED`)

Structured traces stored locally at `$XDG_DATA_HOME/godot-mcp/traces/` (and OS-equivalent on macOS/Windows). Spans for:

- Docs ingestion per stage (fetch, parse classes, parse tutorials, embed, write).
- LSP spawn duration.
- LSP query latency per operation.
- Cache hit/miss rates.

Rotation: cap at 100MB or 7 days, whichever first.

No phone-home. No data transmitted externally.

## Testing and benchmarks

Three benchmark plans, in order of effort and value.

### 1. Tool-routing accuracy

**Goal:** Validate that agents pick the right tool when given a natural-language query.

**Method:** Pass tool schemas to the Anthropic API with `tool_choice: "any"`. Run a curated set of ~50-100 queries covering docs, LSP, and editor tools. Measure per-tool precision and recall. Run separately for Claude Opus and Claude Sonnet.

**When to do this:** Optional during implementation. Cheap to set up. Useful diagnostic if agents seem to pick wrong tools in practice.

**Acceptance criteria:** None hardcoded. Used as a diagnostic, not a gate.

### 2. End-to-end GDScript correctness

**Goal:** Measure whether the MCP actually improves agent output quality.

**Method:** Curated set of GDScript tasks (write a function, modify a class, find a bug). Hold the agent constant. Run each task with and without the MCP available. Score the produced code against ground truth for correctness and version-appropriateness.

**When to do this:** The headline metric. The thing that tells you whether the project succeeded.

**Acceptance criteria:** Soft. Compare MCP-enabled vs. MCP-disabled correctness. The MCP should produce measurable improvement.

### 3. Chunking quality + correctness

**Goal:** Validate that the tutorial chunking strategy produces retrievable, useful chunks, AND that agents can answer questions correctly given retrieved chunks.

**Method:** Curate ~50 tutorial queries with known correct answer locations.

**Part A (retrieval):** For each query, run `godot_search_tutorials`. Check whether the correct chunk appears in top 5 results.

**Part B (correctness):** For each query, retrieve top 5 chunks, feed to a model with the query, score the answer against ground truth.

**Part C (config A/B testing):** Run benchmark #2 across two or more chunking configurations. Compare downstream correctness. Used for picking between viable strategies, not a pass/fail gate.

**Acceptance criteria (Part A + B):**

- Recall@5 ≥ 80% (correct chunk in top 5 for at least 40/50 queries).
- Recall@1 ≥ 50% (correct chunk is top result for at least 25/50 queries).
- Answer correctness ≥ 70% on Part B.
- No chunks exceeding hard cap (3000 tokens).
- ≤ 5% of chunks below 100 tokens (sign of over-splitting).
- Manual inspection of 20 random chunks: all coherent standalone reads.

**Tuning levers** if benchmarks miss criteria: adjust soft/hard cap, change boundary level (H2 vs H3), revisit cross-reference handling, add overlap between adjacent chunks.

## Implementation phases

Suggested PR sequence:

1. **Refactor `src/index.ts` into modules.** No new features. Establishes the module structure described above.
2. **Rename existing tools** with `godot_` prefix. Mechanical change.
3. **Shared infrastructure** (env parsing, logging, telemetry setup).
4. **Docs ingestion** (`docs/ingest.ts`, `version-manager.ts`, schema, build script). Verifiable via `npm run build:docs` producing a valid DB.
5. **Docs tools.** Six new tools registered, lookup against the DB.
6. **LSP client** (`lsp/client.ts`, `lsp/process.ts`) standalone. Verifiable with manual integration tests.
7. **LSP tools (read-only).** Seven tools.
8. **LSP tools (advisory write).** Three tools.

Optional/follow-up: 9. **Auto-republish CI pipeline** (with security hardening). 10. **Symbol-based resolution** (cclsp-style fallback) — v1.1 if not landed in v1. 11. **Per-server adapter pattern** for Godot-specific LSP quirks — initially empty, populated as quirks are discovered.

## Future work

- **Godot 3.x support.** Would require a separate parser path for the older XML schema. Assess demand before investing.
- **Pagination on `godot_search_api`.** Currently capped at limit param; cursor-based pagination if needed.
- **Auto-republish on Godot release.** See Distribution section.
- **Symbol-based resolution in LSP.** cclsp's `findSymbolsByName` approach as a fallback when agents provide imprecise positions.
- **Per-server adapter for Godot LSP quirks.** Empty in v1; populate as quirks are discovered.
- **`godot_get_workspace_diagnostics`.** Cross-file diagnostic queries. YAGNI for v1.
- **Multi-project / multi-root workspaces.** Single root only in v1.
- **Attach to user's existing Godot editor LSP** as an opt-in mode. Would need `GODOT_LSP_ATTACH_TO_PORT` env var; user accepts single-client implications.
- **`GODOT_LSP_MAX_FILE_KB`.** Add if real-world usage exposes memory issues.

## Research items for implementation

Items to investigate during v1 implementation rather than at design time:

- **Godot's behavior under concurrent project access.** Two MCP sessions, two headless Godots, same project. Does Godot use lock files? What's the failure mode? Default lean if no clear answer: report LSP unavailable for the second session with a clear message.
- **Godot LSP response for built-in symbol definitions.** Does `godot_find_definition` on `Node.add_child` return a synthetic URI? A real engine source path? Nothing? Characterize before deciding whether to special-case or pass through.
- **Godot LSP capability advertisement.** What capabilities does Godot's LSP actually advertise? Drives which tools are reliably supported.
- **Godot LSP single-client behavior.** Verify whether modern Godot 4.x still rejects multiple LSP clients per process, or whether the limit was relaxed.
- **Godot LSP file watcher behavior.** Does it push `publishDiagnostics` on external disk changes, or only after our `didChange`? Affects whether our auto-resync is strictly necessary.
- **Schema design.** Read the cclsp source (`src/lsp-client.ts`), study how Drizzle 1.0 handles SQLite extensions, decide on table layout based on actual query patterns observed during implementation.
- **FTS5 tokenizer choice and BM25 weights.** Decide after seeing real query patterns and benchmark results from benchmark #3.

## Edge cases and known limitations

Worth flagging in user-facing documentation:

- **Two MCP instances on the same project may fail to spawn the second Godot LSP** depending on Godot's behavior. Acceptable limitation; user runs one session at a time per project.
- **Mid-life server crashes are reported differently per MCP client.** Some show stderr; some just say "disconnected." Acceptable limitation.
- **MCP crash leaks headless Godot.** Exit handlers cover normal shutdown; SIGKILL/OOM leaks one process. User cleans up manually.
- **Memory footprint with all subsystems active is several hundred MB to ~1GB** (docs DB, embedding model, Godot headless). Documented for user awareness, not treated as a design constraint.
- **SQLite over networked filesystems (NFS, SMB) is unreliable.** If the cache directory is on networked storage, set `XDG_CACHE_HOME` to a local directory.
- **Cache disk full during ingestion** produces a clear error message rather than a corrupted DB (atomic rename pattern).
- **Schema-version cache pollution.** Old DBs from previous package versions accumulate. Run `npm run docs:clean` to prune.
- **Switching `GODOT_DOCS_VERSION` between values accumulates cache files.** Same cleanup tool.
- **`stable` (bundled DB version) and Godot's current stable may diverge.** Bundled DB is pinned to whatever shipped with the package. Use `GODOT_DOCS_VERSION=latest` to track Godot's actual current stable.

## Appendix: changes from upstream fork

This fork makes the following changes to `Coding-Solo/godot-mcp`:

1. Refactor single-file `src/index.ts` into a module structure.
2. Rename 14 existing tools to use the `godot_` prefix. One tool (`get_godot_version` → `godot_get_version`) drops a redundant naming element.
3. Add docs subsystem: 6 new tools, bundled DB, ingestion pipeline, version management.
4. Add LSP subsystem: 10 new tools, headless Godot process management, LSP client.
5. Adopt Drizzle ORM (pending 1.0) for the new SQLite-backed docs storage.
6. Add OpenTelemetry instrumentation with local-only trace storage.
7. Add `GODOT_MCP_LOG_LEVEL` for stderr verbosity control.

The fork does not currently plan to merge upstream. No deprecation path for the renames is required since the fork has no users.
