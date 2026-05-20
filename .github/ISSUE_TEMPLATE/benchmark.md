---
name: Benchmark
about: Quality / correctness benchmark from the DESIGN.md testing section
title: "Benchmark: <metric>"
labels: ["benchmark"]
---

**Source:** [docs/DESIGN.md § Testing and benchmarks → \<metric\>](https://github.com/riverbank-studio/godot-mcp/blob/main/docs/DESIGN.md#<anchor>)

**Goal:** \<One sentence — what does this benchmark prove or disprove?\>

**Method:** \<Inputs (fixture set, query set), measurement (precision/recall, latency, exact-match), comparison if any (model vs model, config vs config).\>

**Acceptance:** \<Hardcoded threshold, OR "diagnostic only — no hardcoded gate; useful when X" pattern.\>

## Deliverable

- [ ] Benchmark harness at `benchmarks/<name>/`
- [ ] Fixture set checked in (or referenced from its curation issue)
- [ ] Reproducible run script (e.g. `npm run bench:<name>`)
- [ ] Findings reported as an issue comment OR `docs/benchmarks/<name>.md`

**Depends on:** \<tools/subsystems that must exist before this can run\>
