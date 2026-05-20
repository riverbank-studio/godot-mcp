# Supply chain / distribution / security review

Seat: supply chain + distribution + security. Reviewed `docs/DESIGN.md`, `package.json`, `scripts/build.js`, issues #6 and #11, and external dependency/platform docs. No state mutated.

## Findings

- **[severity: high]** **[scope: design]** **Tarball downloads are not integrity-checked.** §"Documentation subsystem → Ingestion pipeline" fetches `https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/{tag}` (step 2) and the same for `godot-docs`, with retries and structural validation but no SHA pin. Git tags are mutable in principle and `codeload` archives are not signed; a compromised or moved tag silently flows through to bundled DBs and every user-triggered ingestion. The design's "structural validation" (file count ≥ 500, `Object.xml` parses) catches truncation, not malicious content.
  _Recommended action:_ edit `docs/DESIGN.md` § Ingestion pipeline — add a step between (2) and (3): compute SHA-256 of the downloaded tarball and compare against an in-tree manifest `data/godot-release-hashes.json` keyed by tag. For `latest`/runtime fetches where no pinned hash exists, at minimum record the observed hash in the `meta` row of the resulting DB so a downstream compromise is detectable. Also consider verifying GitHub's release attestation (available for `actions/attest-build-provenance`–signed releases) when present.

- **[severity: high]** **[scope: design]** **Native dependency matrix is overstated; sqlite-vec has known gaps.** §"Native dependencies" claims "All three have prebuilds for x64/arm64 Linux/macOS/Windows." Ground truth from the latest releases:
  - `better-sqlite3` v12.10.0 ships node-vXXX prebuilds for darwin-arm64/x64, linux-x64/arm/arm64, **linuxmusl-x64/arm/arm64**, and **win32-arm64/x64**. Good.
  - `sqlite-vec` v0.1.9 ships loadables for linux x86_64/aarch64, macOS x86_64/aarch64, windows x86_64. **No Windows ARM64**, **no linux-musl**. PR #271 (Windows ARM64) and PR #199 (musl) are open and unmerged. Issues #271, #222, #73, #199, #248 all track the same gaps.
  - `@xenova/transformers` is unmaintained-adjacent (the maintained successor is `@huggingface/transformers`); ONNX Runtime prebuilds via `onnxruntime-node` skip linuxmusl and may skip win32-arm64 depending on version.
    This means Alpine/musl users (a non-trivial slice of MCP server deployments — official Node Alpine images are very common in containers) and ARM64 Windows users will hit `npm install` failures with no source-build fallback for sqlite-vec on Windows ARM64 (no MSVC ARM64 toolchain check in DESIGN).
    _Recommended action:_ edit `docs/DESIGN.md` § Native dependencies — replace the one-line claim with a real matrix table (rows: OS×arch×libc, cells: per-dep prebuild availability). Add an explicit "Unsupported platforms" subsection naming Alpine/musl and Windows ARM64. Decide and document the fallback: refuse to install with a clear preflight check (`postinstall` script), or ship Docker as the supported install path for Alpine. Open a follow-up issue separate from #6 to track the matrix.

- **[severity: high]** **[scope: issue:#11]** **Auto-republish "manual approval step" is hand-waved.** Issue #11 lists "manual approval step" as a bullet under supply-chain risk but doesn't specify the mechanism. Without specifics, this becomes "click Approve to publish whatever Godot just released" — which is the supply-chain vulnerability, not the mitigation.
  _Recommended action:_ edit issue #11 body — specify concretely: (a) workflow runs on Godot release webhook or scheduled poll, (b) builds + tests in an isolated runner, (c) publishes only to a staging dist-tag (`npm publish --tag canary`) via `npm publish --provenance` using GitHub Actions OIDC trusted publishing, (d) promotion from `canary` to `latest` requires a human-driven workflow_dispatch gated by a GitHub Environment with required reviewers, (e) all third-party Actions pinned to SHA, not `@v3`/`@main`, (f) ingestion verifies the new Godot tag's SHA against an updated `data/godot-release-hashes.json` before building. Also add a hard rule: "Bundled docs DB shall never be republished without rebuilding from a hash-pinned source."

- **[severity: high]** **[scope: design]** **`prepublishOnly` running a full docs build at publish time is fragile.** §"Distribution and release → Bundled docs DB" says the DB "is regenerated in CI before publish via a `prepublishOnly` script." `prepublishOnly` runs on the publisher's machine when invoked by `npm publish`; if it requires network and the GitHub Tags API or codeload is rate-limited, slow, or down, `npm publish` fails partway through. Worse, `prepublishOnly` runs _before_ the tarball is built, so a partial DB write into `data/` between a failure and a retry can corrupt the next attempt. And if `prepublishOnly` ever runs accidentally on `npm install` of a future consumer (it doesn't, by design, but `prepare` is in the current `package.json`), runtime fetches become install-time fetches.
  _Recommended action:_ edit `docs/DESIGN.md` § Distribution — clarify that docs DB build is a CI workflow step that commits/uploads `data/docs-stable.db` as a release artifact and the publish step is a _separate_ job that reuses the artifact. The `prepublishOnly` script should verify the artifact exists and exit clean, not perform any network work. Document this as a hard invariant. Reuses §"Ingestion pipeline" with the CI threshold of 0, but moves it out of the publish boundary.

