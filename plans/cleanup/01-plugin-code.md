# Cleanup: `JazzKit/` (shipping bundle)

Scope: `JazzKit/*.qml`, `JazzKit/autofix.js`, `JazzKit/lib/*.js`.
See [README.md](README.md) for guardrails (notably: edits to `lib/*.js` invalidate
`harness/acceptance.json`).

---

## P1 — Dead code: `JazzKit.selectStaffRange` -- DONE

**Where:** [JazzKit/lib/jazzkit.js:72-86](../../JazzKit/lib/jazzkit.js#L72-L86), export at
[:215](../../JazzKit/lib/jazzkit.js#L215).

**Problem:** No production caller. It exists to prepare a selection for a dispatched
`cmd()` — and no shipping action dispatches `cmd()` any more (forms can't). The only
references are three tests ([test/jazzkit.test.mjs:51-80](../../test/jazzkit.test.mjs#L51-L80)),
a mention in the `EffectCtx` typedef ([effects.js:20](../../JazzKit/lib/effects.js#L20)),
and the two `plans/*.md` docs. Its docstring ("The dispatched `cmd()`s act on
`curScore.selection`") documents an architecture the code no longer has.

**Do:** Delete the function, its export entry, its tests, and the `selectStaffRange`
mention in the `EffectCtx` `@property {*} JazzKit` line. Also drop it from
`test/require-exports.test.mjs` if listed (it is not, currently).

---

## P2 — Stale comments that describe code that no longer exists -- DONE

Each of these actively misleads a reader; fix the text, don't just delete it.

| # | Where | Says | Reality |
| --- | --- | --- | --- |
| a | [effects.js:85](../../JazzKit/lib/effects.js#L85) | "Drum targets are left to the slash path (handled separately)" | `compCuesNotes` routes drums to `_writeDrumCueInto` (voice-3 cue notes), not the slash path |
| b | [line_breaks.qml:13-14](../../JazzKit/line_breaks.qml#L13-L14) | "the pattern proven safe from a form (see `courtesy_accidentals`)" | There is no `courtesy_accidentals.qml`; it was folded into the `autofix` macro |
| c | [articulations.js:4-7](../../JazzKit/lib/articulations.js#L4-L7) | "The .qml resolves each articulation … (see `_canonicalName` there) … The .qml keeps the effects" | The caller is `effects.js`, and the function is `canonicalName` (no underscore), in this same file |
| d | [slashes.js:4-7](../../JazzKit/lib/slashes.js#L4-L7) | "The .qml walks the score and reads out …" | `effects.js:_emptyRestRegions` does |
| e | [accidentals.js:11](../../JazzKit/lib/accidentals.js#L11), [articulations.js:9](../../JazzKit/lib/articulations.js#L9) | "`QML: import "lib/x.js" as X`" | Both are `require()`d by the `autofix.js` macro, never imported by a form |
| f | [InfoDialog.qml:6-10](../../harness/InfoDialog.qml#L6-L10) | "Shared … popup for all plugins … Replaces the per-plugin `showMessage()`" | No shipping form uses it; only `harness/test_harness.qml` does (CLAUDE.md already says so) |

**Outcome:** All six rewritten (f alongside the P3 move).

---

## P3 — `InfoDialog.qml` and `musescore.d.ts` ship to end users -- DONE

**Where:** `JazzKit/lib/InfoDialog.qml` (now [harness/InfoDialog.qml](../../harness/InfoDialog.qml)),
[JazzKit/lib/musescore.d.ts](../../JazzKit/lib/musescore.d.ts),
[scripts/sync.sh:30](../../scripts/sync.sh#L30) (`cp -r "$SRC/" "$DEST"`).

**Problem:** `sync.sh` copies `JazzKit/` wholesale into the user's `extensions/JazzKit/`,
so a dev-only QML component and a TypeScript declaration file land in every install.
`InfoDialog.qml` is a *harness* dependency living in the *shipping* bundle.

**Do (pick one):**
- Move `InfoDialog.qml` to `harness/` (`sync-harness.sh` already copies `harness/*.qml`;
  change the harness's `import "lib"` to `import "."`), and leave `musescore.d.ts` where
  it is but exclude it in `sync.sh` (`rsync --exclude '*.d.ts'`, or a `cp` + `rm`); **or**
- accept both and say so explicitly in CLAUDE.md.

Recommended: the move. It removes the only cross-dependency from the shipping bundle to
dev tooling.

**Outcome:** Moved to `harness/InfoDialog.qml` (`git mv`); the harness now does
`import "."`. `sync.sh` strips `lib/*.d.ts` from the deployed bundle. `check-qml.mjs`
gained a PascalCase-filename rule so a component outside `lib/` is still exempt from the
`MuseScore{}`-root check, and `npm run check`'s file list was updated. CLAUDE.md's layout
section now describes both.

---

## P4 — `comp_cues.qml` and `comp_slashes.qml` are ~95% the same file -- PARTLY DONE

**Where:** [comp_cues.qml](../../JazzKit/comp_cues.qml) vs
[comp_slashes.qml](../../JazzKit/comp_slashes.qml).

**Problem:** The two files were near-identical: same properties, same `loadEnabledIds()`,
byte-identical `capture()`, same `apply()` shape, same ColumnLayout/Repeater/button row.
They differed in four things only: `settingsTag`, the effect called, the `targets` element
shape (**objects** vs **bare ints**), and two strings.

**Outcome:** Step 1 done — `compSlashesNotes` now accepts either a bare staff index or
`{staffIdx, isDrum}` (unit-tested for both), so both forms pass the same rows. The shared
logic is gone from the forms: `JazzKit.guardScore` / `captureSingleStaffRange` (P5) plus a
new `JazzKit.selectedTargets(rows)`, the inverse of `computeTargets`. What remains is the
duplicated **UI block** — moved to [03-remaining.md](03-remaining.md#p4-step-2--the-shared-comp-form-component)
(needs a GUI run to verify).

---

## P5 — Selection capture + version guard duplicated in five entry points -- DONE

**Where:**
[comp_cues.qml:54-74](../../JazzKit/comp_cues.qml#L54-L74),
[comp_slashes.qml:54-74](../../JazzKit/comp_slashes.qml#L54-L74),
[fill_empty_slashes.qml:36-55](../../JazzKit/fill_empty_slashes.qml#L36-L55),
[line_breaks.qml:65-82,131-134](../../JazzKit/line_breaks.qml#L65-L82),
[autofix.js:35-40](../../JazzKit/autofix.js#L35-L40),
[test_harness.qml:onRun](../../harness/test_harness.qml).

**Problem:** The same three blocks are copy-pasted with the same literal strings:
- `if (!curScore) … "Open a score first."`
- `if (!JazzKit.isSupportedVersion(…)) … "This plugin is for MuseScore 4.4 or later"`
  (the string is duplicated **six** times, and `autofix.js` uses a *seventh*, different
  wording — "needs MuseScore 4.4 or later")
- rewind `SELECTION_START` / `SELECTION_END`, `if (selEnd === 0) selEnd = curScore.lastSegment.tick + 1`,
  single-staff check.

**Do:** Add to `jazzkit.js` (pure, injectable, unit-testable with a fake score):

```js
// returns { ok:true, selStart, selEnd, measureTick, staffIdx } | { ok:false, error }
function captureSingleStaffRange(curScore, Cursor) { … }
// returns "" when fine, else the user-facing message
function guardScore(curScore, major, minor) { … }
```

Each form then calls two functions instead of ~20 lines. Add tests to
`test/jazzkit.test.mjs` covering: no score, wrong version, no range selection,
multi-staff selection, `selEnd === 0` fallback.

---

## P6 — Six near-identical `effectCtx()` builders, drifting -- WON'T DO

Declined after analysis; the reasoning is recorded in
[03-remaining.md](03-remaining.md#considered-and-declined).

---

## P7 — Duplicated write-and-decorate machinery in `effects.js` -- DONE

`effects.js` is 903 lines and three pairs of functions are structurally the same code.

**a. `_writeCueInto` vs `_writeSlashRhythmInto`**
([effects.js:213-260](../../JazzKit/lib/effects.js#L213-L260) vs
[:355-383](../../JazzKit/lib/effects.js#L355-L383)) — identical pass-1 positioning
(new cursor → `staffIdx`/`voice 0` → `rewindToTick(measureTick)` → fill leading rest →
loop `setDuration`+`addNote`/`addRest`) and identical pass-2 walk
(`_markingsByTick` → second cursor → `while (c2.segment && c2.tick < selEnd)` →
per-chord decoration + `_addMarkings`). Only the per-CR write and the per-chord
decoration differ.

**Do:** Extract two helpers and express both writers (and the drum writer's pass 2) in
terms of them:

```js
function _cursorAt(ctx, staffIdx, voice, tick)          // the 4-line rewind dance, ×9 in this file
function _writeSource(ctx, cur, measureTick, selStart, src, writeCR)
function _decorateWritten(ctx, staffIdx, selStart, selEnd, markAt, onChord)
```

`_cursorAt` alone removes nine copies of the same four lines
(:223-226, :249-252, :357-360, :372-375, :458-462, :478-482, :558-561, :570-573, :754-756).

**b. `_slashPitch` / `_drumCuePitch` / `_isDrumStaff`**
([:312-324](../../JazzKit/lib/effects.js#L312-L324),
[:411-418](../../JazzKit/lib/effects.js#L411-L418),
[:725-729](../../JazzKit/lib/effects.js#L725-L729)) — all three open with the same
`_partForStaff → instrumentAtTick(0) → .drumset` chain.

**Do:** `function _drumsetFor(ctx, staffIdx)` returning the drumset or null; the three
callers become 2-4 lines each and `_isDrumStaff` becomes `!!_drumsetFor(...)`.

**c. Per-property `try {} catch {}` noise**
([:332-347](../../JazzKit/lib/effects.js#L332-L347),
[:422-433](../../JazzKit/lib/effects.js#L422-L433),
[:618-643](../../JazzKit/lib/effects.js#L618-L643),
[:652-673](../../JazzKit/lib/effects.js#L652-L673),
[:783-812](../../JazzKit/lib/effects.js#L783-L812)) — ~25 single-statement `try` blocks
with empty catches and gratuitously numbered catch variables (`e2`…`e8`; the numbering
is unnecessary, catch params don't collide).

**Do:** One helper — `function _trySet(obj, key, value)` (or `_setProps(obj, {…})`) —
and call it. `_applySlashChord` drops from 16 lines to 8, `_applyDrumCueChord` from 12
to 6. Keep the try/catch semantics (property support varies by build); just stop
writing them out longhand.

---

## P8 — Repeated `visible:` flags and triplicated radio buttons in the forms -- PARTLY DONE

**Problem:** Every option control in the four forms carried its own
`visible: root.message === ""` (20+ copies of one condition); `autofix_settings.qml` had
three `RoundedRadioButton` blocks differing only in label and value; and the comp forms
sized themselves with hand-computed pixel arithmetic while the other three forms used an
implicit-height binding.

**Outcome:** (a) and (b) done — the option controls now sit in a single
`ColumnLayout { visible: root.message === "" }` per form (20+ bindings → 4), and the radio
buttons are a `Repeater` over a `[{label, value}]` model. (c) — the comp forms' `updateSize()`
and its `chromeHeight`/`rowHeight` constants — moved to
[03-remaining.md](03-remaining.md#p8c--replace-the-comp-forms-hand-computed-height): a
wrongly-sized dialog is exactly the failure that needs a visual check.

---

## P9 — `countStaves`'s four-name fallback -- DONE

**Where:** [jazzkit.js:37-51](../../JazzKit/lib/jazzkit.js#L37-L51).

**Problem:** Four spellings tried in order, then a hard-coded `16`. The comment justifies
16 as "degrade to processing the first 16" — but `fixMarcatoStaccatos` and
`fixCourtesyAccidentals` use it as a loop bound over `staffIdx`, so on a 3-staff score
the fallback would read 13 non-existent staves (harmless today only because `nstaves`
always exists on 4.4+). The plugin already refuses to run below 4.4, where `nstaves` is
the documented name.

**Do:** Reduce to `score.nstaves` with a `|| 0` guard; keep at most one alias if there is
evidence a supported build needs it. Update the tests
([test/jazzkit.test.mjs:16-27](../../test/jazzkit.test.mjs#L16-L27)) accordingly.

---

## P10 — `classifyChord` returns fields nobody reads -- DONE

**Where:** [articulations.js:104-126](../../JazzKit/lib/articulations.js#L104-L126).

**Problem:** `effects.js` uses only `hasMarcato`, `staccatoIndices` and `addAbove`
([:657-671](../../JazzKit/lib/effects.js#L657-L671)); the harness uses only
`staccatoIndices`. `needsStaccato`, `marcatoAbove` and `marcatoBelow` are unused, and
`addAbove` is literally `marcatoAbove` — the same value under two names.

**Do:** Trim the return shape to `{hasMarcato, staccatoIndices, addAbove}` and update
`test/articulations.test.mjs`. (If `needsStaccato` reads better at the call site, use it
*instead of* the `staccatoIndices.length` check in `_processMarcatoStaccato` rather than
keeping both.)

---

## P11 — `_tryAddHiddenStaccato` re-scans to hide what it just hid -- MOVED

Still open — it is a "verify, then simplify" item and the verification is a GUI harness run.
Full write-up in [03-remaining.md](03-remaining.md#p11--_tryaddhiddenstaccato-re-scans-to-hide-what-it-just-hid).

---

## P12 — `line_breaks.qml` settings use cryptic keys and string-encoded numbers -- DONE

**Where:** [line_breaks.qml:32-46](../../JazzKit/line_breaks.qml#L32-L46).

**Problem:** Persists `{d, r, e, mn, mx}` with the three numbers written as `String(...)`
and read back with `parseInt(...) || fallback`. The metatag is JSON — it holds numbers
and booleans natively. The abbreviations save nothing and the round-trip adds two
conversion bugs' worth of surface (`parseInt("") || 0`).

**Do:** Store `{atDouble, atRepeats, everyN, minBars, maxBars}` with real types, and
reuse the normalise-on-load pattern already written for Autofix
([jazzkit.js:176-207](../../JazzKit/lib/jazzkit.js#L176-L207)) — ideally by generalising
`loadAutofixSettings`/`saveAutofixSettings` into one `loadSettings(curScore, tag, defaults)`
pair used by both, which is itself a small duplication removal. Old tags simply fall back
to defaults (per-score cosmetic setting, low stakes) — say so in a comment.

---

## P13 — Optional: split `effects.js` -- WON'T DO (for now)

Declined; P7 removed the duplication that motivated it. Reasoning in
[03-remaining.md](03-remaining.md#considered-and-declined).

---

## P14 — Boilerplate comment blocks repeated verbatim across libs -- DONE

**Where:** The `// Exposed for the Node test loader; QML reaches the functions by name
directly.` line appears in all six libs, and `// require()-able from an extension macro;
no-op under QML import / Node loader.` in five — with a *longer* variant in
`articulations.js` ([:140-143](../../JazzKit/lib/articulations.js#L140-L143)) and
`effects.js` ([:889-891](../../JazzKit/lib/effects.js#L889-L891)).

**Problem:** The "why" (a missing trailer silently returns the previous require's object)
is worth stating **once**; six copies of the "what" is noise.

**Do:** Keep the full explanation in exactly one place — it already exists in
`.claude/skills/musescore-plugin-dev/reference/api-gotchas.md` and
`test/require-exports.test.mjs:1-14`. In the libs, reduce each trailer to a single line:
`// Export trailer — MANDATORY, see api-gotchas "macros actions".`

Same treatment for the four-to-thirteen-line "No MuseScore API here / QML: import …"
headers on `slashes.js`, `linebreaks.js`, `articulations.js`, `accidentals.js` — they say
the same thing four times. Two lines each is enough once P2's inaccuracies are fixed.

**Do not** touch the trap-documenting comments in `effects.js` (the `rewindToTick` /
`changeCRlen` / `NoteInput::addPitch` / ledger-line blocks) — those cite MuseScore source
and are the reason the code looks the way it does.

---

## P15 — Efficiency note (low priority) -- DONE

`_measureAt` ([effects.js:539-548](../../JazzKit/lib/effects.js#L539-L548)) walks from
`firstMeasure` every call, and is called per region from `fillEmptyBeatsNotes`
(:594) and via `_measureEndTick` (:504). On a long score with many empty regions this is
O(measures × regions). Not a problem at realistic sizes; worth a `// O(n·m), fine at
score scale` note or a cached measure list if a big-score slowdown is ever reported.
