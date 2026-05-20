<!--
PR-type: bugfix (fixes a reported defect)

Use when fixing an issue tagged `bug`. For new behavior or refactors, prefer
?template=implementer.md.
-->

Closes #\<N\>

## Root cause

\<One paragraph: what was broken, and why. Distinguish symptom from cause — agents and reviewers should both leave with a clear mental model of the underlying defect.\>

## Fix

\<What the fix does. Why it addresses the root cause and not just the symptom.\>

## Regression test

\<Path to the test that fails before this change and passes after. If you couldn't add one, explain why (and whether that signals a missing testing capability).\>

## Verification

- [ ] Repro from #\<N\> no longer reproduces
- [ ] `npm run build` clean
- [ ] `npm run lint` clean
- [ ] `npm run format:check` clean
- [ ] `npm test` green (including the new regression test)
- [ ] CI green
