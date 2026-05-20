---
name: Tool implementation
about: New godot_* tool from the DESIGN.md tool surface
title: "godot_<tool_name>"
labels: ["tool"]
---

**Source:** [docs/DESIGN.md § \<section\>](https://github.com/riverbank-studio/godot-mcp/blob/main/docs/DESIGN.md#<anchor>) (#\<N>)

> \<First-sentence tool description from DESIGN.md. Used to disambiguate from sibling tools.\>

**Behavior**

- \<Data sources / underlying API — FTS5, LSP request, GDScript operation, etc.\>
- \<Parameters: required vs optional, defaults, validation rules\>
- \<Edge cases — empty inputs, missing data, error vs empty-result semantics\>
- \<Disambiguation from sibling tools — what makes this tool distinct from `godot_*`\>

**Schema (sketch)**

```json
{
  "name": "godot_<tool_name>",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Acceptance**

- [ ] Implementation lands at the path defined in DESIGN.md's module organization
- [ ] Unit tests cover the happy path and each edge case above
- [ ] Tool description matches the canonical shape (see #40 once that lands)
- [ ] No regressions in adjacent tools (run full test suite)

**Parent:** #\<epic\> • **Depends on:** #\<blocker\>
