# Cleanup: what's left

Everything from [01-plugin-code.md](01-plugin-code.md) and
[02-harness-and-tooling.md](02-harness-and-tooling.md) that was **not** implemented in the
2026-07-25 cleanup pass. Those two documents now record only completed work; this one is
the open list. IDs are kept so the earlier docs' cross-references still resolve.

**All four actionable items need a running MuseScore.** That is the single reason they were
deferred: MuseScore 4 has no headless plugin runner, so a QML/UI change can only be
verified by clicking through it, and two of these touch user-facing dialogs where a silent
break is the failure mode.

---

## R0 — Re-stamp the e2e acceptance (do this first)

`npm run e2e:check` currently **fails**, by design: T1 added `JazzKit/lib/accidentals.js`
to the fingerprint and the effect layer was refactored, so the recorded run in
`harness/acceptance.json` no longer matches the code.

```bash
scripts/e2e.sh            # or --autoclick; needs the GUI
# then commit the refreshed harness/acceptance.json
```

The harness itself was refactored too (T2–T4, T14) — the run also validates that. Expect
the same 75 assertions to pass; the labels were kept byte-identical on purpose, so any
change in the report is a real regression, not churn.

Do this **before** the items below, and again after each of them, so a failure has one
possible cause.

⚠️ **Run `scripts/e2e.sh`, never `node scripts/e2e-accept.mjs` by hand.** A stale
`jazzkit-harness-report.txt` from an earlier session is still lying in
`~/Documents/MuseScore4/Scores/`, and `e2e-accept.mjs` will happily stamp *that* old report
against *today's* fingerprint — producing an acceptance record that claims a passing run
which never happened. (This was caught and reverted once during the cleanup pass.)
`e2e.sh` deletes stale reports before launching, which is the whole reason it exists.
Consider making `e2e-accept.mjs` refuse a report older than the source it fingerprints.

---

## P4 step 2 — the shared comp-form component

**Where:** [comp_cues.qml](../../JazzKit/comp_cues.qml) and
[comp_slashes.qml](../../JazzKit/comp_slashes.qml).

**State:** Step 1 (unified target shape) and step 3 (shared logic in `jazzkit.js`) are
done — see P4's Outcome note. What remains is ~45 lines of **identical UI** in both files:
the result label, the picker `ColumnLayout` + `Repeater` + `CheckBox` delegate, and the
Cancel/Apply button row. The two files now differ only in `settingsTag`, the effect they
call, and two strings.

**Do:** Extract the dialog body into `JazzKit/lib/CompTargetsForm.qml`, parameterised by
`settingsTag`, prompt text, result template and the effect function. Each action file
becomes `MuseScore { id: root; CompTargetsForm { anchors.fill: parent; … } }`.

**Watch out for:**
- The manifest maps each action to a file, so the `MuseScore{}` root must stay in the
  action file — the component is the *content*, not the root.
- A component in `lib/` is already deployed by `sync.sh` and exempt from `check-qml.mjs`'s
  root-element rule (both `lib/**` and PascalCase filenames are exempt since P3).
- **The open question:** whether the component can see the plugin globals (`curScore`,
  `Element`, `Cursor`, …). They are context properties of the plugin's QML context, which
  *should* propagate into a nested component instantiated in that context — but this is
  unverified, and it is the thing most likely to fail. If it does, pass them in as
  properties (`property var ctx: ({curScore: curScore, …})` in the action file), which also
  gives P6 the single `effectCtx()` it wanted.

**Verify:** open a score, select a range in one staff, run **To Comp Cues** and **To Comp
Slashes**; check the instrument list populates, checkboxes toggle, Apply writes and the
result message appears, and the remembered selection survives a reopen.

---

## P8c — replace the comp forms' hand-computed height

**Where:** [comp_cues.qml:32-38](../../JazzKit/comp_cues.qml#L32-L38) and the same block in
`comp_slashes.qml`: `updateSize()` plus the `chromeHeight: 130` / `rowHeight: 40` magic
numbers, called from four places.

**Do:** Use the binding the other three forms use —
`height: contentColumn.implicitHeight + 32` — and delete `updateSize()`, both constants and
its call sites. Best done **together with P4 step 2**, since the shared component can own
the sizing once.

**Verify:** the dialog must open tall enough for every checkbox with no scrollbar or
clipping, at 1 target and at 5+, and must resize sensibly when it switches to the result
message.

---

## P11 — `_tryAddHiddenStaccato` re-scans to hide what it just hid

**Where:** [effects.js](../../JazzKit/lib/effects.js) — `_tryAddHiddenStaccato`.

**State:** Untouched. Its four property writes now go through `_trySet`, but the code still
hedges both ways: it sets `hidden`/`visible = false` on the new articulation *before*
`cursor.add(s)`, then linearly re-scans `el.articulations` to find the element by symbol
and set the same two flags again. One of the two halves is dead code, and nothing records
which.

**Do:** Delete the rescan loop, run `scripts/e2e.sh`, and check the assertion
"marcato: marcato-only chord gained a hidden staccato" (and "…pre-existing staccato is now
hidden"). If they still pass, keep it deleted and add a one-line comment: *pre-add flags
survive `cursor.add`*. If they fail, restore the rescan and delete the **pre-set** instead,
with a comment saying the flags are dropped on add. Either way the hedge goes and the
finding is documented.

---

## T5 (residual) — confirm the menu layout

README and CLAUDE.md disagreed about where the actions appear; README now follows
CLAUDE.md — one multi-action manifest nests them under a **JazzKit** submenu of **Plugins**.
Nobody has looked at the actual menu.

**Do:** `scripts/sync.sh`, restart, open the Plugins menu, and correct whichever document is
wrong (README's "## Plugins" intro, CLAUDE.md's "Menus" note, or the api-gotchas
reference).

---

## Considered and declined

Recorded here so they aren't re-opened without new information.

- **P6 — one shared `effectCtx()` builder.** A helper in `jazzkit.js` can see neither the
  MuseScore globals nor the sibling libs, so the only possible shape is
  `merge(globals, libs)`: every caller still enumerates both by hand and nothing shrinks.
  The `tsc` argument doesn't hold either — `tsc` reads `lib/*.js` only, never the `.qml`
  callers, so tightening the `EffectCtx` typedef catches nothing at a call site. **Revisit
  only via P4 step 2**, where one component can legitimately own one `effectCtx()` for both
  comp forms.
- **P13 — split `effects.js` into per-effect files.** P7 removed the duplicated machinery,
  so the file's size is now shared helpers and MuseScore-trap commentary rather than
  repeated code. The cost is unchanged (every form's imports, the fingerprint list, a GUI
  re-run). Revisit only if it keeps growing.
