# JazzKit

MuseScore 4 plugin(s) that nudge notation toward jazz conventions. QML, plugin
API, MuseScore 4.4+ (developed on 4.7.3, macOS/Apple Silicon).

## Language style

Be brief and concise. State what's needed, not more.

## Before any plugin work

Use the **`musescore-plugin-dev`** skill and read its
[api-gotchas.md](.claude/skills/musescore-plugin-dev/reference/api-gotchas.md)
first — the plugin API has many non-obvious traps, documented there with source
citations. Note: **MuseScore 4 has no CLI plugin runner** — plugins run only in
the GUI; debugging is log + crash-dump analysis (scripts in the skill).

## Layout

- `JazzKit/` — the plugin source, a **single MU4.4+ extension bundle** (NOT loose
  legacy plugins): `manifest.json` declares the menu actions and `sync.sh` deploys
  the folder to MuseScore's user **`extensions/JazzKit/`** (not `Plugins/`). One
  multi-action manifest → the actions nest under a **"JazzKit" submenu** (grouping
  is by manifest, not `menuPath`/`categoryCode` — see api-gotchas "Menus"). Pinned
  `"apiversion": 1` for the bare `curScore`/`Cursor`/`SymId`/enum globals. Every
  action is a `type: "form"` `.qml` (a `MuseScore {}` component shown as a view):
  `autofix_settings.qml` (the option panel for the `autofix.js` macro),
  `comp_cues.qml`, `comp_slashes.qml`,
  `fill_empty_slashes.qml`, `line_breaks.qml`. The two comp actions are thin roots
  around the shared `CompTargetsForm.qml` (a PascalCase **component**, not an
  action — no `MuseScore{}` root, resolved implicitly from the bundle dir, handed
  the plugin globals as its `ctx`). **A form gets no `onRun`** — work
  runs from `Component.onCompleted` / button handlers — and **cannot dispatch
  notation `cmd()`s** (focus trap), so every effect is **direct-API only** (cursor
  note input + element properties; slash notation replicates `Chord::setSlash`).
  The exception is `autofix.js`, a `type: "macros"` action: a form is a *view*, so
  it ALWAYS opens a window — an action that takes no input and should run silently
  must be a macro (`main()`, no UI, `require("lib/x.js")` instead of `import`,
  `console.log` instead of a dialog). `test/require-exports.test.mjs` emulates the
  extension script engine so the macro's module wiring is unit-tested; the effects
  it calls are the same ones the GUI harness drives.
- `JazzKit/lib/*.js` — shared **pure** JS libraries (`jazzkit.js`,
  `accidentals.js`, `articulations.js`, `linebreaks.js`, `slashes.js`) plus `effects.js` (the
  API-touching effect layer — cursor/direct-API mutations, `// @ts-check`ed but
  exercised by the GUI harness + a fake cursor in `test/effects.test.mjs`).
  Imported into a form via `import "lib/x.js" as X`. Each ends with a per-file
  `var <name>Lib = {…}` (the Node loader reads it; QML calls by name) plus a
  guarded `exports =` trailer so an extension macro could `require()` it. The
  external MuseScore API shapes are modelled in `JazzKit/lib/musescore.d.ts`
  (`declare namespace MS` — verified, *not* authoritative; grep the source before
  trusting a shape). tsconfig drops the DOM lib (else `Selection` etc. collide).
  Types the **libs only** — `tsc` can't read `.qml`.
- `harness/InfoDialog.qml` — the "JazzKit says…" popup (`show(msg)`), **dev-only**:
  the harness shows its report with it, the shipping forms render their result
  inline. It lives in `harness/` so it never ships; `sync.sh` likewise strips
  `lib/*.d.ts` from the deployed bundle.
- `test/` — Node unit tests for `JazzKit/lib/`. `load-qml-lib.mjs` evals a lib
  the way QML does (top-level decls → the `JazzKitExports` namespace) and injects
  fakes; `harness.mjs` is a zero-dep runner (deliberate: no packages, no runner
  config — Node ≥18, see `engines`).
- `DrumsetPatterns-main/` — third-party reference plugin; working drum-staff
  cursor examples. `test-plugin/` — throwaway.

## Dev loop

```bash
npm run verify    # test + typecheck + check + e2e:check — what CI runs
npm test                              # unit-test JazzKit/lib (node test/run.mjs)
npm run typecheck                     # JSDoc types on JazzKit/lib/*.js (tsc --checkJs, no build)
npm run check                         # QML/manifest lint (JazzKit/ + harness/)
npm run e2e:check                     # a passing GUI harness run is recorded for this code
scripts/sync.sh   # deploy JazzKit → run from Plugins menu (GUI)
scripts/e2e.sh [--autoclick]   # deploy both pkgs, open a blank fixture, launch MuseScore, (auto-)run the harness, print+accept its report
scripts/mslog.sh          # what it did
python3 scripts/analyze-crash.py  # if it crashed
```

Only pure logic is unit-testable — anything hitting the API (`cursor.add`,
`cmd()`, layout) is still GUI-only. Push decisions into `JazzKit/lib/` and keep
the `.qml` to effects. MuseScore re-reads an existing `.qml` each run; a new
`.qml` (or new `lib/*.js`) needs a restart + one-time enable in Home > Plugins.

## Conventions

- One `.qml` = one `MuseScore { onRun }` = one menu entry. New action → new
  `.qml` with the shared `menuPath` prefix.
- Keep actions scoped — never touch anything outside the target staff/region;
  verify the selection before a destructive `cmd()`.
- **Always add a regression test for any bug you fix.** Pure-logic bugs → a case
  in `test/`; API/layout/rendering bugs → an assertion in the GUI harness
  (`harness/test_harness.qml`) that would have caught it (assert the specific
  invariant, e.g. `fixedLine >= -1` for the no-ledger-line rule, not just that the
  effect ran). A found-and-fixed issue without a guarding assertion is unfinished.
