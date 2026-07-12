#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -f "$ROOT/.env" ] && source "$ROOT/.env"
: "${MUSE_SCORE_FOLDER:?set MUSE_SCORE_FOLDER (e.g. in .env)}"
mkdir -p "$ROOT/logs"
"$MUSE_SCORE_FOLDER" -d 2>&1 | tee "$ROOT/logs/musescore-run.log"