- **[severity: medium]** **[scope: design]** **150MB npm package is ~30× a typical MCP server and will hurt cold-start UX.** §"Distribution and release → Embedding model" states package size ~150MB with no mitigation other than "README will note install size." Typical MCP servers are <5MB; a cold `npx -y godot-mcp` invocation on a fresh runner (the default install pattern for MCP clients) will download ~150MB before the first tool call is answered, which can be 30–90s on consumer connections. This is the install-time impact for _every_ user, not just power users who set `GODOT_DOCS_VERSION=latest`.
  _Recommended action:_ edit `docs/DESIGN.md` § Embedding model — adopt download-on-first-use for the embedding model as the default, with `GODOT_MCP_BUNDLE_MODEL=1` for offline-install users. Move the model out of the npm tarball and into a `postinstall` fetch (with a SHA-pinned URL, see finding above). Document the cold-start cost (one-time ~80MB download + ~1s model load) explicitly. Bundled DB stays in tarball; model does not. Result: tarball drops to ~70MB.

- **[severity: medium]** **[scope: design]** **No offline-only install path documented for orgs that ban runtime fetches.** §"Documentation subsystem" has runtime fetcher for non-`stable` versions and §"Logging and telemetry" implies network calls during normal operation if `latest` is in play. Corporate environments commonly block egress to GitHub or proxy it with TLS-intercepting middleboxes that `codeload.github.com` may not negotiate cleanly. The design lists "user accepts failure modes" but offers no escape hatch.
  _Recommended action:_ edit `docs/DESIGN.md` § Configuration — add `GODOT_MCP_OFFLINE=1` that disables all runtime network calls (rejects `GODOT_DOCS_VERSION=latest` and non-bundled `X.Y` with a clear error pointing at the offline install path). Add §"Offline installation" subsection: how to pre-warm the cache dir from an air-gapped machine, where to drop a pre-built DB, the schema-version contract for offline DBs.

- **[severity: medium]** **[scope: design]** **GitHub Tags API at 60/hr unauthenticated is fragile under NAT.** §"Documentation subsystem → Version resolution" (step 4) uses the GitHub Tags API for `latest` resolution. Unauthenticated rate limit is 60 req/hr per IP (confirmed via GitHub docs). Behind a corporate NAT, dozens of MCP sessions share one outbound IP and the limit is consumed quickly. CI runners on shared cloud IPs (GitHub Actions runners have a small pool of source IPs as far as the upstream API can tell) are also vulnerable.
  _Recommended action:_ edit `docs/DESIGN.md` § Version resolution — document an optional `GITHUB_TOKEN` env var that, when set, is passed as `Authorization: Bearer` for tag lookups (boosts to 5,000/hr). Mention that `GITHUB_TOKEN` is auto-provided in GitHub Actions runs. Also: extend the 1-hour TTL to 24 hours when running in CI (detect via `process.env.CI`), since CI sees `latest` change at most weekly.

- **[severity: medium]** **[scope: design]** **Telemetry trace contents are not documented; PII risk is unspecified.** §"Logging and telemetry → OTel telemetry" lists span categories (ingestion stages, LSP spawn duration, query latency, cache hit/miss) but not the attribute keys. Two leak vectors stand out: LSP spans almost certainly carry file URIs and position info (which include local absolute paths, possibly including usernames on macOS/Linux), and docs query spans may carry the full query string verbatim (which can include code snippets the user typed). Even with "no phone-home," local trace files end up in support bundles, cloud-synced home directories, and crash reports.
  _Recommended action:_ edit `docs/DESIGN.md` § OTel telemetry — add an explicit "Trace contents" subsection listing every attribute recorded per span. State that file paths are stored relative to the project root (never absolute), that query strings are length-hashed (not stored verbatim) by default, with `GODOT_MCP_TRACE_QUERIES=1` opting into verbatim capture for debugging. Add `XDG_DATA_HOME/godot-mcp/traces/README.md` in the trace dir explaining what's in there. (This is also a docs item, but the design owes the user-facing privacy promise.)

