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

## Not every menu action is plugin-dispatchable (`cmd()` vs `command://`)

- MS4.7 routes some notation actions through a newer `muse::rcommand` layer:
  `undo`, `redo`, `copy`, `cut`, `paste`, `delete`, `pitch-up/down`, `move-*` are
  defined as `command://notation/<name>` (`src/notationscene/notationcommands.h`).
- **`undo` is NOT reachable from a plugin.** `cmd("undo")` → log
  `not a registered action: undo`; `cmd("command://notation/undo")` → same (`not a
  registered action: 'command://notation/undo'`). Verified this session. There is
  **no plugin API to undo** — plan effects/tests around that (reset by re-reading a
  fixture or applying the inverse edit, not by undo).
- `paste`/`delete`/`pitch-up` *do* dispatch under their short codes (dual-registered
  as plain action codes too) — but don't assume a menu action is dispatchable; probe
  it. `try call action: X` in the log means it reached a handler; `not a registered
  action` means no.
- **`pitch-up`/`pitch-down` need a single selected *note element*, not a range.** On
  a range the handler routes to `moveSelection(Up)` and hits
  `ASSERT ... MoveDirection::Left == d || Right == d` (`notationinteraction.cpp`).
  Select one note with `curScore.selection.select(note)` (not `selectRange`).

## Creating / loading scores from a plugin (half-implemented in MS4)

- `newScore(name, part, measures)` builds a `Score` object but its "open the score"
  step is `NOT_IMPLEMENTED` (`api/v1/qmlpluginapi.cpp`) — the new score never becomes
  `curScore`/active, so `cmd()` can't target it. Usable only for direct-API cursor
  writes on the returned object, not `cmd()`-driven effects.
- `readScore(name, /*noninteractive*/ true)` → `"Noninteractive flag is not yet
  implemented"` → **returns `nullptr`**. `readScore(name, false)` opens the file in a
  **new window** (interactive) and returns it.
- Upshot for automated testing: there is no silent/headless score load+drive. A test
  harness must drive a fixture the **user has open**; it can select regions, run
  effects via `cmd()`, and read results off the API (all confirmed working) — but it
  can't undo, so isolate cases on independent regions and discard the fixture after.

## `appendPart` a percussion instrument → async mixer crash

- `curScore.appendPart(id)` works for pitched instruments, but appending a
  **percussion/drumset** part makes MuseScore async-load a heavy Muse Hub sampler
  ("Big Kit") and the audio mixer then **crashes** — `analyze-crash.py` on the dump
  shows `MixerPanelModel::onTrackAdded → resolveInsertIndex →
  Part::instrumentTrackIdList` (verified this session with the test harness). The
  crash is *after* the plugin finishes (all `cmd()`s dispatch fine) — it's the async
  mixer catching up on the added track, not the effect.
- **Fix: append the percussion part, then YIELD to the event loop before doing
  anything else.** The crash is a *race*, not a hard incompatibility — the manual
  Instruments dialog adds a drumset fine because it returns to idle and lets the
  mixer's async `onTrackAdded` slot run against a settled score. In a plugin, do the
  same: `appendPart` in `onRun`, then **return** and continue in a one-shot `Timer`
  (interval ~800 ms) — the event loop drains the mixer update while idle, and the
  rest of the run proceeds without the crash. (Verified in the test harness: adding
  the drum staff up front + a `settleTimer` before running any case.)
- A **busy-wait `sleep` does NOT work** — `onRun` is synchronous JS on the main
  thread, so spinning there blocks the very thread that must drain the mixer update.
  You have to actually return from `onRun` (Timer/`Qt.callLater`), not sleep.
- Appending many *pitched* parts interleaved with `cmd()`s is fine (they init on the
  light MS Basic soundfont); only the percussion track-add needs the yield. Also
  avoid `removeParts` churn while samplers are still initializing — leave the
  throwaway fixture and close unsaved.

## CLI / headless via `--test-case` (autobot) — how far it goes (MS 4.7.3)

Verified this session by running `mscore --test-case <script.js>` and reading the log.

- **`--test-case <file>` runs a JS "autobot" script from the CLI** and **exits 0 on
  finish / non-zero on a failed step** (`consoleapp.cpp processTestflow`:
  `qApp->exit(ret.code())`). `api.autobot.fatal(msg)`/`error(msg)` fail the run; a
  bare `throw` inside a step also fails it — but a throw in `main()` body is only
  logged and still exits 0. Wrapper: `scripts/run-testflow.sh`.
- **It's `ConsoleApp` mode, always** — `--test-case` hard-sets it
  (`commandlineparser.cpp`); the GUI path never processes scripts. The macOS bundle
  ships only the `cocoa` Qt platform (no `offscreen`), so a window still opens.
- **Namespace is `api.autobot`** on 4.7.3 (`api.testflow` is the newer rename; absent
  here). Present: `api.{log,autobot,dispatcher,navigation,interactive,context,
  filesystem,process}`. **Absent: `api.engraving` and `api.shortcuts`.**
