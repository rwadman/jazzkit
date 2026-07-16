#!/bin/bash
# End-to-end plugin test: deploy BOTH packages (the shipping JazzKit plugin and the
# JazzKitTest harness), open an empty score, then wait for the one-click harness run
# and print its report.
#
# There is no headless/CLI path for score-editing plugins on MS 4.7.x (see
# api-gotchas.md), so the harness runs from the GUI plugin menu — one click. This
# script does everything around that: sync, open a blank fixture, launch, collect.
#
# The only manual steps while this waits:
#   1. Plugins ▸ "zz Test Harness"
#        (first run only: enable "JazzKit Test" in Home ▸ Plugins, then re-run.)
#   2. Read the box, then close the score WITHOUT saving.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# A committed empty score (single treble staff, no notes — the harness adds its own
# instruments). Built from MuseScore's own Treble-Clef template. We open a throwaway
# COPY so an accidental Save can never dirty the committed fixture.
FIXTURE="$ROOT/harness/fixtures/blank.mscz"
WORK="${TMPDIR:-/tmp}/jazzkit-e2e-fixture.mscz"

# The harness writes its report to the first of these that is writable (see
# emitReport in harness/test_harness.qml); keep in sync with harness-report.sh.
REPORTS=(
  "$HOME/Documents/MuseScore4/Scores/jazzkit-harness-report.txt"
  "${TMPDIR:-/tmp}/jazzkit-harness-report.txt"
  "$HOME/jazzkit-harness-report.txt"
)

"$ROOT/scripts/sync.sh"                   # (re)deploy the shipping JazzKit package
"$ROOT/scripts/sync-harness.sh"           # (re)deploy the JazzKitTest harness package

# Clear stale reports so we only print THIS run's.
rm -f "${REPORTS[@]}"

# Open a fresh throwaway copy of the blank fixture.
[ -f "$FIXTURE" ] || { echo "Fixture not found: $FIXTURE" >&2; exit 1; }
cp "$FIXTURE" "$WORK"
open -na "/Applications/MuseScore 4.app" "$WORK"

cat <<'EOF'

MuseScore is opening on a blank score. In it:
  1. Plugins ▸ "zz Test Harness"
       (first run only: enable "JazzKit Test" in Home ▸ Plugins, then re-run.)
  2. Read the box, then close the score WITHOUT saving.

Waiting for the harness report (Ctrl-C to stop waiting)...
EOF

# Poll for the report file, up to the timeout.
TIMEOUT="${E2E_TIMEOUT:-600}"   # seconds
elapsed=0
while :; do
  FOUND="$(ls -t "${REPORTS[@]}" 2>/dev/null | head -1 || true)"
  [ -n "$FOUND" ] && break
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "No report after ${TIMEOUT}s. Run scripts/harness-report.sh once you've clicked the harness." >&2
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo
echo "== $FOUND =="
cat "$FOUND"

# Stamp a clean pass into harness/acceptance.json so CI can verify the harness was
# run for this exact code (it can't run the GUI itself). Refuses a failing report.
echo
if grep -q "HARNESS PASSED" "$FOUND" && ! grep -q "FAIL" "$FOUND"; then
  node "$ROOT/scripts/e2e-accept.mjs" "$FOUND"
else
  echo "Report has failures — not recording acceptance. Fix, re-run." >&2
fi
