# Agent-team orchestration plan

How a team of Claude Code agents will implement all 38 open issues in this repo in parallel, respecting blocking relationships, using TDD, with one PR per issue.

> Source-of-truth document. Living plan — update it as decisions evolve. Not a design doc; see `docs/DESIGN.md` for what we're building.

---

## 1. Locked-in decisions

| Topic | Choice |
| --- | --- |
| Wave 0 (pre-orchestrator) | User + me set up CI interactively (Godot binary install, build/test/lint workflow, smoke PR). Orchestrator only launches once CI is green. |
| Concurrency cap | None — DAG-driven, peaks ~13 concurrent agents in Wave 4 (renumbered; was Wave 3 before CI became Wave 0) |
| PR granularity | One PR per issue, including each sub-issue under epics #7, #9, #10 |
| Merge policy | Agents open PRs **ready-for-review**; the user merges |
| Non-TDD issues | Research (#34, #39) hand-off to user as `docs/research/<topic>.md` PRs; benchmark/curation issues use acceptance-criteria assertions instead of unit tests |
| Orchestrator | Background `/loop` coordinator agent, tick = 10 min; auto-exits when every issue is in `{Done, Blocked}` |
| Stack rebase | Dependent branches auto-rebase when their blocker PR head moves |
| `dispatch.ts` hotspot | Epic-infra PR for #7 and #9 introduces an auto-discovery registry; per-tool PRs touch only their own file |
| Quality gate | Local `npm test` + `npm run lint` + CI green required before marking ready-for-review |
| Failure handling | Retry once with a fresh agent + fresh worktree; if still failing, open draft PR titled `[BLOCKED] ...` and set Status=Blocked |
| Self-review | Every PR: agent runs `/review`. Tool & LSP PRs additionally run `/security-review` |
| State tracking | GitHub Projects v2 with a `Status` single-select field (`Pending` / `Blocked` / `In-Progress` / `Ready-for-Review` / `Done`); fallback to labels if `project` scope unavailable |
| Research deliverable | `docs/research/<topic>.md` markdown PR |
| Drive-by findings | Implementers file new GH issues via `gh issue create`; PR diffs stay scoped |
| Model + effort tiering | Opus 4.7 + `ultrathink` (architectural), Sonnet 4.6 + `think hard` (leaves/benchmarks), Sonnet 4.6 + `think` (mechanical), Opus 4.7 + `think harder` (research). See §5. |
| Worktree base | `E:\Bradley\Documents\VSCodeProjects\godot-mcp-worktrees\<branch-name>` |

---

## 2. Dependency graph

```
Wave 0 — Interactive CI setup (user + me, no orchestrator yet)
  - Build/test/lint scripts, GH Actions workflow, Godot in CI, smoke PR.
  - See §3.6.

Wave 1 — Foundation (orchestrator launches here, all 9 in parallel):
  #3  Refactor src/index.ts into modules ─┐
  #34 Research: Godot LSP behavior         │  (research)
  #39 Research: FTS5 tokenizer + BM25      │  (research)
  #40 Canonical tool descriptions (14)     │
  #41 Curate GDScript task set             │
  #42 Curate tutorial query set            │
  #43 Native-dep platform matrix           │
  #44 GODOT_MCP_OFFLINE mode               │
  #47 Tarball SHA pinning                  │

Wave 2 (after #3):
  #4  Rename tools with godot_ prefix
  #5  Shared infrastructure                ──┐
                                             │
Wave 3 (after #5):                           │
  #6  Docs ingestion pipeline ──┐            │
  #8  LSP client + process mgmt ───┐         │
                                   │         │
Wave 4 (after #6, #8 — epic-infra PRs first, then per-tool):
  Epic #7 infra → #14, #15, #16, #17, #18, #19   (6 docs tools, parallel)
  Epic #9 infra → #20, #21, #22, #23, #24, #25, #26  (7 LSP read-only tools, parallel)

Wave 5 (after #9):
  Epic #10 → #27  (preview_rename, advisory-write)
  #12 Symbol-based LSP resolution
  #13 Follow-up: Per-server LSP adapter (after #8)

Wave 6 (benchmarks):
  #11 Auto-republish CI    (needs #47, #6)
  #30 Tool-routing bench   (needs #9, #7, #40)
  #31 E2E GDScript bench   (needs #9, #7, #41)
  #32 Chunking bench       (needs #42, #7, #6)
  #45 LSP correctness bench (needs #9, #8)

Wave 7:
  #46 Chunking A/B comparison report (needs #32, #31)
```

**Parallelism profile** (best case, assuming no failures):

| Phase | Concurrent agents |
| --- | --- |
| Wave 0 | 0 (user + me interactive) |
| Wave 1 (Foundation) | 9 |
| Wave 2 | 2 (#4, #5) |
| Wave 3 | 2 (#6, #8) — runs alongside any unfinished Wave 1 |
| Wave 4 | up to 13 (6 docs + 7 LSP tools) + 2 epic-infra = 15 peak |
| Wave 5 | 3 (#10/#27, #12, #13) |
| Wave 6 | up to 5 (benchmarks) |
| Wave 7 | 1 (#46) |

---

## 3. Pre-flight setup

Before launching the coordinator, the user (or one preparatory agent) must do the following **once**:

### 3.1 Token scopes

```pwsh
gh auth refresh -h github.com -s project
```

Adds `read:project` and `project` write scopes so the coordinator can query and mutate the Status field.

### 3.2 Land the DESIGN.md wave-2 branch

The branch `docs/design-amendments-wave-2` (currently checked out, clean) carries the canonical DESIGN.md the implementers will read. It must merge to `main` before agents start, otherwise they'll work against the stale design.

```pwsh
gh pr create --base main --head docs/design-amendments-wave-2 --title "docs: Wave 2 design amendments" --body "..."
# Self-review, merge.
```

### 3.3 Create the GitHub Project + Status field

```pwsh
# One-time. Creates a Project owned by the repo's org with a Status field.
gh project create --owner riverbank-studio --title "godot-mcp build" --format json

# Add Status field options (via GraphQL — gh project field-create is limited).
# Options: Pending (default), Blocked, In-Progress, Ready-for-Review, Done
```

Then add all open issues:

```pwsh
gh issue list --state open --limit 100 --json number --jq '.[].number' |
  ForEach-Object { gh project item-add <project-number> --owner riverbank-studio --url "https://github.com/riverbank-studio/godot-mcp/issues/$_" }
```

Initial Status: every issue → `Pending`.

### 3.4 Worktree base directory and orchestrator state

```pwsh
New-Item -ItemType Directory -Path "E:\Bradley\Documents\VSCodeProjects\godot-mcp-worktrees" -Force
New-Item -ItemType Directory -Path "E:\Bradley\Documents\VSCodeProjects\godot-mcp\.orchestrator" -Force
echo ".orchestrator/" >> .gitignore   # if not already ignored
```

`.orchestrator/state.json` mirrors the Projects v2 state locally so the coordinator can detect drift and resume cleanly after a crash. Shape:

```json
{
  "issues": {
    "3": { "status": "In-Progress", "branch": "feat/3-refactor-index", "pr": null, "worktree": "...", "attempts": 1, "lastTick": "2026-05-20T18:00:00Z" }
  },
  "lastTick": "2026-05-20T18:00:00Z"
}
```

### 3.5 Verify the build pipeline locally

```pwsh
npm install
npm run build
npm test   # if there's no test script yet, it gets added in Wave 0 below
```

### 3.6 Wave 0 — Interactive CI setup (pre-orchestrator)

Done by the user + me together, **not** by the orchestrator. Goals:

- A `test` npm script that runs against `build/` and exits non-zero on failure.
- A `lint` npm script (likely `tsc --noEmit` + an existing linter; the design doc should
  say what's expected).
- GitHub Actions workflow that runs build + test + lint on every PR.
- **Godot binary installed in CI** — every tool PR from Wave 2 onward needs it.
  Most likely: cache a pinned Godot tarball, extract it, expose `GODOT_PATH` to the
  runner's env. The `godot-release-hashes.json` artifact from #47 may inform pinning
  but doesn't need to land first.
- A trivial smoke test that calls one existing tool through `executeOperation`, so we
  know the CI plumbing works before any agent depends on it.

Done = a green CI run on a throwaway PR that exercises build + test + lint + a Godot
invocation. Only then do we bootstrap the coordinator.

---

## 4. The coordinator

A long-running Claude Code agent invoked via `/loop 10m <coordinator-prompt>`. Each tick:

1. **Refresh state**
   - Query Projects v2 for each issue's Status (or labels in fallback mode).
   - Query `gh pr list --state open` for active PRs and their head SHAs.
   - Query `gh pr checks <N>` for CI status on each open PR.
2. **Reconcile**
   - For each issue with `Status=Ready-for-Review` whose PR has been merged externally → mark `Done`.
   - For each PR where a blocker PR's head SHA changed since last tick → enqueue a rebase job (handled by spawning a short-lived rebase agent in the existing worktree).
3. **Launch implementers**
   - Build the set of issues where `Status=Pending` AND every `blockedBy` issue is in `{Ready-for-Review, Done}`.
   - For each, spawn an implementer agent (see §5) in its own worktree. Set `Status=In-Progress` immediately.
4. **Escalations**
   - For any implementer that returned `BLOCKED`, set `Status=Blocked`, post a comment on the issue with the agent's diagnostic.
5. **Heartbeat**
   - Write `.orchestrator/state.json` and `.orchestrator/tick-<n>.log`.
   - Print a one-line summary: `tick 17: 4 in-progress, 2 ready, 1 blocked, 31 pending, 0 done`.
6. **Terminal condition (auto-exit)**
   - If every tracked issue has Status in `{Done, Blocked}` (no Pending, no In-Progress, no Ready-for-Review left), write a final summary to `.orchestrator/final-summary.md` listing what landed, what's blocked, what was filed as new drive-by issues, then set `state.json.terminated = true` and exit the `/loop` (omit the next `ScheduleWakeup`).
   - The user can resume by setting any blocked issue back to Pending and re-invoking `/loop`.

The coordinator does **not** implement issues itself. It only orchestrates.

Coordinator prompt (gist):

```
You are the godot-mcp build coordinator. Read docs/orchestration-plan.md
for the contract. On each tick:
- Refresh state from GH Projects + open PRs + CI checks.
- For ready-to-launch issues (Pending + blockers cleared), spawn an implementer agent via the Agent tool with subagent_type=general-purpose, run_in_background=true, isolation=worktree, and the implementer prompt template from §5. Set Status=In-Progress.
- For PRs whose blocker head SHA changed, spawn a rebase agent.
- For blocked agents, set Status=Blocked and post a comment.
- Update .orchestrator/state.json.
- Print a one-line tick summary.
Never edit code yourself. Never merge PRs.
```

---

## 5. The implementer agent

Each implementer is spawned in its own git worktree. It receives a tailored prompt built from this template. The first line is a thinking-budget trigger — `ultrathink` for architectural PRs (#3, #5, #7-infra, #9-infra, #43, #44, #47, #6, #8), `think hard` for tool leaves and benchmarks, `think` for purely mechanical work (#4, curation):

```
<thinking-trigger>

ROLE: Implement GitHub issue #<N> for riverbank-studio/godot-mcp.

ISSUE: #<N> — <title>
ISSUE URL: https://github.com/riverbank-studio/godot-mcp/issues/<N>
BLOCKED BY: <list of blocker issue numbers and their PR branches if open>

BASE BRANCH:
  - If all blockers are merged: base off origin/main.
  - If any blocker has an open PR: base off the topmost open blocker PR's head branch.
    Branch chain: <list>. Use git rebase --onto if multiple blockers.

BRANCH NAME: <type>/<N>-<slug>
  e.g. feat/14-godot-search-api, refactor/3-modules, chore/47-tarball-sha

WORKTREE: Already created at <path>. cwd is set there.

CONTRACT (must hold for every implementer):
1. Read docs/DESIGN.md first. Then read the full issue body.
2. TDD: write failing tests before implementation. Exceptions:
   - Research issues (#34, #39): produce docs/research/<topic>.md instead.
   - Curation issues (#40, #41, #42): produce the artifact + an assertion script
     that validates the curated dataset's shape.
   - Benchmark issues (#30, #31, #32, #45, #46): build the harness + a small smoke
     fixture + assertions on the harness output shape.
3. Tools available: npm, git, gh, node (>=24), Godot binary at <path-or-detect>.
4. Quality gate before marking ready-for-review:
   a. npm run build && npm test && npm run lint (all green locally)
   b. git push -u origin <branch>
   c. gh pr create --draft --base <base> --head <branch> --title "..." --body "Closes #<N>. ..."
   d. Wait for CI green (`gh pr checks <pr> --watch`).
   e. /review the PR. Address non-trivial findings in a follow-up commit.
   f. If this PR touches src/dispatch.ts, src/tools/, src/lsp/, or any child-process
      spawning code: also run /security-review.
   g. gh pr ready <pr>
   h. Comment on the issue with the PR URL.
   i. Exit with status READY.
5. Failure handling:
   - If after one full attempt (writing tests, implementing, running quality gate,
     fixing review feedback) you cannot reach READY, output a diagnostic of:
     what you tried, what failed, what's needed to unblock. Exit with status BLOCKED.
   - The coordinator will retry once with a fresh worktree before final escalation.
6. Drive-by findings:
   - If you find an unrelated bug, missing test, dead code, security smell, or
     documentation gap that's clearly out of scope for your issue, file it as a
     new GH issue with `gh issue create`. Include: reproduction or pointer
     to the file/line, why it's out of scope here, and a link back to your PR
     (e.g. "Discovered while implementing #<N>").
   - Apply labels matching the area (`area:foundation`, `area:docs`, `area:lsp`)
     and a type label (`bug`, `tech-debt`, `follow-up`, etc.).
   - Do NOT include the drive-by fix in your PR. Keep your diff scoped.
7. Never:
   - Force-push unless rebasing onto a blocker (coordinator handles rebases anyway).
   - Modify .orchestrator/, the coordinator's state, or other agents' worktrees.
   - Merge any PR (yours or others').
   - Add yourself as reviewer or assignee.
   - Touch files outside the scope of your issue (file new issues instead, per §6).
8. Commit message footer (every commit):
   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
9. PR body footer:
   🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

The implementer is `subagent_type=general-purpose`, `isolation=worktree`, `run_in_background=true`.

**Model + effort assignment:**

| Bucket | Issues | Model | Thinking trigger | Effort approximation |
| --- | --- | --- | --- | --- |
| Architectural | #3, #5, #6, #7-infra, #8, #9-infra, #43, #44, #47 | Opus 4.7 | `ultrathink` | max |
| Tool leaves & benchmarks | #14–19, #20–27, #10, #12, #13, #30–32, #45, #46, #11 | Sonnet 4.6 | `think hard` | high |
| Mechanical / curation | #4, #40, #41, #42 | Sonnet 4.6 | `think` | medium |
| Research hand-off | #34, #39 | Opus 4.7 | `think harder` | very high |

The Agent tool doesn't expose an explicit effort/thinking-budget parameter; the
trigger words above are interpreted by the spawned subagent's Claude Code instance
and enable extended thinking at progressively higher budgets. Architectural prompts
also explicitly call for "explore 2–3 alternatives in design notes inline before
writing code"; leaf prompts go straight to "implement, test, ship."

---

## 6. Worktree strategy

```
E:\Bradley\Documents\VSCodeProjects\godot-mcp                          # main checkout
E:\Bradley\Documents\VSCodeProjects\godot-mcp-worktrees\
  feat-3-refactor-index\        # worktree for #3
  feat-4-godot-prefix\          # worktree for #4 (branches from feat/3-refactor-index)
  feat-5-shared-infra\          # worktree for #5
  feat-14-search-api\           # worktree for #14
  ...
```

Each worktree is created by the coordinator with:

```pwsh
git worktree add -b <branch-name> "E:\...\godot-mcp-worktrees\<branch-name>" <base-ref>
```

When the implementer finishes (READY or BLOCKED), the coordinator does **not** prune the worktree yet — it may need re-entering for rebase or escalation work. Worktrees are pruned at end-of-wave or on user command.

Rebase agent (spawned when a blocker's head moves):

```
ROLE: Rebase branch <X> onto updated blocker branch <Y> at SHA <Z>.
cwd is the worktree for <X>.
1. git fetch origin
2. git rebase origin/<Y>
3. If conflicts: attempt automatic resolution following the patterns in CLAUDE.md.
   If you can't resolve cleanly, exit with status REBASE_BLOCKED.
4. npm test
5. git push --force-with-lease
6. /review the PR again only if the diff changed meaningfully.
7. Exit with status REBASED.
```

---

## 7. Hotspot mitigation: auto-discovery registry

The biggest merge-conflict risk is `src/dispatch.ts` — 14 tool PRs would each add an entry. The epic-infra PRs eliminate this:

**Epic #7 infra PR** (lands before #14–19):

```ts
// src/tools/docs-tools.ts (new file)
import { type ToolDefinition } from "../shared/tool-types.js";

export const docsTools: ToolDefinition[] = [];

export function registerDocsTool(def: ToolDefinition) {
  docsTools.push(def);
}
```

```ts
// src/dispatch.ts (modified once, by the epic-infra PR)
import { docsTools } from "./tools/docs-tools.js";
import { lspTools } from "./tools/lsp-tools.js";
// existing editor/scene/project tool imports...

const ALL_TOOLS = [...editorTools, ...sceneTools, ...projectTools, ...docsTools, ...lspTools];
```

Per-tool PRs (e.g. #14 `godot_search_api`):

```ts
// src/tools/docs/search-api.ts (new file — touches nothing else)
import { registerDocsTool } from "../docs-tools.js";

registerDocsTool({
  name: "godot_search_api",
  description: "...",
  inputSchema: { ... },
  handler: async (params) => { ... },
});
```

Plus the tool's own test file. **Zero conflict surface with sibling tool PRs.**

Same pattern for `src/tools/lsp-tools.ts` driven by epic #9's infra PR.

---

## 8. Wave-by-wave forecast

### Wave 0 — Interactive CI setup

User + me in this session (or another), before the coordinator launches. See §3.6. Done = a throwaway PR with build + test + lint + Godot-touching smoke step goes green in CI.

### Wave 1 — Foundation (orchestrator's first tick)

| Issue | Type | Notes |
| --- | --- | --- |
| #3 | refactor | Architectural; Opus 4.7. Blocks the entire chain. Highest priority. |
| #34 | research | docs/research/godot-lsp-builtins.md. Hand back for review. |
| #39 | research | docs/research/fts5-tokenizer-bm25.md. |
| #40 | content | 14 tool descriptions per DESIGN.md. |
| #41 | curation | GDScript task set; output as fixtures/benchmarks/gdscript/*.json. |
| #42 | curation | Tutorial Q/A set; output as fixtures/benchmarks/tutorials/*.json. |
| #43 | infra | Platform matrix + postinstall preflight. May touch package.json scripts. |
| #44 | feature | GODOT_MCP_OFFLINE env + pre-built DB path resolver. |
| #47 | infra | Tarball SHA + godot-release-hashes.json manifest. |

**Conflict watch:** #43, #44, #47 may all touch `package.json` and `scripts/`. Coordinator schedules these to land in declared order if conflicts arise: #43 → #47 → #44.

### Wave 2 — Sequenced behind #3

- #4 `feat/4-godot-prefix` — base off `feat/3-refactor-index` head once that PR opens.
- #5 `feat/5-shared-infra` — base off `feat/3-refactor-index` head.

#4 and #5 don't conflict (one renames exported tool names, the other adds new shared modules), so both run concurrently.

### Wave 3 — Sequenced behind #5

- #6 `feat/6-docs-ingestion` — base off `feat/5-shared-infra` head.
- #8 `feat/8-lsp-client` — base off `feat/5-shared-infra` head.

### Wave 4 — Epic-infra PRs, then leaf tools

For epic #7:
1. `feat/7-docs-tools-infra` — introduces `src/tools/docs-tools.ts` registry + `src/docs/*` helpers consumed by all 6 docs tools.
2. Six concurrent leaves: #14, #15, #16, #17, #18, #19. Each branches from `feat/7-docs-tools-infra` head.

For epic #9:
1. `feat/9-lsp-tools-infra` — registry + LSP request/response helpers.
2. Seven concurrent leaves: #20, #21, #22, #23, #24, #25, #26.

The two epic-infra PRs can run concurrently with each other. Their leaves can run concurrently too — **15 concurrent agents at peak** (2 epic-infra + 13 leaves).

### Wave 5

- #10/#27 — base off `feat/9-lsp-tools-infra` head (or main if #9 has merged).
- #12 — base off main once #9 merges (or off the read-only tools epic head if needed).
- #13 — base off `feat/8-lsp-client` head.

### Wave 6 — Benchmarks

All five run concurrently once their blockers are open:
- #11 needs #47 + #6
- #30 needs #9 (read-only LSP), #7 (docs tools), #40
- #31 needs #9, #7, #41
- #32 needs #42, #7, #6
- #45 needs #9, #8

### Wave 7

- #46 — runs after #32 and #31. Single agent. Coordinator auto-exits after this lands or escalates.

---

## 9. Failure escalation flow

```
implementer exits BLOCKED
   │
   ├─ coordinator increments attempts counter
   │
   ├─ attempts == 1?
   │   yes: prune worktree, recreate fresh, respawn implementer.
   │   no:  open draft PR titled "[BLOCKED] #<N>: <title>" with the diagnostic
   │        as the body. Set Status=Blocked. Post comment on issue tagging
   │        @<user> with what's needed.
   │
   └─ coordinator skips this issue on subsequent ticks until user resets
      Status=Pending in the project.
```

A rebase agent that exits `REBASE_BLOCKED` triggers the same path against the *dependent* PR, not the blocker.

---

## 10. Risks and known weak spots

1. **DESIGN.md ambiguity.** Several issues will hit places where DESIGN.md is silent. Implementers must default to opening a draft PR with `[QUESTION]` in the title rather than guessing.
2. **CI duration.** If CI takes >10 min, the coordinator's tick may launch dependents from a stale PR head. Mitigation: coordinator polls `gh pr checks --watch` instead of just snapshotting status each tick.
3. **Auto-rebase storms in Wave 3.** When 13 tool PRs all sit on top of one epic-infra PR and the epic-infra PR gets review changes, 13 rebases queue up. Mitigation: rebases run serially per blocker, not in parallel.
4. **Token cost.** No concurrency cap × 13 concurrent agents × `ultrathink`/`think hard` triggers × multi-step implementations can spend significantly. Mitigation: model + thinking-trigger tiering per §5; Sonnet 4.6 with `think hard` (not `ultrathink`) for leaves; reserved Opus 4.7 + `ultrathink` for architectural PRs only.
5. **`activeProcess` model in `run_project`.** Not relevant to most issues, but a few may need to touch it; flag as architectural.
6. **Drive-by issue spam.** Implementers may file many low-value follow-up issues. Mitigation: §5 item 6 requires a concrete pointer to the file/line and a one-line "why it's out of scope here"; coordinator can review the issues each tick and the user can close noisy ones.

---

## 11. Bootstrapping the orchestrator

Once pre-flight (§3) is complete:

```pwsh
# In the main checkout:
/loop 10m "You are the godot-mcp build coordinator. Read docs/orchestration-plan.md
sections 4 and 5 for your contract. Run one tick now."
```

The first tick will:
- Inspect `Status=Pending` issues, find all foundation-wave issues unblocked
- Create 9 worktrees under `godot-mcp-worktrees\`
- Spawn 9 implementer agents in the background (`run_in_background: true`)
- Set their Status to `In-Progress`
- Return a tick summary
- Sleep until the next 10-min mark

Subsequent ticks will pick up Wave 1 as soon as #3's PR opens, and so on.

---

## 12. Resolved questions

- [x] **Godot binary in CI.** Set up interactively in Wave 0 (§3.6) before the orchestrator launches. Removed from risk list.
- [x] **Drive-by findings.** Implementers file new GH issues with `gh issue create` when they find unrelated work. PR diffs stay scoped. See §5 item 6.
- [x] **Terminal behavior.** Coordinator auto-exits when every issue is in `{Done, Blocked}`. See §4 step 6.
- [x] **Model + effort tiering.** Opus 4.7 + `ultrathink` for architectural; Sonnet 4.6 + `think hard` for leaves & benchmarks; Sonnet 4.6 + `think` for mechanical/curation; Opus 4.7 + `think harder` for research hand-offs. See §5 table.

---

*Generated 2026-05-20. Update this file as decisions evolve.*
