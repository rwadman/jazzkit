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

# Opt-in automation (local dev only — needs Accessibility permission for the
# controlling terminal; see below). Both default off so the manual path is
# unchanged.
# Both refuse to run when a MuseScore is already open (we'd script/kill the wrong
# instance and lose the developer's unsaved work).
#   --autoclick   drive Plugins ▸ harness via UI scripting (implies --kill)
#   --kill        force-kill the MuseScore WE launched on exit
#   --no-kill     cancel the implied --kill from --autoclick
AUTOCLICK=0
KILL=""              # unset => defaults to AUTOCLICK below
MENU_ITEM="zz Test Harness"
# System Events identifies the app by its EXECUTABLE name, not the app title:
# CFBundleExecutable is "mscore" (CFBundleName is "MuseScore Studio", the .app is
# "MuseScore 4.app" — none of which System Events answers to). Verify with:
#   osascript -e 'tell application "System Events" to get name of every process'
PROC="mscore"

usage() { echo "usage: $(basename "$0") [--autoclick] [--kill|--no-kill]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --autoclick) AUTOCLICK=1 ;;
    --kill)      KILL=1 ;;
    --no-kill)   KILL=0 ;;
    -h|--help)   usage ;;
    *)           echo "unknown argument: $1" >&2; usage ;;
  esac
  shift
done
[ -n "$KILL" ] || KILL="$AUTOCLICK"   # --kill defaults to whatever --autoclick is

MS_MATCH="MuseScore 4.app/Contents/MacOS"
MS_PID=""            # set after launch; the ONLY process we may kill

# Killing (and the session.json swap below) is only safe when no MuseScore of the
# user's own is running: their unsaved scores would go with it, and the blanked
# session.json would take crash recovery down too. Refuse rather than risk it.
if [ "$KILL" = "1" ] || [ "$AUTOCLICK" = "1" ]; then
  if pgrep -f "$MS_MATCH" >/dev/null 2>&1; then
    echo "MuseScore is already running. --autoclick/--kill would target the wrong" >&2
    echo "instance and could lose unsaved work. Quit MuseScore first, or run" >&2
    echo "$(basename "$0") with no flags (manual mode)." >&2
    exit 1
  fi
fi

# MuseScore records its open scores here while running and empties it on a clean
# quit. A kill -9 leaves it populated, so the NEXT launch shows a crash-recovery
# dialog that steals focus and swallows our file-open (verified: this was the
# intermittent "unclean shutdown, score won't open" failure). But session.json is
# the user's real data (their normally-open scores), so we don't clobber it: we
# back it up, blank it for our run, and restore the backup after the app is dead.
# Only used on the --kill path — that's the only mode that hard-kills and then has
# a dead app safe to write session.json back into.
SESSION="$HOME/Library/Application Support/MuseScore/MuseScore4/session/session.json"
SESSION_BAK=""   # set by backup_session when a backup is taken

backup_session() {
  [ -e "$SESSION" ] || return 0
  SESSION_BAK="$(mktemp "${TMPDIR:-/tmp}/jazzkit-session.XXXXXX")"
  cp "$SESSION" "$SESSION_BAK"
  printf '[\n]\n' > "$SESSION"   # blank it so the next launch shows no recovery dialog
}

restore_session() {
  [ -n "$SESSION_BAK" ] && [ -e "$SESSION_BAK" ] || return 0
  cp "$SESSION_BAK" "$SESSION"   # app is dead by now — safe to write back
  rm -f "$SESSION_BAK"
  SESSION_BAK=""
}

# Force-kill ONLY the instance we launched ($MS_PID, captured right after `open`).
# That instance holds nothing but our throwaway COPY of the fixture, so a hard kill
# can't lose real work and it sidesteps the "Save changes?" dialog entirely. Never
# pkill by name: that would also take out a MuseScore the developer started (see the
# already-running guard above). Once it's gone we put the real session.json back.
kill_app() {
  if [ -n "$MS_PID" ]; then kill -9 "$MS_PID" 2>/dev/null || true; fi
  restore_session
}

# Tear down on any exit (success, timeout, Ctrl-C) when killing is enabled.
[ "$KILL" = "1" ] && trap kill_app EXIT

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
# On the kill path, blank session.json (backing it up first) so our hard kill
# can't leave MuseScore flagged as unclean; restored by kill_app once it's dead.
[ "$KILL" = "1" ] && backup_session
open -na "/Applications/MuseScore 4.app" "$WORK"

# Remember the process `open` just spawned so kill_app can target it and nothing
# else. `-n` = newest match; we guaranteed above that no other instance exists on
# the kill path, and `open` is synchronous enough that the process is up by now
# (retry briefly in case it isn't).
for _ in 1 2 3 4 5 6 7 8 9 10; do
  MS_PID="$(pgrep -n -f "$MS_MATCH" 2>/dev/null || true)"
  if [ -n "$MS_PID" ]; then break; fi
  sleep 1
done

if [ "$AUTOCLICK" = "1" ]; then
  # Drive the Plugins menu via UI scripting. Needs Accessibility permission for
  # the controlling terminal (System Settings ▸ Privacy & Security ▸
  # Accessibility) — without it osascript errors out (-1719) and we fall through
  # to the manual instructions. The retry loop waits for the app + menu item to
  # exist (covers launch lag). If "JazzKit Test" isn't enabled yet the item
  # never appears and the loop times out — enable it in Home ▸ Plugins once.
  echo "Auto-clicking Plugins ▸ \"$MENU_ITEM\"..."
  osascript <<APPLESCRIPT || echo "  (auto-click failed — grant Accessibility, or click it manually)" >&2
tell application "System Events"
  tell process "$PROC"
    set frontmost to true
    repeat 60 times
      if exists (menu item "$MENU_ITEM" of menu 1 of menu bar item "Plugins" of menu bar 1) then exit repeat
      delay 0.5
    end repeat
    click menu item "$MENU_ITEM" of menu 1 of menu bar item "Plugins" of menu bar 1
  end tell
end tell
APPLESCRIPT
  echo
  echo "Waiting for the harness report (Ctrl-C to stop waiting)..."
else
  cat <<'EOF'

MuseScore is opening on a blank score. In it:
  1. Plugins ▸ "zz Test Harness"
       (first run only: enable "JazzKit Test" in Home ▸ Plugins, then re-run.)
  2. Read the box, then close the score WITHOUT saving.

Waiting for the harness report (Ctrl-C to stop waiting)...
EOF
fi

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
  exit 1
fi
