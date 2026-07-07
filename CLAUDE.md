# Jazzify

MuseScore 4 plugin(s) that nudge notation toward jazz conventions. Written in
QML against the MuseScore plugin API. Targets MuseScore 4.4+ (developed on 4.7.3,
macOS / Apple Silicon).

## Language style

Be brief and concise. State what's needed, not more.

## Before doing any plugin work

**Use the `musescore-plugin-dev` skill** (`.claude/skills/musescore-plugin-dev/`).
Read its [reference/api-gotchas.md](.claude/skills/musescore-plugin-dev/reference/api-gotchas.md)
before writing or changing plugin code — the MuseScore plugin API has many
non-obvious traps (drum-staff voice forcing, selection locking during `startCmd`,
cursor `rewindToTick` skipping empty voices, crashes from nested commands, action
codes that differ from menu labels) and that file documents them with source
citations. Skipping it means rediscovering them the hard way.

Key fact up front: **MuseScore 4 has no CLI plugin runner.** Plugins only execute
inside the GUI. The feedback loop is log-reading + crash-dump analysis, not a
headless test harness. The skill provides scripts for all of it.

## Layout

- `jazzify/` — the plugin. One `.qml` per menu action, all sharing the
  `menuPath: "Plugins.Jazzify.*"` prefix so they group under a **Jazzify**
  submenu:
  - `jazzify.qml` — "Fix Marcato Staccatos" (adds hidden staccatos under marcatos)
  - `drum_slashes.qml` — "Drumify Selection to Slashes" (copies a selection into
    the drum staff as a voice-3 rhythmic-slash cue + voice-1 beat slashes)
  - `manifest.json` — plugin metadata
- `DrumsetPatterns-main/` — a third-party reference plugin (Phil Kan). Good,
  working examples of cursor-based note entry on drum staves. Reference only.
- `test-plugin/` — throwaway experiments.
- `load_plugin.sh` / `start_ms.sh` — original helper scripts (see below).

## Dev loop

```bash
node .claude/skills/musescore-plugin-dev/scripts/check-qml.mjs jazzify/*.qml  # sanity-check QML
.claude/skills/musescore-plugin-dev/scripts/sync.sh                          # copy into MuseScore
# → run the plugin from MuseScore's Plugins menu (GUI), then:
.claude/skills/musescore-plugin-dev/scripts/mslog.sh                         # see what it did
python3 .claude/skills/musescore-plugin-dev/scripts/analyze-crash.py         # if it crashed
```

`sync.sh` supersedes `load_plugin.sh` (same idea: copy the plugin to
`~/Documents/MuseScore4/Plugins/jazzify/`). `start_ms.sh` launches MuseScore with
debug logging to `~/musescore-run.log`. MuseScore re-reads an existing plugin's
`.qml` each run; a **new** `.qml` file needs a restart + a one-time enable in
Home > Plugins.

## Conventions

- One `.qml` file = one `MuseScore { onRun: … }` = one menu entry. Add a new
  action as a new `.qml` with the shared `menuPath` prefix, not as extra logic in
  an existing file.
- Keep plugin actions **scoped** — don't touch anything outside the staff/region
  the action is about. Verify the selection landed where intended before running
  a destructive built-in `cmd()`.
- Verify plugin API assumptions against MuseScore source, not the online docs:
  `.claude/skills/musescore-plugin-dev/scripts/fetch-mscore-src.sh`.