- **[severity: medium]** **[scope: design]** **WAL mode + SQLite on networked filesystems is flagged but not enforced.** §"Storage → Schema overview" says "WAL mode enabled" and §"Edge cases" notes "SQLite over networked filesystems (NFS, SMB) is unreliable. If the cache directory is on networked storage, set `XDG_CACHE_HOME` to a local directory." This relies on the user reading edge-cases doc. WAL specifically is _worse_ over NFS/SMB than rollback-journal mode — corruption rather than slow operation.
  _Recommended action:_ edit `docs/DESIGN.md` § Storage — add a startup check: detect the cache dir's filesystem (e.g. on Linux read `/proc/mounts`, on macOS check `getmntinfo`, on Windows `GetDriveType`); if it's a known network type (NFS, CIFS/SMB, AFS, GPFS, or Windows `DRIVE_REMOTE`), fail fast with a clear error directing the user to `XDG_CACHE_HOME`. Better to refuse than risk silent DB corruption.

- **[severity: medium]** **[scope: design]** **Node 24 floor will block a real population of users today.** §"Node version" says "Node 24 is the current active LTS line at time of writing." That's correct as of May 2026, but Node 22 (`Jod`) only reaches EOL on 2026-05-13 — and many distros (Debian stable, Ubuntu LTS pre-26.04, ChromeOS, corporate-managed Node Version Managers defaulting to "lts/iron" or "lts/jod") ship 20 or 22 by default. MCP servers run wherever the user's coding agent runs; the agent doesn't dictate Node version. A Node 24 floor without a fallback path will manifest as `engines` warnings (npm 9+ doesn't enforce by default but `engines-strict=true` config does) and outright failures with `npm ci`.
  _Recommended action:_ edit `docs/DESIGN.md` § Node version — soften to Node 22 LTS minimum if the implementation doesn't actually require a Node 24 API. Audit which Node 23+ features are load-bearing; document each. If 24 is genuinely required, add a `preinstall` script that prints a clear "this package requires Node 24+" message with the upgrade command for popular Node managers.

- **[severity: low]** **[scope: design]** **No supply-chain protection on the npm publish path itself.** Beyond the auto-republish issue, the manual publish path is currently `npm publish` with whatever the maintainer's local `~/.npmrc` token provides. A leaked token republishes a malicious version under the same name.
  _Recommended action:_ edit `docs/DESIGN.md` § Distribution — adopt npm Trusted Publishing (GitHub Actions OIDC, `npm publish --provenance`) for v1 manual releases too, not just future auto-republish. Provenance is free for public packages and gives end users a verifiable build trail (signed by Sigstore). Add a CI workflow `release.yml` triggered by tag push; the maintainer's local machine should never publish directly.

- **[severity: low]** **[scope: design]** **Lock-file PID reuse on Windows is a stale-lock hazard.** §"Concurrency" — "Find lock → check if PID alive AND mtime within 5 minutes → if yes, wait up to 60s for lock release, else reclaim." On Windows, PID recycling happens fast (PIDs are small integers, kernel reuses aggressively); the "PID alive" check can return a _different_ process that happens to inherit the same PID. The 5-minute mtime guard mostly papers over this, but a worst-case interleaving lets two MCP instances both believe they own the lock.
  _Recommended action:_ edit `docs/DESIGN.md` § Concurrency — store a startup nonce (random UUID, written by the lock holder on acquire) and verify it after acquire by re-reading the lock file. On Linux/macOS, prefer `flock`/`fcntl` advisory locks (atomic, kernel-managed, auto-released on process death) over PID/mtime heuristics. On Windows, prefer `LockFileEx`. Lock-file content stays advisory/diagnostic.

- **[severity: low]** **[scope: design]** **`stdout`/`stderr` of headless Godot piped to MCP's stderr risks PII leak.** §"LSP subsystem → Process management → stdout/stderr" says "Pipe to MCP's stderr with a `[godot]` prefix." Godot's LSP logs include file paths and may log full source-line content from `didChange` payloads. These flow into stderr, which MCP clients commonly persist in client logs that get attached to bug reports.
  _Recommended action:_ edit `docs/DESIGN.md` § stdout/stderr — gate Godot's subprocess output behind `GODOT_MCP_LOG_LEVEL` such that `info` (default) only forwards warnings/errors from Godot, and `debug` forwards everything. Document that the `debug` level can leak user source content to the agent's transcript.

## Threat model sketch

**Trust roots (what we delegate trust to)**

- npm registry: signs and serves the godot-mcp tarball. If compromised, every user is compromised.
- GitHub release tags `godotengine/godot`, `godotengine/godot-docs`: source of truth for docs content. If a tag is force-pushed or the account is compromised, our bundled DB and runtime fetches carry the payload.
- The maintainer's npm publish credential (currently: local token; should be: GitHub Actions OIDC).
- Native dep maintainers: `WiseLibs/better-sqlite3`, `asg017/sqlite-vec`, `xenova/transformers`. Their prebuild binaries execute in the user's process with full filesystem access.
- The bundled embedding model (Xenova/all-MiniLM-L6-v2 on HuggingFace): if the model files are tampered, retrieval is silently corrupted (low impact: retrieval quality, not arbitrary code execution).
- The Godot binary the user points `GODOT_PATH` at: arbitrary code execution by design. We don't and can't verify it.
- The user's `XDG_CACHE_HOME`/`XDG_DATA_HOME` filesystem: trace files and cached DBs land here.

