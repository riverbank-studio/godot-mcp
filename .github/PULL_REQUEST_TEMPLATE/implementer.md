<!--
PR-type: implementer (issue implementation, typically agent-driven)

Default for the build orchestrator (docs/orchestration-plan.md §5). Pick this
when a PR implements a tracked issue end-to-end. For repo-hygiene work prefer
?template=chore.md; for bug fixes ?template=bugfix.md; for docs-only changes
?template=docs.md.
-->

Closes #\<N\>

## Summary

\<What this PR implements, in 2–4 sentences. State the user-visible effect and the structural choice if non-trivial.\>

## Design notes

\<Non-obvious decisions made during implementation. Trade-offs considered. Pointers to the DESIGN.md sections that constrained the work.\>

## Out of scope

\<What this PR deliberately doesn't do. Drive-by findings filed as new issues during this work should be linked here.\>

- (none) / Filed as #\<n\>, #\<m\>

## Verification

- [ ] `npm run build` clean
- [ ] `npm run lint` clean
- [ ] `npm run format:check` clean
- [ ] `npm test` green (including new tests for this PR)
- [ ] CI green on this PR's latest commit
- [ ] _(agent PRs only)_ `/review` run; non-trivial findings addressed in a follow-up commit
- [ ] _(agent PRs only)_ `/security-review` run if the PR touches tool dispatch, child-process spawning, or file I/O

<!-- Delete this line if the PR is human-authored: -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
