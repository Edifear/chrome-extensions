#!/bin/bash
# Installs the native messaging host for React Go to Component extension.
#
# Usage:
#   ./install-host.sh [--user-data-dir <path>]... [--ext-id <id>]... [--no-auto]
#
# By default, scans Chrome profiles (default + any auto-detected from the
# `chrome` shell alias + explicit --user-data-dir) for extensions loaded from
# this script's directory, and allows all matching IDs. Pass --ext-id to add
# IDs manually (useful if the extension isn't loaded yet).

set -e

EXPLICIT_IDS=()
EXTRA_DATA_DIRS=()
AUTO_DETECT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --user-data-dir)
      [ -n "$2" ] || { echo "Error: --user-data-dir requires a path"; exit 1; }
      EXTRA_DATA_DIRS+=("$2")
      shift 2
      ;;
    --ext-id)
      [ -n "$2" ] || { echo "Error: --ext-id requires a value"; exit 1; }
      EXPLICIT_IDS+=("$2")
      shift 2
      ;;
    --no-auto)
      AUTO_DETECT=0
      shift
      ;;
    -h|--help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      # Back-compat: first positional = extension ID
      EXPLICIT_IDS+=("$1")
      shift
      ;;
  esac
done

HOST_NAME="com.react_goto_component.open_in_editor"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/native-host/open-in-editor.py"
DEFAULT_USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome"

# Auto-detect --user-data-dir from the `chrome` shell alias.
if [ "$AUTO_DETECT" = "1" ]; then
  for sh in zsh bash; do
    command -v "$sh" >/dev/null 2>&1 || continue
    alias_def=$("$sh" -ic 'alias chrome' 2>/dev/null || true)
    [ -n "$alias_def" ] || continue
    detected=$(printf '%s' "$alias_def" | sed -nE "s/.*--user-data-dir[= ]([^' \"]+).*/\1/p")
    if [ -n "$detected" ]; then
      EXTRA_DATA_DIRS+=("$detected")
      echo "Detected chrome alias --user-data-dir: $detected"
      break
    fi
  done
fi

# Profiles to scan / install into.
ALL_USER_DATA_DIRS=("$DEFAULT_USER_DATA_DIR" "${EXTRA_DATA_DIRS[@]}")

# Collect extension IDs whose load path matches this repo.
collected_ids=""
for udd in "${ALL_USER_DATA_DIRS[@]}"; do
  [ -d "$udd" ] || continue
  ids=$(python3 - "$udd" "$SCRIPT_DIR" <<'PY'
import glob, json, os, sys
udd, src = sys.argv[1], sys.argv[2]
found = set()
for pname in ("Secure Preferences", "Preferences"):
    for prefs in glob.glob(os.path.join(udd, "*", pname)):
        try: data = json.load(open(prefs))
        except Exception: continue
        for eid, meta in data.get("extensions", {}).get("settings", {}).items():
            if meta.get("path") == src:
                found.add(eid)
for eid in sorted(found):
    print(eid)
PY
)
  for id in $ids; do
    collected_ids="$collected_ids $id"
  done
done

# Merge explicit + detected, dedupe.
ALL_IDS=()
seen=""
for id in "${EXPLICIT_IDS[@]}" $collected_ids; do
  [ -n "$id" ] || continue
  case ":$seen:" in *":$id:"*) continue ;; esac
  seen="$seen:$id"
  ALL_IDS+=("$id")
done

if [ ${#ALL_IDS[@]} -eq 0 ]; then
  echo "Error: no extension IDs found."
  echo "Load this extension (unpacked) in Chrome first, or pass --ext-id <id>."
  echo "Source dir: $SCRIPT_DIR"
  exit 1
fi

chmod +x "$HOST_SCRIPT"

# Build allowed_origins JSON array.
ORIGINS=""
for id in "${ALL_IDS[@]}"; do
  [ -n "$ORIGINS" ] && ORIGINS="$ORIGINS,
"
  ORIGINS="$ORIGINS    \"chrome-extension://$id/\""
done

MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Opens files in editor for React Go to Component extension",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
$ORIGINS
  ]
}
EOF
)

install_to() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
  echo "  $dir/$HOST_NAME.json"
}

echo ""
echo "Installed native messaging host at:"
seen=""
for udd in "${ALL_USER_DATA_DIRS[@]}"; do
  case ":$seen:" in *":$udd:"*) continue ;; esac
  seen="$seen:$udd"
  install_to "$udd/NativeMessagingHosts"
done

echo ""
echo "Script:         $HOST_SCRIPT"
echo "Allowed IDs:    ${ALL_IDS[*]}"
echo ""
echo "Configure your editor in the extension popup."
echo "Restart Chrome for changes to take effect."
