# godot-mcp v1 Tool Descriptions

Canonical reference for all 14 `godot_*` v1 tools. This document is the human-readable companion to [`src/tools/descriptions.ts`](../src/tools/descriptions.ts), which is the machine-readable single source of truth that all tool registrations import from.

The descriptions here are identical to those in `descriptions.ts`. They are organized to make the disambiguation matrix from [DESIGN.md § Tool descriptions](DESIGN.md) verifiable by a human reviewer.

## Disambiguation matrix

| Pair | Disambiguating signal |
|------|-----------------------|
| `godot_search_api` vs `godot_search_tutorials` | "API signatures / classes" vs "tutorials and guides / how-to" |
| `godot_search_api` vs `godot_get_class` | "search matching a query" vs "look up by exact name" |
| `godot_get_class` vs `godot_find_member` | "full API / explore a class" vs "one member / exact details" |
| `godot_search_tutorials` vs `godot_get_tutorial` | "search to discover" vs "fetch a known path returned by search" |
| `godot_get_class` vs `godot_docs_info` | "look up class content" vs "report loaded docs version/coverage" |
| `godot_search_api` vs `godot_docs_info` | same axis as above |
| `godot_find_definition` (user code) vs `godot_get_class` / `godot_find_member` (engine API) | "symbol in your GDScript project code" vs "built-in Godot engine type" |

---

## Docs tools (6)

---

## `godot_search_api`

### Summary

Search the Godot Engine API reference by keyword or query.

### Description

Search the Godot Engine API reference for classes or members matching a query — prefer this over guessing API signatures from prior knowledge. Returns a ranked list of matching classes and members from the offline Godot docs index. Accepts an optional `inherits_from` filter to scope results to subclasses of a given type, and an optional `category` filter (e.g., `2D`, `3D`, `Physics`). Use this tool when you need to find what API classes or methods exist (find by query); use `godot_get_class` instead when you already know the exact class name (look up by name). Empty query with no filters returns `{results: [], hint}` — not an error.

**Routing note:** The first sentence carries "API reference" and "query" to disambiguate from `godot_search_tutorials` ("tutorials and guides") and `godot_get_class` ("exact name").

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `query` | Recommended | Search query string. Matched against class names, member names, and brief descriptions using FTS5 full-text search. Leave empty only when using filters. |
| `inherits_from` | No | Restrict results to classes that inherit (directly or transitively) from this class name. Example: `Node2D`. |
| `category` | No | Restrict results to classes in this category. Common values: `2D`, `3D`, `Physics`, `Audio`, `Animation`, `UI`. |
| `limit` | No | Maximum number of results to return. Default: 20. |

### Example invocation

```json
{
  "tool": "godot_search_api",
  "arguments": {
    "query": "move and slide",
    "inherits_from": "CharacterBody3D"
  }
}
```

### Example response

```json
{
  "results": [
    {
      "type": "member",
      "class": "CharacterBody3D",
      "name": "move_and_slide",
      "kind": "method",
      "signature": "bool move_and_slide()",
      "brief": "Moves the body based on velocity. Returns true if a collision occurred."
    }
  ]
}
```

---

## `godot_get_class`

### Summary

Look up a Godot built-in engine class by exact name.

### Description

Look up a Godot built-in engine class by exact name to explore its full API — use this when you know the class name, not for searching. Returns a structured record with the class description, inheritance chain, and optionally methods, properties, signals, and constants. Use `godot_search_api` instead when you need to find a class by keyword (find by query). Use `godot_find_member` instead when you need exact details on a single method, property, signal, or constant (exact details on one member). Use `godot_docs_info` to check which Godot docs version is loaded rather than to look up a class. Use `godot_find_definition` when searching for a symbol in GDScript code you wrote (user code), not a built-in Godot type.

**Routing note:** "Look up by exact name" and "full API" disambiguate from `godot_search_api` ("query") and `godot_find_member` ("one member"). The explicit redirects to `godot_find_definition` and `godot_docs_info` prevent the most common cross-tool misrouting.

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `class_name` | Yes | Exact name of the Godot class to look up. Case-insensitive with a "did you mean?" suggestion on mismatch. Example: `CharacterBody3D`. |
| `include` | No | Comma-separated subset of sections to return. Valid values: `methods`, `properties`, `signals`, `constants`, `description`, `inheritance`. Omitting returns all sections. |

