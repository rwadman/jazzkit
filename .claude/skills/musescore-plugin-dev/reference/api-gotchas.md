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

- **`cursor.addNote` (note INPUT) can't write an arbitrary pitched rhythm onto a
  drum staff.** In `NoteInput::addPitch` (`src/engraving/editing/noteinput.cpp`) for
  a drumset:
  - invalid drum pitch → `return nullptr` (silently dropped — no note, no error);
  - `track = ds->voice(pitch) + staffBase` → **drumset forces the voice**,
    overriding `cursor.voice`. This forcing is ONLY in note input.
  - Reliable path for pitched → drum: `cmd("copy")` + `cmd("paste")` (as the GUI).
  - **But `cursor.add(chord)` bypasses note input entirely** and honors `cursor.voice`
    on a drum staff (see the voice-3 technique in "Direct-API effects" below).
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
  -plugin levers.) Confirmed in the GUI on 4.7.3: JazzKit's 6 actions appear as a
  **JazzKit** submenu of **Plugins**. No API hook injects a custom separator (the menu auto-adds one
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
- **The host sizes the window ONCE, at show, from the root's implicit size — and
  never resizes it again.** The chain (verified in source):
  `ExtensionViewer.qml` binds `height: builder.contentItem.implicitHeight` →
  `ExtensionViewerDialog` binds `contentHeight: viewer.height` →
  `StyledDialogView`'s `contentBody.implicitHeight` → and
  `WindowView::showView()` ends with
  `updateSize(QSize(rootObject->implicitWidth(), rootObject->implicitHeight()))`
  (`windowview.cpp`), which is the only call that sizes the QWindow. `DialogView`
  adds the title bar separately (`frameMargins`), so `contentHeight` is the client
  area — the title bar is NOT eating your content. Consequences:
  - a value that is too small at show ⇒ **buttons off the bottom**, permanently;
  - changing `implicitHeight` later (e.g. when the form switches to its result
    message) does nothing to the window.
- **Measuring a `Repeater`-driven `ColumnLayout` does NOT work — use row
  arithmetic.** A plain `height: contentColumn.implicitHeight + 32` binding is fine
  for static content (`line_breaks.qml`), but with a `Repeater` the layout hasn't
  laid out when the host measures, and `forceLayout()` before reading
  `implicitHeight` **still came up short in the GUI** (buttons below the bottom
  edge — tried twice on JazzKit's comp forms, reverted both times). Compute it:
  `chromeHeight(130) + rows * rowHeight(40)`, or a flat 180 for a message-only
  state. See `CompTargetsForm.qml`'s `updateSize()`.
- **ASSIGN `implicitHeight`, don't bind it.** `root.implicitHeight = <value>` from
  the root's `Component.onCompleted` works; `implicitHeight: <expression>` on the
  `MuseScore{}` root lost the button row entirely in the same form. Verified the
  hard way, twice.
- **A form can't dispatch notation `cmd()`s WHILE ITS WINDOW IS OPEN, but can after
  `quit()`.** Most notation actions are gated on `isNotationPage()` →
  `UiContextResolver` (4.7.x source, `src/context/internal/uicontextresolver.cpp`):
  an open plugin window makes the context "dialog" and the dispatcher logs `no one
  can handle the action: <code>`. Verified in the GUI on 4.7.5 with a probe form:
  `cmd("tie")` at 1.5 s → refused; `quit()` then `cmd("tie")` → works,
  synchronously, and the form's JS keeps running afterwards (`Qt.callLater` and a
  300 ms `Timer` after `quit()` both still fired and dispatched). Traps:
  - In the first tick after the form opens the window isn't yet the current dialog,
    so a `cmd()` there works (misleading). A `quit()` there is LOST: the window still
    opens. Quit only once the window is up (a user click, or ≥ ~1.5 s).
  - A LEGACY plugin (`onRun`) counts as a dialog for its whole run: `cmd("tie")`
    is refused there, while `pitch-up` works (it has a different gate). This is
    probably where the old "forms can't cmd()" note came from.
  - So: do the direct-API work, `quit()`, then run the `cmd()`s. JazzKit's comp
    forms do exactly this for ties (`CompTargetsForm.apply` → `Effects.applyTies`),
    and the harness quits itself before running its cases.

## `macros` actions — the way to run WITHOUT opening a window

- A **`form` action always opens a window**: the host loads it as a view in a
  `StyledDialogView`. There is no "invisible form" — an action that takes no input
  and should just run must be **`type: "macros"`** (a `.js` whose `main()` the
  script engine calls — the shipped `courtesy_accidentals` add/remove are exactly
  this, as is JazzKit's `autofix.js`). A form can close itself with
  `Qt.callLater(quit)`, but the window still flashes — only a macro shows nothing.
- **A v1 macro gets the same bare globals a legacy QML plugin had.**
  `EngravingApiV1::setup` copies *every* property/invokable of the engraving API
  onto the global object (`api/v1/engravingapiv1.cpp`), so `curScore`,
  `newElement`, `cmd`, `quit`, `division`, `mscoreMajorVersion` and every enum
  (`Element`, `Segment`, `Cursor`, `SymId`, `Accidental`, …) are all there.
- **`require("lib/x.js")` works and is the macro's `import`.** `JsModuleLoader`
  resolves a non-`MuseApi.*` name against the SCRIPT'S OWN directory first (then
  the default/user extension paths), wraps the file in an IIFE, and returns
  whatever it assigned to the global `exports`.
- **`exports` is ONE shared global, never reset between requires**
  (`scriptengine.cpp` sets it once at engine setup; `requireFile` just reads it
  back after evaluating). So a lib that forgets the
  `if (typeof exports !== "undefined") { exports = <lib>; }` trailer silently
  returns the **previous** require's exports — you get a live object of the wrong
  shape, and the failure surfaces far away as
  `TypeError: Property 'x' of object [object Object] is not a function`. Verified
  this session: `require("lib/articulations.js")` (no trailer at the time) handed
  back jazzkit.js's exports. Give EVERY lib the trailer, even ones no macro
  requires yet — `test/require-exports.test.mjs` emulates this loader (a `node:vm`
  context = the shared global; entry script unwrapped, requires IIFE-wrapped) and
  fails if a trailer goes missing, so this is checkable without the GUI.
- **No dialog API in v1 macros** — `console.log` (→ the MuseScore log) is the only
  feedback channel. That's a feature for a silent action, and the reason anything
  needing options keeps a separate `form` action for its settings.
- Menu-dispatched macros have no window, so `cmd()` works there without the
  `quit()` dance a form needs.

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
- **`cursor.setDuration(z, n)` silently TRUNCATES a length no single note value
  spells.** It builds `TDuration(Fraction)`, which (release build) rounds down to
  the longest value that fits: `setDuration(5, 8)` → a half. A gap-filling rest
  then ends early and every later write lands early. Split arbitrary spans into
  plain values first (`effects.js` `splitRestTicks`).
- **Tuplets: `duration` is NOMINAL.** A triplet eighth reads `duration` 1/8 (240
  ticks); `actualDuration` is 160. Reading `duration` and writing it back with
  `setDuration` flattens the triplet to straight eighths and shifts everything
  after it. Re-create the tuplet with `cursor.addTuplet(fraction(3,2),
  fraction(1,4))` (leaves the cursor on its first member, pre-filled with rests),
  then write the members with their NOMINAL durations. `el.tuplet.actualNotes /
  normalNotes / duration` give the ratio and span; the start tick is
  `tuplet.elements[0].parent.tick` (`EngravingItem.fraction` is 4.6+ only).
  `addTuplet` refuses a tuplet crossing a barline.
- **Ties can't be built through the API.** A Tie element needs its end note, which
  nothing exposes: `note.add(newElement(Element.TIE))` reaches `undoAddElement`,
  which dereferences the missing start/end notes (crash). Use `cmd("tie")`: with
  several notes selected (`selection.select(n, true)`), ONE `cmd("tie")` ties each
  to its next same-pitch note in a single undo step. It toggles a selected note
  that is already tied OFF, and a note with no next same-pitch note may be tied to
  a later selected note or grow a new note, so select only notes whose next note
  provably continues the tie (`effects.js` `applyTies`).
- **A plugin-built chord is ZERO ticks long**, so `chord.duration = D` after
  `cursor.add(chord)` is a *lengthen* (`Score::changeCRlen` → `makeGap`). `makeGap`
  counts the chord's own span only from the first score segment AFTER the chord's
  tick: if ANY staff has a segment inside the span (a drum groove's eighths), the
  stretch up to it goes uncounted and makeGap eats the next element in the voice.
  Fix: set `chord.duration` first to exactly that stretch, then to D (only works
  when the stretch is one note value — see `_writeDrumCueInto`). There is no way to
  set a detached chord's length (`durationTypeWithDots` sets only the type, not
  the ticks; `noteType` is read-only), and `chord.remove` on a detached chord goes
  through `deleteItem` — don't.
- A note whose duration crosses a barline is auto-written as **tied slices** — a
  second pass that cue-sizes / applies articulations must walk by **tick**, not by
  source index (there are more target chords than source notes).
- **Writing to a DRUM staff needs a VALID drum pitch.** `cursor.addNote(pitch)`
  silently drops invalid drum pitches and **forces the voice by pitch**. Get a
  usable pitch from the drumset: `part.instrumentAtTick(t).drumset.isValid(p)` /
  `.voice(p)` / `.name(p)`. See `effects.js` `_slashPitch`. (`SLASH_PITCH=71` works
  only on pitched staves.)
- **You CAN place a drum note in voice 3/4 from a form — via `cursor.add`, NOT
  note input.** `cursor.addNote` (note input) forces the voice by pitch and no
  default-kit pitch maps to voice 3/4, so `cursor.voice=2` is overridden. But the
  forcing lives only in `NoteInput::addPitch`. `Cursor::add(ChordRest)`
  (`api/v1/cursor.cpp`) does `s->setTrack(cursor.track); undoAddCR(...)` — it
  **honors `cursor.voice`** and never touches the drumset. The one catch: a fresh
  `newElement(Element.CHORD)` has `DurationType::V_INVALID`, and the only exposed
  duration setter (`chord.duration` → `changeCRlen`) needs the chord already
  placed in a measure — you can't set it before adding. **Technique that works**
  (verified this session in the harness — `_writeDrumCueInto`), all inside ONE
  `startCmd`/`endCmd` so layout is deferred until durations are valid:
  1. **Rest shell**: write the rhythm as RESTS into the target voice with
     `cursor.addRest()` — it goes through `enterRest`, NOT `addPitch`, so **no
     voice-forcing**; it also advances the cursor and segments the voice. (Use the
     empty-voice trick to position: `voice=0; rewindToTick(measureTick); voice=N`.)
  2. **Drop notes**: a second cursor walks the shell with `cursor.next()`; at each
     note beat, build `Element.CHORD` + `Element.NOTE` (`chord.add(note)`), then
     `cursor.add(chord)` (replaces the rest at `cursor.track`), then
     `chord.duration = <the rest's duration>` to fix the invalid duration.
  Then dress as a cue: `small` (chord-level, not per-note), `play=false`,
  `stemDirection=Direction.UP`, `headGroup=HEAD_NORMAL`, `fixed=true` +
  `fixedLine=-1`. **Ledger lines**: `ChordLayout::updateLedgerLines` draws them for
  any note above line `-1` (`upLine >= -1` → none) regardless of notehead — so the
  notehead group does NOT suppress them; `fixedLine=-2` strikes a ledger line
  through the note. `-1` (space just above the top line) is the highest ledger-free spot.
  `cmd("voice-3")` also moves an existing selection but needs a
  macro (form focus trap) — the `cursor.add` path needs no `cmd()`. Melody pitches
  still can't be shown on a drum staff (dropped) — the cue is rhythm on a fixed
  carrier pitch (any valid drum pitch; voice is now set explicitly).

## Rests (grouping, full-measure rests)

- **MuseScore's own rest grouping = `Score::setRests` → `toRhythmicDurationList`**
  (rests: maxDots 1; a whole bar → a full-measure rest). A range `cmd("delete")`
  refills with it, but it ALSO deletes every annotation in the range, chord symbols
  included (`deleteAnnotationsFromRange`, and plugins can't set the selection
  filter). JazzKit ports the function (`lib/rests.js`) and rewrites rest runs with
  cursor note input, which keeps time-anchored text (chord symbols, staff text,
  dynamics: `TextBase::allowTimeAnchor`) but deletes fermatas and slurs inside the
  rewritten span (`makeGap`, 4.7.3).
- **A full-measure rest can't be made through the API.** Note input never writes
  one, and `durationTypeWithDots` is readable (`{type, dots}`) but its write is
  `NOT_SUPPORTED` (`PropertyValue::fromQVariant`). Use `cmd("full-measure-rest")`
  (`Score::cmdFullMeasureRest`) with the bar's FIRST rest selected: it replaces
  that one voice's rests in that bar. Its range path needs the selection to end on
  a barline segment, and a plugin `selectRange` always ends on a chord/rest segment,
  so there it silently does nothing. It removes tuplet members without their
  tuplet, so skip bars with tuplets. `el.isFullMeasureRest` reads the result.
- **Regroup rhythms = `cmd("reset-groupings")`** (`Score::regroupNotesAndRests`,
  note path of the same `toRhythmicDurationList`, maxDots 1, more lenient than
  rests). With nothing selected it does the whole score. It rewrites EVERY rest run
  and tie chain in range (cloning the first chord), so it also deletes fermatas and
  slurs inside each rewritten span and drops articulations/lyrics from all but the
  first chord of a chain. JazzKit runs it per staff and bar, only where its port
  predicts a change and nothing would be lost (`effects.js` `groupNotes`). A plugin
  `selectRange(barStart, nextBarStart, s, s+1)` selects exactly that bar; an end
  tick at the score's end resolves to "no segment" = to the end.
- `removeElement(rest)` refuses voice-1 rests; voice 2-4 rests become gaps and are
  deleted once only gaps remain in the bar (`Score::deleteItem`).
- **Set a Harmony's `text` AFTER `cursor.add(h)`.** Setting it on a detached
  `newElement(Element.HARMONY)` crashes in `Harmony::setProperty` (verified crash
  dump).

## Accidentals (`note.accidentalType` can silently RETUNE the note)

- `note.accidentalType = X` is not a cosmetic property — it routes to
  `EditNote::changeAccidental` (`src/engraving/editing/editnote.cpp`), which
  **recomputes the pitch** from the staff line + the accidental in force
  (`measure->findAccidental`) and undo-changes it. Setting `Accidental.NONE` on a
  note whose accidental was *required* therefore transposes it. **Guard every
  write: capture `note.pitch`, write, and roll back if it moved** (see
  `effects.js` `_setAccidental`/`_clearAccidental`).
- Setting a type that matches the pitch already sounding takes the `forceAdd`
  branch: the accidental is (re)created with `AccidentalRole::USER` and drawn
  unconditionally — that is exactly a courtesy/cautionary accidental, and
  MuseScore won't garbage-collect it.
- Bracketing is a property of the **Accidental element**, not the note:
  `note.accidental.accidentalBracket = 0|1|2` (none/parenthesis/bracket —
  `dom/accidental.h`), readable only after the accidental exists.
- Reading state: `note.tpc` is the **written** spelling, `note.tpc1` the concert
  one (use `tpc1` for the Cb/B# octave correction so transposing staves work),
  `note.tieBack` marks a tie continuation (never needs an accidental), and
  `cursor.keySignature` is the signed sharp count in force **for the cursor's
  staff** — so set `staffIdx`/`voice` before rewinding to read it.
- Unpitched percussion staves have no meaningful accidentals — skip them (find
  them via the part's `drumset`).

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
