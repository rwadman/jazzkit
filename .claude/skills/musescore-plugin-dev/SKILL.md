---
name: musescore-plugin-dev
description: Develop, run, and debug the JazzKit MuseScore 4 plugin (QML). Use when writing or changing a MuseScore plugin, verifying the plugin API / action codes, running a plugin in MuseScore, reading MuseScore logs, or analyzing a MuseScore crash dump caused by a plugin.
---

# Developing the JazzKit MuseScore plugin

JazzKit is a **MuseScore 4 plugin** in QML (`plugins/*.qml`). It runs only inside
the MuseScore GUI — **MuseScore 4 has no CLI plugin runner**, so there is no
headless way to execute a plugin. Loop: edit → check → sync → run in GUI → read
log → (if crash) symbolicate dump.

**Read [reference/api-gotchas.md](reference/api-gotchas.md) before writing plugin
code** — the API traps there (drum-staff voice forcing, selection lock during
`startCmd`, cursor `rewindToTick` skipping empty voices, crash from nested
commands, action codes ≠ menu labels) are the whole reason this skill exists.

Paths are relative to the repo root. Prereqs: MuseScore 4.4+ at
`/Applications/MuseScore 4.app`; `node` + `python3`; for crash analysis,
`pip3 install minidump aenum`. macOS/Apple-Silicon.

## Commands

```bash
# static-check QML (no real qmllint exists; catches silent-no-op syntax slips)
node .claude/skills/musescore-plugin-dev/scripts/check-qml.mjs plugins/*.qml

# copy plugin → ~/Documents/MuseScore4/Plugins/JazzKit/
.claude/skills/musescore-plugin-dev/scripts/sync.sh

# newest MuseScore log, plugin-relevant lines (-f follow, -a all)
.claude/skills/musescore-plugin-dev/scripts/mslog.sh

# symbolicate the newest crash dump (or pass a .dmp path)
python3 .claude/skills/musescore-plugin-dev/scripts/analyze-crash.py

# sparse-checkout MuseScore source into ./.mscore-src for API/action-code grepping
.claude/skills/musescore-plugin-dev/scripts/fetch-mscore-src.sh
```

## Running the plugin (GUI only)

Open a score (the drum-slash action needs a pitched staff + a drum staff), make a
selection, then Plugins → *action*. Observe with `mslog.sh` — each step
logs as `try call action: <code>`. An existing `.qml` is re-read each run; a
**new** `.qml` needs a restart + one-time enable in Home > Plugins.

## Debugging

- Log has no stack trace for crashes; `analyze-crash.py` scans the crashed
  stack for `mscore` return addresses and runs them through `atos`. It found the
  real `voice-3` crash this session: `Score::changeSelectedElementsVoice →
  NotationInteraction::changeSelectedElementsVoice → NotationActionController::changeVoice`
  — i.e. the crash was inside MuseScore, not our code (see reference, "startCmd /
  crashes"). Dumps: `~/Library/Application Support/MuseScore/MuseScore4/logs/dumps/completed/`.
- Verify API assumptions against source, not the online docs, e.g.:
  ```bash
  grep -rn 'registerAction'          .mscore-src/src/notationscene/internal/notationactioncontroller.cpp  # action codes
  grep -rn 'Q_INVOKABLE\|Q_PROPERTY' .mscore-src/src/engraving/api/v1/                                    # API surface
  ```
- `Cursor::addNote: cursor location is undefined` → rewound on an empty
  voice/track, or set `staffIdx`/`voice` after `rewind`. See reference, "Cursor".
- Plugin "does nothing", no error → likely a `selectRange` that no-op'd (locked
  selection) or a QML slip. Check `mslog.sh` and `check-qml.mjs`.

`.mscore-src/` is scratch (git-ignored) — delete when done.
