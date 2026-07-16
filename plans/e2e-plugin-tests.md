# Plan A — End-to-end plugin test harness (one-click, in-GUI)

## Goal
A single command that opens MuseScore ready to test, and a **single menu click**
that runs **every JazzKit plugin's real effect end-to-end** against auto-built
fixtures, asserts the results off the live API, and shows one PASS/FAIL report.
Manual input is reduced to: run the script → click one menu item → read the box.

## Why it must be this shape (read before designing)
Proven this session and recorded in
[.claude/skills/musescore-plugin-dev/reference/api-gotchas.md](../.claude/skills/musescore-plugin-dev/reference/api-gotchas.md):
- **No CLI / headless path** exists for score-editing plugins on MS 4.7.x. `--test-case`
  runs in `ConsoleApp` mode where **no notation UI is built** (`curScore` is null,
  navigation fails with `not found section: TopTool`), so the effects — which need
  `curScore` + `cmd()` — cannot run. MuseScore's own equivalents are compiled C++
  gtests (not reachable from our QML) and GUI autobot tests (need a display + the
  in-app panel). The GUI plugin menu is therefore the floor: **one click.**
- **No plugin-side `undo`** (`cmd("undo")` / `command://notation/undo` are not
  dispatchable). Reset between cases by operating on **independent regions/staves**
  of the fixture and discarding it; never rely on undo.
- **Modal dialogs block/mislead an automated run.** The harness must therefore call
  the plugins' **extracted effect functions** (see Plan B — `JazzKit/lib/effects.js`),
  NOT dispatch the plugin menu actions (those open `CompTargetsDialog`/`InfoDialog`).
- **Fixtures can be built in-plugin**: `curScore.appendPart(id)`, `appendMeasures(n)`,
  `cursor.setDuration`/`addNote`/`addRest` all work in the GUI; `removeParts([p])`
  cleans up. (`newScore`/`readScore` are half-implemented — do not use.)
- Respect the `startCmd`/`endCmd` rules and "each `cmd()` standalone" rule from the
  gotchas file, and re-verify `curScore.selection.startStaff` before any destructive
  `cmd()`.

## Dependencies
This plan assumes **Plan B has extracted each plugin's effect into
`JazzKit/lib/effects.js`** as a pure-executor function taking a `ctx` bundle
(`{curScore, cmd, Cmd, JazzKit, Slashes, Element, Segment, Cursor, …}`) plus
pre-computed params, and returning a plain result object (no dialogs). If Plan B is
not yet done for a given plugin, that plugin's case is written as `H.skip(...)` with a
TODO until its effect is extracted. Do Plan B first, or interleave per plugin.

Current state: `fillEmptyBeats` is already extracted (`JazzKit/lib/effects.js`) and
covered by the existing single-case harness `harness/test_harness.qml` — use that as
the template.

## Deliverables
1. `harness/test_harness.qml` — extend from 2 cases to **one case per plugin effect**.
2. `harness/lib/` (synced copy) — no change; harness imports `JazzKit/lib/*` via the
   `JazzKitTest` package that `scripts/sync-harness.sh` assembles.
3. `scripts/e2e.sh` — new launch script (below).
4. `plans/e2e-plugin-tests.md` acceptance run recorded once (paste the report box).

## Fixture strategy (deterministic, self-cleaning)
Build everything inside the harness on the currently-open score; require the score be
empty first (guard already in `test_harness.qml`: `scoreHasNotes()` → refuse). Per
case, append the instruments that case needs, write only that case's notes, run the
effect, assert, then leave it (the whole fixture is discarded — the harness prints
"close WITHOUT saving"). Keep cases on **separate appended parts** so they can't
interfere and order doesn't matter.

Helper inventory already in `test_harness.qml` (reuse): `findNote`, `findEmptyMeasure`,
`chordCount`, `buildFixture` (appendPart + appendMeasures + seed note), `cleanupFixture`.
Generalise `buildFixture` to return a handle per case (see steps).

## Per-plugin cases (fixtures + assertions)
For each, "select" means `JazzKit.selectStaffRange(curScore, a, b, staffIdx)` and
assert its return; "effect" means the `Effects.*` function from Plan B.

1. **Fill Empty Beats with Slashes** — `Effects.fillEmptyBeats`
   - Fixture: one pitched staff; a measure whose voice-1 is all rests.
   - Assert: `chordCount` in that measure goes `0 → >0`; `res.filled === res.regions`.
   - (Already implemented — keep as the reference case.)

