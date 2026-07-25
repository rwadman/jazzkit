# Cleanup: what's left

Everything from [01-plugin-code.md](01-plugin-code.md) and
[02-harness-and-tooling.md](02-harness-and-tooling.md) that was **not** implemented in the
2026-07-25 cleanup pass. Those two documents now record only completed work; this one is
the open list. IDs are kept so the earlier docs' cross-references still resolve.

**Status (2026-07-25, second pass): CLOSED — every item is resolved and GUI-verified.**
R0, P11, P4 step 2 and T5 are done; P8c is **declined** — twice attempted, twice broken
in the GUI, reverted to the shipping arithmetic (read that section before touching
dialog sizing again). Nothing here is open; the sections below are the record.

---

## R0 — Re-stamp the e2e acceptance — **DONE**

Re-stamped; `npm run e2e:check` passed against the recorded run (75 ok, recorded
2026-07-25). It fails again now, by design: P11 below changed `effects.js`.

The suggested hardening was also implemented: `scripts/e2e-accept.mjs` now refuses a
report whose mtime predates any file in the fingerprinted set, so a stale
`jazzkit-harness-report.txt` can no longer be stamped against today's code. (It still
can't detect a report that was *copied* to a fresh timestamp — `e2e.sh` deleting stale
reports before launching remains the primary defence.)

⚠️ Still true: **run `scripts/e2e.sh`, never `node scripts/e2e-accept.mjs` by hand.**

---

## P4 step 2 — the shared comp-form component — **DONE, GUI-verified**

**Implemented as** [JazzKit/CompTargetsForm.qml](../../JazzKit/CompTargetsForm.qml):
the result label, the picker `ColumnLayout` + `Repeater` + `CheckBox` delegate, the
button row, and the capture/apply logic, all in one `Item`. Each action file
([comp_cues.qml](../../JazzKit/comp_cues.qml),
[comp_slashes.qml](../../JazzKit/comp_slashes.qml)) is now ~45 lines: the `MuseScore{}`
root the manifest needs, four properties (`settingsTag`, `prompt`, `resultTemplate`,
`effect`), the `ctx`, and `onCloseRequested: root.quit()`.

**Two decisions that differ from the sketch above:**

- **It lives next to the action files, not in `lib/`.** Same directory ⇒ QML resolves
  the type implicitly, with **no import statement at all** — one less thing that can
  fail in the GUI, where each attempt costs a full run. It is still deployed by
  `sync.sh`, still exempt from `check-qml.mjs`'s root-element rule (PascalCase), and —
  unlike `lib/*.qml` — it is *covered* by `npm run check`'s `JazzKit/*.qml` glob.
- **The globals are passed in, not inherited.** The open question (does a nested
  component see `curScore`/`Element`/`Cursor`?) was not gambled on: the action file
  builds the `ctx` object and the component reads `ctx.curScore` etc. That object is
  also the effect layer's `EffectCtx` — the single `effectCtx()` P6 wanted, now owned
  by one place per action instead of two.

- **The component's root is the `ColumnLayout` itself**, anchored to the action's
  `MuseScore{}` root, rather than an `Item` wrapping it. That keeps the instantiated
  tree identical to the shipping forms' (`MuseScore` → `ColumnLayout` → controls) —
  worth it because dialog sizing in this host is fragile and unverifiable outside the
  GUI (see P8c).

**Verified (GUI):** both **To Comp Cues** and **To Comp Slashes** open, list the
instruments, apply to the score, and remember the picks across a reopen. So the
passed-in `ctx` carries the plugin globals correctly — a nested component does **not**
need to inherit them.

---

## P8c — replace the comp forms' hand-computed height — **DECLINED (tried twice, reverted)**

Do not attempt this a third time without new information. Both replacements broke the
dialog in the GUI:

1. `contentColumn.forceLayout()` then `contentHeight = implicitHeight + 32` → dialog
   opened too short, **buttons just below the bottom edge**;
2. the same measurement kept as `Math.max(measured, explicit)`, with the root's
   `implicitHeight` **bound** to it → **worse: the buttons did not show at all**.

The original arithmetic (`180` for the message state, `chromeHeight + rows * rowHeight`
for the picker) is restored, now in **one** place — `CompTargetsForm.updateSize()` —
which is all P8c was really worth: the duplication across two files and four call sites
is gone, the magic numbers stay.

**Why this is fragile, from the MuseScore source** (now written up in api-gotchas,
"Extension `form` actions"): the window is sized exactly once, at show —
`WindowView::showView()` ends in
`updateSize(rootObject->implicitWidth(), rootObject->implicitHeight())` (`windowview.cpp`)
and nothing resizes it afterwards. `DialogView` adds the title bar separately via
`frameMargins`, so the shortfall is *not* window chrome being subtracted — a
`Repeater`-filled `ColumnLayout` genuinely measures smaller than it renders at that
moment, even after `forceLayout()`. Two corollaries worth keeping:

- **assign `implicitHeight`, don't bind it.** The version that shipped always assigned
  (`root.implicitHeight = …` from `Component.onCompleted`); the binding attempt is the
  one that lost the buttons entirely. The action files now assign via `setSize()`, called
  from `Component.onCompleted` and from `onContentHeightChanged`.
- the `updateSize()` after Apply cannot resize the window either — it only matters that
  the picker height (the taller of the two states) is right at open.

---

## P11 — `_tryAddHiddenStaccato` re-scans to hide what it just hid — **DONE**

The rescan loop is deleted (and the `el` parameter with it): the function sets
`hidden`/`visible = false` on the new articulation, `cursor.add`s it, and returns.

**Verified in the GUI**: `scripts/e2e.sh` re-stamped `harness/acceptance.json` against
the rescan-free `effects.js` and passed 75/75 — including
`marcato: marcato-only chord gained a hidden staccato` and
`marcato: pre-existing staccato is now hidden`. So the **pre-add flags survive
`cursor.add`** and the rescan was dead code; the finding is recorded in the comment at
the site.

Note when touching this: any byte of `effects.js` (a comment included) changes the e2e
fingerprint and invalidates the acceptance record — so a comment-only edit costs a GUI
re-run. Say it once, in the same commit as the code.

---

## T5 (residual) — confirm the menu layout — **DONE, GUI-verified**

The actions really do nest under a **JazzKit** submenu of **Plugins**, exactly as
`appmenumodel.cpp` `makePluginsItems()` predicted for a multi-action manifest. README,
CLAUDE.md and the api-gotchas "Menus" note were already right; no document needed a
correction. Observed on MuseScore 4.7.3, macOS.

---

## Considered and declined

Recorded here so they aren't re-opened without new information.

- **P6 — one shared `effectCtx()` builder.** A helper in `jazzkit.js` can see neither the
  MuseScore globals nor the sibling libs, so the only possible shape is
  `merge(globals, libs)`: every caller still enumerates both by hand and nothing shrinks.
  The `tsc` argument doesn't hold either — `tsc` reads `lib/*.js` only, never the `.qml`
  callers, so tightening the `EffectCtx` typedef catches nothing at a call site.
  **Partly resolved by P4 step 2**: the two comp actions now each build one `ctx` object
  that serves as both the component's globals and the effect's `EffectCtx`. The remaining
  forms keep their own `effectCtx()`, and that is fine.
- **P13 — split `effects.js` into per-effect files.** P7 removed the duplicated machinery,
  so the file's size is now shared helpers and MuseScore-trap commentary rather than
  repeated code. The cost is unchanged (every form's imports, the fingerprint list, a GUI
  re-run). Revisit only if it keeps growing.
