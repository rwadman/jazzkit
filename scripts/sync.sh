#!/bin/bash
# Copy the JazzKit bundle (JazzKit/) into MuseScore 4's user EXTENSIONS folder,
# under the "JazzKit" name, so MuseScore picks it up as one extension. JazzKit is
# now a manifest.json-based extension (not loose legacy plugins), so it lives in
# extensions/, NOT Plugins/. The manifest + action .qml are read at load, so a
# change to the manifest or a new action needs a restart and a one-time enable in
# the Plugin Manager.
#
# Dest comes from EXTENSIONS_FOLDER in .env if set, else the default below.
#
# Usage:  scripts/sync.sh              (from anywhere)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && source "$ROOT/.env"

SRC="$ROOT/JazzKit"
# MuseScore's user extensions path (userAppDataPath/extensions). Expand a leading
# ~ — it stays literal when the value comes from a quoted var.
EXTENSIONS_FOLDER="${EXTENSIONS_FOLDER:-$HOME/Library/Application Support/MuseScore/MuseScore4/extensions}"
DEST="${EXTENSIONS_FOLDER/#\~/$HOME}/JazzKit"

if [ ! -d "$SRC" ]; then
  echo "Source bundle dir not found: $SRC" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$SRC/" "$DEST"
# Dev-only files that live in the source bundle but have no business in a user
# install: the TypeScript declarations are for `npm run typecheck` alone.
rm -f "$DEST"/lib/*.d.ts
echo "Synced to $DEST"
echo "Restart MuseScore, then enable JazzKit once in Home > Plugins."

# JazzKit used to ship as loose legacy plugins. Only nag if such a copy is still there.
LEGACY="$HOME/Documents/MuseScore4/Plugins/JazzKit"
if [ -e "$LEGACY" ]; then
  echo "NOTE: a legacy copy still sits in $LEGACY — delete it to avoid duplicate menu entries."
fi
