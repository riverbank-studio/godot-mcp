# GDScript Correctness Benchmark Dataset — v1

This directory contains the ground-truth task set for benchmark #31 ("End-to-end GDScript correctness"). The dataset tests whether an AI agent produces correct, version-appropriate GDScript when given a natural-language prompt.

## Schema

Each task lives at `v1/tasks/{id}/` and contains:

```
v1/tasks/{id}/
├── task.json          # metadata + prompt (required)
├── before/            # starting project state (may be empty for write tasks)
│   └── *.gd           # pre-existing files the agent must work with/around
├── solutions/         # ground-truth implementations
│   ├── solution-a.gd  # primary accepted solution
│   └── solution-b.gd  # optional alternate solution
└── check.gd           # programmatic pass/fail check (run against agent output)
```

### `task.json` fields

| Field               | Type                                       | Required | Description                                                         |
| ------------------- | ------------------------------------------ | -------- | ------------------------------------------------------------------- |
| `id`                | string                                     | yes      | Unique slug matching the directory name                             |
| `summary`           | string                                     | yes      | One-line description of the task                                    |
| `prompt`            | string                                     | yes      | Verbatim prompt given to the agent                                  |
| `category`          | `"write"` \| `"modify"` \| `"debug"` \| `"version-sensitive"` | yes | Task category |
| `difficulty`        | `1` \| `2` \| `3`                          | yes      | Difficulty rating (1=easy, 2=medium, 3=hard)                       |
| `godot_version`     | string                                     | yes      | Minimum Godot version the solution targets (e.g., `"4.3"`, `"4.4"`) |
| `tags`              | string[]                                   | yes      | Free-form tags for filtering (e.g., `["signals", "nodes"]`)        |
| `evaluation_notes`  | string                                     | yes      | Human-readable hints for reviewers; key correctness criteria       |
| `api_check`         | object \| null                             | yes      | Programmatic API-version check spec (null if not applicable)       |

### `api_check` sub-object

When `api_check` is not null:

| Field        | Type     | Description                                                            |
| ------------ | -------- | ---------------------------------------------------------------------- |
| `class_name` | string   | Godot class to check                                                   |
| `member`     | string   | Method, property, or signal name that must exist in target version     |
| `introduced` | string   | Version string where this member was introduced (e.g., `"4.4"`)       |
| `removed`    | string   | Version string where this member was removed (`null` if still present) |
| `notes`      | string   | Human-readable description of the version constraint                   |

## Categories

| Category           | Description                                                          | Count |
| ------------------ | -------------------------------------------------------------------- | ----- |
| `write`            | Implement a new function or class from scratch                       | 20    |
| `modify`           | Edit an existing script to add or change behavior                    | 14    |
| `debug`            | Identify and fix a broken script                                     | 14    |
| `version-sensitive`| Requires knowledge of API differences between Godot 4.x minor versions | 12 |

**Total: 60 tasks** (20% version-sensitive = 12 tasks; exceeds the 20% minimum of 50 tasks)

## Running the validation script

```bash
npm run validate:gdscript-tasks
```

This script verifies:

- All directories under `v1/tasks/` have a `task.json` that parses and conforms to the schema.
- All `task.json` ID fields match their parent directory name.
- All referenced `solutions/solution-a.gd` files exist.
- Total count is between 50 and 80.
- At least 20% of tasks are `version-sensitive`.
- All `api_check` objects (when not null) have the required fields.

## Reviewing spot-check tasks

To satisfy the acceptance criterion that at least 20% of tasks are spot-checked for API accuracy, reviewers should focus on:

1. `version-sensitive` tasks — verify that each `api_check.member` exists in the Godot class reference for the stated `godot_version`.
2. `debug` tasks — verify that the bug in `before/*.gd` is genuine (not a syntax error that GDScript would catch at parse time).
3. `write` tasks with `difficulty: 3` — verify that the `solutions/solution-a.gd` compiles without errors in Godot 4.x.

Official Godot class reference: https://docs.godotengine.org/en/stable/classes/

## Dataset provenance

This dataset was hand-curated against the Godot 4.3–4.5 class reference. Tasks involving API version boundaries were cross-checked against the Godot changelog and class reference diff between minor versions.
