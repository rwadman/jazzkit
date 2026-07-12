#!/bin/bash
# Copy the plugin source (plugins/) into MuseScore 4's user plugin folder, under
# the "JazzKit" package name, so MuseScore picks it up. MuseScore re-reads a
# plugin's .qml on each run, but a NEW .qml needs a restart (or Home > Plugins >
# refresh) and a one-time enable in the Plugin Manager.
#
# Dest comes from PLUGINS_FOLDER in .env if set, else the default below.
#
# Usage:  scripts/sync.sh              (from anywhere)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && source "$ROOT/.env"

SRC="$ROOT/plugins"
# Expand a leading ~ — it stays literal when the value comes from a quoted var.
PLUGINS_FOLDER="${PLUGINS_FOLDER:-$HOME/Documents/MuseScore4/Plugins}"
DEST="${PLUGINS_FOLDER/#\~/$HOME}/JazzKit"

if [ ! -d "$SRC" ]; then
  echo "Source plugin dir not found: $SRC" >&2
  exit 1
fi

rm -rf "$DEST"
cp -r "$SRC/" "$DEST"
echo "Synced to $DEST"
echo "If you added a NEW .qml, restart MuseScore and enable it in Home > Plugins."
