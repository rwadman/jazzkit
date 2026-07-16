#!/bin/bash
# Print the JazzKit test-harness report. The harness (harness/test_harness.qml) can't
# expose a copyable dialog and this build's plugin console.log doesn't reach the log,
# so it writes the report to a file — this prints it. Checks the same locations the
# harness tries, newest first.
set -euo pipefail

CANDIDATES=(
  "$HOME/Documents/MuseScore4/Scores/jazzkit-harness-report.txt"
  "${TMPDIR:-/tmp}/jazzkit-harness-report.txt"
  "$HOME/jazzkit-harness-report.txt"
)

FOUND="$(ls -t "${CANDIDATES[@]}" 2>/dev/null | head -1 || true)"
[ -n "$FOUND" ] || { echo "No harness report found. Looked in:" >&2; printf '  %s\n' "${CANDIDATES[@]}" >&2; exit 1; }

echo "== $FOUND ==" >&2
cat "$FOUND"
