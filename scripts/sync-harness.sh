#!/bin/bash
# Deploy the DEV test harness as its own MuseScore package (JazzKitTest), kept
# separate from the shipping JazzKit package so the test plugin never leaks into a
# user install. The package = harness/*.qml + a copy of JazzKit/lib (the harness
# imports the same libs the shipping plugins use).
#
# A NEW package needs a MuseScore restart + a one-time enable in Home > Plugins.
#
# Usage:  scripts/sync-harness.sh            deploy JazzKitTest
#         scripts/sync-harness.sh --clean    remove JazzKitTest (undo the leak)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && source "$ROOT/.env"

PLUGINS_FOLDER="${PLUGINS_FOLDER:-$HOME/Documents/MuseScore4/Plugins}"
DEST="${PLUGINS_FOLDER/#\~/$HOME}/JazzKitTest"

if [ "${1:-}" = "--clean" ]; then
  rm -rf "$DEST"
  echo "Removed $DEST"
  exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$ROOT"/harness/*.qml "$ROOT"/harness/manifest.json "$DEST"/
cp -r "$ROOT/JazzKit/lib" "$DEST/lib"
echo "Synced harness to $DEST"
echo "New package → restart MuseScore and enable 'JazzKit Test' in Home > Plugins."
