---
name: Research investigation
about: Open question that needs characterization before implementation
title: "Research: <question>"
labels: ["research"]
---

**Source:** [docs/DESIGN.md § \<section\>](https://github.com/riverbank-studio/godot-mcp/blob/main/docs/DESIGN.md#<anchor>)

> \<The open question, phrased so it admits a concrete answer (yes/no, a value, a behavioral characterization).\>

## Why this matters

\<What downstream decision depends on the answer? Which sibling issues are blocked or risk being mis-specified?\>

## Investigation plan

- [ ] \<Step 1: e.g. run a probe against Godot's LSP and capture the response shape\>
- [ ] \<Step 2: ...\>
- [ ] Capture findings as a `docs/research/<topic>.md` report PR

## Deliverable

A `docs/research/<topic>.md` markdown report containing:

- The question, restated
- Method (commands, queries, fixtures used — reproducible)
- Raw observations (logs, JSON, screenshots)
- Conclusion + recommendation for any downstream issues

**Depends on:** \<blockers, e.g. #8 for LSP-touching research\>
