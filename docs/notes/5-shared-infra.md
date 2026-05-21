# Shared infrastructure notes for #5

Implementation notes for [`docs/DESIGN.md` § Architecture → Shared infrastructure](../DESIGN.md#shared-infrastructure)
and [§ Logging and telemetry](../DESIGN.md#logging-and-telemetry). Recorded so the
public surface of these modules — which every Wave 3+ subsystem consumes — is
not litigated again in review.

## Decision 1 — Where the latch primitive lives

### Alternative A — `src/shared/sync/latch.ts`

Group concurrency primitives under a `sync/` subfolder in case future primitives
appear (e.g. a single-flight gate, a rate limiter).

- **Pro:** room to grow.
- **Con:** premature; one primitive does not justify a folder. DESIGN.md L199
  explicitly says `src/shared/latch.ts`.

Rejected.

### Alternative B — `src/shared/latch.ts` (chosen)

Flat file directly under `src/shared/`.

- Matches DESIGN.md L199 verbatim, which downstream subsystems will import
  against.
- If a sibling primitive ever appears, promoting to `sync/` is a one-commit
  move that updates imports mechanically.

## Decision 2 — Telemetry shape

### Alternative A — full `@opentelemetry/sdk-node` SDK + auto-instrumentation

Ship the canonical OTel SDK with `BatchSpanProcessor` and a file-exporter.

- **Pro:** standard semantics; `OTEL_SDK_DISABLED` is honored by the SDK
  itself; future OTLP exporter is a config flip.
- **Con:** ten-plus transitive deps (`@opentelemetry/api`,
  `sdk-trace-base`, `sdk-trace-node`, `resources`, `semantic-conventions`,
  `instrumentation`, etc.) for a stub with no in-tree consumer yet — the spans
  themselves land in Wave 3+. Adds package weight, install time, and a CVE
  surface for zero current value.

Rejected for the initial PR. The chosen design keeps the public API
OTel-compatible so this can be the natural follow-up.

### Alternative B — Node `EventEmitter`-based recorder

Emit synthetic span-start/span-end events on an emitter; let subsystems
subscribe.

- **Pro:** no exporter abstraction; just listeners.
- **Con:** doesn't match the OTel mental model; rotation, file format, and
  attribute-shape contracts have nowhere natural to live; later migrating to
  OTel means rewriting every call site, not just the recorder.

Rejected.

### Alternative C — Minimal in-tree facade matching OTel span semantics (chosen)

A small `Telemetry` interface with `startSpan(name, attrs?) → Span`,
`Span.setAttribute(k, v)`, `Span.end(err?)`. The default `FileTelemetry`
implementation writes NDJSON span records to
`$XDG_DATA_HOME/godot-mcp/traces/godot-mcp-{date}.ndjson`, rotates on file size
(100 MB) or age (7 days), and is disabled when `OTEL_SDK_DISABLED=true`. A
`NoopTelemetry` is used when disabled.

The interface intentionally mirrors `@opentelemetry/api`'s `Span`/`Tracer`
shape so that a follow-up PR can swap `FileTelemetry` for an OTel-backed
implementation without changing a single call site.

PII discipline is encoded in helper functions exported from the same module:

- `relativizePath(path, projectRoot)` returns a project-root-relative form
  with a sentinel (`<absolute>`) when relativization would escape; spans
  should only ever attach `relativizePath()`-passed values.
- `hashQuery(query)` returns `{length, sha256Prefix8}`. Attached when
  `GODOT_MCP_TRACE_QUERIES` is unset.
- `verbatimQueryAllowed(cfg)` is the single gate callers ask before attaching
  a raw query string.

Rationale: encodes the PII rules in the API rather than relying on every
caller to remember them, and keeps the package weight near zero.

## Decision 3 — How env parsing extends PR #55's `parseSharedEnv`

PR #55 introduces `parseSharedEnv(env): SharedEnvConfig` with `offline`,
`docsDbPath`, `modelPath`, `docsVersion`. The header comment explicitly
says: _"this file is intentionally extensible so that PR doesn't conflict with
this one — additional fields are appended to `SharedEnvConfig` and
`parseSharedEnv`."_ Our base branch (`refactor/3-modules`) does not contain
PR #55's `src/shared/env.ts` yet, so we are introducing the file ourselves.

### Alternative A — separate `parseLoggingEnv` / `parseTelemetryEnv` modules

Keep `parseSharedEnv` PR-#55-shaped; layer new functions next to it.

- **Pro:** lowest merge risk with PR #55.
- **Con:** every consumer has to call three functions and merge their
  results, defeating the "centralized config" point of `parseSharedEnv`.
  PR #55's own header rejects this approach.

Rejected.

### Alternative B — extend `SharedEnvConfig` with new fields, keep all PR #55 exports verbatim (chosen)

Introduce `src/shared/env.ts` as a strict superset of PR #55's:

- Re-export PR #55's `OfflineModeError`, `SharedEnvConfig`, `EnvSource`,
  `parseSharedEnv` with the **same names, the same signatures, the same
  semantics, and the same cross-field validation rules**. PR #55's tests
  (when merged) must pass against this file unchanged.
- Add fields to `SharedEnvConfig`:
  - `logLevel: LogLevel` — parsed from `GODOT_MCP_LOG_LEVEL`, default
    `"info"`. Invalid values throw `EnvParseError`.
  - `traceQueries: boolean` — parsed from `GODOT_MCP_TRACE_QUERIES`.
  - `otelDisabled: boolean` — parsed from `OTEL_SDK_DISABLED`.
- Re-export `parseBoolean` and `parseOptionalString` as named exports so
  Wave 3+ code (and tests) can share the strict boolean grammar PR #55
  established (canonical `1`/`0`/`true`/`false`, throw on anything else).

Merge story: when PR #55 lands and `refactor/3-modules` is rebased onto main,
the two `src/shared/env.ts` files conflict trivially because they share
identical PR #55 content. Take whichever version is more recent; both should
yield the same `parseSharedEnv` behavior for the offline subset.

### Network guard

`src/shared/network-guard.ts` is taken verbatim from PR #55. It does not need
extension; #5 does not add new network operations. We ship it as-is so that
PR #55's call sites (if rebased on this branch first) compile unchanged.

## Decision 4 — Logger surface

DESIGN.md L210 specifies format `[godot-mcp][subsystem] message`. The existing
`src/shared/logging.ts` provides only `logDebug` and reads `DEBUG=true` (binary).
We extend, preserving the existing names so PR #58's call sites continue to
compile.

- Keep `logDebug(message: string): void` and `isDebugEnabled: boolean` exports
  for back-compat. `logDebug` continues to work without a subsystem prefix
  (used by infra code that pre-dates the formatted scheme).
- Add `logError(subsystem, message)`, `logWarn(subsystem, message)`,
  `logInfo(subsystem, message)`, plus a `Logger` interface and
  `createLogger(subsystem): Logger` factory that returns
  `{ error, warn, info, debug }` methods bound to the subsystem string.
- Levels are read once at module load from `GODOT_MCP_LOG_LEVEL` (default
  `info`). The five levels in order are
  `silent < error < warn < info < debug`. A message at level `L` is emitted
  iff `levelRank(currentLevel) >= levelRank(L)`.
- `setLogLevelForTesting(level)` is exported solely so tests can mutate the
  effective level without touching `process.env`. Production code must not
  call it. The module's docstring marks it as test-only.

## Decision 5 — InitLatch semantics (codifying the Wave 2 D8 amendment)

The amendment in #5 fully specifies the shape. Notes on what's left to nail
down:

- `resolve(value)` and `reject(error)` are **idempotent in the sense that a
  second call throws synchronously** rather than silently dropping. This is
  what the acceptance criterion "idempotent `resolve`/`reject` (second call
  throws)" demands, and it surfaces double-init bugs immediately instead of
  letting them hide as silent no-ops. `reset()` clears that arming so the
  next `resolve`/`reject` is once-again accepted.
- `reset()` rejects every pending `await()` with a sentinel `LatchResetError`
  (subclass of `Error`) so callers can distinguish "the latch was reset out
  from under me" from a real `reject(error)` they were awaiting.
- `state()` is sync and returns the current internal state by value; mutation
  goes through `resolve`/`reject`/`reset` only.
- `await()` resolves synchronously (via a pre-resolved promise) when the
  latch is already in the `ready` state, so docs-style "tool handler awaits
  the latch on every call" pays no measurable cost after first ready.