**Attack surfaces**

- `npm install godot-mcp`: download + prebuild matrix. Prebuilds are downloaded over HTTPS but the binaries are not signed by us.
- Runtime fetch from `codeload.github.com` (when `GODOT_DOCS_VERSION` is `latest` or `X.Y`): unauthenticated GET, no hash pin.
- Runtime fetch from GitHub Tags API (`latest` resolution): unauthenticated, rate-limited per IP.
- `prepublishOnly` running on the publisher's machine at `npm publish`: pulls live tarballs into a publish artifact.
- LSP subprocess: arbitrary Godot binary, full FS access, listens on localhost TCP. If host firewall is misconfigured, the Godot LSP port could be reachable.
- Trace files: persistent local writes containing query/path data.
- Stderr passthrough from headless Godot: source content leakage into logs.

**Mitigations present in design**

- Sparse-extract `doc/classes/` only (limits blast radius of a hostile tarball).
- Structural validation (catches truncation/format anomalies).
- Atomic SQLite write (`.tmp` + rename) — no corruption on cache-full.
- LSP-tools validate paths within project root (limits cross-project file reads).
- Process isolation per MCP session (headless Godot, no shared state).
- OTel local-only ("no phone-home" stated explicitly).
- LSP writes are advisory (agent applies via own edit tools, preserving checkpoints).
- 4xx don't retry (limits runaway fetches on user typos).

**Gaps (this is where the findings above land)**

- No tarball SHA pinning.
- No npm provenance / Trusted Publishing.
- No documented platform matrix; Alpine/musl and Windows ARM64 silently broken.
- No offline-install path for restricted networks.
- No documented trace-content schema; verbatim paths/queries plausible.
- No filesystem-type check for the cache dir.
- Stderr passthrough of headless Godot can leak source content.
- Lock file uses PID+mtime, not OS-level advisory locking.
- `prepublishOnly` couples publish atomicity to network availability.
- Manual publish path not pinned to a CI workflow.

## Open questions

- Does the maintainer want to support Alpine/musl in v1, or is the official-Node-Alpine container audience explicitly out of scope? The answer drives whether we need to wait on `sqlite-vec` PRs #199/#271 or ship a `postinstall` preflight that refuses to install on unsupported platforms.
- Is the docs DB regenerated _exactly_ during `prepublishOnly`, or does CI build it earlier and `prepublishOnly` just validate? The design wording is ambiguous (says "regenerated in CI before publish via a `prepublishOnly` script") — these are different invariants with very different failure modes.
- Where does the embedding model live in the tarball if bundled — under `node_modules/@xenova/transformers/` (auto-managed) or in a `data/models/` dir we copy at install time? The choice affects whether `npm dedupe` or `npm ci --omit=dev` removes it.
- Does the existing fork's `executeOperation(...)` path also validate user-controlled paths (project path, file paths into GDScript ops) for path traversal? This is upstream-fork hygiene that's not in DESIGN's scope but is part of the same threat model since the new tools coexist with the old.
- Is there an upstream-fork concern about identity? `package.json` still says `author: Solomon Elias` and points to `Coding-Solo/godot-mcp` for bugs/homepage. If the riverbank-studio fork publishes to npm under a new name, fine; if it publishes over `godot-mcp` (the unscoped name currently in `package.json`), that's a name-squat conflict and should be flagged.

## Out of scope

- **Tool description routing accuracy and disambiguation of `godot_search_api` vs `godot_search_tutorials`** → Agent-UX seat.
- **The latch primitive's semantics, who waits on it, error propagation between docs/LSP init failures** → Systems architect seat.
- **Whether `vscode-jsonrpc` is the right LSP-client library, how Godot's TCP-only LSP single-client constraint interacts with port scanning** → LSP specialist seat.
- **Whether MiniLM-L6 is the right embedding model for Godot tutorial retrieval; chunking strategy quality** → Docs specialist seat.
- **Whether the 80%/50%/70% benchmark thresholds in §"Testing and benchmarks → 3. Chunking quality" are measurable and achievable** → Benchmark seat.
- **Whether `process.exit(1)` on docs init failure vs LSP soft-fail is the right asymmetry** → Systems architect seat (mentioned only because it intersects with the "150MB tarball, first-run network fetch" UX, but the decision itself is architectural).