### Example invocation

```json
{
  "tool": "godot_get_class",
  "arguments": {
    "class_name": "CharacterBody3D",
    "include": "methods,properties"
  }
}
```

### Example response

```json
{
  "name": "CharacterBody3D",
  "inherits": "PhysicsBody3D",
  "brief": "Specialized physics body for characters...",
  "methods": [
    { "name": "move_and_slide", "signature": "bool move_and_slide()", "description": "..." }
  ],
  "properties": [
    { "name": "velocity", "type": "Vector3", "description": "Current movement velocity." }
  ]
}
```

---

## `godot_find_member`

### Summary

Look up exact details on one member of a Godot engine class.

### Description

Look up exact details on one member (method, property, signal, or constant) of a Godot engine class — use this when you need a specific member, not to browse a whole class. Returns an array of matching member records; multiple hits occur when `kind` is omitted and a name exists across several kinds. Use `godot_get_class` instead to explore all members of a class at once. Prefer this tool over guessing parameter types or return types from prior knowledge.

**Routing note:** "One member" and "exact details" disambiguate from `godot_get_class` ("explore a class").

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `class_name` | Yes | Name of the Godot class to search within. Example: `Node2D`. |
| `member_name` | Yes | Name of the member to find. Example: `global_position` or `move_and_slide`. |
| `kind` | No | Restrict results to one member kind: `method`, `property`, `signal`, or `constant`. When omitted, all matching members across all kinds are returned. |

### Example invocation

```json
{
  "tool": "godot_find_member",
  "arguments": {
    "class_name": "Node2D",
    "member_name": "global_position",
    "kind": "property"
  }
}
```

### Example response

```json
{
  "results": [
    {
      "class": "Node2D",
      "name": "global_position",
      "kind": "property",
      "type": "Vector2",
      "description": "Global position of this node. This is equivalent to `position` if the node has no parent..."
    }
  ]
}
```

---

## `godot_search_tutorials`

### Summary

Search Godot's tutorials and guides for how-to answers.

### Description

Search Godot's tutorials and guides for how-to answers — prefer this over guessing from prior knowledge when the user asks a conceptual or workflow question. Uses hybrid lexical + dense (BGE-small-en-v1.5) retrieval over the offline docs index. Returns ranked chunks with `path` values you pass to `godot_get_tutorial` to fetch full content. Use `godot_search_api` instead for questions about API classes or method signatures. Use `godot_get_tutorial` to fetch a tutorial you already found via this tool (fetch a known path returned by search).

**Routing note:** "Tutorials and guides" and "how-to" disambiguate from `godot_search_api` ("API signatures / classes"). The explicit "fetch a known path" redirect to `godot_get_tutorial` prevents calling search when you already have a path.

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `query` | Yes | Natural-language question or topic. Examples: "how do I move a character with physics", "collision layers and masks explained". |
| `limit` | No | Maximum number of result chunks to return. Default: 5. |

### Example invocation

```json
{
  "tool": "godot_search_tutorials",
  "arguments": {
    "query": "how do I use collision layers and masks"
  }
}
```

### Example response

```json
{
  "results": [
    {
      "path": "tutorials/physics/physics_introduction.rst",
      "title": "Physics Introduction",
      "heading_path": "Collision layers and masks",
      "excerpt": "Godot provides 32 physics layers numbered 1 through 32...",
      "score": 0.94
    }
  ]
}
```

---

## `godot_get_tutorial`

### Summary

Fetch the full content of a Godot tutorial by its path.

### Description

Fetch the full content of a Godot tutorial by its path — use this after `godot_search_tutorials` returns a path, not for discovery. Use `godot_search_tutorials` first to discover relevant tutorial paths, then call this tool to read the content.

**Routing note:** "Fetch a known path" and the explicit reference to `godot_search_tutorials` disambiguate from the search tool ("search to discover").

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `path` | Yes | Tutorial path as returned in `godot_search_tutorials` results. Example: `tutorials/3d/using_gridmaps.rst`. |

### Example invocation

```json
{
  "tool": "godot_get_tutorial",
  "arguments": {
    "path": "tutorials/physics/physics_introduction.rst"
  }
}
```

