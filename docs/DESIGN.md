# godot-mcp: Design Document

## Overview

This document describes the architecture and design of the `godot-mcp` MCP server, a fork of [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp). The fork extends the existing editor/scene control tools with two new capability areas:

1. **Documentation retrieval** — search and lookup over Godot's class reference and tutorials.
2. **Language Server Protocol integration** — code intelligence via Godot's built-in GDScript LSP.

The three capability areas (editor control, docs, LSP) are designed to coexist in a single MCP server installation but operate independently. They share configuration conventions and infrastructure where useful but otherwise have isolated lifecycles, failure modes, and operational characteristics.

This document is intentionally organized so each capability area can be implemented and shipped as a separate PR sequence. The order of work is: rename existing tools → docs subsystem → LSP subsystem.

This document was revised in May 2026 following the Wave 2 multi-agent design review. Notable scope changes from the original: `godot_code_actions` and `godot_preview_code_action` deferred to v1.1 (Godot's LSP doesn't implement `codeActionProvider`); symbol-based fallback promoted from follow-up to v1; embedding model switched from MiniLM-L6 to BGE-small-en-v1.5 with download-on-first-use; Drizzle ORM dropped in favor of `better-sqlite3` direct. See the appendix at end of document for the full change list with rationale.

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

**v1 ships 28 tools total: 14 existing (renamed) + 6 docs + 7 LSP read + 1 LSP advisory-write.** (Down from a draft of 30; two code-action tools deferred — see below.)

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

1. **`godot_search_api`** — Search the Godot Engine API reference. Supports optional `inherits_from` and `category` filters. Empty query with no filters returns `{results: [], hint}` (not an error), so agents can recover without an error-handling branch.
2. **`godot_get_class`** — Look up a specific Godot class by name. Returns full structured record with optional `include` parameter for subset selection (methods, properties, signals, constants, description, inheritance).
3. **`godot_find_member`** — Look up a method, property, signal, or constant on a class. Returns array of matches when `kind` is unspecified (cross-kind name collisions return all hits). Originally proposed as `godot_get_member`; renamed in Wave 2 because the singular noun contradicted the array-return semantics and the `find_*` family naming makes routing easier for LSP-trained agents.
4. **`godot_search_tutorials`** — Search Godot's tutorials and guides (prose docs). Hybrid lexical + dense retrieval.
5. **`godot_get_tutorial`** — Fetch a specific tutorial by path returned from `godot_search_tutorials`.
6. **`godot_docs_info`** — Get information about the documentation currently loaded (version, source, indexed_at, class count, tutorial count, ingestion warnings, embedding model id, source SHAs).

### LSP tools (8 in v1; 10 planned for v1.1)

Read-only operations:

7. **`godot_find_definition`** — Find definition of a symbol by position OR by name. Accepts either `(line, character)` or `symbol_name`.
8. **`godot_find_references`** — Find all references to a symbol by position OR by name.
9. **`godot_hover`** — Get hover information (signature, docs) for a symbol by position OR by name.
10. **`godot_document_symbols`** — List all symbols in a file. Caps at 500 symbols with `truncated` flag for larger files.
11. **`godot_workspace_symbols`** — Search symbols across the workspace by query string (substring, case-insensitive — Godot's LSP does not implement fuzzy matching).
12. **`godot_get_diagnostics`** — Get diagnostics for a specific file. Awaits pending diagnostics push with tiered timeout (10s first-touch per URI, 2s steady-state); timeout returns `partial: true`, not an error.
13. **`godot_signature_help`** — Get signature help for a function call at a position. Returns empty (not error) when out of context. Documented as unreliable on `.new()` constructor calls and multi-line argument lists ([godot#51617](https://github.com/godotengine/godot/issues/51617)).

Advisory write operations — return proposed edits without applying them, so the agent can apply via its native edit tools and preserve Claude Code's checkpoint/rewind:

14. **`godot_preview_rename`** — Compute a rename across the project. Returns edits as `{file, line, before, after}` triples (with `before` widened to be unique within the file) ready for `str_replace`.

**Deferred to v1.1 (blocked upstream):**

- `godot_code_actions` and `godot_preview_code_action` — Godot's LSP does not advertise `codeActionProvider` ([godot-proposals#14307](https://github.com/godotengine/godot-proposals/issues/14307) is an open, unmerged feature request as of May 2026). Reopen the issues and ship these when upstream lands.

**Symbol-based fallback (v1):** The read-only and write LSP tools accept `symbol_name` as an alternative to `(line, character)`. This was promoted from a v1.1 follow-up because agents routinely give imprecise positions; cclsp's experience demonstrates it's table-stakes for usability. See [cclsp's `findSymbolsByName`](https://github.com/ktnyt/cclsp) for the reference pattern.

### Tool descriptions

Tool descriptions are written for the agent, not for human documentation. Two cross-cutting principles:

- Each description's first sentence is the primary routing signal — written to disambiguate from peers.
- Search-style tools include a "prefer this over guessing from prior knowledge" line, leveraging the agent's tendency to consult docs when prompted.

**Source-file pattern:** all 14 v1 tool descriptions live in a single file (`src/tools/descriptions.ts`) exported as a typed record. This keeps strings aligned and lets a unit test verify the disambiguation matrix below. See the dedicated tracking issue for the drafting work.

Disambiguation pairs to maintain in the descriptions (expanded in Wave 2):

- `godot_search_api` vs `godot_search_tutorials` — "API signatures / classes" vs "how-to questions / guides."
- `godot_search_api` vs `godot_get_class` — "find by query" vs "look up by name."
- `godot_get_class` vs `godot_find_member` — "explore a class" vs "exact details on one member."
- `godot_search_tutorials` vs `godot_get_tutorial` — "search to discover" vs "fetch a known path (returned by search)."
- `godot_get_class` vs `godot_docs_info` — "lookup a class" vs "report the loaded docs version/coverage."
- `godot_search_api` vs `godot_docs_info` — same axis as above.
- **`godot_find_definition` (user GDScript) vs `godot_get_class`/`godot_find_member` (engine API)** — "find a symbol the agent wrote" vs "look up a built-in Godot type." This pair is the most important agent-routing distinction since LSP-trained models default to `find_definition` for anything that looks like a symbol.

**Position-handling convention:** positions on the wire are 1-based (matches editor convention; line 1 = first line, column 1 = first column). Internally converted to 0-based for LSP. The 1-based note lives in the **parameter doc** for `line`/`character`, not in the description first sentence (the first sentence carries routing weight that shouldn't be diluted).

## Configuration

All configuration via environment variables. No config file.

### Documentation subsystem

| Variable                               | Default                   | Purpose                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GODOT_DOCS_VERSION`                   | `stable`                  | Which Godot version's docs to serve. Accepts `stable`, `latest`, or `X.Y` (e.g., `4.5`). Patch versions and pre-releases rejected. Godot 3.x not supported in v1 — versions `<4.0` rejected (see Future Work). |
| `GODOT_DOCS_FAILURE_THRESHOLD_PERCENT` | `5` at runtime, `0` in CI | Maximum percentage of files allowed to fail parsing before ingestion fails.                                                                                                                                    |
| `GODOT_DOCS_EAGER_INIT`                | `false`                   | Preload the embedding model in the background after server init, hiding the ~2–4s ONNX cold-start cost from the first tutorial search.                                                                         |
| `GODOT_DOCS_DB_PATH`                   | unset                     | Override the resolved DB path with a pre-built `.db` file. Skips version resolution; schema integrity check still runs. Useful for offline installs.                                                           |
| `GODOT_DOCS_TARBALL_HASH_OVERRIDE`     | unset                     | Override the `data/godot-release-hashes.json` manifest for a single ingestion. Rare — needed only for forks with non-upstream tarballs.                                                                        |

### LSP subsystem

| Variable                         | Default     | Purpose                                                                                                                                                        |
| -------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GODOT_LSP_PORT`                 | `6005`      | Starting port for headless Godot LSP. Scans upward if in use.                                                                                                  |
| `GODOT_LSP_PROJECT_PATH`         | auto-detect | Project root. Auto-detect walks up from cwd looking for `project.godot`.                                                                                       |
| `GODOT_LSP_EAGER_INIT`           | `false`     | Spawn headless Godot at MCP startup instead of on first LSP call. **Recommended `true` for interactive agent use** — see Process management § Spawn lifecycle. |
| `GODOT_LSP_SPAWN_RESET_MINUTES`  | `30`        | If no spawn cycle has occurred in N minutes, the spawn-cycle counter resets (windowed cap; complements the on-successful-handshake reset).                     |
| `GODOT_LSP_DIAGNOSTIC_FIRST_MS`  | `10000`     | First-touch `publishDiagnostics` await timeout per file URI in a session.                                                                                      |
| `GODOT_LSP_DIAGNOSTIC_STEADY_MS` | `2000`      | Steady-state `publishDiagnostics` await timeout (after the first touch).                                                                                       |

`GODOT_LSP_HOST` was considered and **removed**: Godot's LSP has no authentication, so the host is hardcoded to `127.0.0.1` (loopback) to prevent WSL/devcontainer users from accidentally binding to `0.0.0.0` and exposing the LSP to the LAN.

### Shared

| Variable                  | Default                 | Purpose                                                                                                                                                                   |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GODOT_PATH`              | inherited from fork     | Path to Godot binary. Used for both editor launch (existing tools) and headless LSP spawn (new).                                                                          |
| `GODOT_MCP_LOG_LEVEL`     | `info`                  | Stderr log verbosity. Levels: `silent`, `error`, `warn`, `info`, `debug`. At `info`, headless Godot's stdout/stderr is filtered to warn/error only; `debug` forwards all. |
| `GODOT_MCP_OFFLINE`       | unset                   | Set to `1` to disable all runtime network calls (no GitHub Tags API, no tarball fetch, no model download). `GODOT_DOCS_VERSION=latest` errors out under this mode.        |
| `GODOT_MCP_MODEL_PATH`    | unset                   | Override path for the embedding model ONNX files (offline-install support).                                                                                               |
| `GODOT_MCP_TRACE_QUERIES` | unset                   | Set to `1` to capture verbatim query strings in OTel traces. Default behavior is length-hashing for privacy.                                                              |
| `GITHUB_TOKEN`            | unset (auto in Actions) | Bearer token for the GitHub Tags API. Boosts from 60 req/hr unauthenticated to 5,000 req/hr. CI environments auto-detect.                                                 |
| `OTEL_SDK_DISABLED`       | unset                   | Standard OTel env var. Set to `true` to disable telemetry instrumentation entirely.                                                                                       |

## Architecture

### Module organization

The existing single-file `src/index.ts` is refactored into modules as the first PR. New work lands in this structure:

```
src/
├── index.ts                # server setup, top-level entry
├── dispatch.ts             # tool name → handler routing; per-call OTel span wrapping, schema validation, error normalization
├── tools/
│   ├── descriptions.ts     # canonical tool descriptions (single source of truth)
│   ├── editor-tools.ts     # existing: launch, run, debug
│   ├── scene-tools.ts      # existing: create_scene, add_node, etc.
│   ├── project-tools.ts    # existing: list, get_info, uid
│   ├── docs-tools.ts       # new
│   └── lsp-tools.ts        # new
├── docs/
│   ├── ingest.ts           # fetch + parse (shared by build script and runtime)
│   ├── version-manager.ts  # env var → DB path resolution
│   ├── schema.ts           # better-sqlite3 direct; SQL schema + prepared statements
│   └── search.ts           # FTS5 + hybrid search implementation
├── lsp/
│   ├── client.ts           # vscode-jsonrpc-based LSP client
│   ├── process.ts          # headless Godot spawn/lifecycle
│   ├── documents.ts        # didOpen tracking, auto-resync (mtime/size-shortcircuited)
│   └── adapter.ts          # Godot-specific LSP quirk workarounds (4 known inhabitants at v1)
└── shared/
    ├── env.ts              # env var parsing and validation
    ├── logging.ts          # stderr logger
    ├── telemetry.ts        # OTel setup
    └── latch.ts            # InitLatch primitive (state introspection + reset + in-flight rejection)
```

`dispatch.ts` is not just a routing table — it owns three cross-cutting responsibilities that justify the separate module: per-call OTel span wrapping, JSON-schema validation of tool arguments, and error normalization to MCP error responses. Without those it would be `Object.assign` in `index.ts`; with them, it pays rent.

Each subsystem registers its tools through `dispatch.ts`. Tools are flat — no nested categories.

### Shared infrastructure

- **InitLatch primitive.** Both docs and LSP use a typed one-shot promise with lifecycle states (`pending | ready | failed`), `reset()` for LSP respawn / docs runtime-refetch retry, and in-flight `await()` rejection on `reset()`. The named primitive is load-bearing for LSP's `unavailable` surface and for the runtime-refetch failure path on docs.
- **Env var parsing.** Centralized validation, fails fast on bad values.
- **Logging.** Stderr-only, level-gated. Format: `[godot-mcp][subsystem] message`. At `info`, headless Godot's stdout/stderr is filtered to warn/error only; `debug` forwards all (and may leak source content into transcripts).
- **Telemetry.** OpenTelemetry traces written to local files (`$XDG_DATA_HOME/godot-mcp/traces/`). Rotation cap at 100MB or 7 days, whichever comes first. Disabled via standard OTel env vars. Trace contents schema is documented at `docs/telemetry.md`; file paths are recorded relative to project root, query strings are length-hashed by default, with `GODOT_MCP_TRACE_QUERIES=1` opting into verbatim capture.

### Cross-subsystem independence

The three subsystems (editor tools, docs, LSP) have **separate latches** and **independent failure modes**:

- **Docs cold-startup failure → server crashes** (docs is core value). **Runtime refetch failure** (e.g. `latest` TTL expiry triggering a refetch hours into a session) → mark docs unavailable, return MCP error from docs tools, **keep server up**. The docs latch transitions to `failed`; editor and LSP tools continue working.
- LSP init failure → server stays up, LSP tools return errors, other tools work.
- Editor tools currently don't have init failures. If a future editor tool needs Godot's version probed at startup or wants to cache `list_projects` results, it gets a latch like the others — this is current state, not a permanent property.

The docs latch is **scoped**: only docs tool handlers `await` it. Editor and LSP tool handlers are not blocked by docs init or by docs runtime-refetch failures.

This means a misconfigured LSP doesn't prevent the agent from using docs, and a docs network failure doesn't break editor tools — at startup or at runtime.

## Documentation subsystem

### Version resolution

Resolution happens at startup, synchronously:

1. Read `GODOT_DOCS_VERSION`. Unset or `stable` → use bundled DB. Skip steps 2-5.
2. Validate format. Bad format → exit 2 with clear message.
3. Compute cache file name: `docs-{version}-v{schema}.db` under OS cache dir.
4. If `version` is `latest`:
   - Check `latest-resolution.json` cache with 1-hour TTL (extended to 24h in CI per `process.env.CI`).
   - On cache miss, fetch GitHub Tags API for `godotengine/godot`, filter to `*-stable` semver tags, pick highest. Cache result.
   - Rate limit: unauthenticated is 60 req/hr per IP; setting `GITHUB_TOKEN` boosts to 5,000 req/hr (auto-detected in GitHub Actions).
5. Cache hit + integrity check passes → use cached DB.
6. Cache miss → kick off async fetch + parse (see below); latch starts unresolved.

`stable` (the default) never makes network calls. `latest` always resolves dynamically (subject to the cache TTL).

`GODOT_MCP_OFFLINE=1` short-circuits this: `latest` errors out, `X.Y` without a local cache hit errors out, and `GODOT_DOCS_DB_PATH` is the supported escape hatch for pre-built DBs in air-gapped environments.

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
2. **Fetch godot tarball.** `https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/{tag}`. **Stream-extract**, retaining only `doc/classes/` entries. (`codeload.github.com` serves sequential `git archive` tarballs; it does not support path filtering or partial downloads, so we stream the full tarball and discard non-matching entries during extraction.) Retries: 5 attempts, exponential backoff (1s/2s/4s/8s/16s, ±25% jitter, 30s cap, 60s overall ceiling). 4xx failures do not retry (likely user error like a typo); 5xx and network errors do.
3. **Validate structurally.** `doc/classes/` exists; XML file count ≥ 500; `Object.xml` parses to a recognizable class structure. Structural failure → treat as fetch failure for retry purposes.
4. **Verify tarball SHA-256.** Compare against the manifest in `data/godot-release-hashes.json` keyed by tag. Manifest mismatch → exit 2 (user-error class, indicates either a compromised tag or a stale manifest). For `latest` / unpinned versions, still compute the SHA and store it in the resulting DB's `meta.tarball_sha256` field — a downstream compromise then becomes detectable by comparing hashes across users / cache invalidations.
5. **Fetch godot-docs tarball.** Same retry/validation/SHA pattern for `https://codeload.github.com/godotengine/godot-docs/tar.gz/refs/heads/{docs_branch}`. Branch mapping: `4.5-stable` → `4.5`. If version-specific branch 404s, fall back to `stable` branch.
6. **Parse class XML.** Each file produces a class record + member records. Failures tracked.
7. **Parse tutorial RST.** Chunk via fallback chain: **H2 → H3 → paragraph (double-newline) → token-window (200-token overlap)**. Soft cap 1500 tokens, hard cap 3000; code blocks remain with surrounding prose; cross-references stored as metadata, not inline-expanded. Pages with no H2 chunk from paragraphs immediately. Failures tracked.
8. **Embed tutorial chunks.** Use BGE-small-en-v1.5 (384-dim, 512-token context, MIT license). Lazily loaded on first tutorial search; downloaded on first use unless `GODOT_MCP_MODEL_PATH` overrides. Batched to avoid memory spikes. _(Originally specified MiniLM-L6-v2 — switched in Wave 2 because MiniLM's 256-token context made >90% of a 3000-token chunk invisible to dense retrieval, and BGE-small materially outperforms it on MTEB retrieval at the same dimensions.)_
9. **Write to SQLite.** Atomic — build to `.tmp`, rename at end. The lock file is held across the rename. On Windows, atomic rename can race with concurrent readers' open handles; `ERROR_SHARING_VIOLATION` is treated as a transient retryable failure rather than a hard error.
10. **Report.** Return `{classes: {parsed, failed, warnings}, tutorials: {parsed, failed, warnings}, retries, durationMs, tarballSha256, docsTarballSha256}` to caller. Caller decides pass/fail based on threshold.

#### Failure semantics

- **Network retry budget per endpoint:** 5 attempts.
- **Structural validation failure:** retried as a fetch failure (truncated tarballs are the common cause).
- **Per-file parse failures:** counted, compared against `GODOT_DOCS_FAILURE_THRESHOLD_PERCENT` across all files. CI sets to 0 (strict), runtime defaults to 5 (lenient).
- **Top-level structural failures** (missing `doc/classes/` directory, malformed tarball): fail hard, don't count toward threshold.
- **Cold-startup ingestion failure → `process.exit(1)`** with a clear stderr message. Different exit codes for user error (bad version: exit 2) vs runtime failure (network: exit 1).
- **Runtime refetch failure** (e.g. `latest` TTL re-resolution kicked off during an active session) does **not** crash the server. The docs latch transitions to `failed`, docs tools return MCP errors with `recovery_hint`, and editor/LSP tools continue working. The user can fix configuration and the next docs tool call will re-trigger initialization.

#### Concurrency

Cross-process mutual exclusion of ingestion uses OS-level advisory locks (`flock` on POSIX, `LockFileEx` on Windows). The on-disk `docs-{version}.lock` file is diagnostic-only: it contains `{pid, nonce, startedAt, heartbeatAt}` to make liveness observable. The writer touches `heartbeatAt` every 5 seconds; other processes detecting a stale heartbeat (`> 60s` since last touch) reclaim only after acquiring the OS lock, and verify `nonce` after acquisition to defeat Windows PID-reuse.

After acquiring the lock, the writer re-checks the cache (another process may have completed) before fetching.

### Storage

#### Schema overview

Defer detailed table design to implementation. Decisions already made:

- **Single `members` table with `kind` column** (method, property, signal, constant, annotation), not separate tables per kind. Unified queries are easier; null-column cost is small.
- **Normalized inheritance** — `classes.inherits` stores immediate parent only. Walk via recursive CTE at query time. Denormalize only if benchmarks prove necessary.
- **`sqlite-vec` extension for tutorial embeddings.** Cleaner queries than flat BLOB.
- **Single-row `meta` table** with `godot_version`, `godot_docs_branch`, `schema_version`, `indexed_at` (ISO 8601 UTC), `class_count`, `tutorial_count`, `ingest_warnings` (JSON), `embedding_model_id` (HuggingFace revision SHA), `ingestion_source_sha` (godot commit), `ingestion_duration_ms`, `tarball_sha256` (godot), `docs_tarball_sha256` (godot-docs).
- **No WAL mode.** The bundled DB is read-only post-ingestion; WAL has no benefit there and would require shipping `-wal`/`-shm` siblings. Connections are opened with `PRAGMA query_only = 1` for defense-in-depth.
- **Cache-dir filesystem check.** On startup, detect the cache dir's filesystem type. If it's a known network type (NFS, CIFS/SMB, AFS, GPFS, or Windows `DRIVE_REMOTE`), fail fast with a clear error directing the user to set `XDG_CACHE_HOME` to a local directory. SQLite over networked filesystems is unreliable; better to refuse than risk silent corruption.
- **Cross-kind member name uniqueness not enforced.** Even if a class can't have a method and property with the same name in practice, the schema permits it.

#### Database client

Use `better-sqlite3` directly with hand-written prepared statements. Drizzle ORM was considered but dropped — neither the 0.45 stable nor the 1.0-rc supports FTS5 virtual tables or `sqlite-vec` extension loading, which is the bulk of search code. The ergonomics savings on the three normal tables (`classes`, `members`, `meta`) was insufficient to justify a moving-target dependency.

### Search

#### Class reference

Pure FTS5 over `classes_fts(name, brief)` and `members_fts(name, signature, description)`. BM25 weighting:

- `ORDER BY bm25(classes_fts, 3.0, 1.0)` — name 3× brief.
- `ORDER BY bm25(members_fts, 3.0, 2.0, 1.0)` — name 3×, signature 2×, description 1×.

Tokenizer: `unicode61` with `tokenchars=_` for class/member tables so `add_child` remains a single token. (Tutorial table uses default `unicode61`.) `trigram` was considered for partial-name lookups but rejected for v1 — reconsider if benchmark results show recall problems on substring queries.

Empty query with structured filters returns the filtered set ordered by name. Empty query with no filters returns `{results: [], hint: "Provide at least a query, inherits_from filter, or category filter."}` — a successful response with guidance, not an MCP error.

#### Tutorials

Hybrid retrieval:

- **Lexical layer:** FTS5 over tutorial chunks (title, heading_path, content). `ORDER BY bm25(tutorials_fts, 3.0, 2.0, 1.0)` (title 3×, heading_path 2×, content 1×).
- **Dense layer:** embedding similarity via `sqlite-vec`.
- **Fusion:** Reciprocal Rank Fusion (RRF) with k=60, per Cormack, Clarke, Büttcher (2009) "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods" (SIGIR'09); Elastic, Vespa, and OpenSearch all inherit the same default. RRF is rank-based so the value of k matters less than the quality of the two input rankings — tuning ranker quality (chunking, embedding) is higher leverage than tuning k.

Embedding model loads lazily on first tutorial search (~1–2s cold-start including ONNX runtime warm-up). `GODOT_DOCS_EAGER_INIT=true` triggers a background preload after server init to hide this cost.

### Concurrency model

The InitLatch primitive (see Shared infrastructure) gates docs tool handlers during initialization:

- **Bundled DB:** latch resolved synchronously at startup. No async path.
- **Cache hit:** latch resolved synchronously after integrity check (`SELECT COUNT(*) FROM classes LIMIT 1`). No async path.
- **Cache miss:** latch starts unresolved. Background fetch + parse runs. On success, latch resolves with the open connection. On cold-startup failure, latch rejects and `process.exit(1)`; on runtime-refetch failure, latch transitions to `failed` and the server stays up.

Docs tool handlers (and only docs tool handlers) `await` the latch before querying. Editor and LSP tool handlers are not blocked by docs init or by docs runtime-refetch.

No "indexing in progress" response shape. No status field in `godot_docs_info`. Tool calls block on the latch until ready or until the latch fails. This is acceptable because indexing is fast (target <30s on common hardware; measured by benchmarks during implementation, not asserted) and well below MCP client timeout limits.

### Error handling

Standard MCP error responses for normal failures:

- Class not found, member not found, tutorial not found → MCP error with `suggestions` array containing similar names (cheap FTS5 lookup).
- Invalid arguments (negative limit, bad filter value) → MCP error "invalid argument."
- Class name case mismatch (`node` instead of `Node`) → case-insensitive lookup with a "did you mean `Node`?" suggestion.

Server-level errors (DB connection lost, file corruption detected at runtime): MCP internal error.

## LSP subsystem

### Implementation approach

Write the LSP client using `vscode-jsonrpc` (Microsoft's JSON-RPC library, supports any duplex transport including TCP) for the protocol layer. Implement LSP semantics (document state, diagnostics cache, capability handshake) ourselves. Do not depend on `cclsp` or `lsp-mcp` as packages — they are MCP servers, not libraries.

Before implementation, study `ktnyt/cclsp` and `tritlo/lsp-mcp` source code thoroughly. Especially worth understanding:

- cclsp's `LSPClient` in `src/lsp-client.ts` (process management, request correlation, capability handshake)
- cclsp's adapter pattern for Vue/Pyright (the shape of per-server workarounds)
- cclsp's `findSymbolsByName` (the v1 symbol-based-fallback pattern)
- lsp-mcp's `publishDiagnostics` buffering and resource subscriptions

Borrow concepts, not code.

### Known Godot LSP server capabilities

From inspection of [`gdscript_language_protocol.cpp`](https://github.com/godotengine/godot/blob/master/modules/gdscript/language_server/gdscript_language_protocol.cpp) plus community confirmation:

**Supported:** `textDocumentSync` = `Full` (1; no incremental), `hoverProvider`, `definitionProvider`, `referencesProvider`, `documentSymbolProvider`, `signatureHelpProvider`, `renameProvider`, `completionProvider`, `codeLensProvider`, `documentHighlightProvider`, `foldingRangeProvider`, `documentLinkProvider`, `colorPresentationProvider`.

**NOT supported:**

- `codeActionProvider` — open at [godot-proposals#14307](https://github.com/godotengine/godot-proposals/issues/14307); reason `godot_code_actions`/`godot_preview_code_action` are deferred to v1.1.
- `workspaceSymbolProvider` — claims support but de-facto broken ([godot-vscode-plugin#989](https://github.com/godotengine/godot-vscode-plugin/issues/989)); the per-server adapter shims this with a union of `documentSymbol` over tracked-open `.gd` files.
- `semanticTokensProvider`, `inlayHintProvider`.

The capability list should be parsed from the actual `initialize` response on a real Godot 4.5/4.6 during integration testing — the list above reflects May 2026 source-code state.

### Process management

#### Spawn lifecycle

- **When to spawn:** Lazy by default, on first LSP tool call. Eager via `GODOT_LSP_EAGER_INIT=true`. **Recommended `true` for interactive agent use** because the first spawn pays a 10–20s cold-start cost (opencode-godot-lsp's README documents the same range) that will likely time out at the MCP-client level if hit lazily on the user's first LSP call.
- **Spawn command:** `godot --editor --headless --lsp-port {port} --path {project_path}`. Binary location from `GODOT_PATH`. `--editor` enables the LSP feature; `--headless` is compatible.
- **Port selection:** Scan upward from `GODOT_LSP_PORT` for the first available port. Avoids conflict with the user's existing editor if one is running.
- **Why isolated processes:** Each MCP session spawns its own headless Godot. The reasons are (a) the user may not have the editor open, (b) querying a project the user isn't currently editing requires us to launch one, (c) defense-in-depth against the 4.0-era disconnect-leak ([godot#75849](https://github.com/godotengine/godot/issues/75849), fixed in 4.1). Godot's LSP supports up to 8 concurrent clients (`LSP_MAX_CLIENTS = 8`); attaching to a user's existing editor instance is **viable** and tracked as a v1.1 opt-in mode (`GODOT_LSP_ATTACH_TO_PORT` env var).
- **stdout/stderr:** Pipe to MCP's stderr with a `[godot]` prefix, gated by `GODOT_MCP_LOG_LEVEL`. At `info` (default), only Godot's warn/error lines flow through; at `debug`, everything flows (and may leak source content into transcripts).
- **Shutdown:** Exit/signal handlers (SIGINT, SIGTERM, normal exit) kill the child Godot. Crashes (SIGKILL, OOM) leak one process per crash — documented in troubleshooting as a manual cleanup item.

#### Death detection and recovery

- `child_process.spawn`, listen for `'exit'` event.
- On death: mark LSP unavailable, next tool call triggers respawn.
- **Tiered recovery on connection drop:**
  1. Check if process is alive (PID check + exit event).
  2. If alive: 3 TCP reconnect attempts with 1s/2s/4s backoff.
  3. If dead, hung (handshake times out), or all reconnects fail: kill remaining process, respawn, fresh handshake. Counts as one spawn cycle.
  4. Cap spawn cycles per session at 3. **The counter resets on successful handshake** (one good connection clears the budget) and is windowed via `GODOT_LSP_SPAWN_RESET_MINUTES` (default 30; if no spawn cycle has happened in that window, the counter resets regardless of handshake state).
  5. When the cap is exhausted, mark LSP permanently unavailable for the session. The unavailable-error includes `recovery_hint: "Restart MCP server (LSP has exhausted its spawn budget for this session). If this happens repeatedly, check for runaway Godot processes."`
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
  - `textDocumentSync.change: 1` (full sync, not incremental — Godot's server only supports full sync; see [godot#87410](https://github.com/godotengine/godot/issues/87410))
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
- **Auto-resync before queries:** required for correctness because Godot's LSP has no internal file watcher (confirmed by source inspection of `gdscript_language_protocol.cpp`). Without our `didChange`, an external edit (Claude Code's `Edit` tool, another agent, `git checkout`) is invisible to the LSP and subsequent queries return stale results. **Mtime/size-shortcircuited:** before any LSP query, `fs.stat` each tracked file referenced by the current call plus any tracked file whose stat (mtime+size) has changed since the last sync check. Only files whose stat changed are re-read and sent as `didChange`. The broader tracked-set is stat-polled at most once per second. This avoids the O(files × size) cost of content-comparing every tracked file on every query.

### Diagnostics

- **Push-driven cache.** Godot's LSP pushes `publishDiagnostics`; we cache per file URI; cache replaces on each new push.
- **`godot_get_diagnostics(file)` semantics:**
  1. Auto-resync triggers `didChange` if disk content differs.
  2. If `didChange` was sent, await the next `publishDiagnostics` for that URI with a **10s timeout on first-touch per URI in a session, 2s on subsequent awaits**. (The first-touch budget accommodates Godot's 10–20s cold-parse on first connection.)
  3. On timeout, return cached diagnostics with `partial: true` flag (not an MCP error).
  4. Return cached diagnostics.
- **Scope:** Per-file. Required `file` parameter. No workspace-wide diagnostics tool in v1.
- **Unopened files:** No diagnostics returned. Agent must reference via a tool that triggers didOpen.
- **Response format:** Array of `{severity, line, character, end_line, end_character, message, source, code}`. Standard flattened LSP shape; positions 1-based per the position-handling convention.
- **Buffer:** Indefinitely until server shutdown. Memory cost trivial.
- **No TTL.** Cache freshness is maintained by `didChange`-triggered push cycles; TTL would add no correctness and would waste work.

### Write operations: advisory pattern

The single advisory-write tool in v1 (`godot_preview_rename`) returns proposed edits without applying them. The agent applies edits via its native edit tools (Claude Code's `Edit`, `Write`, etc.), preserving the checkpoint/rewind flow. (`godot_code_actions` and `godot_preview_code_action` are deferred to v1.1 — Godot's LSP doesn't implement `codeActionProvider`.)

Response shape uses a generalized `action` envelope so v1.1 code-action tools can reuse it:

```json
{
  "action": { "kind": "rename", "from": "old_name", "to": "new_name" },
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

Two correctness rules baked into the shape:

- **`before` widening for uniqueness.** If a line-level `before` is non-unique in the file, the MCP widens it by including preceding non-blank lines until the pair is unique (up to 5 lines of widening). If still ambiguous after 5 lines, falls back to LSP-native range coordinates (`{file, range: {start, end}, newText}`) and emits `widened: false` flag on the change record. The agent consumes either shape; this puts the burden of producing a uniquely matchable string on the MCP, not the agent.
- **Same-line multi-edit merge.** Renames like `var x = old_name(old_name(1))` produce multiple LSP TextEdits with disjoint ranges on the same line. The per-line `(before, after)` shape merges them into a single change whose `after` reflects all edits applied. A same-line rename test case is part of the acceptance criteria.

If the file content shifts between MCP-compute and agent-apply, `str_replace` fails cleanly and the agent re-runs the preview against fresh state.

### Tool-specific behavior

- **Position handling:** Agents see 1-based line and character (matches editor convention). Internally converted to 0-based for LSP. Documented in the parameter doc, not the description first sentence (preserves first-sentence routing weight).
- **Range semantics:** LSP half-open ranges `[start, end)` preserved through to tool responses. Documented.
- **Universal zero-results rule:** all 7 read-only LSP tools return an empty array (or empty object for hover) on zero results, never an MCP error. The rule lives at the subsystem level and is referenced from each tool's behavior section.
- **Symbol-based fallback:** `godot_find_definition`, `godot_find_references`, `godot_hover`, and `godot_preview_rename` accept `symbol_name` as an alternative to `(line, character)`. Resolution: positional path first if provided and in-bounds; otherwise `documentSymbol` (single-file scope) or the adapter-shimmed `workspace/symbol` (project scope). Multi-match results return an array with `disambiguation_hint` per match.
- **Multiple definitions:** Return array, agent disambiguates.
- **Hover format:** Pass through LSP's `MarkupContent` (markdown). The per-server adapter normalizes `MarkedString` (deprecated LSP type) and Godot-specific markdown quirks to standard `MarkupContent { kind: "markdown" }` before truncation. **Markdown-fence-aware truncation** at 5000 chars: if the cut lands inside a fenced code block, extend forward to the next closing fence up to a hard cap of 6000 chars; if extension would exceed the hard cap, trim back to the most recent fence boundary before the cut. Add `truncated: true` flag whenever any truncation occurs.
- **`workspace_symbols` query:** Substring, case-insensitive. Godot's LSP does not implement fuzzy or CamelCase matching; the parameter doc documents this explicitly. Native results are unioned with the adapter shim (a union of `documentSymbol` over tracked-open `.gd` files) because Godot's native `workspace/symbol` returns empty for most queries.
- **`document_symbols` large file:** Cap response at 500 symbols with `truncated: true` flag. Symbol list ordered by declaration order in the file.
- **`signature_help` out of context:** Empty result, not error. Tool description warns the agent that GDScript signature help is unreliable on `.new()` constructor calls (returns `GDScript.new()` docs instead of the actual class's `_init()`) and on multi-line argument lists ([godot#51617](https://github.com/godotengine/godot/issues/51617)).
- **Built-in symbol redirect:** When `godot_find_definition` resolves to a URI that fails an `fs.access(R_OK)` check (or matches a synthetic `gdscript://` / `godot://` scheme), the adapter redirects the result to a docs-subsystem lookup against `godot_find_member`. The agent sees a unified response with `source: "docs"` instead of `source: "lsp"`.
- **Autoload-globals shim:** `find_references` on an identifier matching an autoload (entry in `project.godot` `[autoload]` section) unions LSP results with a regex-anchored text-grep over tracked files. Grep-derived hits carry `source: "grep_fallback"`.

### Concurrency

- **Single TCP connection** to Godot's LSP per MCP session.
- **2-priority request queue.** Interactive lane (`hover`, `signatureHelp`, `documentSymbol`) jumps ahead of background lane (`references`, `workspaceSymbol`, `rename`, `documentLink`). Within each lane, requests serialize. A pending background-lane request is preempted only if the interactive-lane queue depth was 0 when the background request started.
- **Per-request timeout:** 30 seconds default (matches cclsp baseline). Per-method adapter overrides allowed (e.g., `references` may extend to 60s on large projects).
- **InitLatch primitive** gates LSP tool calls during init and during respawn cycles.

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

- Docs is the core MCP value; without docs, the server is largely pointless. Crash is honest on cold-startup; runtime refetch fail is mark-unavailable.
- LSP is opt-in. Misconfigured LSP (bad project path, missing Godot binary) shouldn't prevent docs and editor tools from working.

On init failure:

- Log prominently to stderr (visible at startup if `GODOT_LSP_EAGER_INIT=true`).
- Mark LSP as unavailable for the session.
- LSP tool calls return clean `"LSP unavailable: {reason}"` errors with a `recovery_hint`.
- Other tools continue working.
- No retry on failed init. User restarts MCP after fixing config.

## Distribution and release

### Bundled docs DB

The npm package ships with `data/docs-stable.db` for the current Godot stable version at publish time. The DB is **not** built during `npm publish` — that would couple publish atomicity to GitHub Codeload availability and the GitHub Tags API. Instead, the build is a separate CI workflow step that produces `data/docs-stable.db` as a release artifact, committed/uploaded ahead of the publish step. The publish step's `prepublishOnly` script validates the artifact exists and is well-formed; it performs no network work.

Consequences:

- Anyone running `npm install` gets immediate docs functionality.
- The bundled `stable` lags Godot's actual current stable by however long it takes to cut a new package release.
- Users who need to track Godot's current stable use `GODOT_DOCS_VERSION=latest`.

### Embedding model

The embedding model is **not bundled** in the npm tarball. It is downloaded on first use by `@huggingface/transformers` from a SHA-pinned URL into the user's HuggingFace cache (~80MB). This drops the npm tarball from ~150MB to ~70MB and aligns with the docs `latest` runtime-fetch posture — first-run users pay a one-time download cost; subsequent runs are instant.

For users with restricted networks, `GODOT_MCP_MODEL_PATH` overrides the resolved model path with a pre-downloaded copy. `GODOT_MCP_OFFLINE=1` rejects any model-download attempt and requires `GODOT_MCP_MODEL_PATH` to be set.

The model used in v1 is **BGE-small-en-v1.5** (384-dim, 512-token context, MIT license). _(Originally specified MiniLM-L6-v2 — switched in Wave 2 because MiniLM's 256-token window made >90% of a 3000-token chunk invisible to dense retrieval.)_ The model SHA is pinned in `data/model-hashes.json`; download verifies the SHA before writing to cache.

### Native dependencies

- `better-sqlite3` — SQLite client (native).
- `sqlite-vec` — vector extension.
- `@huggingface/transformers` — ONNX runtime for embedding inference (native via `onnxruntime-node`).

#### Supported platform matrix

| Platform                  | `better-sqlite3` | `sqlite-vec`                                                  | `@huggingface/transformers` |
| ------------------------- | ---------------- | ------------------------------------------------------------- | --------------------------- |
| Linux x64 (glibc)         | ✅               | ✅                                                            | ✅                          |
| Linux arm64 (glibc)       | ✅               | ✅                                                            | ✅                          |
| Linux x64 (musl / Alpine) | ✅               | ❌ ([PR #199](https://github.com/asg017/sqlite-vec/pull/199)) | ❌                          |
| Linux arm64 (musl)        | ✅               | ❌                                                            | ❌                          |
| macOS x64                 | ✅               | ✅                                                            | ✅                          |
| macOS arm64               | ✅               | ✅                                                            | ✅                          |
| Windows x64               | ✅               | ✅                                                            | ✅                          |
| Windows arm64             | ✅               | ❌ ([PR #271](https://github.com/asg017/sqlite-vec/pull/271)) | varies by version           |

#### Unsupported platforms

**Alpine / musl Linux** and **Windows-on-ARM** are not supported in v1. The official Node Alpine image is a common container base; users hitting this should use a glibc-based image (`node:bookworm-slim` or similar). A `postinstall` preflight script detects unsupported platforms and exits with a clear message + remediation pointer. In CI environments (`process.env.CI`), the preflight prints a warning rather than exiting, so the matrix tests can capture the failure mode without aborting.

### Node version

Minimum Node version is **22** in `package.json` `engines`. Node 24 was considered (was the LTS line at design time) but rolled back to 22 to match what most distros and Node-version managers ship by default. Node 22 EOL is 2026-04-30; once that lands, revisit the floor.

### npm publish path

All releases use GitHub Actions OIDC + `npm publish --provenance` for end-to-end Sigstore-signed provenance. The maintainer's local machine never publishes directly; a `release.yml` workflow triggered by `git push --tags` handles publishing. Provenance is free for public packages and gives users a verifiable build trail.

### Auto-republish on Godot release (future)

A CI pipeline auto-rebuilds and republishes the package on Godot releases. Concrete approval gate:

1. **Trigger:** Godot-release webhook or scheduled poll (auth via `GITHUB_TOKEN`).
2. **Build:** isolated runner builds + tests against the new Godot tag.
3. **Hash verify:** ingestion verifies the new tag's SHA against an updated `data/godot-release-hashes.json` (updates to the manifest are PR'd separately and reviewed before any rebuild uses them).
4. **Staged publish:** publishes to a canary dist-tag via `npm publish --tag canary --provenance`.
5. **Promotion to `latest`:** requires a separate `workflow_dispatch` run gated by a GitHub Environment with required reviewers.
6. **All third-party Actions pinned to SHA**, not floating tags. Dependabot enabled.
7. **Hard invariant:** the bundled docs DB is never republished without rebuilding from a hash-pinned source.

## Logging and telemetry

Two separate concerns:

### Stderr logging (`GODOT_MCP_LOG_LEVEL`)

Operational, human-readable. Levels: `silent | error | warn | info | debug`. Default `info`.

Examples:

- `info`: "Building docs index for Godot 4.5. This is a one-time setup..."
- `warn`: "LSP connection dropped, attempting reconnect (2/3)"
- `error`: "FATAL: Could not load docs for GODOT_DOCS_VERSION=4.55"
- `debug`: Per-request LSP messages, per-file ingestion progress, headless Godot stdout/stderr.

At `info` and below, headless Godot's stdout/stderr is filtered to warn/error lines only. `debug` forwards everything — documented as potentially leaking source content into the agent's transcript.

### OTel telemetry (`OTEL_SDK_DISABLED`)

Structured traces stored locally at `$XDG_DATA_HOME/godot-mcp/traces/` (and OS-equivalent on macOS/Windows). Spans for:

- Docs ingestion per stage (fetch, parse classes, parse tutorials, embed, write).
- LSP spawn duration.
- LSP query latency per operation.
- Cache hit/miss rates.

Rotation: cap at 100MB or 7 days, whichever first.

#### Trace contents and PII posture

Trace attribute schema is documented at `docs/telemetry.md`. PII-sensitive fields:

- **File paths** are recorded **relative to project root**, never absolute.
- **Query strings** default to a length-hash (`{length, sha256_prefix_8}`). Verbatim capture requires `GODOT_MCP_TRACE_QUERIES=1`.
- **Source-line snippets** never recorded.
- A `README.md` is written into the trace directory on first trace explaining what's in there.

No phone-home. No data transmitted externally.

## Testing and benchmarks

Three benchmark plans in this document plus a fourth (LSP correctness) tracked separately as a follow-up. In order of effort and value.

### 1. Tool-routing accuracy

**Goal:** Validate that agents pick the right tool when given a natural-language query.

**Method:** Pass tool schemas to the Anthropic API with `tool_choice: "any"`. Run a curated set of ~50-100 queries covering docs, LSP, and editor tools. Measure per-tool precision and recall. Run separately for Claude Opus and Claude Sonnet.

Three ablation runs to isolate the contribution of each routing signal:

- **(a) Full description** (the production candidate)
- **(b) First sentence only** (validates the "first sentence is the primary routing signal" claim)
- **(c) Name + parameter schema only** (controls for description quality)

**When to do this:** Optional during implementation. Cheap to set up. Useful diagnostic if agents seem to pick wrong tools in practice.

**Cost and cadence:** ~600 API calls per full run; small. Run on-demand and on every PR touching `src/tools/descriptions.ts`.

**Acceptance criteria:** None hardcoded. Used as a diagnostic, not a gate.

**Precondition:** Canonical tool descriptions exist in `src/tools/descriptions.ts` (tracked as a separate issue; blocks this benchmark).

### 2. End-to-end GDScript correctness

**Goal:** Measure whether the MCP actually improves agent output quality.

**Method:** Curated set of GDScript tasks (write a function, modify a class, find a bug). Hold the agent and model constant. Run each task with and without the MCP available. Score the produced code against ground truth.

**Per-task 3-point rubric:**

- **0** — fails to compile/parse, or uses APIs absent from the chosen `GODOT_DOCS_VERSION`.
- **1** — compiles and approximates intent, but uses wrong/deprecated APIs or misses edge cases.
- **2** — matches ground truth in correctness and is version-appropriate.

Programmatic complement: `godot --check-only` for compile-success, plus API-version match against `godot_get_class`/`godot_find_member` results.

**When to do this:** The headline metric. The thing that tells you whether the project succeeded.

**Cost and cadence:** ~100 model calls per full run + ~2 hours human review. Run pre-release and on every PR touching `src/docs/`, `src/tools/`, or anything that affects retrieval.

**Acceptance criteria:** MCP-on mean score ≥ MCP-off mean score + **0.3** across ≥ 30 tasks, **p < 0.05 by paired t-test**.

**Precondition:** The labeled task set (tracked as a separate issue).

### 3. Chunking quality + correctness

**Goal:** Validate that the tutorial chunking strategy produces retrievable, useful chunks, AND that agents can answer questions correctly given retrieved chunks.

**Method:** ~50 curated tutorial queries with **page + heading-anchor** ground truth (not chunk-ID — chunks are derived artifacts whose identity changes with config). A result chunk "covers" an answer anchor when the chunk's page path matches AND its heading_path either contains or is contained by the anchor heading.

**Part A (retrieval):** For each query, run `godot_search_tutorials`. A "covering" chunk in top 5 counts as a hit.

**Part B (correctness):** For each query, retrieve top 5 chunks, feed to a model (held constant per benchmark run; version recorded) with the query, score the answer against ground truth.

(Part C — A/B testing chunking configs — was split into its own follow-up issue; it's a research methodology not a deliverable.)

**Acceptance criteria (Part A + B):**

- Recall@5 ≥ 80% (covering chunk in top 5 for ≥ 40/50 queries).
- Recall@1 ≥ 50% (covering chunk is top result for ≥ 25/50 queries).
- Answer correctness ≥ 70% on Part B.
- No chunks exceeding hard cap (3000 tokens) — depends on the chunking fallback chain landing.
- ≤ 5% of chunks below 100 tokens (sign of over-splitting).
- Chunk-length distribution reported (mean, median, p95) alongside percentile checks.
- Manual inspection of a seeded-RNG 20-chunk sample: two independent reviewers agree on ≥ 18/20 coherent under a documented "tells a complete-enough sub-topic" rubric.

**Cost and cadence:** ~50 model calls per Part B run; small. Run pre-release and on any PR that touches chunking, ingestion, or the embedding model.

**Tuning levers** if benchmarks miss criteria: adjust soft/hard cap, change boundary level (H2 vs H3), revisit cross-reference handling, add overlap between adjacent chunks.

**Precondition:** The labeled tutorial query set + chunking fallback chain (both tracked as separate issues).

### 4. LSP correctness (tracked separately)

A fourth benchmark covering the LSP subsystem against a curated GDScript fixture project is tracked as a follow-up issue. Covers cold-call vs steady-state behavior, auto-resync correctness on external edits, and the v1 symbol-based fallback.

### Benchmark harness

Benchmark scaffolding lives at `benchmarks/` at repo root, excluded from npm publish. Results written to `benchmarks/results/{benchmark}/{ISO-date}.json` so historical runs are diffable.

## Implementation phases

Suggested PR sequence:

1. **Refactor `src/index.ts` into modules.** No new features. Establishes the module structure described above.
2. **Rename existing tools** with `godot_` prefix. Mechanical change.
3. **Shared infrastructure** (env parsing, logging, telemetry setup, InitLatch primitive).
4. **Docs ingestion** (`docs/ingest.ts`, `version-manager.ts`, schema, build script, tarball SHA pinning). Verifiable via `npm run build:docs` producing a valid DB.
5. **Docs tools.** Six new tools registered, lookup against the DB.
6. **LSP client** (`lsp/client.ts`, `lsp/process.ts`, `lsp/documents.ts`, `lsp/adapter.ts`) standalone. Verifiable with manual integration tests.
7. **LSP tools (read-only).** Seven tools, including symbol-based fallback.
8. **LSP tools (advisory write).** One tool in v1 (`godot_preview_rename`).

Optional/follow-up: 9. **Auto-republish CI pipeline** (with security hardening). 10. **Per-server adapter expansion** — initial inhabitants populate during implementation; v1.1 extends as new quirks surface. 11. **`godot_code_actions` + `godot_preview_code_action`** — reopens when godot-proposals#14307 lands.

## Future work

- **Godot 3.x support.** Would require a separate parser path for the older XML schema. Assess demand before investing.
- **Pagination on `godot_search_api`.** Currently capped at limit param; cursor-based pagination if needed.
- **Auto-republish on Godot release.** See Distribution section.
- **`godot_code_actions` + `godot_preview_code_action`.** Blocked on Godot's LSP implementing `codeActionProvider` (godot-proposals#14307).
- **`godot_get_workspace_diagnostics`.** Cross-file diagnostic queries. YAGNI for v1.
- **Multi-project / multi-root workspaces.** Single root only in v1.
- **Attach to user's existing Godot editor LSP** as an opt-in mode (`GODOT_LSP_ATTACH_TO_PORT` env var). Viable since Godot's LSP supports up to 8 concurrent clients; deferred for v1 default to keep "user may not have the editor open" working.
- **`GODOT_LSP_MAX_FILE_KB`.** Add if real-world usage exposes memory issues.

## Research items for implementation

Items to investigate during v1 implementation rather than at design time. The Wave 2 review desk-resolved several; the remaining items are integration-test-shaped.

- **Godot LSP response for built-in symbol definitions.** Does `godot_find_definition` on `Node.add_child` return a synthetic URI? A real engine source path? Nothing? Characterize before deciding whether the adapter's built-in-URI redirect uses `gdscript://` scheme matching or a fs-readability heuristic.
- **FTS5 tokenizer choice and BM25 weights.** Baseline values committed in this document; final tuning runs against benchmark #3's labeled set.

(Resolved in Wave 2: Godot LSP supports up to 8 concurrent clients; Godot LSP has no internal file watcher and auto-resync is required; project-level concurrency is mediated by port scan; capability list documented; Drizzle dropped for `better-sqlite3` direct.)

## Edge cases and known limitations

Worth flagging in user-facing documentation:

- **Mid-life server crashes are reported differently per MCP client.** Some show stderr; some just say "disconnected." Acceptable limitation.
- **MCP crash leaks headless Godot.** Exit handlers cover normal shutdown; SIGKILL/OOM leaks one process. User cleans up manually.
- **Memory footprint with all subsystems active is several hundred MB to ~1GB** (docs DB, embedding model, Godot headless). Documented for user awareness, not treated as a design constraint.
- **SQLite over networked filesystems (NFS, SMB) is rejected at startup.** The cache directory is validated against known network filesystem types and the server refuses to operate if the cache dir is on one. Set `XDG_CACHE_HOME` to a local directory.
- **Cache disk full during ingestion** produces a clear error message rather than a corrupted DB (atomic rename pattern).
- **Schema-version cache pollution.** Old DBs from previous package versions accumulate. Run `npm run docs:clean` to prune.
- **Switching `GODOT_DOCS_VERSION` between values accumulates cache files.** Same cleanup tool.
- **`stable` (bundled DB version) and Godot's current stable may diverge.** Bundled DB is pinned to whatever shipped with the package. Use `GODOT_DOCS_VERSION=latest` to track Godot's actual current stable.
- **First LSP tool call cold-start is 10–20s** on a fresh project. Set `GODOT_LSP_EAGER_INIT=true` to hide the cost behind server startup instead.
- **Concurrent MCP sessions on the same project work fine.** The upward port scan from `GODOT_LSP_PORT=6005` finds the next available port; Godot supports up to 8 concurrent LSP clients (though we spawn isolated processes regardless). The prior caution about "two MCP instances may fail to spawn the second Godot LSP" has been retracted.

## Appendix: changes from upstream fork

This fork makes the following changes to `Coding-Solo/godot-mcp`:

1. Refactor single-file `src/index.ts` into a module structure.
2. Rename 14 existing tools to use the `godot_` prefix. One tool (`get_godot_version` → `godot_get_version`) drops a redundant naming element.
3. Add docs subsystem: 6 new tools, bundled DB, ingestion pipeline, version management.
4. Add LSP subsystem: 8 new tools in v1 (10 planned), headless Godot process management, LSP client with per-server adapter.
5. Use `better-sqlite3` directly for the new SQLite-backed docs storage.
6. Add OpenTelemetry instrumentation with local-only trace storage and documented PII posture.
7. Add `GODOT_MCP_LOG_LEVEL` for stderr verbosity control.

The fork does not currently plan to merge upstream. No deprecation path for the renames is required since the fork has no users.

## Appendix: 2026-05 design review (Wave 2)

The May 2026 multi-agent design review produced 76 findings across six review seats (systems architect, agent UX, LSP specialist, docs/retrieval specialist, supply-chain/security, benchmark). The full memos and synthesis with action mapping live at [`docs/reviews/2026-05-design-review/`](reviews/2026-05-design-review/).

Material changes from this revision (compact list; see synthesis for full traceability):

- **Tool surface narrowed** from 10 to 8 LSP tools in v1 (`godot_code_actions`, `godot_preview_code_action` deferred — Godot's LSP doesn't implement `codeActionProvider`).
- **`godot_get_member` → `godot_find_member`** rename (matches array-return semantics and the `find_*` family).
- **Symbol-based fallback promoted to v1** from v1.1 (agents give imprecise positions; cclsp's experience shows this is table-stakes).
- **Embedding model:** MiniLM-L6-v2 → BGE-small-en-v1.5 (512-token context vs 256, materially better MTEB retrieval).
- **Embedding model bundling:** dropped from npm tarball; download-on-first-use with SHA-pinned URL.
- **Drizzle ORM:** dropped; `better-sqlite3` direct (Drizzle doesn't support FTS5 / sqlite-vec anyway).
- **WAL mode:** dropped; `PRAGMA query_only = 1` on read.
- **Chunking:** explicit fallback chain (H2 → H3 → paragraph → token-window) for pages where H2 alone produces oversize chunks.
- **InitLatch primitive:** typed surface with state introspection, reset, in-flight rejection (was an unspecified "one-shot promise").
- **`process.exit(1)` on docs:** scoped to cold-startup only; runtime refetch fail = mark unavailable, server stays up.
- **Auto-resync:** mtime/size-shortcircuited; required for correctness (Godot LSP has no file watcher).
- **3-spawn-cycle cap:** resets on successful handshake; windowed via `GODOT_LSP_SPAWN_RESET_MINUTES`.
- **LSP request queue:** single-flight 10s → 2-priority 30s.
- **Diagnostic await:** flat 2s → tiered 10s first-touch / 2s steady-state.
- **Native dep matrix:** explicit; Alpine/musl and Windows-on-ARM declared unsupported in v1 (sqlite-vec prebuilds missing).
- **Tarball SHA pinning:** new `data/godot-release-hashes.json` manifest verified at ingest.
- **`prepublishOnly`:** decoupled from network; CI artifact build + publish-time validation.
- **Node version:** 24 → 22 (avoid blocking common distros' default Node).
- **Auto-republish:** concrete approval gate (canary → required-reviewer-gated promotion + npm Trusted Publishing).
- **Loopback-only LSP host:** dropped `GODOT_LSP_HOST` config.
- **OTel privacy posture:** documented trace schema; length-hashed query strings by default.
- **Telemetry env vars:** `GODOT_MCP_OFFLINE`, `GODOT_DOCS_DB_PATH`, `GODOT_MCP_MODEL_PATH`, `GODOT_MCP_TRACE_QUERIES`, `GITHUB_TOKEN`, `GODOT_DOCS_EAGER_INIT`, `GODOT_LSP_SPAWN_RESET_MINUTES`, `GODOT_LSP_DIAGNOSTIC_FIRST_MS`, `GODOT_LSP_DIAGNOSTIC_STEADY_MS` added.
- **Benchmarks gain concrete rubrics** (#31 paired t-test with +0.3 delta; #32 page-anchor ground truth) and **dataset-curation issues** filed as preconditions.
- **`godot_search_api` empty-no-filter:** error → `{results: [], hint}`.
- **Hover truncation:** char-cut → markdown-fence-aware.
- **Advisory-write response:** `rename`-specific → generalized `action: {kind, ...}` envelope; `before` widening; same-line edit merge.
- **Per-server adapter:** four known inhabitants enumerated (workspace/symbol shim, hover format normalization, built-in URI redirect, autoload-references grep fallback).

Six new tracking issues were filed for follow-up work surfaced by the review: tool-description drafting, GDScript task-set curation, tutorial query-set curation, native-dep matrix + preflight, offline mode, LSP correctness benchmark, chunking A/B report, tarball SHA manifest. Five research items resolved via desk research and closed; two updated with partial answers + integration-test plans.
