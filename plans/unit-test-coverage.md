# Plan B — Maximise `npm test` coverage (planner/executor split)

## Goal
Move as much plugin logic as possible under **headless Node unit tests** (`npm test`),
so that CI catches regressions without MuseScore. The API-touching parts (`cmd()`,
`cursor.add`, layout) can never be unit-tested, but almost every plugin currently
inlines **pure decisions** (what to select, in what order, which beats to clear, which
elements to add) alongside those side effects. Extract the decisions.

## The pattern: planner (pure) + executor (thin)
Split each effect into:
- **Planner** — a pure function in `JazzKit/lib/*.js` that takes plain data (ticks,
  staff indices, timesig, selection geometry, target list) and returns an **ordered
  list of operation descriptors**, e.g.
  `[{op:"select", a, b, staff}, {op:"cmd", code:"copy"}, {op:"cmd", code:"paste"}, …]`.
  No MuseScore globals. **Unit-tested.**
- **Executor** — a tiny function (in `JazzKit/lib/effects.js`, driven by the `.qml`)
  that walks the descriptor list and performs each op via `ctx`
  (`ctx.JazzKit.selectStaffRange`, `ctx.cmd`, `ctx.curScore`, …). Not unit-tested, but
  now trivial and identical across plugins.

The executor stays GUI-only; the **plan** — the part with all the branching and
arithmetic that actually breaks — becomes fully testable. This is the highest-leverage
coverage move available given the constraints in
[.claude/skills/musescore-plugin-dev/reference/api-gotchas.md](../.claude/skills/musescore-plugin-dev/reference/api-gotchas.md).

## Conventions to follow (match the existing code)
- Pure libs live in `JazzKit/lib/*.js`, `// @ts-check`, JSDoc-typed against
  `JazzKit/lib/musescore.d.ts`, ending with a `var xxxLib = { … }` export trailer read
  by the Node loader (`test/load-qml-lib.mjs`). See `JazzKit/lib/slashes.js` as the
  model.
- Tests: `test/<name>.test.mjs` using `test/harness.mjs` (`test`, `eq`, `ok`), loaded via
  `loadQmlLib("../JazzKit/lib/<x>.js", "<x>Lib")`. Register the file in `test/run.mjs`.
- `npm test`, `npm run typecheck`, and `node scripts/check-qml.mjs JazzKit/*.qml
  JazzKit/lib/*.qml` must all stay green.
- Keep the `.qml` files to: read selection → build params → call `Effects.*` → map
  result to `InfoDialog`. No decision logic left in the `.qml`.

## Current state (audit)
Already pure + tested: `jazzkit.js` (`computeTargets`, `isCompInstrument`, json tags,
`countStaves`, `selectStaffRange` [thin]), `slashes.js` (`emptyRestRegions`, `beatTicks`),
`linebreaks.js` (`computeLines`, `minMerge`), `articulations.js` (`classifyChord`,
`chordNames`, `staccatoCandidates`, `articSymbol`), `harness.js`.
Already split: `fill_empty_slashes.qml` → `Effects.fillEmptyBeats` (executor) +
`Slashes.emptyRestRegions` (planner). **Use this as the reference implementation.**

Remaining inline logic to extract, per plugin:

### 1. `comp_slashes.qml` → planner `Slashes`/new `comp.js` + `Effects.compSlashes`
- Inline today: `stamp()` — per target, the fixed 4-step sequence (copy source →
  paste → slash-rhythm real region → delete leading beats) with the `selStart >
  measureTick` branch.
- Planner `compSlashesPlan({measureTick, selStart, selEnd, srcStaffIdx, targets})` →
  ordered op list incl. the conditional leading-beat `delete`. Pure; unit-test the op
  list for: single target, multiple targets, `selStart === measureTick` (no delete
  step), and `target === srcStaffIdx` skipped.
- Executor `Effects.compSlashes(ctx, params)` walks the plan; returns
  `{targetsDone, error}`. `.qml` reads selection + targetsModel → params.

### 2. `comp_cues.qml` → planner + `Effects.compCues`
- Inline today: `stamp()`, `pitchedCue()`, `drumComp()`, `makeCueSize()`.
- Two planners: `compCuePitchedPlan(...)` and `compCueDrumPlan(...)` returning op lists
  (paste, optional leading-beat delete, cue-size marker step / voice-3 + slash-rhythm +
  slash-fill). Represent "make cue size" as an op `{op:"cueSize", staff, a, b}` the
  executor implements with the cursor walk (that walk stays in the executor).
