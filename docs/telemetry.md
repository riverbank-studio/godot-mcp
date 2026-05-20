# Telemetry: trace attribute schema and PII posture

godot-mcp records structured spans to local NDJSON files for diagnostic
purposes. **No data is ever transmitted off the user's machine.** This
document is the source of truth for the trace attribute schema and the
privacy rules every span producer must follow.

## Where traces land

| Platform | Path                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| Linux    | `$XDG_DATA_HOME/godot-mcp/traces/` (default `~/.local/share/godot-mcp/traces/`) |
| macOS    | `~/Library/Application Support/godot-mcp/traces/`                               |
| Windows  | `%LOCALAPPDATA%\\godot-mcp\\traces\\`                                           |

The trace directory is created lazily on the first span. A `README.md` is
written into the directory at the same time explaining what's in it.

## File format

One NDJSON file per "session," rotated when the active file exceeds 100 MB
or 7 days, whichever comes first. Each line is one span record with the
shape:

```jsonc
{
  "name": "docs.search", // operation name
  "startTime": "2025-09-14T12:34:56.789Z",
  "durationMs": 42,
  "status": "ok", // "ok" | "error"
  "errorMessage": "<only when status=error>",
  "attributes": {
    "kind": "tutorial",
    "hits": 5,
    "file": "src/main.gd", // relative to project root, never absolute
    "query.length": 19,
    "query.sha256_prefix8": "a3f12b91",
  },
}
```

## Privacy rules — every span producer must obey

These rules are encoded in helper functions exported from
`src/shared/telemetry.ts`. Calling them is the only sanctioned way to attach
a path or query attribute to a span.

### 1. File paths are relative to project root

Use `relativizePath(target, projectRoot)` to render any path attribute.
The function returns:

- The project-root-relative form when `target` is inside `projectRoot`.
- The sentinel string `<absolute>` when the target would escape the project
  root, when it is not absolute, or when relativization is ambiguous.

Absolute paths must never appear in trace files.

### 2. Query strings are length-hashed by default

Use `hashQuery(query)` to produce `{length, sha256Prefix8}` and attach the
two as separate attributes:

```ts
const h = hashQuery(query);
span.setAttribute("query.length", h.length);
span.setAttribute("query.sha256_prefix8", h.sha256Prefix8);
```

`GODOT_MCP_TRACE_QUERIES=1` opts into verbatim capture. The single gate is
`verbatimQueryAllowed(cfg)` — call it before attaching a raw query string.

### 3. Source-line snippets are never recorded

Not as attributes, not as error messages. If you find yourself wanting to
attach a code snippet to a span, attach the relativized file path + the
range instead.

### 4. Error stacks are not captured

`span.end(err)` records `err.message` only. Stack frames may contain
absolute paths from V8 and are deliberately omitted.

## Attribute naming

- Use dotted lowercase: `docs.version`, `lsp.connection_attempt`,
  `query.sha256_prefix8`.
- Booleans use the bare name: `cache.hit`, not `cache.is_hit`.
- Counts use plural nouns: `hits`, `retries`.
- Durations always end in `_ms`.

## Disabling telemetry

Set the standard OTel env var `OTEL_SDK_DISABLED=true`. The facade swaps in
a noop implementation; no I/O, no allocations beyond the empty span object.

## Why a hand-rolled facade instead of `@opentelemetry/sdk-node`

The current implementation writes NDJSON directly because the project does
not have any in-tree span producers yet — they land in Wave 3+. The public
API mirrors `@opentelemetry/api`'s `Tracer` / `Span` shape so a follow-up
PR can swap `FileTelemetry` for an OTel-backed implementation without
changing a single call site. See `docs/notes/5-shared-infra.md` Decision 2
for the full rationale.