- **A plugin IS dispatchable from a script**: `api.dispatcher.dispatch(
  "action://extensions/v1/<pkg-lowercased-path>/<file>.qml?action=main")` runs the
  legacy plugin's `onRun` (extensions load in console mode). The plugin **must be
  enabled once in the GUI** first, else dispatch pops an "enable it?" dialog that
  fails in console mode.
- **FileIO is sandboxed**: writes to `/tmp` are blocked (`apiv1::isPathAllowed`).
  Allowed: `~/Documents/MuseScore4[/…]` and `FileIO.tempPath()` (== `$TMPDIR`). Use
  `marker.tempPath() + "/x.txt"` to hand results back to a shell wrapper.
- **THE WALL: no current notation in ConsoleApp → `curScore` is null.**
  `PluginAPI::currentScore()` = `context()->currentNotation()`, which is a
  GUI-session concept. `api.autobot.openProject(name)` (resolves `name` under
  `userDataPath()/…TestingFiles`) returns `true` and loads the file, but it never
  becomes the current notation, so a dispatched plugin sees `curScore == null` even
  after long async waits. `newScore()` makes an object but not current either
  (`writeScore` then fails: "Only writing the selected score is currently supported").
  ⇒ **score-editing plugins (anything needing `curScore`/`cmd()`) can't run against a
  real score from the CLI on 4.7.3.** The bundled `autobotscripts/TC*` that DO edit
  scores rely on `api.shortcuts`/navigation and are meant for the in-app GUI Autobot
  panel, not `--test-case`. CLI is usable only for plugin logic that needs no score.
- **No CLI→GUI bridge.** In ConsoleApp mode the UI isn't built at all: navigation
  fails with `not found section with name: TopTool`, so you can't even drive the
  New-Score dialog to *create* a score. `Testflow::execScript` supports a `GuiApp`
  branch (full window/nav/shortcuts) — but it's only invoked from `consoleapp.cpp`
  (ConsoleApp); the GUI runs scripts only via the manual Diagnostics ▸ Testflow panel
  (`runScript`), and there is no startup/config hook to auto-run one. Verified on
  4.7.4. Net: on 4.7.x there is **no fully-automated path to exercise score effects
  outside the GUI plugin menu** (one click). Automated CI = Node unit tests of the
  pure `lib/` logic; effect verification stays the GUI harness. A future MuseScore
  that registers `MuseApi.Engraving` in the script engine *and* sets a current
  notation in console mode could unlock headless — re-probe with `smoke.js` then.

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

## Menus / packaging (JazzKit = ONE extension bundle)

- **JazzKit ships as a single extension bundle**, NOT loose legacy `.qml`
  plugins: a `manifest.json` (`uri`, `type`, `apiversion`, `actions[]`) in a
  folder deployed to the user **`extensions/`** dir (macOS:
  `~/Library/Application Support/MuseScore/MuseScore4/extensions/JazzKit/`), not
  `Documents/MuseScore4/Plugins/`. It shows as **one row** in the Plugin Manager
  (one enable) instead of one row per file.
- **A multi-action manifest auto-nests under its `title`.** `appmenumodel.cpp`
  `makePluginsItems()`: a manifest with >1 `actions[]` shown on the appmenu emits
  `makeMenu(m.title, …)` — so `"title": "JazzKit"` + 5 actions ⇒ a **"JazzKit"
  submenu**. (`menuPath`/`categoryCode` are irrelevant here — those are the loose
  -plugin levers.) No API hook injects a custom separator (the menu auto-adds one
  after "Manage plugins…"), and plugins can't register a dockable panel
  (Palettes/Properties are C++ appshell docks).
- **Pin `"apiversion": 1`** (default is 2) to keep the legacy-compatible globals
  (`curScore`, `cmd`, `Cursor`, `SymId`, all enums, `Settings`, `MessageDialog`).
  `courtesy_accidentals` (a shipped built-in) is the reference apiversion-1 bundle.
- Action `type`: **`form`** = a `MuseScore {}` `.qml` loaded as a view (see below);
  **`macros`** = a `.js` with a `main()` run by the ScriptEngine (has bare
  `curScore`/`cmd`, `require()`, but **no dialog API in v1** — messages go to
  `api.log` only). For a *loose* legacy `.qml` suite instead, a shared
  `categoryCode` is the submenu lever (raw code = title unless it's a built-in:
  `composing-arranging-tools`/`color-notes`/`playback`/`lyrics`).

## Extension `form` actions (what JazzKit uses)

- **A `form` gets NO `onRun`.** It's loaded as a view by the ui-engine, so run
  work from `Component.onCompleted` (defer a tick with `Qt.callLater` before
  mutating) and button `onClicked`. `quit()` closes the form.
