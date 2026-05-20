#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook: gates `git commit` / `git push` from inside Claude
# Code sessions.
#
# Behaviour:
#   1. Filters bash commands; only acts on `git commit` / `git push`.
#   2. Runs `prettier --write` on staged files and re-stages them,
#      so formatting is fixed by the tool rather than left to the
#      agent. Blocks only if prettier itself errors (e.g. parse error).
#   3. Runs `eslint .` and blocks on any error.
#
# Fails open on missing dependencies (jq, prettier, eslint) with a
# clear stderr notice so a broken local env never locks commits.
#
# Known limitation: `git commit -a` / `git commit <paths>` stage
# files as part of the commit itself, after this hook runs, so the
# Prettier auto-format pass can miss them. The PostToolUse Prettier
# hook keeps everything formatted between commits, so this is rarely
# observable in practice. ESLint still runs against the full tree
# regardless.

if ! command -v jq >/dev/null 2>&1; then
  echo "lint-format-gate: jq not on PATH, skipping." >&2
  exit 0
fi

INPUT="$(cat)"
CMD="$(jq -r '.tool_input.command // empty' <<<"$INPUT")"

if ! printf '%s\n' "$CMD" | grep -Eq '(^|[[:space:];|&()])git[[:space:]]+(commit|push)([[:space:]]|$)'; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# ── Prettier: auto-format staged files ────────────────────────────────
if command -v npx >/dev/null 2>&1 && npx --no-install prettier --version >/dev/null 2>&1; then
  PRETTIER=(npx --no-install prettier)
elif command -v prettier >/dev/null 2>&1; then
  PRETTIER=(prettier)
else
  PRETTIER=()
  echo "lint-format-gate: prettier not found, skipping format pass." >&2
fi

if [ "${#PRETTIER[@]}" -gt 0 ]; then
  # Staged files: added/copied/modified/renamed in the index.
  mapfile -t STAGED < <(git diff --cached --name-only --diff-filter=ACMR)
  if [ "${#STAGED[@]}" -gt 0 ]; then
    if ! "${PRETTIER[@]}" --write --ignore-unknown --log-level warn -- "${STAGED[@]}" 2>&1; then
      echo "lint-format-gate: prettier failed during format pass; aborting commit." >&2
      exit 2
    fi
    # Re-stage anything prettier touched (files prettier ignored stay as-is).
    git add -- "${STAGED[@]}"
  fi
fi

# ── ESLint: block on errors ───────────────────────────────────────────
if command -v npx >/dev/null 2>&1 && npx --no-install eslint --version >/dev/null 2>&1; then
  ESLINT=(npx --no-install eslint)
elif command -v eslint >/dev/null 2>&1; then
  ESLINT=(eslint)
else
  echo "lint-format-gate: eslint not found, skipping lint check." >&2
  exit 0
fi

if ! OUT="$("${ESLINT[@]}" . 2>&1)"; then
  echo "lint-format-gate: blocked by eslint errors:" >&2
  printf '%s\n' "$OUT" >&2
  exit 2
fi

exit 0
