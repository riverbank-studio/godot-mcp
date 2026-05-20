#!/usr/bin/env bash
set -euo pipefail

# PostToolUse hook: runs `prettier --write` on the file that was just
# edited or written, so prettier-supported files are always formatted
# without the agent having to remember.
#
# Silent on the happy path. Fails open on missing deps so a broken
# local env never blocks edits — the commit gate is the enforcer.

if ! command -v jq >/dev/null 2>&1; then
  echo "prettier-on-edit: jq not on PATH, skipping." >&2
  exit 0
fi

INPUT="$(cat)"
FILE="$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")"

[ -n "$FILE" ] || exit 0

# Paranoia: only touch files inside the project.
case "$FILE" in
  "$CLAUDE_PROJECT_DIR"/*) ;;
  *) exit 0 ;;
esac

# Resolve a prettier runner — prefer the local one via npx --no-install
# so it always matches the project's pinned version.
if command -v npx >/dev/null 2>&1 && npx --no-install prettier --version >/dev/null 2>&1; then
  RUNNER=(npx --no-install prettier)
elif command -v prettier >/dev/null 2>&1; then
  RUNNER=(prettier)
else
  echo "prettier-on-edit: prettier not found (tried npx --no-install and PATH), skipping." >&2
  exit 0
fi

# --ignore-unknown skips files prettier doesn't recognise (.gd, .sh, ...)
# and .prettierignore is respected automatically.
if ! "${RUNNER[@]}" --write --ignore-unknown --log-level warn -- "$FILE" 2>&1; then
  # Prettier itself errored (parse error or similar). Don't block the
  # edit — surface the failure on stderr so it's visible.
  echo "prettier-on-edit: prettier failed on $FILE (see above)." >&2
fi

exit 0
