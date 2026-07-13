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

- `JazzKit/` — the plugin source (deployed to MuseScore under the `JazzKit`
  package name). One `.qml` per menu action, each `menuPath: "Plugins.<title>"`
  (MuseScore 4 flattens submenus, so entries sort alphabetically by `title`
  under Plugins — no submenu): `fix_marcato_staccatos.qml` (Fix Marcato
  Staccatos), `comp_cues.qml` (To Comp Cues), `comp_slashes.qml` (To Comp Slashes),
  `fill_empty_slashes.qml` (Fill Empty Beats with Slashes), `line_breaks.qml`
  (Format Line Breaks), `manifest.json`.
- `JazzKit/lib/*.js` — shared **pure** JS libraries (`jazzkit.js`,
  `articulations.js`, `linebreaks.js`, `slashes.js`) plus `commands.js` (named
  constants for the MuseScore `cmd()` action codes), imported into a `.qml` via
  `import "lib/x.js" as X`. Typed with JSDoc + `// @ts-check` (no build — QML
  loads these files as-is; `npm run typecheck` runs `tsc --checkJs`). Each ends
  with a per-file `var <name>Lib = {…}` the Node loader reads (QML calls the
  functions by name). The external MuseScore API shapes the libs consume are
  modelled once in `JazzKit/lib/musescore.d.ts` (`declare namespace MS` — our
  verified model, *not* authoritative; grep the source before trusting a shape).
  tsconfig drops the DOM lib (else `MS`-less names like `Selection` collide).
  Note: this types the **libs only** — `tsc` cannot read `.qml`, so JS embedded
  in QML bindings/handlers stays unchecked.
- `JazzKit/lib/*.qml` — shared **QML components** (widget trees):
  `CompTargetsDialog.qml` (the checkbox-list dialog for the comp plugins) and
  `InfoDialog.qml` (the "JazzKit says…" popup with a `show(msg)` method, used by
  every plugin). Used via a directory import (`import "lib"`); not unit-testable
  (GUI-only). A
  QML-imported JS library is stateless and can't see MuseScore globals
  (`curScore`, `cmd`, `SymId`), so lib functions take those as arguments — which
  is also what makes them unit-testable. `sync.sh` deploys `lib/` automatically.
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
scripts/sync.sh   # → run from Plugins menu (GUI)
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
