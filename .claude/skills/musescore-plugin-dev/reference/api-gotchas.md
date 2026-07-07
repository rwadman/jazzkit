# MuseScore 4 plugin API — hard-won gotchas

Every item below was verified this session against the MuseScore source
(`scripts/fetch-mscore-src.sh`) or a real crash dump / log — not guessed. File
paths are within the MuseScore repo checkout. When in doubt, **grep the source**;
the online plugin docs are thin and sometimes wrong about MuseScore 4.

## Environment / workflow

- **There is NO CLI plugin runner in MuseScore 4.** `mscore --help` has
  `--test-case*` (MuseScore's own internal QML tests) and `-j`/`-o`
  (score conversion), but nothing that runs a user `.qml` plugin against a
  score. Plugins only execute inside the GUI. Your feedback loop is:
  sync → run in GUI → read the log (`scripts/mslog.sh`) → analyze crash dump
  (`scripts/analyze-crash.py`). Plan for that; don't look for a headless
  plugin harness that doesn't exist.
- MuseScore **re-reads a plugin's `.qml` each time you run it**, so edits to an
  existing file need no restart. **New `.qml` files** need a restart and must be
  **enabled once** in Home > Plugins (new plugins default to disabled).
- Plugins have no visible stdout. `console.log(...)` goes to the MuseScore log
  (`~/Library/Application Support/MuseScore/MuseScore4/logs/`). Every dispatched
  action is logged as `ActionsDispatcher::doDispatch | try call action: <code>` —
  this is how you see which step a plugin reached before misbehaving.
- Crash dumps (Crashpad `.dmp`) land in `logs/dumps/completed/`. The log has NO
  usable stack trace for a crash; `scripts/analyze-crash.py` reconstructs one.

## `cmd("...")` — running built-in actions

- `cmd(s)` (top-level plugin function) dispatches the action code `s` through
  the global `ActionsDispatcher`, identical to clicking the menu. Confirmed in
  `src/engraving/api/v1/qmlpluginapi.cpp` (`PluginAPI::cmd`).
- **Action codes are NOT the menu labels.** Find the real code with
  `grep -rn 'registerAction' src/notationscene/internal/notationactioncontroller.cpp`.
  Notably:
  - "Toggle rhythmic slash notation" → `cmd("slash-rhythm")`
  - "Fill with slashes" → `cmd("slash-fill")`
  - "Voice 3" (move selection to voice 3) → `cmd("voice-3")`
  - swap voices 1&3 → `cmd("voice-x13")`
- A dispatched `cmd()` operates on **`curScore.selection`** (the engraving
  selection). Setting the selection from the plugin (see below) DOES drive it —
  but only when the selection is not locked.

## Selection

- `curScore.selection.selectRange(startTick, endTick, startStaff, endStaff)`
  works and IS reflected in `curScore.selection` and in subsequent `cmd()`s —
  BUT **`endStaff` is exclusive** and `endTick` is exclusive. To select one
  staff: `selectRange(a, b, staffIdx, staffIdx + 1)`.
- **`selectRange` silently returns `false` and changes nothing while a
  `curScore.startCmd()` is open** — the selection is locked during an open
  command (`Selection::checkSelectionIsNotLocked`,
  `src/engraving/api/v1/selection.cpp`). Symptom: your `selectRange` no-ops and a
  following `cmd()` runs against the *previous* (e.g. the user's source)
  selection. **Do selection changes OUTSIDE `startCmd`/`endCmd`.**
- Always **verify** the selection landed where you intended before running a
  destructive `cmd()`: read back `curScore.selection.startStaff`. If it's not
  your target, abort — otherwise you corrupt whatever was selected before.
- `rewind(Cursor.SELECTION_END)` sets `tick` to 0 when the selection reaches the
  end of the score; fall back to `curScore.lastSegment.tick + 1`.

## Cursor (note input)

- Set **`staffIdx` and `voice` BEFORE** `rewind`/`rewindToTick`, not after.
  `rewindToTick` does `setSegment(); nextInTrack()`, and `nextInTrack` searches
  using the *current* track (`src/engraving/api/v1/cursor.cpp`).
- **`rewindToTick` skips forward past any segment that has no element in the
  current track.** So rewinding directly on an EMPTY voice runs off the end of
  the score → cursor position undefined → `addNote` logs
  `"cursor location is undefined"` and adds nothing. Workaround to write into an
  empty voice N: set `voice = 0` (voice 0 always has content — MuseScore fills it
  with rests), `rewindToTick(t)`, THEN set `voice = N` (this keeps the segment;
  `setVoice`/`setStaffIdx` only change the track, not the segment), then
  `setDuration` + `addNote`.

## Drum / percussion staves — the big traps

- **You cannot write an arbitrary pitched rhythm onto a drum staff with the
  cursor.** In `NoteInput::addPitch` (`src/engraving/editing/noteinput.cpp`), for
  a drumset staff:
  - `if (!ds->isValid(nval.pitch)) return nullptr;` — a pitch that isn't a valid
    drum instrument is **silently dropped** (no note, no error). This is why
    copying a Trumpet melody to a drum staff via `cursor.addNote` produced zero
    notes.
  - `track = ds->voice(pitch) + staffBase;` — **the drumset FORCES the voice**
    based on the pitch. Your `cursor.voice` is overridden. So you can't choose
    voice 3 via cursor input on a drum staff.
  - The reliable way to get pitched material onto a drum staff (with proper
    pitch→instrument mapping) is `cmd("copy")` then `cmd("paste")` — the same
    path the GUI uses.
- `part.hasDrumStaff` finds the percussion part; `Math.floor(part.startTrack/4)`
  is its absolute staff index (robust even with multi-staff parts like Piano).
- The `Drumset` API (`part`/`instrument` → drumset; `isValid`, `voice`, `line`,
  `noteHead`) exists **since MuseScore 4.6** — don't rely on it for ≤4.5.

## `startCmd` / `endCmd` and crashes

- Wrap a *single* logical edit in `curScore.startCmd()` / `curScore.endCmd()`.
- **Do NOT wrap multiple `cmd("...")` calls in one outer `startCmd`.** Each
  built-in `cmd()` runs its own command; nesting them inside a plugin `startCmd`
  leaves the score locked and un-relaid-out between steps, and operating on stale
  segment pointers crashes MuseScore. The real `voice-3` crash this session was
  exactly this: `changeSelectedElementsVoice → undoRemoveElement →
  Measure::remove → SegmentList::remove` on a stale pointer (see the analyze-crash
  output). Running copy/paste/voice-3/slash-rhythm/slash-fill as **separate
  standalone `cmd()`s** (no outer `startCmd`) fixed it — the score lays out
  between steps.
- `curScore.doLayout(fraction(0,1), fraction(-1,1))` forces a mid-command
  relayout if you truly need one (since 4.6), but prefer separate commands.

## Menus

- `menuPath: "Plugins.Jazzify.My Action"` nests the plugin under a **Jazzify**
  submenu. Multiple `.qml` files sharing the `"Plugins.Jazzify.*"` prefix group
  together. `setMenuPath` logs a "deprecated" debug line but still works in 4.7.
- One `.qml` = one menu entry = one `MuseScore { onRun: ... }`. For several
  independent actions, use several `.qml` files with a shared `menuPath` prefix.