2. **Fix Marcato Staccatos** — `Effects.fixMarcatoStaccatos` (whole-score, no selection)
   - Fixture: a staff with a chord carrying a **marcato** articulation and no staccato
     (add via `newElement(Element.ARTICULATION)` + `cursor.add`, symbol from
     `Articulations.staccatoCandidates`/marcato SymId), plus a second chord with
     marcato **and** a visible staccato.
   - Assert: result `{added, hidden}` is `{added:1, hidden:1}`; then re-read the two
     chords' `articulations` and confirm each marcato now has a staccato and it is
     `hidden`/`!visible`.

3. **To Comp Slashes** — `Effects.compSlashes` (extracted `stamp()`)
   - Fixture: a pitched "source" staff with a short rhythm selected + one comp target
     staff (e.g. a second pitched part). Params: `{measureTick, selStart, selEnd,
     srcStaffIdx, targets:[targetStaffIdx]}`.
   - Assert: target staff voice-1 over `[selStart, selEnd)` now has chords (slashes);
     leading beats `[measureTick, selStart)` are rests again; source staff unchanged.

4. **To Comp Cues** — `Effects.compCues` (extracted `stamp`/`pitchedCue`/`drumComp`)
   - Fixture A (pitched target): source rhythm + a pitched target. Assert target voice-1
     has a **cue-size** copy (`chord.small === true`, `notes[k].small === true`).
   - Fixture B (drum target): source + a percussion part (`appendPart` a drumset
     instrument; confirm `part.hasDrumStaff`). Assert voice-3 has slash-rhythm chords
     and voice-1 has time slashes. (If drum fixture proves flaky under the API, downgrade
     to `H.skip` with a note — see gotchas "drum staves".)

5. **Format Line Breaks** — `Effects.lineBreaks`
   - Fixture: a single staff with N measures (`appendMeasures`) and a known structural
     marker if the effect uses one (double barline etc. — add via the same action the
     plugin reads, or seed the metatag options the plugin persists).
   - Assert: after running, the count/position of `Element.LAYOUT_BREAK` elements matches
     what `Linebreaks.computeLines(...)` predicts for that fixture (the pure lib is
     already unit-tested, so assert the effect reproduces its plan).

## Report
Reuse `JazzKit/lib/harness.js` (`newReport`/`check`/`skip`/`format`). One `InfoDialog`
at the end with the full `format(report)` text. Header already encodes
PASS/FAIL/SKIP counts. Keep the "close WITHOUT saving" trailer.

