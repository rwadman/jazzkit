---
name: musescore-plugin-dev
description: Develop, run, and debug the Jazzify MuseScore 4 plugin (QML). Use when writing or changing a MuseScore plugin, verifying the plugin API / action codes, running a plugin in MuseScore, reading MuseScore logs, or analyzing a MuseScore crash dump caused by a plugin.
---

# Developing the Jazzify MuseScore plugin

Jazzify is a **MuseScore 4 plugin** written in QML (`jazzify/*.qml`). A MuseScore
plugin is not a standalone app — it runs **inside the MuseScore GUI**, triggered
from the Plugins menu. There is **no CLI plugin runner** in MuseScore 4, so you
cannot execute a plugin headlessly. The dev loop is:

1. Edit `jazzify/<plugin>.qml`
2. Static-check it (`scripts/check-qml.mjs`)
3. Sync into MuseScore's plugin folder (`scripts/sync.sh`)
4. Run it from the GUI (human step — see below)
5. Read what happened (`scripts/mslog.sh`), and if MuseScore crashed,
   symbolicate the dump (`scripts/analyze-crash.py`)

Before writing plugin code, **read [reference/api-gotchas.md](reference/api-gotchas.md)** —
it captures the non-obvious API traps (drum-staff voice forcing, selection lock
during `startCmd`, cursor `rewindToTick` skipping empty voices, crash from nested
commands, real action codes). It will save you the multi-hour rediscovery this
skill came out of.

Paths below are relative to the repo root (`/Users/rikard/kod/jazzify`). Scripts
live in `.claude/skills/musescore-plugin-dev/scripts/`.

## Prerequisites

- MuseScore 4.4+ installed at `/Applications/MuseScore 4.app` (verified with
  4.7.3, Apple Silicon).
- `node` and `python3` for the helper scripts.
- For crash analysis only: `pip3 install minidump aenum`.

## Static check (before every sync)

```bash
node .claude/skills/musescore-plugin-dev/scripts/check-qml.mjs jazzify/*.qml
```

Catches unbalanced braces/parens (which show up at runtime only as a silent
no-op) and missing required `MuseScore{}` keys. There is no real qmllint for
MuseScore's QML dialect.

## Sync into MuseScore

```bash
.claude/skills/musescore-plugin-dev/scripts/sync.sh
```

Copies `jazzify/*.qml` + `manifest.json` to
`~/Documents/MuseScore4/Plugins/jazzify/`. MuseScore re-reads an existing
plugin's `.qml` on each run (no restart needed). A **new** `.qml` file needs a
MuseScore restart and must be enabled once in Home > Plugins (new plugins default
to disabled).

## Run (the only path: GUI)

MuseScore 4 has no way to run a plugin from the command line. To exercise the
plugin:

1. Open a score in MuseScore (Jazzify's drum-slash action needs a score with a
   pitched staff and a drum/percussion staff).
2. Make a selection if the plugin acts on one.
3. Plugins → Jazzify → *<action>*.

Then observe:

```bash
# What the last run dispatched + any Cursor/selection warnings:
.claude/skills/musescore-plugin-dev/scripts/mslog.sh
# Live-follow while you click:
.claude/skills/musescore-plugin-dev/scripts/mslog.sh -f
```

`mslog.sh` finds the newest log under
`~/Library/Application Support/MuseScore/MuseScore4/logs/` and filters to the
lines that matter (`doDispatch`, `Cursor::`, selection/PluginAPI/ASSERT/WARN/
ERROR), hiding audio-sampler spam. Each plugin step shows as
`try call action: <code>`, so you can see exactly which step it reached.

## When MuseScore crashes

A plugin bug can hard-crash MuseScore. The log won't have a stack trace, but
Crashpad writes a minidump. Symbolicate the newest one:

```bash
python3 .claude/skills/musescore-plugin-dev/scripts/analyze-crash.py
# or a specific dump:
python3 .claude/skills/musescore-plugin-dev/scripts/analyze-crash.py path/to.dmp
```

It reconstructs a backtrace by scanning the crashed thread's stack for return
addresses inside the `mscore` binary and running them through `atos`. Example
real output (the `voice-3` crash that drove a plugin rewrite this session):

```
Exception: EXCEPTION_SIGHUP at 0x100
  mu::engraving::Score::changeSelectedElementsVoice(unsigned long)
  mu::notation::NotationInteraction::changeSelectedElementsVoice(unsigned long)
  mu::notation::NotationActionController::changeVoice(unsigned long)
```

That trace is what told us `cmd("voice-3")` was crashing inside MuseScore itself
(not our code) — see [reference/api-gotchas.md](reference/api-gotchas.md),
"startCmd / endCmd and crashes".

macOS/Apple-Silicon only (atos against the installed app). Dumps live in
`~/Library/Application Support/MuseScore/MuseScore4/logs/dumps/completed/`.

## Verify the API against real MuseScore source

The plugin API docs are thin. The fastest way to answer "what's the action code
for X" / "does this property exist" / "what does this built-in actually do" is to
grep the MuseScore source:

```bash
.claude/skills/musescore-plugin-dev/scripts/fetch-mscore-src.sh   # → ./.mscore-src
```

Sparse-checks-out only `src/engraving` + `src/notation` + `src/notationscene`
(blobless, depth 1 — fast). Then, for example:

```bash
grep -rn 'registerAction'          .mscore-src/src/notationscene/internal/notationactioncontroller.cpp  # action codes
grep -rn 'Q_INVOKABLE\|Q_PROPERTY' .mscore-src/src/engraving/api/v1/                                    # plugin API surface
grep -rn 'void Chord::setSlash'    .mscore-src/src/engraving/dom/chord.cpp                               # what a built-in does
```

`.mscore-src/` is a scratch checkout; add it to `.gitignore` or delete when done.

## Gotchas (see reference for the full list + source citations)

- **No headless plugin execution** — GUI only. Don't hunt for a `--plugin` flag.
- **Drum staves silently drop non-drum pitches and force the voice** — you can't
  `cursor.addNote` a melody onto a drum staff; use `cmd("copy")`/`cmd("paste")`.
- **`selectRange` no-ops while a `startCmd` is open** (selection is locked) — do
  selection changes outside commands, and verify `selection.startStaff` before
  running a destructive `cmd()`.
- **Never wrap several `cmd()`s in one `startCmd`** — it crashes on stale
  segments; run them standalone.
- **Action codes ≠ menu labels** — `slash-rhythm`, `slash-fill`, `voice-3`, not
  the human strings.

## Troubleshooting

- `Cursor::addNote: cursor location is undefined` in the log → you rewound on an
  empty voice/track, or set `staffIdx`/`voice` after `rewind`. See the cursor
  section in the reference.
- Plugin "does nothing" and no error dialog → likely a `selectRange` that
  silently failed (locked selection), or a QML syntax slip (`check-qml.mjs`), or
  it turned into a no-op on the wrong selection. Check `mslog.sh`.
- New plugin doesn't appear in the menu → restart MuseScore and enable it in
  Home > Plugins.
