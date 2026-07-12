#!/bin/bash
# Copy the plugin source (plugins/) into MuseScore 4's user plugin folder so MuseScore
# picks it up. MuseScore re-reads a plugin's .qml on each run, but NEW plugin
# files require a restart (or Home > Plugins > refresh) and must be enabled once
# in the Plugin Manager (new plugins default to disabled).
#
# Usage:  scripts/sync.sh              (from the repo root)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SRC="$REPO_ROOT/plugins"
DEST="$HOME/Documents/MuseScore4/Plugins/JazzKit"

if [ ! -d "$SRC" ]; then
  echo "Source plugin dir not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
cp -v "$SRC"/*.qml "$SRC"/manifest.json "$DEST"/ 2>/dev/null || cp -v "$SRC"/*.qml "$DEST"/
echo "Synced to $DEST"
echo "If you added a NEW .qml, restart MuseScore and enable it in Home > Plugins."
