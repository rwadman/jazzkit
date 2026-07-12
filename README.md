# JazzKit

A set of [MuseScore 4](https://musescore.org/) plugins that help me when arranging for jazz ensembles — comping slashes, cue copies, line-break formatting, and articulation cleanup.

Developed on MuseScore 4.7.3 (requires 4.1+), macOS / Apple Silicon.

> ⚠️ **These plugins are entirely vibe-coded.** Every line was written by an LLM
> agent against the MuseScore plugin API, with light human steering. It works
> on the scores I've thrown at it, but it has not been carefully audited. Treat
> it accordingly: **save your work before running any of these**, and expect
> rough edges. PRs and bug reports welcome, but no guarantees.

## Plugins

All entries appear under **Plugins** in the MuseScore menu (MuseScore 4 flattens
submenus, so they sort alphabetically by title):

| Menu entry | What it does |
| --- | --- |
| **To Comp Cues** | Copy the selected passage into chosen instruments. Pitched instruments get a cue-size copy; drum/percussion parts get a rhythmic comping cue. Choices remembered per instrument. |
| **To Comp Slashes** | Copy the selected rhythm into voice 1 of chosen comping instruments as slash notation. Empty beats become rests. |
| **Fill Empty Beats with Slashes** | Fill only the empty beats of voice 1 with slashes, leaving existing notes untouched. |
| **Format Line Breaks** | Clear existing breaks and re-apply line breaks at double barlines, repeats, and every N bars. |
| **Fix Marcato Staccatos** | Clean up marcato/staccato articulations toward jazz convention. |

## Install

1. Copy the contents of [`plugins/`](plugins/) into your MuseScore 4 plugins
   folder (typically `~/Documents/MuseScore4/Plugins/`), keeping the `JazzKit`
   package name.
2. Restart MuseScore.
3. Enable the plugins in **Home → Plugins** (one-time).

## Development

MuseScore 4 has no CLI plugin runner — plugins run only in the GUI, and
debugging is log + crash-dump analysis. Dev tooling lives in
[`scripts/`](scripts/); API notes live under
[`.claude/skills/musescore-plugin-dev/`](.claude/skills/musescore-plugin-dev/),
and [`CLAUDE.md`](CLAUDE.md) documents the dev loop.

```bash
# lint QML (catches silent-no-op syntax slips)
node scripts/check-qml.mjs plugins/*.qml

# deploy plugins/ → MuseScore's plugin folder (PLUGINS_FOLDER, or the default)
scripts/sync.sh

# launch MuseScore with logging → logs/musescore-run.log
scripts/start_ms.sh

# newest MuseScore log, plugin-relevant lines (-f follow, -a all)
scripts/mslog.sh
```

Copy `.env.example` to `.env` and set the paths for your machine — `sync.sh`
(via `PLUGINS_FOLDER`) and `start_ms.sh` (via `MUSE_SCORE_FOLDER`) read it.

## License

[MIT](LICENSE).
