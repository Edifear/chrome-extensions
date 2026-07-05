#!/bin/sh
# SessionEnd hook (record-agent-test plugin): stop — and optionally delete —
# the md worktree this session registered for cleanup.
#
# No-op unless a marker exists for the ending session:
#   <plugin-root>/state/<session_id>.json   {"worktree": "<name>", "delete": false}
# The medallion skill writes the marker for every worktree the session claimed:
# the persistent record-agent-test placeholder, overflow worktrees, and PR
# worktrees it created itself.
#
# The record-agent-test placeholder worktree is PERMANENT: it is always
# stopped, never deleted, regardless of what the marker says.
# Delete runs WITHOUT --force, so md refuses if the worktree has uncommitted
# changes — the marker is best-effort, never data-destroying.
# Always exits 0: cleanup failure must never surface as a hook error.

set -u
MARKER_DIR="$(cd "$(dirname "$0")/.." && pwd)/state"
LOG="$MARKER_DIR/cleanup.log"
mkdir -p "$MARKER_DIR"

INPUT=$(cat 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

field() {
  printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1" 2>/dev/null
}

SESSION_ID=$(field session_id)
REASON=$(field reason)
[ -n "$SESSION_ID" ] || exit 0
# "resume" means the conversation is saved to continue later — not really over.
[ "$REASON" = "resume" ] && exit 0

# Housekeeping: drop markers from sessions that died without firing SessionEnd,
# and keep the log from growing unbounded (last ~200 lines once it passes 100 KB).
find "$MARKER_DIR" -name '*.json' -mtime +7 -delete 2>/dev/null
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 102400 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

MARKER="$MARKER_DIR/$SESSION_ID.json"
[ -f "$MARKER" ] || exit 0

WORKTREE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree", ""))' "$MARKER" 2>/dev/null)
DELETE=$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("delete") else "0")' "$MARKER" 2>/dev/null)
if [ -z "$WORKTREE" ]; then
  rm -f "$MARKER"
  exit 0
fi

# Hard guard: the persistent recording worktree is stop-only, never deleted.
if [ "$WORKTREE" = "record-agent-test" ]; then
  DELETE=0
fi

MD="$HOME/.local/bin/md"
[ -x "$MD" ] || MD=$(command -v md 2>/dev/null) || { echo "$(date -u +%FT%TZ) session=$SESSION_ID: md binary not found" >> "$LOG"; exit 0; }

{
  echo "$(date -u +%FT%TZ) session=$SESSION_ID reason=$REASON worktree=$WORKTREE delete=$DELETE"
  "$MD" stop "$WORKTREE" 2>&1
  if [ "$DELETE" = "1" ]; then
    "$MD" worktree delete "$WORKTREE" --no-cmux --json 2>&1
  fi
} >> "$LOG" 2>&1

rm -f "$MARKER"
exit 0
