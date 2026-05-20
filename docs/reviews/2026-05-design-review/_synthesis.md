# Wave 2 — Synthesis & decisions

Six memos, 76 findings (21 high / 41 medium / 14 low). Cross-reviewer convergence is strong on the structural calls. Where they conflict, I'm resolving here so Wave 3 can execute mechanically.

## Cross-cutting decisions

| # | Decision | Source(s) | Rationale |
|---|----------|-----------|-----------|
| D1 | `godot_code_actions` (#28) and `godot_preview_code_action` (#29) → **close as blocked-upstream**; drop from v1 LSP write epic. | LSP H2 | Godot LSP does not advertise `codeActionProvider`; godot-proposals#14307 still open. Tool surface drops from 10→8 LSP tools. |
| D2 | `godot_get_member` → **rename to `godot_find_member`**. | UX M6 | Singular name contradicts array-return when `kind` unspecified; matches `find_definition`/`find_references` family. |
| D3 | Symbol-based fallback (#12) → **promote v1.1 → v1**; accept `symbol_name` alt-param on `find_definition`/`find_references`/`hover`. | LSP M8 | cclsp's `findSymbolsByName` is ~80 lines; agents give imprecise positions; in v1 even a `workspace/symbol`-backed stub helps. |
| D4 | Embedding model → **switch to BGE-small-en-v1.5** (was MiniLM-L6-v2). | Docs M3 | Same dims (384), same family of ONNX-compatible, 512-token context (vs 256), materially better MTEB retrieval; MIT license. |
| D5 | Embedding model bundling → **download-on-first-use** (was: bundle in npm tarball). | Docs M4 + Supply M5 | Drops package ~150→~70 MB; aligned with the docs `latest` runtime-fetch posture. SHA-pin the model URL. |
| D6 | WAL mode → **drop**; use `PRAGMA query_only=1` on the read-only bundled DB. | Docs M7 | WAL has no benefit on a read-only post-ingestion DB; eliminates `-wal`/`-shm` siblings; `query_only` is a stronger correctness guarantee. |
| D7 | Drizzle ORM → **drop**; default to `better-sqlite3` direct. | Docs M5 | Drizzle 1.0 still RC; doesn't support FTS5/sqlite-vec anyway; only 3 normal tables, fallback path is approximately the same code. Removes a moving target. |
| D8 | Latch primitive → **define real surface** (state introspection, reset, in-flight rejection). | Sys M4 | Otherwise it's just `Promise<void>` and the "latch pattern" callout is ceremony. LSP genuinely needs the state surface (`unavailable`, respawn-clears). |
| D9 | Position handling → **keep 1-based on wire**, move convention note from first sentence to parameter doc, add explicit warning in every position-taking tool. | UX H3 | Editor convention rationale is real; competing pressure is "don't crowd routing signal". The fix is structural — parameter docs, not description sentences. |
| D10 | `process.exit(1)` on docs → **scope to cold-startup only**. Runtime refetch fail = mark unavailable, MCP error, server stays up. | Sys H1 | Current wording breaks cross-subsystem-independence claim for runtime refetches (latest TTL re-fetch hours into a session). |
| D11 | Auto-resync → **narrow to mtime/size short-circuit + tracked-file scope**. | Sys H3 + LSP H3 + LSP-research#37 | Per protocol-source research, Godot LSP has no file watcher → resync is required for correctness; but current "read content and compare every file every query" is pathological. |
| D12 | 3-spawn-cycle cap → **reset on successful handshake**, add window env var (`GODOT_LSP_SPAWN_RESET_MINUTES`), document MCP-restart remediation. | Sys H2 + LSP M7 | Workday-long sessions can't recover from a single transient port collision under the current rule. |
| D13 | Native-dep matrix → **be explicit**; `sqlite-vec` has no Windows-ARM64 and no musl prebuilds; document and gate via `postinstall` preflight. | Supply H2 | Current "All three have prebuilds for x64/arm64 Linux/macOS/Windows" claim is false. |
| D14 | Tarball integrity → **SHA-pin via `data/godot-release-hashes.json`**; record observed hash in DB meta for runtime fetches. | Supply H1 | Git tags are mutable; structural validation catches truncation but not malicious content. |
| D15 | `prepublishOnly` docs build → **separate CI artifact build from publish**; publish step validates artifact, does no network work. | Sys M7 + Supply H4 | Couples publish atomicity to GitHub network availability today. |
| D16 | Auto-republish (#11) approval → **specify mechanism**: canary dist-tag, GH Environment with required reviewers, SHA-pinned actions, npm Trusted Publishing, ingestion verifies updated hash manifest. | Supply H3 | "Manual approval step" is hand-waved; needs concrete gate. |
| D17 | Node version → **soften to Node 22 LTS** unless 23+ API is load-bearing. | Supply M9 | Node 22 EOL is 2026-05-13; many Linux distros still default to ≤22; current floor blocks real users. |
| D18 | `GODOT_LSP_EAGER_INIT` → **recommend `true`** in docs (default stays `false` for compatibility) given 10–20s cold-start. | LSP M11 | Lazy default optimizes for the rare case (LSP unused); first-call timeout is the common case. |
| D19 | Drop `GODOT_LSP_HOST` config; hardcode loopback. | LSP L14 | LSP has no auth; non-loopback bind is security footgun for WSL/devcontainer users. |
| D20 | Add `GODOT_MCP_OFFLINE=1` config + offline-install path. | Supply M6 | Corporate networks ban runtime fetches; current "user accepts" is a silent failure. |
| D21 | Add optional `GITHUB_TOKEN` config for tags API. | Docs L14 + Supply M7 | 60/hr unauth limit is fragile under NAT and CI shared IPs. |
| D22 | Add `GODOT_DOCS_EAGER_INIT` config for background model preload. | Docs L11 | Aligns with `GODOT_LSP_EAGER_INIT` pattern; hides 2–4s ONNX cold-start. |
| D23 | OTel traces → document schema; default to length-hashing query strings; gate verbatim with `GODOT_MCP_TRACE_QUERIES=1`. | Supply M8 | Local trace files end up in support bundles; file paths and query strings are PII vectors. |
| D24 | LSP stderr passthrough → gate Godot subprocess output by log level. | Supply L13 | Default `info` only forwards Godot warn/error; `debug` forwards everything (may leak source content). |
| D25 | Drop `code_action` from advisory-write canonical shape generalization; rename top-level `rename` field → `action: {kind, ...}` for forward compatibility with future code-action tools. | UX L11 | Even though code-action tools drop in v1 (D1), the shape should generalize for v1.1 reintroduction. |
| D26 | `godot_search_api` empty-query-no-filters → return `{results: [], hint}` not MCP error. | UX M5 | Cleaner agent recovery; reserves errors for invalid args. |
| D27 | LSP timeout default 10s → **30s**; introduce 2-priority queue (`hover`/`signatureHelp`/`documentSymbol` jump `references`/`workspaceSymbol`/`rename`). | LSP M6 | cclsp uses 30s; head-of-line blocking degrades interactive feel. |
| D28 | Per-server adapter (#13) → **enumerate 4 known initial inhabitants** in body. | LSP M8 | workspace/symbol-empty, hover-format, built-in-URIs, autoload-references. |
| D29 | Diagnostic `publishDiagnostics` await → **10s first-touch / 2s steady-state**. | LSP H4 | First-compile cold-start is documented at 10–20s in opencode-godot-lsp's own README. |
| D30 | Hover truncation → **markdown-fence-aware**; add `truncated: true` flag. | UX M9 | Cutting mid-fence corrupts agent rendering + downstream regex. |
| D31 | `workspace_symbols` → explicit "substring, case-insensitive; no fuzzy matching" caveat in description. | UX M10 | Godot's LSP doesn't implement workspace/symbol well anyway (see also D28 adapter list). |
| D32 | Advisory-write `before` strings → MCP widens to unique within file; supports same-line non-overlapping edits via merge-on-line. | UX M7 + LSP H5 | `str_replace` requires uniqueness; per-line model breaks on `old(old())` rename. |
| D33 | "Zero results → empty array" promoted to a single top-level rule for all 7 LSP read tools. | UX M4 | Currently inconsistent across sub-issues. |
| D34 | Cache-dir filesystem check → **fail fast on known network FS** (NFS/SMB/CIFS); WAL drop (D6) already removes the worst-case corruption mode. | Supply M8 | Stricter than "user reads edge-cases doc". |
| D35 | Lock file → use OS-level advisory locking (`flock`/`LockFileEx`); PID+mtime is fragile especially on Windows PID-reuse. | Sys M6 + Supply L12 | Heartbeat + atomic create + nonce verification as defense-in-depth. |

## Research items — resolution status

| # | Status | Resolution |
|---|--------|------------|
| #33 (concurrent project access) | **CLOSE** — resolved | No project-level lockfile; port-level contention only, handled by upward port scan. Retract edge-case warning. |
| #34 (built-in symbol defs) | **UPDATE body** — needs real Godot | Document desk-research findings; defer to LSP-tool integration testing. Add Output/Done-when. |
| #35 (capability advertisement) | **CLOSE** — resolved | Documented full capability list from protocol source. Confirms `codeActionProvider` absent (drives D1). |
| #36 (single-client behavior) | **CLOSE** — resolved | Up to 8 concurrent clients (`LSP_MAX_CLIENTS = 8`). Future-work "attach to user's editor" promoted to viable path. |
| #37 (file watcher behavior) | **CLOSE** — resolved | No internal file watcher; auto-resync required. Drives D11. |
| #38 (Drizzle/schema) | **CLOSE** — resolved via D7 | Drizzle dropped; remaining table-layout work belongs in #6's PR not as research. |
| #39 (FTS5/BM25) | **UPDATE body** — partial | Starting BM25 weights and tokenizer choices committed; tuning belongs in benchmark #32. |

## New issues to create

| Slug | Title | Blocks | Priority |
|------|-------|--------|----------|
| N1 | Draft canonical tool descriptions for all 14 godot_* tools | #30 routing benchmark, #7/#9 epics | High |
| N2 | Curate ~50–80 GDScript task/ground-truth set for benchmark #31 | #31 | High |
| N3 | Curate ~50 tutorial query/answer set for benchmark #32 | #32 | High |
| N4 | Native-dep platform matrix + `postinstall` preflight | v1 release | High |
| N5 | `GODOT_MCP_OFFLINE` mode + pre-built DB override | v1 release | Med |
| N6 | LSP correctness benchmark | v1 release | Med |
| N7 | Chunking-config A/B comparison report | post-#31, post-#32 | Low |
| N8 | Tarball SHA pinning + `data/godot-release-hashes.json` manifest | #6 | High |

## Issue body edits — summary

| Issue | Edit |
|-------|------|
| #5 | Add latch acceptance criteria for D8 (states, reset, in-flight rejection). |
| #6 | Add D14 (SHA pinning), D11 (mtime-shortcut auto-resync), D15 (separate CI build from publish). |
| #8 | Apply D11 (auto-resync), D12 (cap reset), D27 (timeout 30s + priority), D29 (10s/2s diagnostic), D18 (eager_init recommendation), correct single-client premise per #36 resolution. |
| #10 | Apply D1 (drop code-action tools), D25 (generalize `action` field), D32 (`before` widening + same-line edits). |
| #12 | Promote from follow-up to v1 (D3). Update title, remove `follow-up` label. |
| #13 | Apply D28 (enumerate 4 known quirks). |
| #14 | Apply D26 (empty-query-no-filter returns hint, not error). |
| #16 | Rename to `godot_find_member` (D2). |
| #19 | Add 3 meta fields per Docs L12 (embedding_model_id, ingestion_source_sha, ingestion_duration_ms). |
| #22 | Apply D30 (markdown-aware truncation). |
| #24 | Apply D31 (explicit substring caveat). |
| #25 | Apply D29 (10s first-touch / 2s steady-state). |
| #26 | Apply LSP L12 (`.new()` quirks warning). |
| #11 | Apply D16 (specify approval gate). |
| #32 | Apply Benchmark H3 (ground truth = page/anchor not chunk-id), M7 (inspector role+rubric), M9 (split Part C → N7). |
| #33-#39 | Add `**Output:**` and `**Done when:**` sections (Benchmark M10). #33/#35/#36/#37/#38 also close. |

## DESIGN.md amendments — section-by-section

Detailed in execution. High-level: every D-decision lands as a targeted edit in the relevant § with a brief rationale. Final section `## Appendix: 2026-05 design review amendments` lists every change with a memo citation.

## Tools closed as blocked-upstream

- #28 `godot_code_actions` (godot-proposals#14307 not implemented)
- #29 `godot_preview_code_action` (same)

Both stay in the repo's tracking for v1.1 reintroduction once upstream lands; closed with "blocked-upstream" comment.

## What stays unchanged (deliberately)

- Single TCP connection per MCP session — LSP M6 introduces priority queue but doesn't fan out connections.
- `vscode-jsonrpc` choice — pure JS, no native deps, fine.
- Tutorial chunking caps (1500 soft / 3000 hard) — Docs H2 narrows the embedding window, not the storage cap.
- `dispatch.ts` exists, but DESIGN.md gains language that gives it real cross-cutting responsibilities (OTel span wrapping, error normalization, schema validation) — Sys M9 resolved by making the abstraction load-bearing rather than dropping it.
- Goals/Non-goals — no changes.

## Out of scope for this review

- Tool-routing benchmark dataset construction itself (covered by N2/N3).
- Implementation-time refactor of the existing fork's `executeOperation()` for path-traversal hardening (Supply OQ4) — separate hygiene item, not in this scope.
- Author/identity in `package.json` (Supply OQ5) — admin task, not a design decision.
