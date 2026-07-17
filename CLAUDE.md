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
  `fix_marcato_staccatos.qml`, `comp_cues.qml`, `comp_slashes.qml`,
  `fill_empty_slashes.qml`, `line_breaks.qml`. **A form gets no `onRun`** — work
  runs from `Component.onCompleted` / button handlers — and **cannot dispatch
  notation `cmd()`s** (focus trap), so every effect is **direct-API only** (cursor
  note input + element properties; slash notation replicates `Chord::setSlash`).
- `JazzKit/lib/*.js` — shared **pure** JS libraries (`jazzkit.js`,
  `articulations.js`, `linebreaks.js`, `slashes.js`) plus `effects.js` (the
  API-touching effect layer — cursor/direct-API mutations, `// @ts-check`ed but
  exercised by the GUI harness + a fake cursor in `test/effects.test.mjs`).
  Imported into a form via `import "lib/x.js" as X`. Each ends with a per-file
  `var <name>Lib = {…}` (the Node loader reads it; QML calls by name) plus a
  guarded `exports =` trailer so an extension macro could `require()` it. The
  external MuseScore API shapes are modelled in `JazzKit/lib/musescore.d.ts`
  (`declare namespace MS` — verified, *not* authoritative; grep the source before
  trusting a shape). tsconfig drops the DOM lib (else `Selection` etc. collide).
  Types the **libs only** — `tsc` can't read `.qml`.
- `JazzKit/lib/InfoDialog.qml` — the shared "JazzKit says…" popup (`show(msg)`),
  used by the dev harness (the shipping forms render their own result inline).
  `sync.sh` deploys `lib/` automatically.
- `test/` — Node unit tests for `JazzKit/lib/`. `load-qml-lib.mjs` evals a lib
  the way QML does (top-level decls → the `JazzKitExports` namespace) and injects
  fakes; `harness.mjs` is a zero-dep runner (Node 16 has no `node --test`).
- `DrumsetPatterns-main/` — third-party reference plugin; working drum-staff
  cursor examples. `test-plugin/` — throwaway.

## Dev loop

```bash
npm test                              # unit-test JazzKit/lib (node test/run.mjs)
npm run typecheck                     # JSDoc types on JazzKit/lib/*.js (tsc --checkJs, no build)
node scripts/check-qml.mjs JazzKit/*.qml JazzKit/lib/*.qml
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
