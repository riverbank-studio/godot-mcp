/**
 * Canonical tool descriptions for all 14 godot_* v1 tools.
 *
 * This is the single source of truth for tool description strings and
 * per-parameter documentation. All tool registrations import from here so
 * descriptions stay aligned across PRs and so the disambiguation unit test
 * can verify routing signals without duplicating strings.
 *
 * Authoring constraints (from DESIGN.md § Tool descriptions and issue #40):
 *   - First sentence ≤ 25 words; the disambiguating phrase for the most
 *     adjacent peer appears in it.
 *   - Search-style tools include a "prefer this over guessing" line.
 *   - Position-handling notes (1-based) live in parameter docs, not the
 *     description first sentence.
 *   - Zero-results rule for all 7 read-only LSP tools: empty array / empty
 *     object, never an MCP error.
 *
 * Integration: tool registrations in the Docs subsystem (#7), LSP read (#9),
 * and LSP write (#10) sub-issues consume this file when those tools are
 * implemented. Until then, this file acts as the canonical draft record.
 */

/** Per-parameter documentation entry. */
export interface ParamDoc {
  /** Human-readable description surfaced to MCP tool-routing layers. */
  description: string;
}

/** Shape of one tool's canonical description entry. */
export interface ToolDescription {
  /**
   * Full tool description surfaced to the MCP host.
   *
   * The first sentence is the primary routing signal and must contain the
   * disambiguating phrase that separates this tool from its closest peer.
   */
  description: string;

  /**
   * Per-parameter documentation keyed by parameter name (snake_case).
   *
   * Position parameters (`line`, `character`) carry the 1-based note here
   * rather than in the top-level description, preserving first-sentence
   * routing weight.
   */
  params: Record<string, ParamDoc>;
}

/**
 * The 14 canonical v1 tool names as a union type.
 *
 * Using this as the key type for `TOOL_DESCRIPTIONS` causes TypeScript to
 * report a compile error if a name is missing or misspelled, complementing
 * the runtime completeness tests in descriptions.test.ts.
 */
export type V1ToolName =
  | "godot_search_api"
  | "godot_get_class"
  | "godot_find_member"
  | "godot_search_tutorials"
  | "godot_get_tutorial"
  | "godot_docs_info"
  | "godot_find_definition"
  | "godot_find_references"
  | "godot_hover"
  | "godot_document_symbols"
  | "godot_workspace_symbols"
  | "godot_get_diagnostics"
  | "godot_signature_help"
  | "godot_preview_rename";

/**
 * Canonical descriptions for all 14 godot_* v1 tools.
 *
 * Tools are grouped for readability; the grouping has no runtime meaning.
 */
