#!/bin/bash
# Show what the plugin did on its last run. MuseScore logs every dispatched
# action and every Cursor/selection warning here - this is your primary
# feedback channel, since plugins have no stdout you can see.
#
# Usage:
#   scripts/mslog.sh            tail the newest log, plugin-relevant lines only
#   scripts/mslog.sh -f         follow (live) the newest log
#   scripts/mslog.sh -a         dump the whole newest log, unfiltered
set -euo pipefail

LOGDIR="$HOME/Library/Application Support/MuseScore/MuseScore4/logs"
LOG="$(ls -t "$LOGDIR"/*.log 2>/dev/null | head -1)"
[ -n "${LOG:-}" ] || { echo "No MuseScore logs in $LOGDIR" >&2; exit 1; }
echo "== $LOG ==" >&2

# Lines worth seeing: action dispatches, Cursor/selection warnings, plugin API
# messages, asserts/errors. Skip the audio-sampler and keyboard-layout spam.
FILTER='doDispatch|Cursor::|selection|Selection|PluginAPI|ASSERT|WARN|ERROR|extensions/v1|slash|voice|JazzKitHarness'
NOISE='MuseSampler|nativeKeycode|Failed to translate|Host requires authentication|FluidSynth|SoundFont'

case "${1:-}" in
  -f) exec tail -f "$LOG" | grep -EI "$FILTER" | grep -vEI "$NOISE" ;;
  -a) exec cat "$LOG" ;;
  *)  grep -EnI "$FILTER" "$LOG" | grep -vEI "$NOISE" | tail -40 ;;
esac
