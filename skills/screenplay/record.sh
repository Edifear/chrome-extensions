#!/usr/bin/env bash
#
# screenplay — record an annotated screencast for a UI flow.
#
# Usage:
#   bash <skill-dir>/record.sh <flow-file.js>
#
# What it does:
#   1. Reads the flow file (must be a single async-arrow expression)
#   2. Replaces the `// >>>HELPERS<<<` marker with helpers.js contents
#   3. Strips a trailing `;` after the closing `}` (Prettier likes to add one;
#      playwright-cli run-code can't accept it)
#   4. Runs `npx playwright-cli run-code` from the current working directory
#      so any relative OUTPUT path inside the flow resolves against the project root.
#
# Pre-requisites:
#   - Chrome running with --remote-debugging-port=9222
#   - playwright-cli attached: `npx playwright-cli attach --cdp=http://localhost:9222`
#   - User logged into the target app
#
# Output: as specified by the OUTPUT constant inside the flow file.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <flow-file.js>" >&2
  exit 1
fi

SRC="$1"
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPERS="$SKILL_DIR/helpers.js"

if [ ! -f "$SRC" ]; then
  echo "error: $SRC not found" >&2
  exit 1
fi
if [ ! -f "$HELPERS" ]; then
  echo "error: $HELPERS not found (skill is broken)" >&2
  exit 1
fi

TMP="$(mktemp -t screenplay.XXXX.js)"
trap 'rm -f "$TMP"' EXIT

# Inject helpers at marker, then strip trailing `};` → `}`
awk -v helpers_file="$HELPERS" '
  /\/\/ *>>>HELPERS<<</ {
    while ((getline line < helpers_file) > 0) print line;
    close(helpers_file);
    next;
  }
  { print }
' "$SRC" | sed -e '$s/};\{0,1\}\([[:space:]]*\)$/}\1/' > "$TMP"

# Extract intended OUTPUT for the post-run summary.
# Tolerant of multi-line `const OUTPUT =` formatting and missing OUTPUT — never fails.
OUTPUT_PATH=$(grep -oE "[A-Za-z0-9_./-]+\.webm" "$SRC" 2>/dev/null | head -1 || true)

echo ">>> running $SRC"
[ -n "$OUTPUT_PATH" ] && echo ">>> expected output: $OUTPUT_PATH (relative to $(pwd))"

npx playwright-cli run-code --filename="$TMP"

if [ -n "$OUTPUT_PATH" ] && [ -f "$OUTPUT_PATH" ]; then
  size_kb=$(( $(stat -f%z "$OUTPUT_PATH" 2>/dev/null || stat -c%s "$OUTPUT_PATH") / 1024 ))
  duration=$(ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "$OUTPUT_PATH" 2>/dev/null || echo "?")
  echo ">>> done: $OUTPUT_PATH — ${duration}s, ${size_kb} KB"
fi
