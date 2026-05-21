# Tool-Routing Accuracy Benchmark Dataset — v1

This directory contains the ground-truth query set for benchmark #30 ("Tool-routing accuracy"). The dataset validates that an LLM picks the correct `godot_*` tool when given a natural-language query.

## Schema

```
datasets/tool-routing/
├── schema.json          # JSON Schema for the query dataset files
├── README.md            # this file
└── v1/
    └── queries.json     # curated query set (60 queries, v1)
```

### `queries.json` fields

| Field                 | Type                | Required | Description                                           |
| --------------------- | ------------------- | -------- | ----------------------------------------------------- |
| `id`                  | string (tr-NNN)     | yes      | Unique query identifier                               |
| `query`               | string              | yes      | Verbatim natural-language query given to the model    |
| `expected_tool`       | string              | yes      | The `godot_*` tool the model should select            |
| `category`            | `docs\|lsp\|editor` | yes      | Capability area the query targets                     |
| `disambiguation_pair` | string \| null      | yes      | Named pair from DESIGN.md §Tool descriptions, or null |
| `notes`               | string              | yes      | Reviewer rationale for the expected tool selection    |

## Dataset composition (v1)

| Category  | Count  | Description                                     |
| --------- | ------ | ----------------------------------------------- |
| `docs`    | 23     | Queries targeting API lookup and tutorial tools |
| `lsp`     | 22     | Queries targeting LSP code-intelligence tools   |
| `editor`  | 15     | Queries targeting editor control tools          |
| **Total** | **60** |                                                 |

### Disambiguation pairs covered

All pairs named in DESIGN.md §Tool descriptions are exercised:

| Pair                                 | Count |
| ------------------------------------ | ----- |
| `get_class` vs `find_member`         | 8     |
| `search_api` vs `search_tutorials`   | 4     |
| `search_api` vs `get_class`          | 4     |
| `search_tutorials` vs `get_tutorial` | 4     |
| `get_class` vs `docs_info`           | 3     |
| `find_definition` vs `get_class`     | 4     |

## Running the harness

```bash
# Validate the dataset (no API calls)
npx tsx benchmarks/harness/validate-tool-routing-dataset.ts

# Dry run — print plan, no API calls
npx tsx benchmarks/harness/tool-routing.ts --dry-run

# Live run (requires ANTHROPIC_API_KEY)
npx tsx benchmarks/harness/tool-routing.ts --model claude-sonnet-4-5 --ablation full

# Run all three ablations
for ablation in full first-sent name-only; do
  npx tsx benchmarks/harness/tool-routing.ts --ablation $ablation
done
```

## Ablation modes

| Mode         | Description                                                              |
| ------------ | ------------------------------------------------------------------------ |
| `full`       | Full tool descriptions (production candidate)                            |
| `first-sent` | First sentence of each description only (validates routing-signal claim) |
| `name-only`  | Tool name + parameter schema, no description text (baseline control)     |

## Results

Results are written to `benchmarks/results/tool-routing/`:

- `<ISO-date>.ndjson` — one JSON object per query (raw results)
- `<ISO-date>-summary.json` — aggregated accuracy, per-tool precision/recall, per-category breakdown

## Prerequisites for live runs

Live runs are **gated on the following issues merging**:

- **#40** — `src/tools/descriptions.ts` (canonical tool descriptions). Without this, the harness falls back to stub descriptions that do not reflect production routing signals.
- **#7** — docs tools (6 tools). Without these, queries targeting `godot_search_api`, `godot_get_class`, etc. will route to stubs.
- **#9** — LSP read-only tools (7 tools). Without these, queries targeting `godot_find_definition`, `godot_hover`, etc. will route to stubs.

The harness prints a warning if `src/tools/descriptions.ts` is absent and uses stub schemas instead.

## Dataset provenance

Queries were curated from:

- DESIGN.md §Tool surface (all 14 v1 tool names and descriptions)
- DESIGN.md §Testing and benchmarks §1 (tool-routing accuracy method)
- Issue #30 Wave 2 amendments (ablation requirements, disambiguation matrix)

Each query was hand-written to test a specific routing decision, with `notes` explaining the reasoning.
