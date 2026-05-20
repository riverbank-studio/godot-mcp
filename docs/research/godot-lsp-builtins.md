# Godot LSP response for built-in symbol definitions

**Status:** Research hand-off for issue [#34](https://github.com/riverbank-studio/godot-mcp/issues/34).
**Informs:** [#13 (per-server LSP adapter)](https://github.com/riverbank-studio/godot-mcp/issues/13), [#20 (`godot_find_definition`)](https://github.com/riverbank-studio/godot-mcp/issues/20).
**Pinned versions:** Godot `4.5-stable` and `4.6.2-stable`. Source identical in both for the code paths analysed.

This document characterises what Godot's GDScript LSP returns from `textDocument/definition` (and related methods) when the symbol under the cursor is a built-in / engine-defined type. The conclusion drives the design of the docs-subsystem fallback in `godot_find_definition`.

---

## 1. TL;DR

> `textDocument/definition` returns an **empty array** (`[]`) when the symbol resolves to a native (engine-defined) class, method, property, constant, signal, enum, or operator. There is **no synthetic URI** (no `gdscript://`, no `godot://`, no `engine://`). There is no engine-source file path either. The symbol is resolved internally — the LSP knows exactly what `Node.add_child` is — but the resolution is intentionally discarded before being put on the wire.

**Recommended adapter strategy:** the empty-array response is **not** a "symbol not found" signal — it overlaps with the genuine no-result case. The adapter cannot distinguish "no symbol at cursor" from "symbol resolved to a native". Therefore the adapter must either:

1. **Hover-first probe (recommended):** call `textDocument/hover` before `textDocument/definition` to disambiguate. Hover returns a populated `contents` for native symbols (it renders the native symbol's documentation). An empty-array `definition` response paired with a non-empty `hover` response means "native, redirect to docs".
2. **Custom `textDocument/nativeSymbol` probe:** Godot exposes a non-standard custom JSON-RPC method (see §4.4) that returns the rendered docs for a `(native_class, symbol_name)` pair. Use this *after* resolving the class/symbol name via hover or completion data when redirecting.

The adapter should then redirect to `godot_find_member` in the docs subsystem with `class_name = <native_class>` and `member_name = <symbol_name>`, surfacing the result with `source: "docs"` per the DESIGN.md § Tool-specific behavior contract for `godot_find_definition`.

---

## 2. Methodology

### 2.1 What was attempted

Direct empirical capture against a running Godot 4.x LSP **was not performed** in this research pass. Two routes were attempted and both blocked:

- **Local Godot 4.x binary.** The development machine has only Godot 3.4.4 and 3.3.4 installed; 3.x is explicitly out of scope per DESIGN.md (`GODOT_DOCS_VERSION` rejects `<4.0`). Godot 3.x's LSP also predates several relevant code paths (smart-resolve and the `nativeSymbol` custom method).
- **Downloading a Godot 4.6.2 portable build from upstream releases.** Blocked by the Claude Code auto-mode permission classifier on the rationale that downloading an executable to run constitutes choosing an external code source. This is a one-flag fix on the user's end (whitelist `github.com/godotengine/godot/releases`), but proceeding via source-code analysis was faster.

### 2.2 What was done instead

Source-code analysis against the pinned tags `4.5-stable` and `4.6.2-stable`. Files inspected (all under `modules/gdscript/language_server/` in the Godot repository):

- `gdscript_text_document.cpp` / `.h` — `textDocument/*` method handlers, including `definition`, `declaration`, `hover`, `references`, `nativeSymbol`.
- `gdscript_workspace.cpp` / `.h` — symbol resolution (`resolve_symbol`, `resolve_native_symbol`), native symbol generation from `EditorHelp::get_doc_data()`, URI handling (`get_file_uri`, `get_file_path`).
- `gdscript_language_protocol.cpp` — JSON-RPC method registration, including the custom `textDocument/nativeSymbol`.
- `godot_lsp.h` — LSP DTOs (`DocumentSymbol`, `Location`, `NativeSymbolInspectParams`).
- `main/main.cpp` — confirms the `--lsp-port <port>` CLI flag exists in 4.6.

Source was compared between `4.5-stable` and `4.6.2-stable`; the relevant code paths (`definition`, `declaration`, `find_symbols`, `initialize`) are byte-for-byte identical, so the conclusions apply unchanged to both.

A future integration test (per the issue's "Done when") should still verify the response shapes empirically against a pinned Godot version once a Godot 4.x binary is available in CI (tracked by Wave 0 CI setup) and once the LSP client lands in #8. The fixture format is suggested in §6.

### 2.3 Sources cited

- `gdscript_text_document.cpp`: <https://github.com/godotengine/godot/blob/4.6.2-stable/modules/gdscript/language_server/gdscript_text_document.cpp>
- `gdscript_workspace.cpp`: <https://github.com/godotengine/godot/blob/4.6.2-stable/modules/gdscript/language_server/gdscript_workspace.cpp>
- `gdscript_language_protocol.cpp`: <https://github.com/godotengine/godot/blob/4.6.2-stable/modules/gdscript/language_server/gdscript_language_protocol.cpp>
- `godot_lsp.h`: <https://github.com/godotengine/godot/blob/4.6.2-stable/modules/gdscript/language_server/godot_lsp.h>
- `godotengine/godot#111400` (LSP 4.5 behaviour with external editors): <https://github.com/godotengine/godot/issues/111400>

---

## 3. Why built-in `definition` returns empty: the code path

### 3.1 Native symbols are built without a URI

At LSP startup, `GDScriptWorkspace::initialize()` (in `gdscript_workspace.cpp`) walks every class in `EditorHelp::get_doc_data()` and constructs a `LSP::DocumentSymbol` for each class plus one for every method, property, signal, constant, enum, and operator on that class:

```cpp
// gdscript_workspace.cpp, ~line 240
for (const KeyValue<String, DocData::ClassDoc> &E : doc->class_list) {
    const DocData::ClassDoc &class_data = E.value;
    const bool is_native = !class_data.is_script_doc;
    LSP::DocumentSymbol class_symbol;
    class_symbol.name = class_name;
    class_symbol.native_class = class_name;   // <-- only field that flags "native"
    class_symbol.kind = LSP::SymbolKind::Class;
    class_symbol.detail = String("<Native> class ") + class_name;
    // ... children populated similarly, each child also sets symbol.native_class = class_name
    native_symbols.insert(class_name, class_symbol);
}
```

Critically, `class_symbol.uri` is **never assigned** in this loop. `DocumentSymbol::uri` is default-constructed (empty `String`) for every native symbol. This applies to every built-in class the engine documents: `Node`, `Vector2`, `Dictionary`, `RefCounted`, `Object`, autoloads-as-classes, etc.

### 3.2 `definition` filters out empty-URI symbols

The `textDocument/definition` handler routes through `find_symbols` (`gdscript_text_document.cpp`, ~line 467):

```cpp
Array GDScriptTextDocument::find_symbols(...) {
    Array arr;
    const LSP::DocumentSymbol *symbol = workspace->resolve_symbol(p_location);
    if (symbol) {
        LSP::Location location;
        location.uri = symbol->uri;
        if (!location.uri.is_empty()) {                          // <-- gate
            location.range = symbol->selectionRange;
            const String &path = workspace->get_file_path(symbol->uri);
            if (file_checker->file_exists(path)) {               // <-- second gate
                arr.push_back(location.to_json());
            }
        }
        r_list.push_back(symbol);                                // symbol still recorded
    } else if (is_smart_resolve_enabled()) {
        // ... smart-resolve fallback over related symbols
    }
    return arr;                                                  // empty for natives
}
```

Two gates discard native symbols:

1. **`location.uri.is_empty()` check** — native symbols never have a uri; gate fails.
2. **`file_checker->file_exists(path)`** — even if a URI were synthesised, it would also have to pass a real filesystem readability check, so any `gdscript://` / `godot://` synthetic scheme would be rejected unless `get_file_path` mapped it to a real on-disk path.

Note also that `r_list.push_back(symbol)` runs **regardless of URI presence**. The native symbol *is* tracked in the out-parameter; it is the JSON response that is empty. This is the key fact `declaration` exploits (see §3.3).

### 3.3 `declaration` has a hidden side-channel for natives

`textDocument/declaration` calls the same `find_symbols` but inspects `r_list` afterwards (`gdscript_text_document.cpp`, ~line 405):

```cpp
Variant GDScriptTextDocument::declaration(const Dictionary &p_params) {
    // ... find_symbols ...
    if (arr.is_empty() && !symbols.is_empty() && !symbols.front()->get()->native_class.is_empty()) {
        const LSP::DocumentSymbol *symbol = symbols.front()->get();
        if (is_goto_native_symbols_enabled()) {
            // Build "class_method:Node:add_child" style id and fire a deferred callable_mp
            // that drives the editor's built-in help viewer. This is in-editor only.
            callable_mp(this, &GDScriptTextDocument::show_native_symbol_in_editor).call_deferred(id);
        } else {
            notify_client_show_symbol(symbol);                    // <-- LSP notification path
        }
    }
    return arr;                                                   // still the empty array
}
```

When `network/language_server/show_native_symbols_in_editor` is **disabled** (the typical case for an external client like ours), the server **pushes a notification** to the client:

- Method: `gdscript/show_native_symbol` (non-standard, server→client notification).
- Params: the full `DocumentSymbol` JSON for the native (including rendered docs).

The LSP response to `textDocument/declaration` itself is still the empty array — the docs come over a separate notification. This is significant: an LSP client that ignores unknown notifications (most do) will see only the empty array and miss the docs.

`textDocument/definition` does **not** have this side-channel. It returns the empty array and is silent about the native symbol.

### 3.4 Hover does work for natives

`textDocument/hover` (`gdscript_text_document.cpp`, ~line 369) uses the same `resolve_symbol` but renders directly:

```cpp
Variant GDScriptTextDocument::hover(const Dictionary &p_params) {
    const LSP::DocumentSymbol *symbol = workspace->resolve_symbol(params);
    if (symbol) {
        LSP::Hover hover;
        hover.contents = symbol->render();   // works for native — render() pulls docs
        hover.range.start = params.position;
        hover.range.end = params.position;
        return hover.to_json();
    }
    // smart-resolve fallback ...
}
```

Hover does not gate on `uri`. A native symbol renders fine — `symbol->render()` returns the formatted documentation built from `class_data.brief_description` + `class_data.description` (plus signature for methods). **This is the primary observable signal for distinguishing "native resolved" from "nothing under cursor".**

### 3.5 References work, but only over user code

`textDocument/references` resolves via `resolve_symbol` then calls `find_all_usages(*symbol)` (`gdscript_workspace.cpp`, ~line 473), which scans every `.gd` file under `res://`. The returned `Location[]` therefore consists of `file://` URIs pointing at the user's scripts where the native is *used* — never the engine source. There is no declaration entry in the array (the native has no `selectionRange` in any disk file).

---

## 4. Response shapes by symbol category

The following table summarises expected response shapes for each LSP method, based on the source-code paths above. Until empirical verification (§6) is done, treat these as predicted shapes derived from source-code inference.

| Symbol category                        | `definition`                    | `declaration`                                                    | `hover`            | `references`                                | `documentSymbol` |
| -------------------------------------- | ------------------------------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------------- | ---------------- |
| User func/var (same file)              | `[{uri: "file://…", range: …}]` | same as definition                                               | populated          | user-code usages                            | included         |
| User func/var (other file in project)  | `[{uri: "file://…", range: …}]` | same                                                             | populated          | user-code usages                            | not included     |
| `Node.add_child` (native method)       | **`[]`**                        | `[]` + `gdscript/show_native_symbol` notification (out-of-band)  | populated          | user-code usages (no engine-side decl)      | n/a              |
| `Vector2.length` (native method)       | **`[]`**                        | `[]` + notification                                              | populated          | user-code usages                            | n/a              |
| `Dictionary.keys` (native method)      | **`[]`**                        | `[]` + notification                                              | populated *        | user-code usages                            | n/a              |
| `RefCounted` (native class)            | **`[]`**                        | `[]` + notification                                              | populated          | user-code usages                            | n/a              |
| Built-in constant (e.g. `INF`, `PI`)   | **`[]`**                        | `[]` + notification                                              | populated          | user-code usages                            | n/a              |
| Built-in enum value                    | **`[]`**                        | `[]` + notification                                              | populated          | user-code usages                            | n/a              |
| Autoload class name                    | `[{uri: "file://…", range: …}]` | same                                                             | populated          | user-code usages                            | included         |
| Unknown / no symbol at cursor          | `[]`                            | `[]`                                                             | `null` / `{}`      | `[]`                                        | n/a              |

`*` The Dictionary-specific error reported in [godot#111400](https://github.com/godotengine/godot/issues/111400) appears to be a downstream-client bug (the user's external editor failing to render hover contents for built-in container types), not a server-side regression — the server-side code path is identical to `Vector2`. We should still cover it explicitly in the integration fixture (§6) because the upstream report is recent and not closed.

### 4.1 Critical ambiguity: empty `definition` array

The empty array from `textDocument/definition` carries **two different meanings**:

- "No symbol at cursor / position out of bounds / unknown identifier."
- "Symbol resolved to a built-in that has no on-disk definition."

The LSP wire-level response is identical. Disambiguation requires a follow-up probe. Recommendation: use `hover` (§4.2).

### 4.2 Disambiguation via hover

A combined probe pattern:

```text
client                     server
  ── textDocument/hover ─────►
                            ◄── hover result
  ── textDocument/definition ►
                            ◄── definition result

if definition.length == 0:
    if hover.contents is empty/null → genuine no-symbol → return empty
    if hover.contents has content   → native-redirect → look up in docs
```

Hover never lies about whether a symbol exists at the position — it shares `resolve_symbol` with definition but does not gate on `uri`. This makes hover the canonical disambiguator.

### 4.3 Disambiguation via `gdscript/show_native_symbol` notifications

In principle a client could call `textDocument/declaration` instead of (or in addition to) `definition` and watch for an inbound `gdscript/show_native_symbol` server-push. Two reasons **not** to rely on this:

- It is a notification, not a response — correlating it to a specific in-flight request is fragile (no request id).
- It only fires when `network/language_server/show_native_symbols_in_editor` is `false` in the running editor's settings. This setting is editor-side configuration we cannot guarantee from the LSP client; a user running their own editor alongside the headless LSP could have toggled it.

The notification is still useful as a *secondary* signal — if the adapter sees it, that confirms native; but the adapter must not require it to function correctly.

### 4.4 Disambiguation via `textDocument/nativeSymbol` (custom method)

Godot registers a non-standard JSON-RPC method `textDocument/nativeSymbol` (`gdscript_language_protocol.cpp` line 574, `gdscript_text_document.cpp` line 140). Params:

```json
{ "native_class": "Node", "symbol_name": "add_child" }
```

Returns the full `DocumentSymbol` JSON for the matched native symbol, or `null` if not found. This is **not a position-based query** — the caller must already know the class+symbol name (typically from hover-resolved name plus the symbol's containing class, or from completion-item `data`).

This method is therefore most useful for *implementing the docs redirect's pre-flight check* ("is `Node.add_child` a known native?") rather than for routing the original cursor-based query. Our adapter doesn't strictly need it — once we know we have a native, we should hand off to the docs subsystem (`godot_find_member`) which has its own offline XML index — but it is a useful cross-check during development of the integration fixture.

---

## 5. Recommendations for `godot_find_definition`

### 5.1 Adapter logic (concrete)

```text
function godot_find_definition(position_or_name):
    # 1. Resolve to (file, line, char). Symbol-name fallback handled per DESIGN.md.
    pos = resolve_position(position_or_name)
    if pos is null:
        return { results: [], source: "lsp" }   # symbol_name didn't resolve

    # 2. Issue parallel hover + definition requests.
    [hover_result, defn_result] = await Promise.all([
        lsp.send("textDocument/hover", pos),
        lsp.send("textDocument/definition", pos),
    ])

    # 3. Definition has on-disk results → return them.
    if defn_result.length > 0:
        return { results: defn_result, source: "lsp" }

    # 4. Definition empty but hover populated → native redirect.
    if hover_has_contents(hover_result):
        # Extract class + member from hover.contents. The MarkdownString rendered
        # by symbol->render() includes a "<Native> class Name" or "func Class.name(...)"
        # header line; the docs subsystem parses class+member from it.
        # Alternatively, derive class+member by re-running resolve_symbol on the
        # docs-side parser (the docs subsystem has its own GDScript AST mini-walker
        # for the same purpose — see #14).
        redirect = docs.find_member(class, member)
        return { results: redirect.matches, source: "docs", redirect_reason: "builtin" }

    # 5. Both empty → genuine miss.
    return { results: [], source: "lsp" }
```

### 5.2 What the adapter should NOT do

- **Do not** match on URI schemes like `gdscript://` or `godot://`. They are never produced by the server. A check like `if (uri.startsWith("gdscript://")) redirect()` is dead code.
- **Do not** rely on `fs.access(R_OK)` failing as the trigger. The server already runs this check before emitting a `Location`; you will never receive a URI that fails it. The DESIGN.md § Built-in symbol redirect bullet currently suggests this as one of two options ("synthetic scheme OR fs-readability heuristic") — both are unreachable. The decision recorded for #13 should be: **hover-content presence**, not URI inspection.
- **Do not** assume `gdscript/show_native_symbol` server-pushes will arrive. They depend on editor-side configuration; the adapter must work without them.
- **Do not** depend on `textDocument/nativeSymbol` being present. It is a Godot-specific extension; if Godot's LSP ever standardises or the method moves, the adapter should degrade to hover-only.

### 5.3 Recommended update to DESIGN.md § LSP subsystem

Replace the current text in DESIGN.md § Per-server adapter:

> **Built-in symbol redirect:** When `godot_find_definition` resolves to a URI that fails an `fs.access(R_OK)` check (or matches a synthetic `gdscript://` / `godot://` scheme), the adapter redirects the result to a docs-subsystem lookup against `godot_find_member`.

with:

> **Built-in symbol redirect:** Godot's LSP returns an **empty `Location[]`** from `textDocument/definition` for any symbol resolving to a native (engine-defined) class/method/property/constant/signal/enum — there is no synthetic URI and no engine-source path (see [docs/research/godot-lsp-builtins.md](research/godot-lsp-builtins.md)). The adapter disambiguates the empty array via a parallel `textDocument/hover` probe: empty `definition` + populated `hover.contents` ⇒ redirect to `godot_find_member` with the native class+member parsed from the hover rendering. The redirected result carries `source: "docs"`.

### 5.4 Performance note

The hover+definition parallel pattern doubles per-call wire traffic vs. definition-only. Mitigations:

- Both calls are O(1) once `resolve_symbol` is cached (and it is — see `ExtendGDScriptParser` caching in `gdscript_workspace.cpp`). The server-side cost is negligible compared to the client→server RTT.
- Local-loopback TCP RTT for a JSON-RPC roundtrip is sub-millisecond; doubling it is invisible.
- The `Promise.all` keeps both in-flight concurrently; the client doesn't serialise them.

No optimisation needed in v1. If profiling later shows this is hot, an alternative is "definition-first, hover-only-on-empty" which trades one RTT for the common case (user-code definition) and pays two RTTs only for the redirect case.

---

## 6. Integration test fixture (specification for the implementer)

Once a Godot 4.x binary is available in CI (after Wave 0) and the LSP client lands (after #8), record real responses for this minimal fixture project and pin them as JSON in `tests/lsp/integration/builtin_definitions/`.

### 6.1 Fixture project

`tests/lsp/integration/builtin_definitions/project/project.godot`:

```ini
config_version=5

[application]
config/name="lsp-builtin-fixture"
config/features=PackedStringArray("4.6")
```

`tests/lsp/integration/builtin_definitions/project/Player.gd`:

```gdscript
extends Node

const SPEED = 200.0
var velocity := Vector2.ZERO
var inventory := {}

func _ready() -> void:
    var child := Node.new()
    add_child(child)                                   # cursor on add_child → native method
    velocity = Vector2(SPEED, 0)                       # cursor on Vector2 → native class
    var length := velocity.length()                    # cursor on length → native method on struct
    inventory["key"] = "value"
    var keys := inventory.keys()                       # cursor on keys → native method on container
    var rc := RefCounted.new()
    rc.unreference()                                   # cursor on unreference → native inherited
    spawn_enemy()                                      # cursor on spawn_enemy → user-defined (control case)

func spawn_enemy() -> void:
    pass
```

### 6.2 Recorded responses

For each cursor position above, record `(hover, definition, declaration, references)`. Store as `<position-id>.<method>.json` so a regression diff is per-method and easy to bisect. Use `4.5.json` / `4.6.json` directory suffix so version-specific deltas surface immediately.

Suggested directory shape:

```
tests/lsp/integration/builtin_definitions/
  project/                          # fixture project
  responses/
    4.6/
      add_child.definition.json     # expect: []
      add_child.declaration.json    # expect: []
      add_child.hover.json          # expect: populated
      vector2_length.definition.json
      vector2_length.hover.json
      ...
      spawn_enemy.definition.json   # expect: populated, control case
      spawn_enemy.hover.json
```

### 6.3 Pin behaviour, not exact bytes

For `hover.contents` (which contains rendered Markdown including localised docs) the test should assert structural properties — non-empty contents, expected `native_class` referenced — rather than byte-equality. The doc text changes between Godot patch releases and would produce noisy diffs.

For `definition.json` / `references.json` byte-equal pinning is fine because the shapes are tiny and stable.

### 6.4 Capability check

Before recording, log the `initialize` response capabilities and pin them too. DESIGN.md § Known Godot LSP server capabilities expects:

```
textDocumentSync = 1 (Full)
hoverProvider, definitionProvider, referencesProvider,
documentSymbolProvider, signatureHelpProvider, renameProvider,
completionProvider, codeLensProvider, documentHighlightProvider,
foldingRangeProvider, documentLinkProvider, colorPresentationProvider
```

Confirm `codeActionProvider` is still absent (per godot-proposals#14307 — DESIGN.md § Deferred for v1.1).

---

## 7. Open questions for the integration test pass

The following are not blockers for #20/#13 design but should be answered when the integration fixture is recorded:

1. **Does hover for `Dictionary.keys` differ from `Vector2.length` server-side?** Source says no, but [godot#111400](https://github.com/godotengine/godot/issues/111400) reports user-visible differences. Likely client-side, but worth confirming on a single fixture.
2. **Does `references` on a native method find usages in *script docstrings*?** `find_usages_in_file` does a token-stream scan over the script body; docstring comments shouldn't match but worth verifying.
3. **Does `gdscript/show_native_symbol` notification fire in headless `--editor` mode at all?** The handler defers via `callable_mp(...).call_deferred()` which depends on the main loop; if headless cycles the main loop differently this may not arrive. (Probably fine — the headless editor still runs a main loop — but worth a test.)
4. **What does `textDocument/nativeSymbol` return when only `native_class` is provided (no `symbol_name`)?** Source suggests it returns the class symbol itself (with children populated). Worth confirming for adapter use.

None of these change the fundamental conclusion in §1.

---

## 8. Failure-handling note (per orchestration plan §1)

Empirical capture against a running Godot LSP was **not** completed in this research pass. The Claude Code auto-mode permission classifier blocked download of a Godot 4.x portable binary. The source-code analysis above is sufficient to make the design decision for #13 / #20, but the integration fixture in §6 remains to be recorded by a future agent or by the implementer of #45 (LSP correctness benchmark) once a Godot 4.x binary is available in CI.

To unblock the empirical capture in a future session, either:

- Pre-install Godot 4.6.2 on the developer machine and set `GODOT_PATH`, or
- Add a permission rule allowing `curl -L https://github.com/godotengine/godot/releases/download/*` in the Claude Code settings.

The Wave 0 CI work already plans Godot installation in CI runners, so the integration fixture will be recordable from CI as a side-effect of #8 landing.
