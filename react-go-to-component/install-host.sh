#!/bin/bash
# Installs the native messaging host for React Go to Component extension.
# Usage: ./install-host.sh <chrome-extension-id>

set -e

EXT_ID="$1"
if [ -z "$EXT_ID" ]; then
  echo "Usage: ./install-host.sh <chrome-extension-id>"
  echo ""
  echo "Find your extension ID at chrome://extensions (enable Developer Mode)"
  exit 1
fi

HOST_NAME="com.react_goto_component.open_in_editor"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/native-host/open-in-editor.py"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

chmod +x "$HOST_SCRIPT"
mkdir -p "$TARGET_DIR"

cat > "$TARGET_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "Opens files in editor for React Go to Component extension",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo "Installed native messaging host:"
echo "  Manifest: $TARGET_DIR/$HOST_NAME.json"
echo "  Script:   $HOST_SCRIPT"
echo "  Extension: $EXT_ID"
echo ""
echo "Configure your editor in the extension popup (VS Code, Cursor, WebStorm, etc.)"
echo "Restart Chrome for changes to take effect."