### Example response

```json
{
  "path": "tutorials/physics/physics_introduction.rst",
  "title": "Physics Introduction",
  "content": "# Physics Introduction\n\nGodot provides several physics engines...\n\n## Collision layers and masks\n\n..."
}
```

---

## `godot_docs_info`

### Summary

Report the Godot docs version and coverage currently loaded in this server.

### Description

Report the Godot docs version and coverage loaded in this server — use this to check which Godot version's docs are active, not to look up classes or tutorials. Returns version string, source, indexed_at timestamp, class count, tutorial count, ingestion warnings, embedding model id, and source SHAs. Use `godot_get_class` or `godot_search_api` when you want to look up Godot API content.

**Routing note:** "Version and coverage" and "loaded" disambiguate from `godot_get_class` and `godot_search_api`, which retrieve content rather than metadata.

### Parameters

No parameters.

### Example invocation

```json
{
  "tool": "godot_docs_info",
  "arguments": {}
}
```

### Example response

```json
{
  "godot_version": "4.3-stable",
  "source": "bundled",
  "indexed_at": "2025-09-01T12:00:00Z",
  "class_count": 512,
  "tutorial_count": 284,
  "embedding_model_id": "BAAI/bge-small-en-v1.5",
  "ingestion_warnings": [],
  "tarball_sha256": "abc123...",
  "docs_tarball_sha256": "def456..."
}
```

---

## LSP read tools (7)

All 7 read-only LSP tools share two cross-cutting behaviors:

- **Zero-results rule:** Returns an empty array (or empty object for hover) when no results are found — never an MCP error.
- **Positions are 1-based** on the wire (line 1 = first line, column 1 = first character). Documented in each tool's parameter table rather than in the description first sentence, per DESIGN.md D9.

---

## `godot_find_definition`

### Summary

Find the definition of a symbol in your GDScript project code.

### Description

Find the definition of a symbol in your GDScript project code — for built-in Godot engine types use `godot_get_class` or `godot_find_member` instead. Accepts either a file position (`file`, `line`, `character`) or a `symbol_name` for symbol-based lookup. Returns an array of definition locations; empty array when no definition is found (never an MCP error). When a position resolves to a built-in Godot type (`gdscript://` URI), the result is automatically redirected to the docs subsystem with `source: "docs"`.

**Routing note:** "Your GDScript project code" and the explicit redirect to `godot_get_class`/`godot_find_member` for built-in types make this the most important routing boundary in the tool set. LSP-trained models default to `find_definition` for any symbol — this description corrects that default.

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `file` | Conditional | Absolute path to the GDScript (.gd or .gdshader) file. Required unless `symbol_name` is provided. |
| `line` | Conditional | Line number of the symbol. **1-based:** line 1 is the first line of the file. Required when `file` is provided. |
| `character` | Conditional | Column number of the symbol. **1-based:** column 1 is the first character. Required when `file` is provided. |
| `symbol_name` | Conditional | Alternative to position-based lookup. Symbol name to resolve across the project. Use when you know the name but not the exact location. |

### Example invocation

```json
{
  "tool": "godot_find_definition",
  "arguments": {
    "file": "/home/user/project/scripts/player.gd",
    "line": 42,
    "character": 10
  }
}
```

### Example response

```json
{
  "definitions": [
    {
      "file": "/home/user/project/scripts/player.gd",
      "line": 8,
      "character": 1,
      "source": "lsp"
    }
  ]
}
```

---

## `godot_find_references`

### Summary

Find all references to a GDScript symbol across your project.

### Description

Find all references to a GDScript symbol across your project — returns every location where the symbol is used. Accepts either a file position (`file`, `line`, `character`) or a `symbol_name`. Returns an empty array when no references are found (never an MCP error). Includes a grep-based fallback for autoload globals whose references may not be tracked by the LSP.

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `file` | Conditional | Absolute path to the GDScript (.gd) file containing the symbol. Required unless `symbol_name` is provided. |
| `line` | Conditional | Line number of the symbol. **1-based:** line 1 is the first line of the file. |
| `character` | Conditional | Column number of the symbol. **1-based:** column 1 is the first character. |
| `symbol_name` | Conditional | Alternative to position-based lookup. Symbol name to find references to across the project. |

