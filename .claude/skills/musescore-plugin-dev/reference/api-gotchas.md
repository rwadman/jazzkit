# MuseScore 4 plugin API — gotchas

All verified this session against MuseScore source (`scripts/fetch-mscore-src.sh`)
or a real crash/log. Online plugin docs are thin and sometimes wrong for MS4 —
**grep the source** when unsure.

## Environment / workflow

- **No CLI plugin runner.** `mscore --help` has only `--test-case*` (MS's own QML
  tests) and `-j`/`-o` (conversion). Plugins run in the GUI; feedback is the log +
  crash dumps.
- MS **re-reads a plugin's `.qml` each run** (no restart). A **new** `.qml` needs
  a restart + a one-time enable in Home > Plugins (new plugins default disabled).
- No plugin stdout. `console.log` → the log
  (`~/Library/Application Support/MuseScore/MuseScore4/logs/`). Each action logs as
  `doDispatch | try call action: <code>` — shows which step was reached.
- Crash minidumps → `logs/dumps/completed/`. The log has no stack trace;
  `scripts/analyze-crash.py` reconstructs one.

## `cmd("...")` — built-in actions

- `cmd(s)` dispatches action code `s` via the global `ActionsDispatcher`, same as
  the menu (`api/v1/qmlpluginapi.cpp`, `PluginAPI::cmd`).
- **Codes ≠ menu labels.** Find them:
  `grep -rn 'registerAction' src/notationscene/internal/notationactioncontroller.cpp`.
  E.g. "Toggle rhythmic slash notation" → `slash-rhythm`; "Fill with slashes" →
  `slash-fill`; "Voice 3" → `voice-3`; swap voices 1&3 → `voice-x13`.
- A dispatched `cmd()` acts on `curScore.selection`.

## Selection

- `selectRange(startTick, endTick, startStaff, endStaff)`: **`endTick` and
  `endStaff` are exclusive**. One staff → `selectRange(a, b, i, i+1)`.
- **`selectRange` silently returns `false` and does nothing while a `startCmd` is
  open** — selection is locked (`Selection::checkSelectionIsNotLocked`,
  `api/v1/selection.cpp`). Symptom: it no-ops and the next `cmd()` runs on the
  *previous* selection. Do selection changes OUTSIDE `startCmd`/`endCmd`.
- Before a destructive `cmd()`, verify `curScore.selection.startStaff` is your
  target; abort otherwise (else you corrupt the prior selection).
- `rewind(Cursor.SELECTION_END)` sets `tick` to 0 at end of score → fall back to
  `curScore.lastSegment.tick + 1`.

## Cursor (note input)

- Set `staffIdx`/`voice` **before** `rewind`/`rewindToTick`. `rewindToTick` does
  `setSegment(); nextInTrack()`, and `nextInTrack` uses the *current* track
  (`api/v1/cursor.cpp`).
- **`rewindToTick` skips forward past segments with no element in the current
  track.** Rewinding on an EMPTY voice runs off the score end → position undefined
  → `addNote` logs `"cursor location is undefined"` and adds nothing. To write
  into empty voice N: set `voice=0` (always has content), `rewindToTick(t)`, then
  set `voice=N` (keeps the segment; `setVoice`/`setStaffIdx` change only the
  track), then `setDuration` + `addNote`.

## Drum / percussion staves

- **Cannot write an arbitrary pitched rhythm onto a drum staff with the cursor.**
  In `NoteInput::addPitch` (`src/engraving/editing/noteinput.cpp`) for a drumset:
  - invalid drum pitch → `return nullptr` (silently dropped — no note, no error);
  - `track = ds->voice(pitch) + staffBase` → **drumset forces the voice**,
    overriding `cursor.voice`.
  - Reliable path for pitched → drum: `cmd("copy")` + `cmd("paste")` (as the GUI).
- `part.hasDrumStaff` finds the percussion part; `Math.floor(part.startTrack/4)`
  is its absolute staff index (robust with multi-staff parts).
- The `Drumset` API (`isValid`/`voice`/`line`/`noteHead`) exists **since 4.6**.

## `startCmd` / `endCmd` and crashes

- Wrap a *single* logical edit in `startCmd()`/`endCmd()`.
- **Never wrap multiple `cmd("...")` in one outer `startCmd`.** Each `cmd()` is
  its own command; nesting leaves the score locked and un-relaid-out, and stale
  segment pointers crash MS. This session's `voice-3` crash was exactly that:
  `changeSelectedElementsVoice → undoRemoveElement → Measure::remove →
  SegmentList::remove`. Fix: run the `cmd()`s standalone (no outer `startCmd`) so
  the score lays out between steps.
- `curScore.doLayout(fraction(0,1), fraction(-1,1))` forces a mid-command
  relayout (since 4.6), but prefer separate commands.

## Menus

- `menuPath: "Plugins.Jazzify.My Action"` nests under a Jazzify submenu; multiple
  `.qml` sharing the `"Plugins.Jazzify.*"` prefix group together. `setMenuPath`
  logs "deprecated" but works in 4.7.
- One `.qml` = one menu entry = one `MuseScore { onRun }`. Several independent
  actions → several `.qml` with a shared `menuPath` prefix.