- Unit-test both plans across the leading-beat branch and drum-vs-pitched selection.
- Executor `Effects.compCues(ctx, params)` dispatches by `isDrum` per target.

### 3. `fix_marcato_staccatos.qml` → `Effects.fixMarcatoStaccatos`
- Pure decision (marcato present? staccato present? add-above?) already in
  `articulations.js`. Inline remnant is **iteration + side effects**
  (`_processStaff/_processVoice/_tryAddHiddenStaccato`, `newElement`, `cursor.add`,
  setting `hidden`/`visible`). Little pure logic remains to extract — instead just move
  the whole traversal into `Effects.fixMarcatoStaccatos(ctx)` returning `{added, hidden}`
  so Plan A can call it and the `.qml` shrinks to one call. No new unit tests required
  beyond the existing `articulations.test.mjs`, but add a test asserting the
  per-chord classifier's decision table is complete (marcato+staccato → hide;
  marcato-only → add; neither → noop) if not already covered.

### 4. `line_breaks.qml` → `Effects.lineBreaks`
- Pure `computeLines`/`minMerge` already tested. Inline remnant: reading the score into
  the `boxes` array the planner consumes, and applying `LAYOUT_BREAK` add/remove. Extract
  a pure `lineBreakOps(boxes, options)` → `{toRemove:[idx…], toAdd:[idx…]}` if the
  add/remove decision has any branching worth testing; otherwise leave as executor.
  Move application into `Effects.lineBreaks(ctx, options)`.

### 5. Shared: selection geometry
- Every comp plugin repeats: rewind to selection → `selStart`, `measureTick =
  measure.firstSegment.tick`, `selEnd` with the end-of-score wrap fallback. The **wrap
  fallback and the `selStart > measureTick` leading-beat decision** are pure. Extract
  `selectionGeometry(cursorReads)` / a helper that, given raw `{selStart, selEnd,
  measureTick, lastTick}`, returns the normalised geometry + `hasLeadingBeats`. Unit-test
  the wrap and leading-beat cases once; reuse in every comp planner.

## Step-by-step for the implementing agent
Do one plugin at a time, keeping everything green between plugins:
1. Pick a plugin; identify its inline planner logic vs side effects.
2. Add the pure planner function to the appropriate `lib/*.js` (new `comp.js` for the
   comp plugins, or extend `slashes.js`), with JSDoc types and the export trailer.
3. Add `test/<lib>.test.mjs` cases covering every branch of the plan (empty targets,
   leading-beat present/absent, source==target skip, multi-target order). Register in
   `test/run.mjs`.
4. Add/extend the executor in `JazzKit/lib/effects.js` to consume the plan via `ctx`.
5. Rewrite the `.qml` to: validate + read selection → params → `Effects.*` → result →
   `InfoDialog`. Delete the now-migrated inline functions.
6. Run `npm test`, `npm run typecheck`, `node scripts/check-qml.mjs JazzKit/*.qml
   JazzKit/lib/*.qml` — all green.
7. **Verify behaviour didn't change**: because none of this is headless-testable, run
   the plugin once in the GUI on a real selection (or via the Plan A harness case) and
   confirm identical output to before. This is mandatory — the refactor moves code but
   must be behaviour-preserving.
8. Commit per plugin with a message noting the planner/executor split.

## Acceptance criteria
- Each comp plugin's step-sequencing decision is a **pure, unit-tested** planner; the
  `.qml` and `effects.js` contain no branching beyond dispatching the plan.
- `npm test` count grows by the new planner cases; `test/run.mjs` includes every new file.
- `npm run typecheck` and `check-qml` stay green; `musescore.d.ts` extended only as needed
  (add shapes you actually touch, per its "verified but minimal" note).
- Each refactored plugin verified once in the GUI as behaviour-identical.
- Net: the only code NOT under `npm test` is the executor's literal API calls
  (`selectStaffRange`, `cmd`, `cursor.add`, cue-size cursor walk) — everything that
  decides *what* to do is tested headlessly.

## Interaction with Plan A
Plan A's harness calls these same `Effects.*` executors, so doing Plan B first makes
Plan A's cases thin and gives the executors a second, end-to-end check in the GUI. Order:
Plan B per plugin → add that plugin's Plan A harness case.