### Example invocation

```json
{
  "tool": "godot_find_references",
  "arguments": {
    "file": "/home/user/project/scripts/player.gd",
    "line": 8,
    "character": 5
  }
}
```

### Example response

```json
{
  "references": [
    { "file": "scripts/player.gd", "line": 8, "character": 5 },
    { "file": "scripts/game.gd", "line": 33, "character": 12 },
    { "file": "scripts/hud.gd", "line": 17, "character": 8, "source": "grep_fallback" }
  ]
}
```

---

## `godot_hover`

### Summary

Get hover information (type signature and inline docs) for a GDScript symbol.

### Description

Get hover information (type signature and inline documentation) for a GDScript symbol at a given position or by name. Accepts either a file position (`file`, `line`, `character`) or a `symbol_name`. Returns an empty object when no hover information is available (never an MCP error). Content is markdown, truncated at 5000 chars with a `truncated` flag when cut.

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `file` | Conditional | Absolute path to the GDScript (.gd or .gdshader) file. Required unless `symbol_name` is provided. |
| `line` | Conditional | Line number of the symbol. **1-based:** line 1 is the first line of the file. |
| `character` | Conditional | Column number of the symbol. **1-based:** column 1 is the first character. |
| `symbol_name` | Conditional | Alternative to position-based lookup. Symbol name to fetch hover information for. |

### Example invocation

```json
{
  "tool": "godot_hover",
  "arguments": {
    "file": "/home/user/project/scripts/player.gd",
    "line": 42,
    "character": 15
  }
}
```

### Example response

```json
{
  "content": {
    "kind": "markdown",
    "value": "**func move_and_slide() -> bool**\n\nMoves the body based on `velocity`. Returns `true` if a collision occurred.\n\n..."
  },
  "truncated": false
}
```

---

## `godot_document_symbols`

### Summary

List all symbols declared in a single GDScript file.

### Description

List all symbols (functions, variables, classes, signals) declared in a single GDScript file. Useful for understanding the structure of a file before editing or navigating to a specific declaration. Returns symbols in declaration order. Capped at 500 symbols with a `truncated` flag for larger files.

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `file` | Yes | Absolute path to the GDScript (.gd or .gdshader) file. |

### Example invocation

```json
{
  "tool": "godot_document_symbols",
  "arguments": {
    "file": "/home/user/project/scripts/player.gd"
  }
}
```

### Example response

```json
{
  "symbols": [
    { "name": "MAX_SPEED", "kind": "constant", "line": 3 },
    { "name": "velocity", "kind": "variable", "line": 7 },
    { "name": "_ready", "kind": "function", "line": 10 },
    { "name": "_physics_process", "kind": "function", "line": 15 }
  ],
  "truncated": false
}
```

---

## `godot_workspace_symbols`

### Summary

Search for GDScript symbols by name across all tracked project files.

### Description

Search for GDScript symbols by name across all tracked files in the project. Uses case-insensitive substring matching — Godot's LSP does not support fuzzy or CamelCase matching, so use partial exact prefixes rather than approximate names. Returns an empty array when no matches are found (never an MCP error). Results are unioned from both the native LSP response and a per-file symbol shim (Godot's native workspace/symbol is unreliable).

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `query` | Yes | Substring to search for in symbol names. Case-insensitive. Example: `player_health`. |

### Example invocation

```json
{
  "tool": "godot_workspace_symbols",
  "arguments": {
    "query": "player_health"
  }
}
```

### Example response

```json
{
  "symbols": [
    { "name": "player_health", "kind": "variable", "file": "scripts/player.gd", "line": 5 },
    { "name": "max_player_health", "kind": "constant", "file": "scripts/constants.gd", "line": 1 }
  ]
}
```

---

## `godot_get_diagnostics`

### Summary

Get type errors, warnings, and parse errors for a GDScript file.

### Description

Get GDScript type errors, warnings, and parse errors for a specific file from Godot's language server. Awaits a fresh diagnostics push after detecting file changes; returns cached results with `partial: true` on timeout rather than erroring. First-touch timeout per file: 10 s. Steady-state timeout: 2 s. Returns an empty array when no diagnostics exist (never an MCP error).

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `file` | Yes | Absolute path to the GDScript (.gd) file to get diagnostics for. |

