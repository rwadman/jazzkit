#!/bin/bash
# Deploy the DEV test harness into the dev-deployed JazzKit extension as one extra
# form action, "zz Test Harness" (Plugins ▸ JazzKit ▸ zz Test Harness). Only the
# DEPLOYED copy is touched — the repo's JazzKit/manifest.json never lists the
# harness, so it can't ship. It runs as a form (not a legacy plugin) because that is
# the context the shipping actions run in: cmd("tie") works from a form and NOT
# from a legacy plugin (see api-gotchas). Riding inside the already-enabled JazzKit
# extension also means no separate package to enable.
#
# Usage:  scripts/sync-harness.sh            add the harness to the deployed JazzKit
#         scripts/sync-harness.sh --clean    redeploy JazzKit without it
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && source "$ROOT/.env"

EXTENSIONS_FOLDER="${EXTENSIONS_FOLDER:-$HOME/Library/Application Support/MuseScore/MuseScore4/extensions}"
DEST="${EXTENSIONS_FOLDER/#\~/$HOME}/JazzKit"

# The harness used to be a separate legacy package here; remove that leftover so it
# doesn't show a second, legacy "zz Test Harness" entry.
LEGACY="$HOME/Documents/MuseScore4/Plugins/JazzKitTest"
[ -e "$LEGACY" ] && rm -rf "$LEGACY" && echo "Removed old legacy harness package $LEGACY"

if [ "${1:-}" = "--clean" ]; then
  "$ROOT/scripts/sync.sh" >/dev/null
  echo "Redeployed JazzKit without the harness"
  exit 0
fi

[ -f "$DEST/manifest.json" ] || "$ROOT/scripts/sync.sh"
cp "$ROOT"/harness/*.qml "$DEST"/
node -e '
const fs = require("fs"); const p = process.argv[1];
const m = JSON.parse(fs.readFileSync(p, "utf8"));
if (!m.actions.some((a) => a.code === "zz_test_harness"))
  m.actions.push({ code: "zz_test_harness", type: "form", title: "zz Test Harness", path: "test_harness.qml" });
fs.writeFileSync(p, JSON.stringify(m, null, 4) + "\n");
' "$DEST/manifest.json"
echo "Harness added to $DEST (Plugins ▸ JazzKit ▸ zz Test Harness)."
