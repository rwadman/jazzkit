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

- `plugins/` — the plugin source (deployed to MuseScore under the `JazzKit`
  package name). One `.qml` per menu action, each `menuPath: "Plugins.<title>"`
  (MuseScore 4 flattens submenus, so entries sort alphabetically by `title`
  under Plugins — no submenu): `fix_marcato_staccatos.qml` (Fix Marcato
  Staccatos), `comp_cues.qml` (To Comp Cues), `comp_slashes.qml` (To Comp Slashes),
  `fill_empty_slashes.qml` (Fill Empty Beats with Slashes), `line_breaks.qml`
  (Format Line Breaks), `manifest.json`.
- `DrumsetPatterns-main/` — third-party reference plugin; working drum-staff
  cursor examples. `test-plugin/` — throwaway.

## Dev loop

```bash
node scripts/check-qml.mjs plugins/*.qml
scripts/sync.sh   # → run from Plugins menu (GUI)
scripts/mslog.sh          # what it did
python3 scripts/analyze-crash.py  # if it crashed
```

MuseScore re-reads an existing `.qml` each run; a new `.qml` needs a restart +
one-time enable in Home > Plugins.

## Conventions

- One `.qml` = one `MuseScore { onRun }` = one menu entry. New action → new
  `.qml` with the shared `menuPath` prefix.
- Keep actions scoped — never touch anything outside the target staff/region;
  verify the selection before a destructive `cmd()`.