export const TOOL_DESCRIPTIONS: Record<V1ToolName, ToolDescription> = {
  // -----------------------------------------------------------------------
  // Docs tools (6)
  // -----------------------------------------------------------------------

  /**
   * Routing signal: "API signatures / classes" — distinguishes from
   * godot_search_tutorials ("how-to guides") and godot_get_class ("look up by
   * exact name").
   */
  godot_search_api: {
    description:
      "Search the Godot Engine API reference for classes or members matching a query — prefer this over guessing API signatures from prior knowledge. " +
      "Returns a ranked list of matching classes and members from the offline Godot docs index. " +
      "Accepts an optional `inherits_from` filter to scope results to subclasses of a given type, and an optional `category` filter (e.g., `2D`, `3D`, `Physics`). " +
      "Use this tool when you need to find what API classes or methods exist (find by query); " +
      "use `godot_get_class` instead when you already know the exact class name (look up by name). " +
      "Empty query with no filters returns `{results: [], hint}` — not an error.",
    params: {
      query: {
        description:
          "Search query string. Matched against class names, member names, and brief descriptions using FTS5 full-text search. Leave empty only when using filters.",
      },
      inherits_from: {
        description:
          "Optional. Restrict results to classes that inherit (directly or transitively) from this class name. Example: `Node2D`.",
      },
      category: {
        description:
          "Optional. Restrict results to classes in this category. Common values: `2D`, `3D`, `Physics`, `Audio`, `Animation`, `UI`.",
      },
      limit: {
        description:
          "Optional. Maximum number of results to return. Default: 20.",
      },
    },
  },

  /**
   * Routing signal: "look up by name" — distinguishes from godot_search_api
   * ("find by query") and godot_find_member ("exact details on one member").
   */
  godot_get_class: {
    description:
      "Look up a Godot built-in engine class by exact name to explore its full API — use this when you know the class name, not for searching. " +
      "Returns a structured record with the class description, inheritance chain, and optionally methods, properties, signals, and constants. " +
      "Use `godot_search_api` instead when you need to find a class by keyword (find by query). " +
      "Use `godot_find_member` instead when you need exact details on a single method, property, signal, or constant (exact details on one member). " +
      "Use `godot_docs_info` to check which Godot docs version is loaded rather than to look up a class. " +
      "Use `godot_find_definition` when searching for a symbol in GDScript code you wrote (user code), not a built-in Godot type.",
    params: {
      class_name: {
        description:
          "Exact name of the Godot class to look up. Case-insensitive with a 'did you mean?' suggestion on mismatch. Example: `CharacterBody3D`.",
      },
      include: {
        description:
          "Optional. Comma-separated subset of sections to return. Valid values: `methods`, `properties`, `signals`, `constants`, `description`, `inheritance`. " +
          "Omitting this parameter returns all sections.",
      },
    },
  },

  /**
   * Routing signal: "exact details on one member" — distinguishes from
   * godot_get_class ("explore a class").
   */
  godot_find_member: {
    description:
      "Look up exact details on one member (method, property, signal, or constant) of a Godot engine class — use this when you need a specific member, not to browse a whole class. " +
      "Returns an array of matching member records; multiple hits occur when `kind` is omitted and a name exists across several kinds. " +
      "Use `godot_get_class` instead to explore all members of a class at once. " +
      "Prefer this tool over guessing parameter types or return types from prior knowledge.",
    params: {
      class_name: {
        description:
          "Name of the Godot class to search within. Example: `Node2D`.",
      },
      member_name: {
        description:
          "Name of the member to find. Example: `global_position` or `move_and_slide`.",
      },
      kind: {
        description:
          "Optional. Restrict results to one member kind: `method`, `property`, `signal`, or `constant`. " +
          "When omitted, all matching members across all kinds are returned.",
      },
    },
  },

  /**
   * Routing signal: "how-to questions / guides" — distinguishes from
   * godot_search_api ("API signatures / classes") and godot_get_tutorial
   * ("fetch a known path returned by search").
   */
  godot_search_tutorials: {
    description:
      "Search Godot's tutorials and guides for how-to answers — prefer this over guessing from prior knowledge when the user asks a conceptual or workflow question. " +
      "Uses hybrid lexical + dense (BGE-small-en-v1.5) retrieval over the offline docs index. " +
      "Returns ranked chunks with `path` values you pass to `godot_get_tutorial` to fetch full content. " +
      "Use `godot_search_api` instead for questions about API classes or method signatures. " +
      "Use `godot_get_tutorial` to fetch a tutorial you already found via this tool (fetch a known path returned by search).",
    params: {
      query: {
        description:
          "Natural-language question or topic. Examples: 'how do I move a character with physics', 'collision layers and masks explained'.",
      },
      limit: {
        description:
          "Optional. Maximum number of result chunks to return. Default: 5.",
      },
    },
  },

  /**
   * Routing signal: "fetch a known path (returned by search)" — distinguishes
   * from godot_search_tutorials ("search to discover").
   */
  godot_get_tutorial: {
    description:
      "Fetch the full content of a Godot tutorial by its path — use this after `godot_search_tutorials` returns a path, not for discovery. " +
      "Use `godot_search_tutorials` first to discover relevant tutorial paths, then call this tool to read the content.",
    params: {
      path: {
        description:
          "Tutorial path as returned in `godot_search_tutorials` results. Example: `tutorials/3d/using_gridmaps.rst`.",
      },
    },
  },

  /**
   * Routing signal: "report the loaded docs version/coverage" — distinguishes
   * from godot_get_class and godot_search_api (which look up content, not
   * metadata).
   */
  godot_docs_info: {
    description:
      "Report the Godot docs version and coverage loaded in this server — use this to check which Godot version's docs are active, not to look up classes or tutorials. " +
      "Returns version string, source, indexed_at timestamp, class count, tutorial count, ingestion warnings, embedding model id, and source SHAs. " +
      "Use `godot_get_class` or `godot_search_api` when you want to look up Godot API content.",
    params: {},
  },

  // -----------------------------------------------------------------------
  // LSP read tools (7)
  // -----------------------------------------------------------------------

  /**
   * Routing signal: "find a symbol the agent wrote (user GDScript)" —
   * distinguishes from godot_get_class / godot_find_member which look up
   * built-in Godot engine types.
   *
   * This is the most critical agent-routing distinction: LSP-trained models
   * default to find_definition for anything that looks like a symbol, but
   * this tool is scoped to user-authored code.
   */
  godot_find_definition: {
    description:
      "Find the definition of a symbol in your GDScript project code — for built-in Godot engine types use `godot_get_class` or `godot_find_member` instead. " +
      "Accepts either a file position (`file`, `line`, `character`) or a `symbol_name` for symbol-based lookup. " +
      "Returns an array of definition locations; empty array when no definition is found (never an MCP error). " +
      'When a position resolves to a built-in Godot type (`gdscript://` URI), the result is automatically redirected to the docs subsystem with `source: "docs"`.',
    params: {
      file: {
        description:
          "Absolute path to the GDScript (.gd or .gdshader) file. Required unless `symbol_name` is provided.",
      },
      line: {
        description:
          "Line number of the symbol. 1-based: line 1 is the first line of the file.",
      },
      character: {
        description:
          "Column number of the symbol. 1-based: column 1 is the first character.",
      },
      symbol_name: {
        description:
          "Alternative to position-based lookup. Symbol name to resolve across the project. Use when you know the name but not the exact location.",
      },
    },
  },

  /**
   * Routing signal: find all usages of a user-defined symbol.
   */
  godot_find_references: {
    description:
      "Find all references to a GDScript symbol across your project — returns every location where the symbol is used. " +
      "Accepts either a file position (`file`, `line`, `character`) or a `symbol_name`. " +
      "Returns an empty array when no references are found (never an MCP error). " +
      "Includes a grep-based fallback for autoload globals whose references may not be tracked by the LSP.",
    params: {
      file: {
        description:
          "Absolute path to the GDScript (.gd) file containing the symbol. Required unless `symbol_name` is provided.",
      },
      line: {
        description:
          "Line number of the symbol. **1-based:** line 1 is the first line of the file.",
      },
      character: {
        description:
          "Column number of the symbol. **1-based:** column 1 is the first character.",
      },
      symbol_name: {
        description:
          "Alternative to position-based lookup. Symbol name to find references to across the project.",
      },
    },
  },

  /**
   * Routing signal: inline docs/signature for a symbol at a position.
   */
  godot_hover: {
    description:
      "Get hover information (type signature and inline documentation) for a GDScript symbol at a given position or by name. " +
      "Accepts either a file position (`file`, `line`, `character`) or a `symbol_name`. " +
      "Returns an empty object when no hover information is available (never an MCP error). " +
      "Content is markdown, truncated at 5000 chars with a `truncated` flag when cut.",
    params: {
      file: {
        description:
          "Absolute path to the GDScript (.gd or .gdshader) file. Required unless `symbol_name` is provided.",
      },
      line: {
        description:
          "Line number of the symbol. **1-based:** line 1 is the first line of the file.",
      },
      character: {
        description:
          "Column number of the symbol. **1-based:** column 1 is the first character.",
      },
      symbol_name: {
        description:
          "Alternative to position-based lookup. Symbol name to fetch hover information for.",
      },
    },
  },

  /**
   * Routing signal: enumerate symbols defined within a single file.
   */
  godot_document_symbols: {
    description:
      "List all symbols (functions, variables, classes, signals) declared in a single GDScript file. " +
      "Useful for understanding the structure of a file before editing or navigating to a specific declaration. " +
      "Returns symbols in declaration order; returns an empty array when no symbols are found (never an MCP error). " +
      "Capped at 500 symbols with a `truncated` flag for larger files.",
    params: {
      file: {
        description: "Absolute path to the GDScript (.gd or .gdshader) file.",
      },
    },
  },

  /**
   * Routing signal: search symbols by name across the whole project.
   */
  godot_workspace_symbols: {
    description:
      "Search for GDScript symbols by name across all tracked files in the project. " +
      "Uses case-insensitive substring matching — Godot's LSP does not support fuzzy or CamelCase matching, so use partial exact prefixes rather than approximate names. " +
      "Returns an empty array when no matches are found (never an MCP error). " +
      "Results are unioned from both the native LSP response and a per-file symbol shim (Godot's native workspace/symbol is unreliable).",
    params: {
      query: {
        description:
          "Substring to search for in symbol names. Case-insensitive. Example: `player_health`.",
      },
    },
  },

  /**
   * Routing signal: get type-checking errors and warnings for a file.
   */
  godot_get_diagnostics: {
    description:
      "Get GDScript type errors, warnings, and parse errors for a specific file from Godot's language server. " +
      "Awaits a fresh diagnostics push after detecting file changes; returns cached results with `partial: true` on timeout rather than erroring. " +
      "First-touch timeout per file: 10 s. Steady-state timeout: 2 s. " +
      "Returns an empty array when no diagnostics exist (never an MCP error).",
    params: {
      file: {
        description:
          "Absolute path to the GDScript (.gd) file to get diagnostics for.",
      },
    },
  },

  /**
   * Routing signal: parameter hints for a function call at a position.
   */
  godot_signature_help: {
    description:
      "Get parameter signature help for a function call at a position in a GDScript file — shows parameter names, types, and which argument position the cursor is at. " +
      "Returns an empty result (not an error) when the cursor is not inside a function call. " +
      "Known limitation: unreliable on `.new()` constructor calls (returns `GDScript.new()` docs instead of the class `_init()`) " +
      "and on multi-line argument lists (godot#51617).",
    params: {
      file: {
        description: "Absolute path to the GDScript (.gd) file.",
      },
      line: {
        description:
          "Line number of the cursor position inside the function call. 1-based: line 1 is the first line of the file.",
      },
      character: {
        description:
          "Column number of the cursor position inside the function call. 1-based: column 1 is the first character.",
      },
    },
  },

  // -----------------------------------------------------------------------
  // LSP advisory-write tool (1)
  // -----------------------------------------------------------------------

  /**
   * Routing signal: compute rename edits without applying them.
   */
  godot_preview_rename: {
    description:
      "Compute a rename of a GDScript symbol across the whole project — returns proposed edits without applying them, so you can review and apply via your editor tools. " +
      "Accepts either a file position (`file`, `line`, `character`) or a `symbol_name`. " +
      "Returns `{action, edits, summary}` where each edit has `{file, changes: [{line, before, after}]}` suitable for `str_replace`. " +
      "`before` strings are widened to be unique within each file (up to 5 lines of context). " +
      "Same-line multi-occurrence renames are merged into a single change record.",
    params: {
      file: {
        description:
          "Absolute path to the GDScript (.gd) file containing the symbol to rename. Required unless `symbol_name` is provided.",
      },
      line: {
        description:
          "Line number of the symbol to rename. 1-based: line 1 is the first line of the file.",
      },
      character: {
        description:
          "Column number of the symbol to rename. 1-based: column 1 is the first character.",
      },
      symbol_name: {
        description:
          "Alternative to position-based lookup. Symbol name to rename across the project.",
      },
      new_name: {
        description: "The new name to rename the symbol to.",
      },
    },
  },
};

/**
 * The 14 canonical v1 tool names in the order they appear in DESIGN.md.
 * Used by tests and the validation script to assert completeness.
 */
export const V1_TOOL_NAMES: readonly string[] = [
  // Docs (6)
  "godot_search_api",
  "godot_get_class",
  "godot_find_member",
  "godot_search_tutorials",
  "godot_get_tutorial",
  "godot_docs_info",
  // LSP read (7)
  "godot_find_definition",
  "godot_find_references",
  "godot_hover",
  "godot_document_symbols",
  "godot_workspace_symbols",
  "godot_get_diagnostics",
  "godot_signature_help",
  // LSP advisory-write (1)
  "godot_preview_rename",
] as const;