## `scripts/e2e.sh` (the launch step)
```bash
#!/bin/bash
# Deploy the harness package and open MuseScore on a blank score, ready for the
# one-click end-to-end run. Manual steps after this: Plugins ▸ "zz Test Harness"
# (first time only: enable "JazzKit Test" in Home ▸ Plugins), then read the box and
# close WITHOUT saving.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/sync-harness.sh"          # (re)deploy JazzKitTest package
MSCORE="${MSCORE_BIN:-/Applications/MuseScore 4.app/Contents/MacOS/mscore}"
# Open a brand-new empty score so the harness's emptiness guard passes.
# (MuseScore has no "new blank score" CLI flag; opening with no file lands on Home —
#  acceptable. If a committed blank fixture is preferred, open it here instead.)
open -na "/Applications/MuseScore 4.app"
cat <<'EOF'
Next:
  1. File ▸ New  → create any empty score (or open a blank fixture).
  2. Plugins ▸ "zz Test Harness"   (first run: enable "JazzKit Test" in Home ▸ Plugins)
  3. Read the PASS/FAIL box. Close the score WITHOUT saving.
EOF
```
(Feel free to commit a `harness/fixtures/blank.mscz` and `open` it directly to remove
the "File ▸ New" step — but a committed fixture must be produced from the GUI once,
since `writeScore` can't mint one headless.)

## Step-by-step for the implementing agent
1. Read `harness/test_harness.qml` and `JazzKit/lib/harness.js` fully; understand the
   existing `fillEmptyBeats` case + `buildFixture`/`cleanup` lifecycle.
2. Confirm Plan B has extracted the effect you're adding a case for. If not, extract it
   first (Plan B) or stub the case with `H.skip`.
3. Add a `caseXxx(r)` function per plugin following the fixture/assert specs above.
   Each case: build its own appended part(s) inside a `startCmd/endCmd`; run the effect;
   assert with `H.check`; do not undo.
4. Wire the new cases into `onRun` after the emptiness guard; keep the final
   `infoDialog.show(H.format(r) + "close WITHOUT saving")`.
5. `node scripts/check-qml.mjs harness/*.qml` must pass. `npm run typecheck` must pass
   (only affects `lib/*.js`, but keep effects.js typed).
6. Write `scripts/e2e.sh`, `chmod +x`.
7. Run it, click the harness, paste the report box here, and iterate on any FAIL using
   `scripts/mslog.sh` (the harness runs in the GUI — logs + crash dumps are the only
   debugging surface).

## Acceptance criteria
- `scripts/e2e.sh` opens MuseScore; a single click on "zz Test Harness" runs **all five
  plugins' effects** and shows one report with **0 FAIL** on a clean run.
- No case relies on `undo`; the fixture is discarded (no save).
- `node scripts/check-qml.mjs harness/*.qml` and `npm run typecheck` pass.
- The test plugins remain in the **`JazzKitTest`** package only (never in `JazzKit/`),
  so nothing leaks into the shipping install.

## Known risks / fallbacks
- Drum-staff cue (case 4B) may be unreliable (see gotchas "drum staves"): if so, `H.skip`
  it with a note rather than block the suite.
- `appendPart` instrument ids are not readable from the API; keep the candidate-list
  approach from `buildFixture` and report which id worked.
- If a `cmd()` effect no-ops, first check `curScore.selection.startStaff` and that the
  selection is a range (see gotchas "Selection").

## Acceptance run (recorded 2026-07-16, MuseScore 4.7.x)

`scripts/e2e.sh` → File ▸ New (any empty score) → Plugins ▸ "zz Test Harness". All
five plugin effects (fill, marcato, comp slashes, comp cues pitched **and drums**)
ran end-to-end with **0 FAIL**. Report retrieved via `scripts/harness-report.sh`
(the harness writes it to `~/Documents/MuseScore4/Scores/jazzkit-harness-report.txt`
— the InfoDialog box can't be copied and plugin `console.log` doesn't reach the log):

```text
HARNESS PASSED — 25 ok.

OK   self-test: pitch-up raises pitch  (expected 61, got 61)
OK   fillEmptyBeats: found fillable regions  (regions=1)
OK   fillEmptyBeats: filled, no select failure  (filled=1/1)
OK   fillEmptyBeats: empty beats became slashes  (voice-1 chords 0 → 4)
OK   marcato: added one hidden staccato  (added=1)
OK   marcato: hid one visible staccato  (hidden=1)
OK   marcato: marcato-only chord gained a hidden staccato  (visibilities=[false])
OK   marcato: pre-existing staccato is now hidden  (visibilities=[false])
OK   compSlashes: no error  (ok)
OK   compSlashes: one target stamped  (targetsDone=1)
OK   compSlashes: target got slash chords  (chords 0 → 4)
OK   compSlashes: source rhythm intact  (source chords=4)
OK   compCues pitched: no error  (ok)
OK   compCues pitched: one target stamped  (targetsDone=1)
OK   compCues pitched: target has a chord  (chord present)
OK   compCues pitched: chord is cue-size  (small=true)
OK   compCues pitched: notehead is cue-size  (note.small=true)
OK   compCues drum: no error  (ok)
OK   compCues drum: one target stamped  (targetsDone=1)
OK   compCues drum: voice-3 comping chords  (voice-3 chords=4)
OK   compCues drum: voice-1 time slashes  (voice-1 chords=4)
OK   lineBreaks: planner predicts breaks  (predicted=15)
OK   lineBreaks: added the planned breaks  (added=15 expected=15)
OK   lineBreaks: cleared no pre-existing breaks  (removed=0)
OK   lineBreaks: LAYOUT_BREAK elements match plan  (found=15)
```

Notes: the drum staff is added by the harness up front, then a one-shot `Timer`
yields to the event loop so the audio mixer settles before the cases run — this is
what avoids the `MixerPanelModel::onTrackAdded` crash (a busy-wait `sleep` does not,
since it blocks the same main thread). `lineBreaks` counts reflect the 32-measure
default of a new score (every-2-bars ⇒ 15 breaks), not a fixed fixture size.
