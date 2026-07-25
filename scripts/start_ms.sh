#!/bin/bash
# Launch MuseScore in the foreground with debug logging (-d), teeing everything to a
# per-run timestamped file under logs/ (gitignored). scripts/mslog.sh reads the newest.
# Binary comes from MUSE_SCORE_FOLDER in .env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && source "$ROOT/.env"
: "${MUSE_SCORE_FOLDER:?set MUSE_SCORE_FOLDER (e.g. in .env)}"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/musescore-run-$(date +%Y%m%d-%H%M%S).log"
echo "Logging to $LOG"
"$MUSE_SCORE_FOLDER" -d 2>&1 | tee "$LOG"
