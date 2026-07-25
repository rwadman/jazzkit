# JazzKit

A set of [MuseScore 4](https://musescore.org/) plugins that help me when arranging for jazz ensembles.

Developed on MuseScore 4.7.3 (requires 4.4+), macOS / Apple Silicon.

> ⚠️ **These plugins are entirely vibe-coded.** Every line was written by an LLM
> agent against the MuseScore plugin API, with light human steering. It works
> on the scores I've thrown at it, but it has not been carefully audited. Treat
> it accordingly: **save your work before running any of these**, and expect
> rough edges. PRs and bug reports welcome, but no guarantees.

## Plugins

JazzKit ships as a single extension with one multi-action manifest, so its entries
nest under a **JazzKit** submenu in the MuseScore **Plugins** menu:

| Menu entry | What it does |
| --- | --- |
| **To Comp Cues** | Copy the selected passage into chosen instruments. Pitched instruments get a cue-size copy; drum/percussion parts get a rhythmic comping cue. Choices remembered per instrument. |
| **To Comp Slashes** | Copy the selected rhythm into voice 1 of chosen comping instruments as slash notation. Empty beats become rests. |
| **Fill Empty Beats with Slashes** | Fill only the empty beats of voice 1 with slashes, leaving existing notes untouched. |
| **Format Line Breaks** | Clear existing breaks and re-apply line breaks at double barlines, repeats, and every N bars. |
| **Autofix** | Runs silently — no dialog at all; the counts go to the MuseScore log. Every enabled fix, over the whole score: hidden staccatos on marcato (^) notes (so playback mimics the usual jazz articulation), and courtesy accidentals — added where a note altered in the previous bar reverts, removed where they have become superfluous. |
| **Autofix Settings** | Choose which fixes **Autofix** performs, and how added courtesy accidentals are drawn — (♮), [♮] or bare. Remembered per score. |

## Install

JazzKit is a MuseScore 4.4+ **extension**, so it goes in `extensions/`, not
`Plugins/`.

1. Copy the [`JazzKit/`](JazzKit/) folder into your MuseScore 4 user extensions
   folder, so it lands at
   `~/Library/Application Support/MuseScore/MuseScore4/extensions/JazzKit/`
   (macOS; [`scripts/sync.sh`](scripts/sync.sh) does this for you).
2. Restart MuseScore.
3. Enable JazzKit in **Home → Plugins** (one-time).

## Development

MuseScore 4 has no CLI plugin runner — plugins run only in the GUI, and
debugging is log + crash-dump analysis. Dev tooling lives in
[`scripts/`](scripts/); API notes live under
[`.claude/skills/musescore-plugin-dev/`](.claude/skills/musescore-plugin-dev/),
and [`CLAUDE.md`](CLAUDE.md) documents the dev loop.

```bash
# everything CI runs: unit tests, typecheck, QML lint, e2e acceptance freshness
npm run verify

# individually
npm test           # Node unit tests for JazzKit/lib
npm run typecheck  # JSDoc types (tsc --checkJs)
npm run check      # QML/manifest lint (catches silent-no-op syntax slips)
npm run e2e:check  # a passing GUI harness run is recorded for this exact code

# deploy JazzKit/ → MuseScore's extensions folder (EXTENSIONS_FOLDER, or the default)
scripts/sync.sh

# launch MuseScore with logging → logs/musescore-run-<timestamp>.log
scripts/start_ms.sh

# newest MuseScore log, plugin-relevant lines (-f follow, -a all)
scripts/mslog.sh
```

Copy `.env.example` to `.env` and set the paths for your machine — `sync.sh`
(via `EXTENSIONS_FOLDER`), `sync-harness.sh` (via `PLUGINS_FOLDER`) and
`start_ms.sh` (via `MUSE_SCORE_FOLDER`) read it.

## License

[MIT](LICENSE).
