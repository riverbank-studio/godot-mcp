#!/usr/bin/env bash
set -euo pipefail

# Stop hook: runs `eslint .` at the end of every Claude turn so
# in-progress lint debt is visible.
#
# Informational only — findings go to stderr but the hook always
# exits 0. The commit gate (lint-format-gate.sh) is the enforcement
# point; this hook just surfaces issues earlier.

# Stop hook receives JSON state on stdin; we don't need it.
cat >/dev/null

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

if command -v npx >/dev/null 2>&1 && npx --no-install eslint --version >/dev/null 2>&1; then
  RUNNER=(npx --no-install eslint)
elif command -v eslint >/dev/null 2>&1; then
  RUNNER=(eslint)
else
  echo "eslint-on-stop: eslint not found (tried npx --no-install and PATH), skipping." >&2
  exit 0
fi

if OUT="$("${RUNNER[@]}" . 2>&1)"; then
  exit 0
fi

echo "eslint-on-stop: lint issues at end of turn (informational — the commit gate enforces):" >&2
printf '%s\n' "$OUT" >&2
exit 0
