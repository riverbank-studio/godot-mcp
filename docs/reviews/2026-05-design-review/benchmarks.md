# Benchmark / acceptance-criteria review

Reviewer seat: benchmark + acceptance-criteria. Scope is whether the criteria in DESIGN.md § Testing and benchmarks and the Acceptance sections of issues #3-#39 are actually measurable, whether the measurement infrastructure (datasets, scoring rubrics, budget, cadence, owners) is tracked anywhere, and what's missing.

## Findings

- **[severity: high]** **[scope: design + issue:#31]**
  Benchmark #31 ("End-to-end GDScript correctness") is named "the headline metric" in DESIGN.md § Testing and benchmarks → 2 but the only acceptance criterion is "The MCP should produce measurable improvement" (DESIGN.md L561, mirrored verbatim in #31 body). There is no defined metric, no defined scoring rubric, no defined ground-truth format, no defined task set, no defined model held constant, no baseline measurement, no statistical-significance threshold, and no minimum delta that would count as "measurable improvement". As stated this is unfalsifiable — any non-negative delta could be claimed as success, any negative delta dismissed as noise. A reasonable concrete rubric to propose: a per-task 3-point score (0 = compile/parse fail or wrong API; 1 = compiles and approximates intent but uses wrong/deprecated API or missing edge cases; 2 = matches ground truth in correctness and is version-appropriate), with the gate being "MCP-on mean score ≥ MCP-off mean score + 0.3 across ≥ 30 tasks, p < 0.05 by paired t-test". Complement that with a programmatic compile-success + API-version-match check (counts tokens against the chosen `GODOT_DOCS_VERSION` class/member tables) so the human rubric isn't the only signal.
  *Recommended action:* edit DESIGN.md § Testing and benchmarks → 2 to specify the metric, rubric, baseline, and gate; mirror into #31 body. Open a separate issue for "Curate GDScript task set for benchmark #31" (dataset is an artifact in its own right; see next finding).

- **[severity: high]** **[scope: design + issue:#31, #32]**
  No issue tracks the curation of any benchmark dataset. #31 needs "a curated set of GDScript tasks" with ground truth; #32 needs "~50 tutorial queries with known correct answer locations". Neither dataset exists, neither has an owner, neither has a location decided (in-repo `benchmarks/`? external?), neither has a schema. The benchmarks cannot run until these exist. As written, the dependency is invisible — #31 depends on #7, #9 and #32 depends on #6, #7, but the actual blocking dependency is "labeled dataset X exists" with no issue to track it.
  *Recommended action:* open three new issues — "Curate ~50 tutorial query/answer set for benchmark #32", "Curate ~50–80 GDScript task/ground-truth set for benchmark #31", "Decide benchmark dataset storage location and schema" — and add them as `Depends on:` for #31 and #32. Specify whether tutorial chunks or pages are the unit of ground-truth labeling for #32 (see next finding).

- **[severity: high]** **[scope: issue:#32]**
  The #32 acceptance criteria "Recall@5 ≥ 80%" and "Recall@1 ≥ 50%" require a labeled set where each query maps to a known correct *chunk*, but tutorial chunks are derived artifacts (DESIGN.md § Ingestion pipeline step 6: chunk by H2, soft cap 1500, hard cap 3000, H3-split on overflow). The set of chunks changes whenever chunking config changes — which is exactly what Part C ("Run benchmark #2 across two or more chunking configurations") proposes to vary. A query labeled to "chunk #14 of page X" under config A is meaningless under config B. The unit of ground truth must be page-level (or section-level by stable heading anchor), not chunk-level — and the recall-target language needs to be reworded to "the chunk(s) overlapping the labeled page/section appear in top 5".
  *Recommended action:* edit #32 Acceptance to clarify ground-truth granularity (page or stable heading anchor, not chunk ID) and reword recall criteria accordingly. Mirror into DESIGN.md § Testing and benchmarks → 3 acceptance list.

- **[severity: high]** **[scope: design + issue:#30]**
  Benchmark #30 (tool-routing accuracy) requires tool *descriptions* that are good enough to route on. DESIGN.md § Tool descriptions (L100-112) states "Each description's first sentence is the primary routing signal — written to disambiguate from peers" and lists three disambiguation pairs to maintain. But no issue actually tracks "draft and review the routing-signal first sentences for all 30 tools as a deliverable". The tool issues (#14-#29) mention the disambiguation pairs in passing but treat description-writing as an implicit part of each tool's implementation. Benchmark #30 will be running against descriptions whose first-sentence quality was never explicitly reviewed against the disambiguation matrix.
  *Recommended action:* open a new issue "Draft and review tool-description routing-signal first sentences (all 30 tools)" with the disambiguation pairs from DESIGN.md L107-112 as the rubric; make #30 depend on it; this is also closely tied to the Agent UX lane and should be flagged for that reviewer.

- **[severity: high]** **[scope: design + issue:#30]**
  Benchmark #30 design uses `tool_choice: "any"` against ~50-100 queries and measures per-tool precision/recall. But the DESIGN.md hypothesis is specifically that "the first sentence is the primary routing signal" — and a single end-to-end precision/recall number can't isolate first-sentence quality from name quality, parameter-schema quality, or peer-description interference. If #30 misses, the team has no instrument to tell which lever to pull. The benchmark should include an ablation: at minimum, run the same query set with (a) full description, (b) first-sentence only, (c) name + parameter schema only. Without it the benchmark validates "agents pick the right tool" but does not validate the specific design claim that first sentences carry the routing weight.
  *Recommended action:* edit DESIGN.md § Testing and benchmarks → 1 Method to add ablation runs; mirror into #30. Alternatively, accept that #30 is a coarse diagnostic only and explicitly call out that ablation is out of scope (current text says "diagnostic, not a gate" — that framing is consistent with skipping ablation, but the disambiguation claim then becomes untested).

- **[severity: medium]** **[scope: design + issues:#30, #31, #32]**
  No benchmark has a budget. #30 calls Anthropic API ~50-100 queries × 2 models (Opus, Sonnet) = ~200 calls per run; #31 calls a model on every task × MCP-on/MCP-off × however many tasks; #32 Part B calls a model on 50 queries; #32 Part C multiplies by N chunking configs. Costs are real and unbounded as written. Nothing tracks Anthropic API spend, nothing tracks who's authorised to spend, nothing tracks per-run budget caps. This will block running any of the three benchmarks until a budget is found ad hoc.
  *Recommended action:* edit DESIGN.md § Testing and benchmarks to add a "Cost and budget" subsection with rough per-run cost estimates and an authorisation note; or add an `## Operational` section to each of #30/#31/#32 listing estimated cost per run and approval requirements.

- **[severity: medium]** **[scope: design + issues:#30, #31, #32]**
  No benchmark has a defined cadence. Should #30 run on every PR that touches a tool description? On every PR that adds a tool? Periodically? Manually-triggered only? Same question for #31 and #32. DESIGN.md § Testing and benchmarks → 1 says "Optional during implementation. Cheap to set up." which implies on-demand only — but #31 ("the headline metric, the thing that tells you whether the project succeeded") presumably needs to run before any v1 release and on any change to retrieval/chunking. None of this is written down. Without a cadence the benchmarks risk being run once at design time and never again.
  *Recommended action:* edit DESIGN.md § Testing and benchmarks to specify cadence per benchmark (suggest: #30 on-demand and on tool-description PRs; #31 pre-release and on retrieval-touching PRs; #32 pre-release and on any chunking/ingest PR). Mirror to issue bodies.

- **[severity: medium]** **[scope: issue:#32]**
  "Manual inspection of 20 random chunks: all coherent standalone reads" (#32 Acceptance, DESIGN.md L582) has no defined inspector, no rubric for "coherent", no rule for "all" vs "majority", and no clear cadence (once at design time, or per chunking-config revision?). If the same inspector inspects every revision the criterion is consistent but unblinded; if different inspectors, the bar drifts. Concrete proposal: keep the 20-chunk sample fixed (drawn once with a seeded RNG), define "coherent" as "the chunk read in isolation tells a complete enough sub-topic that an LLM given only the chunk could answer a tutorial question that the chunk should cover", and require two reviewers to agree on ≥ 18/20.
  *Recommended action:* edit #32 Acceptance to specify inspector role, rubric, sample stability across revisions, and pass threshold.

- **[severity: medium]** **[scope: design + issue:#32]**
  Part C of #32 ("Run benchmark #2 across two or more chunking configurations. Compare downstream correctness. Used for picking between viable strategies, not a pass/fail gate.") is a research methodology, not a unit of deliverable work. There is no acceptance criterion for "Part C done" — it could be claimed satisfied by running two configs once with no documented outcome. It's also coupled to #31 (it explicitly *is* "benchmark #2" run repeatedly), but #31 is itself unspecified (see first finding), so Part C inherits all the same problems. Either Part C should be split into its own issue with a deliverable ("a written A/B report comparing at least two chunking configs A and B on the #31 task set, with a recommendation"), or it should be removed from #32's acceptance and moved into the "Tuning levers" prose at L584.
  *Recommended action:* split Part C into a new follow-up issue "Chunking-config A/B comparison report" depending on #31 and #32; remove from #32 Part A+B acceptance list (which is currently the only gated criteria).

- **[severity: medium]** **[scope: issues:#33-#39]**
  None of the seven research items has any closure criterion. Each says "Informs: #N" but never "Done when: ..." or "Output: ...". A research item could sit open forever — there's no signal for when investigation has produced enough information to act. Concrete proposal for all seven: add an "Output" section listing the artifact (e.g., #34: "a paragraph in DESIGN.md § LSP subsystem documenting the actual response shape for built-in symbols, plus a decision recorded in #20 on whether to special-case or pass through"); add a "Done when" line.
  *Recommended action:* edit each of #33-#39 to add `**Output:**` and `**Done when:**` sections. As a batch this is six similar edits.

- **[severity: medium]** **[scope: issue:#12, #13, #11]**
  The follow-up epics #11 (auto-republish CI), #12 (symbol-based LSP resolution), #13 (per-server LSP adapter) have no acceptance section at all. Even granting that follow-ups are scoped loosely, "Deferred to post-v1" with no closure criterion means these issues can never be objectively closed. #11 has a "Required design concerns" list which is close to acceptance criteria but isn't framed as such; #12 and #13 have nothing.
  *Recommended action:* add minimal acceptance bullet lists to #11/#12/#13. For #11, promote the "Required design concerns" list to `**Acceptance**`. For #12/#13, write 2-3 lines.

- **[severity: low]** **[scope: issue:#7]**
  The #7 (docs tools epic) acceptance is "All 6 sub-issues closed" + "Disambiguation pairs from DESIGN.md maintained in tool descriptions". The disambiguation criterion is unmeasurable — there's no rubric for "maintained". Could be partially addressed by referencing the new tool-descriptions issue from finding #4 above.
  *Recommended action:* once the tool-descriptions issue exists, replace #7's second bullet with `**Depends on:** <new issue>`.

- **[severity: low]** **[scope: issues:#14-#29]**
  None of the 16 individual tool issues has its own Acceptance section. Each describes behavior in prose, but there's no checkbox criteria like "input validation rejects unspecified `kind` with X message" or "case-mismatch returns suggestions in field Y". This makes per-tool PR review more subjective than it has to be. For #25 specifically the "2s timeout" is in prose but not as a checkbox; for #22 the 5000-char truncation likewise; for #23 the 500-symbol cap likewise. Magnitudes embedded in prose tend to be skimmed past in review.
  *Recommended action:* either add a minimal `**Acceptance**` checklist to each tool issue surfacing the load-bearing numbers and edge cases, or accept that the parent epics (#7, #9, #10) gate via "all sub-issues closed" and that per-tool review is done in PR description. If accepted, no change.

- **[severity: low]** **[scope: design]**
  DESIGN.md § Testing and benchmarks does not specify where benchmark scaffolding lives in the repo (`benchmarks/`? `scripts/benchmarks/`?), what package manages the harness (custom Node script? a test runner?), or whether benchmark code is shipped in the npm package (it shouldn't be). Without this convention each benchmark will be set up ad hoc and the three will not share scaffolding even when they could (e.g., model invocation, scoring serialization, run-result storage).
  *Recommended action:* add a "Benchmark harness location" paragraph to DESIGN.md § Testing and benchmarks — proposed: `benchmarks/` directory at repo root, excluded from npm publish, results written to `benchmarks/results/{benchmark}/{ISO-date}.json`.

## Acceptance-criteria audit

Mapping every issue to: checkbox criteria / prose criteria / no criteria.

| Issue | Title (abbrev)                                   | Acceptance shape                            |
| ----- | ------------------------------------------------ | ------------------------------------------- |
| #3    | Refactor src/index.ts into modules               | checkbox (5 items)                          |
| #4    | Rename existing tools with godot_ prefix         | checkbox (4 items)                          |
| #5    | Shared infrastructure                            | checkbox (6 items)                          |
| #6    | Docs ingestion pipeline                          | checkbox (7 items)                          |
| #7    | Docs tools (6 tools) epic                        | checkbox (2 items — one unmeasurable)       |
| #8    | LSP client + process management                  | checkbox (6 items)                          |
| #9    | LSP read-only tools epic                         | checkbox (2 items)                          |
| #10   | LSP advisory-write tools epic                    | checkbox (3 items)                          |
| #11   | Follow-up: Auto-republish CI                     | prose (concerns list, not framed as gate)   |
| #12   | Follow-up: Symbol-based LSP resolution           | none                                        |
| #13   | Follow-up: Per-server LSP adapter                | none                                        |
| #14   | godot_search_api                                 | prose (Behavior section, no checkbox)       |
| #15   | godot_get_class                                  | prose                                       |
| #16   | godot_get_member                                 | prose                                       |
| #17   | godot_search_tutorials                           | prose                                       |
| #18   | godot_get_tutorial                               | prose                                       |
| #19   | godot_docs_info                                  | prose                                       |
| #20   | godot_find_definition                            | prose                                       |
| #21   | godot_find_references                            | prose                                       |
| #22   | godot_hover                                      | prose (5000-char cap embedded)              |
| #23   | godot_document_symbols                           | prose (500-symbol cap embedded)             |
| #24   | godot_workspace_symbols                          | prose                                       |
| #25   | godot_get_diagnostics                            | prose (2s timeout embedded)                 |
| #26   | godot_signature_help                             | prose                                       |
| #27   | godot_preview_rename                             | prose                                       |
| #28   | godot_code_actions                               | prose                                       |
| #29   | godot_preview_code_action                        | prose                                       |
| #30   | Benchmark: Tool-routing accuracy                 | prose ("none hardcoded — diagnostic")       |
| #31   | Benchmark: E2E GDScript correctness              | prose (1 unmeasurable sentence)             |
| #32   | Benchmark: Chunking quality + correctness        | checkbox (6 items — see findings)           |
| #33   | Research: concurrent project access              | none (informs only)                         |
| #34   | Research: built-in symbol definitions            | none                                        |
| #35   | Research: LSP capability advertisement           | none                                        |
| #36   | Research: LSP single-client behavior             | none                                        |
| #37   | Research: LSP file watcher behavior              | none                                        |
| #38   | Research: Schema design + Drizzle 1.0            | none                                        |
| #39   | Research: FTS5 tokenizer + BM25 weights          | none                                        |

Summary: 9 issues have checkbox acceptance criteria (#3-#10, #32), 17 have prose-only behavior sections that read as design intent but were not framed as gates (#11, #14-#31), and 11 have no criteria at all (#12, #13, #33-#39 plus the prose-only follow-ups arguably). The benchmarks are the worst-served — the only one with checkboxes (#32) has multiple unmeasurable bullets (see findings).

## Open questions

- Who owns dataset curation for the #31 GDScript task set and the #32 tutorial query set? The implication of the project structure is that the author (bkshrader) does, but unstated.
- Is there an Anthropic API budget allocated for benchmark runs, and a process for refilling it? Without this, finding #6 cannot resolve into concrete numbers.
- Should benchmark code be vendored in this repo or live in a sibling repo? Affects supply-chain footprint of the published npm package.
- Is benchmark #31 expected to compare MCP-enabled vs unmodified Claude only, or also vs MCP-enabled with an alternate doc source (e.g., the upstream `tkmct/godot-doc-mcp`)? The latter would test whether *this* MCP improves over a generic Godot docs MCP, which is a stronger claim than "improves over no docs at all".
- For #32 Part B "feed to a model with the query, score the answer against ground truth" — which model? Different models will score differently on the same retrieved chunks, and the answer-correctness metric drifts with model version. Should be held constant per benchmark generation, with the model version recorded alongside results.
- Should there be a fourth benchmark for LSP correctness — e.g., a curated GDScript repo with known definition/reference locations, used to validate #20/#21? Currently none of the three benchmarks exercise the LSP subsystem at all, even though it's half the new tool surface.

## Out of scope

- **Module organization details** (whether `src/docs/`, `src/lsp/` should be split further; whether benchmark harness lives under `scripts/` or `benchmarks/`). Systems architect.
- **Tool-description wording itself** — the disambiguation pair text, the "prefer this over guessing" line, the per-tool first-sentence drafts. Agent UX. (This memo only flags that no issue tracks drafting the descriptions as a deliverable, and that benchmark #30 depends on them existing.)
- **LSP protocol decisions** — whether capabilities should be discovered vs hardcoded, whether to support semantic tokens, etc. LSP specialist.
- **Retrieval quality details** — whether MiniLM-L6 is the right embedding model, RRF k=60 choice, BM25 weight ratios. Docs specialist. (This memo only flags that the *measurement* of retrieval quality in #32 is under-specified, not the retrieval algorithm itself.)
- **Native-dependency / package security** for `better-sqlite3`, `sqlite-vec`, `@xenova/transformers`. Supply-chain reviewer.