### Example invocation

```json
{
  "tool": "godot_get_diagnostics",
  "arguments": {
    "file": "/home/user/project/scripts/player.gd"
  }
}
```

### Example response

```json
{
  "diagnostics": [
    {
      "severity": "error",
      "line": 42,
      "character": 5,
      "end_line": 42,
      "end_character": 18,
      "message": "Identifier 'velcoity' is not declared in the current scope.",
      "source": "GDScript",
      "code": null
    }
  ],
  "partial": false
}
```

---

## `godot_signature_help`

### Summary

Get parameter signature help for a function call at a cursor position.

### Description

Get parameter signature help for a function call at a position in a GDScript file — shows parameter names, types, and which argument position the cursor is at. Returns an empty result (not an error) when the cursor is not inside a function call. Known limitation: unreliable on `.new()` constructor calls (returns `GDScript.new()` docs instead of the class `_init()`) and on multi-line argument lists (godot#51617).

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `file` | Yes | Absolute path to the GDScript (.gd) file. |
| `line` | Yes | Line number of the cursor position inside the function call. **1-based:** line 1 is the first line of the file. |
| `character` | Yes | Column number of the cursor position inside the function call. **1-based:** column 1 is the first character. |

### Example invocation

```json
{
  "tool": "godot_signature_help",
  "arguments": {
    "file": "/home/user/project/scripts/player.gd",
    "line": 55,
    "character": 28
  }
}
```

### Example response

```json
{
  "signatures": [
    {
      "label": "move_and_collide(motion: Vector3, test_only: bool = false) -> KinematicCollision3D",
      "parameters": [
        { "label": "motion: Vector3" },
        { "label": "test_only: bool = false" }
      ],
      "active_parameter": 0
    }
  ]
}
```

---

## LSP advisory-write tool (1)

---

## `godot_preview_rename`

### Summary

Compute a rename of a GDScript symbol across the project and return proposed edits without applying them.

### Description

Compute a rename of a GDScript symbol across the whole project — returns proposed edits without applying them, so you can review and apply via your editor tools. Accepts either a file position (`file`, `line`, `character`) or a `symbol_name`. Returns `{action, edits, summary}` where each edit has `{file, changes: [{line, before, after}]}` suitable for `str_replace`. `before` strings are widened to be unique within each file (up to 5 lines of context). Same-line multi-occurrence renames are merged into a single change record.

**Advisory pattern:** This tool never modifies files. The agent applies the returned edits using its own edit tools (e.g., `str_replace`), preserving Claude Code's checkpoint/rewind behavior.

### Parameters

| Name | Required | Description |
|------|----------|-------------|
| `file` | Conditional | Absolute path to the GDScript (.gd) file containing the symbol to rename. Required unless `symbol_name` is provided. |
| `line` | Conditional | Line number of the symbol to rename. **1-based:** line 1 is the first line of the file. |
| `character` | Conditional | Column number of the symbol to rename. **1-based:** column 1 is the first character. |
| `symbol_name` | Conditional | Alternative to position-based lookup. Symbol name to rename across the project. |
| `new_name` | Yes | The new name to rename the symbol to. |

### Example invocation

```json
{
  "tool": "godot_preview_rename",
  "arguments": {
    "file": "/home/user/project/scripts/player.gd",
    "line": 8,
    "character": 5,
    "new_name": "movement_speed"
  }
}
```

### Example response

```json
{
  "action": { "kind": "rename", "from": "max_speed", "to": "movement_speed" },
  "edits": [
    {
      "file": "scripts/player.gd",
      "changes": [
        { "line": 3, "before": "const MAX_SPEED = 200", "after": "const MOVEMENT_SPEED = 200" },
        { "line": 22, "before": "    velocity = direction * MAX_SPEED", "after": "    velocity = direction * MOVEMENT_SPEED" }
      ]
    },
    {
      "file": "scripts/enemy.gd",
      "changes": [
        { "line": 15, "before": "    if player.max_speed > 100:", "after": "    if player.movement_speed > 100:" }
      ]
    }
  ],
  "summary": { "files": 2, "locations": 3 }
}
```
