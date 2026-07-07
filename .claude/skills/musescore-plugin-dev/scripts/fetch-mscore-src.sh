#!/bin/bash
# Sparse-checkout the MuseScore source so you can grep the ACTUAL implementation
# instead of guessing at the plugin API. This is the single highest-leverage
# move for this codebase: action codes, cursor/selection semantics, and the
# api/v1 wrapper surface are all discoverable here and nowhere else reliable.
#
# Usage:  scripts/fetch-mscore-src.sh [dest-dir]     (default: ./.mscore-src)
#
# Then grep, e.g.:
#   grep -rn 'registerAction'          <dest>/src/notationscene/internal/notationactioncontroller.cpp
#   grep -rn 'Q_INVOKABLE\|Q_PROPERTY' <dest>/src/engraving/api/v1/
#   grep -rn 'void Chord::setSlash'    <dest>/src/engraving/dom/chord.cpp
set -euo pipefail

DEST="${1:-./.mscore-src}"

if [ -d "$DEST/.git" ]; then
  echo "Already present at $DEST"
else
  git clone --filter=blob:none --no-checkout --depth 1 \
    https://github.com/musescore/MuseScore.git "$DEST"
  git -C "$DEST" sparse-checkout init --cone
  # These four dirs hold everything a plugin author needs:
  #  engraving/api/v1  -> the plugin API surface (Cursor, Score, Selection, Note, Chord, Part...)
  #  engraving/dom     -> real element behaviour (setSlash, note input, drumset)
  #  engraving/editing -> undoable edit ops (editvoice, editslashnotation, paste)
  #  notationscene     -> action codes: registerAction("slash-rhythm", ...) etc.
  git -C "$DEST" sparse-checkout set \
    src/engraving src/notation src/notationscene
  git -C "$DEST" checkout >/dev/null 2>&1
  echo "Checked out MuseScore source into $DEST"
fi

echo
echo "Action codes (what cmd(\"...\") accepts):"
grep -rn 'registerAction' "$DEST/src/notationscene/internal/notationactioncontroller.cpp" | head -5 || true