- **The host sizes the window to the root's `implicitWidth/Height`, read ONCE at
  load** (`ExtensionViewer.qml`; falls back to `width/height`, then 480×600). A
  `Repeater`-driven `ColumnLayout` hasn't laid out when it's measured → the window
  comes up too short and buttons fall off. Fix: set `implicitHeight` **explicitly**
  from the known row count (see `comp_*` forms' `updateSize()`).
- **A form CANNOT dispatch notation `cmd()`s** — same focus trap as the old
  `pluginType:"dialog"`. The host `ExtensionViewer` (a `StyledDialogView`) holds
  focus, so `paste`/`slash-rhythm`/`voice-3`/`slash-fill` log
  `no one can handle the action` (context-free `copy` still runs — misleading).
  Verified via the harness log. ⇒ **effects invoked from a form must be
  direct-API only** (cursor note-input + element properties), never `cmd()`.
  Anything that genuinely needs `cmd()` must be a **`macros`** action (menu-
  dispatched, notation focused — `cmd()` works there, as `colornotes` shows).

## Direct-API effects (cursor writing, slashes, drums)

- **Cue/slash notation is fully buildable via the API** (all in `elements.h`):
  cue size = chord/note `small`; slash = replicate `Chord::setSlash` — per note
  `headGroup = NoteHeadGroup.HEAD_SLASH`, `fixed = true`, `fixedLine = 4`
  (middle line of a 5-line staff), `play = false`, hide notes after the first
  (`visible = false`); per chord `stemDirection = Direction.DOWN`, and for the
  stemless beat-fill also `noStem = true` + `beamMode = Beam.NONE`. See
  `JazzKit/lib/effects.js` `_applySlashChord`.
- **`rewindToTick(t)` on an EMPTY target skips FORWARD, not to the measure start.**
  `rewindToTick` = `tick2leftSegment(); nextInTrack()`, and `nextInTrack` advances
  past any segment with no element in the current track. A full-measure rest's only
  segment is at the measure start, so a score-wide segment at `t` (created by
  *another* staff) has no element in the empty target → the cursor lands in the
  NEXT measure. Symptom: notes written a bar late ("added to the closest point").
  **Fix: `rewindToTick(measureTick)`** (the measure start always has a target
  rest) **then write a leading rest up to `selStart`** — that positions AND splits
  the rest. See `effects.js` `_writeCueInto` / `_writeSlashRhythmInto`.
- A note whose duration crosses a barline is auto-written as **tied slices** — a
  second pass that cue-sizes / applies articulations must walk by **tick**, not by
  source index (there are more target chords than source notes).
- **Writing to a DRUM staff needs a VALID drum pitch.** `cursor.addNote(pitch)`
  silently drops invalid drum pitches and **forces the voice by pitch**. Get a
  usable pitch from the drumset: `part.instrumentAtTick(t).drumset.isValid(p)` /
  `.voice(p)` / `.name(p)`. See `effects.js` `_slashPitch`. (`SLASH_PITCH=71` works
  only on pitched staves.)
- **You cannot place a drum note in voice 3/4 via note input.** Because the
  drumset forces the voice by pitch and **no default-drumset pitch maps to voice
  3/4** (probe a kit: valid pitches sit in voices 1-2 only), `cursor.voice = 2`
  is overridden. So the "drum comp cue in voice 3" look (`JazzKit/lib/effects.js`
  `_writeDrumCueInto`) tops out at the drumset's highest voice (usually UI voice
  2): write the rhythm on the highest-voice valid pitch, then dress it as a cue —
  `small`, `play=false`, `stemDirection=Direction.UP`, `headGroup=HEAD_NORMAL`,
  `fixed=true` + `fixedLine=-2` (above the staff). Actual **voice 3** needs
  `cmd("voice-3")` to *move* an existing selection — a macro, not a form. Melody
  pitches can't be shown on a drum staff at all (dropped) — the cue is rhythm on
  a fixed carrier pitch.

## Legacy dialogs + notation `cmd()` (focus/context trap — pre-bundle)

- The same trap bites a **`pluginType: "dialog"`** legacy plugin. If you must run
  `cmd()`s from a legacy plugin, open your **own** `Window` and on Apply
  **`window.close()` FIRST, then run the `cmd()`s** (closing returns notation
  focus). JazzKit no longer does this (it's a direct-API bundle) but the pattern
  is the escape hatch for a loose plugin that needs `cmd()`.
- No bundled `Settings` module (checked MS 4.7 / Qt 6.10 — neither `QtCore` nor
  `Qt.labs.settings` ships). Persist dialog choices as a **score metatag**
  (`curScore.setMetaTag` + mirror to `curScore.excerpts[i].partScore`), per
  `line_breaks.qml`. `FileIO` (`import FileIO 3.0`) is available if you need a
  real file instead.
- Muse.UiComponents controls render with light theme text; on a light custom
  `Window` (`color:"#f0f0f0"`) force a dark `contentItem` or use
  `QtQuick.Controls` with an explicit dark `color`.
