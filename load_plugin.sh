#!/bin/bash
# Copy the plugin source (plugins/) into MuseScore 4's user plugin folder, under
# the "JazzKit" package name. MuseScore re-reads a plugin's .qml on each run, but
# a NEW .qml needs a restart and a one-time enable in Home > Plugins.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -f "$ROOT/.env" ] && source "$ROOT/.env"

: "${PLUGINS_FOLDER:?set PLUGINS_FOLDER (e.g. in .env)}"
# Expand a leading ~ — it stays literal when the value comes from a quoted var.
DEST="${PLUGINS_FOLDER/#\~/$HOME}/JazzKit"

rm -rf "$DEST"
cp -r "$ROOT/plugins/" "$DEST"
echo "Synced to $DEST"
