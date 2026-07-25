# Cleanup: harness, tests, scripts, docs

Scope: `harness/`, `test/`, `scripts/`, `.github/`, `README.md`, `CLAUDE.md`, `plans/`,
`.env.example`, `.gitignore`.
See [README.md](README.md) for guardrails.

---

## T1 — `accidentals.js` is missing from the e2e fingerprint (correctness gap) -- DONE

**Where:** [scripts/e2e-fingerprint.mjs:16-24](../../scripts/e2e-fingerprint.mjs#L16-L24).

**Problem:** `TRACKED` lists `effects.js`, `articulations.js`, `linebreaks.js`,
`slashes.js`, `jazzkit.js` — but **not** `JazzKit/lib/accidentals.js`, even though the
harness drives it through `Effects.fixCourtesyAccidentals` and asserts eight cases
against it (`courtesy: …` in `harness/acceptance.json`). Editing the courtesy-accidental
planner today does **not** invalidate the recorded acceptance, so CI would pass on an
untested change. That is exactly the failure mode this gate exists to prevent.

**Do:** Add `"JazzKit/lib/accidentals.js"` to `TRACKED`, re-run `scripts/e2e.sh`, commit
the new `harness/acceptance.json`. Do this **first** — it changes the fingerprint anyway,
so it can share a GUI run with the rest of the work.

---

## T2 — Duplicate helpers in `test_harness.qml` -- DONE

**Where:** [harness/test_harness.qml](../../harness/test_harness.qml).

| Pair | Lines | Overlap |
| --- | --- | --- |
| `chordAt` / `chordAtVoice` | [120-125](../../harness/test_harness.qml#L120-L125) / [696-705](../../harness/test_harness.qml#L696-L705) | `chordAt(s, t)` ≡ `chordAtVoice(s, 0, t)` |
| `dumpVoice` / `dumpVoiceN` | [155-166](../../harness/test_harness.qml#L155-L166) / [761-770](../../harness/test_harness.qml#L761-L770) | `dumpVoice(s, f, t)` ≡ `dumpVoiceN(s, 0, f, t)` (cursor walk vs segment walk — check the inclusive/exclusive `to` bound before collapsing) |
| `dumpTick` / `chordAtVoice` | [167-177](../../harness/test_harness.qml#L167-L177) / 696 | both hand-roll "find the ChordRest segment at tick" |

**Do:** Keep the `…Voice`/`…N` variants, make the others one-line wrappers, and factor the
"segment at tick" walk into a single `segmentAt(tick)` helper used by `chordAtVoice`,
`dumpTick` and `fermataCount` ([228-240](../../harness/test_harness.qml#L228-L240)).
Also move `chordAtVoice` and `dumpVoiceN` up into the helpers section — they are
currently defined *between case functions* (696, 761), which makes the file read as if
the cases were appended without re-reading it.

**Outcome:** Done, with one deliberate exception: `dumpVoice` and `dumpVoiceN` stay two
functions. `dumpVoice`'s `to` is inclusive and `dumpVoiceN`'s exclusive, and every caller
passes the next measure's start tick — so `dumpVoice` intentionally prints one extra
segment. Collapsing them would have changed five diagnostic strings; a comment now records
this so nobody retries it. Note `chordAt` is now strictly "the chord at exactly this tick"
(it was the cursor's forward-skipping lookup); every call site passes a tick where a
voice-0 segment provably exists.

---

## T3 — Dead ternaries in the harness -- DONE

**Where:** [test_harness.qml:733](../../harness/test_harness.qml#L733) and
[:799](../../harness/test_harness.qml#L799):
`var ch = voice >= 0 ? chordAtVoice(drum, voice, …) : null;` — `voice` is the literal
`2`, assigned three lines earlier.

**Do:** `var ch = chordAtVoice(drum, voice, …);`

---

## T4 — The five drum-cue cases repeat the same 10-line prelude -- DONE

**Where:** `caseCompCuesNotesDrum` (709), `…DrumMidBar` (775), `…DrumEighths` (815),
`…DrumQuartersPartial` (858), plus `caseCompSlashesNotesDrum` (626).

**Problem:** Each opens with the identical `findDrumStaff()` + skip-with-`partsDiag()`,
`appendPitched()` + check, `ensureMeasures(n)`, source write, then a `compCuesNotes` call
whose only variation is the tick range. ~50 lines of copy-paste, and the copies have
already drifted (label prefixes differ: `"compCuesNotes drum: …"` vs `"drum cue mid-bar: …"`).

**Do:** Extract

```qml
// returns { drum, src } or null (already recorded the skip/failure)
function drumCueFixture(r, label, bars) { … }
```

and a small `runDrumCue(r, label, {drum, src, selStart, selEnd, measureTick})` that makes
the call and asserts `res.error === ""`. Each case shrinks to its actual, distinct
assertions. Keep every existing assertion — they are named regressions.

**Outcome:** Done. `drumCueFixture` takes *two* labels (skip vs source-staff), because in
two cases those strings are unrelated and both are named regressions. All 98 assertion
labels were diffed before/after: byte-identical. `caseCompSlashesNotesDrum` uses only the
fixture helper (it drives a different effect).

---

## T5 — README contradicts the code in four places -- DONE

**Where:** [README.md](../../README.md).

| Says | Reality |
| --- | --- |
| "Copy `JazzKit/` into … `~/Documents/MuseScore4/Plugins/`" (Install, steps 1-3) | It's a MU4.4+ **extension**: `~/Library/Application Support/MuseScore/MuseScore4/extensions/JazzKit/` ([sync.sh:17-21](../../scripts/sync.sh#L17-L21), CLAUDE.md) |
| "requires 4.1+" | `isSupportedVersion` requires **4.4+** ([jazzkit.js:31-35](../../JazzKit/lib/jazzkit.js#L31-L35)); every action refuses below that |
| "All entries appear under **Plugins** … MuseScore 4 flattens submenus, so they sort alphabetically by title" | CLAUDE.md says one multi-action manifest nests them under a **"JazzKit" submenu** |
| "deploy `JazzKit/` → MuseScore's plugin folder (`PLUGINS_FOLDER`, or the default)" (Development) | `sync.sh` reads **`EXTENSIONS_FOLDER`**; `PLUGINS_FOLDER` is now only used by `sync-harness.sh` |

**Do:** Fix all four (verify the menu behaviour in the GUI before writing it down —
CLAUDE.md and README currently can't both be right). The version number appears in ~7
strings across the codebase; consider a single `JazzKit.MIN_VERSION_TEXT` constant so the
next bump is one edit (see P5 in [01-plugin-code.md](01-plugin-code.md)).

**Outcome:** All four fixed, and `JazzKit.MIN_VERSION_TEXT` now backs every UI string
(forms + harness). `autofix.js` keeps its own log wording ("needs MuseScore 4.4 or later")
— it's a log line with a test asserting it, not UI. The menu-layout sentence (a "JazzKit"
submenu) was **confirmed in the GUI** in the second pass, so no document needed correcting
— see [T5 (residual)](03-remaining.md#t5-residual--confirm-the-menu-layout-done-gui-verified).

---

## T6 — `.env.example` is missing the variable `sync.sh` actually reads -- DONE

**Where:** [.env.example](../../.env.example) — lists `MUSE_SCORE_FOLDER` and
`PLUGINS_FOLDER` only.

**Problem:** `scripts/sync.sh` reads `EXTENSIONS_FOLDER`
([:20](../../scripts/sync.sh#L20)), which the example never mentions. A new checkout
that sets `PLUGINS_FOLDER` (as README instructs) silently deploys nowhere useful.

**Do:** Add `EXTENSIONS_FOLDER` with the macOS default, and comment which script reads
each of the three.

---

## T7 — One-off migration nag in `sync.sh` -- DONE

**Where:** [scripts/sync.sh:33](../../scripts/sync.sh#L33) — every sync prints
"NOTE: the old legacy copy (if any) still sits in Documents/MuseScore4/Plugins/JazzKit —
delete it…".

**Do:** Delete the line (the migration is long done), or make it conditional on that path
actually existing.

---

## T8 — `plans/*.md` are finished plans describing a design that wasn't adopted -- DONE

**Where:** `plans/unit-test-coverage.md`, `plans/e2e-plugin-tests.md`
(now [plans/archive/](../archive/)).

**Problem:** Both are implemented. Worse, `unit-test-coverage.md` specifies a
planner/executor split built on **operation descriptors** (`[{op:"select"}, {op:"cmd"}…]`)
and `ctx.cmd` / `ctx.JazzKit.selectStaffRange` — an architecture the code deliberately
abandoned when forms turned out to be `cmd()`-free. An agent reading `plans/` for context
gets a design that contradicts `effects.js`.

**Do:** Move both to `plans/archive/` with a one-line "IMPLEMENTED — superseded by the
direct-API effect layer; kept for history" header, or delete them (the git history keeps
them either way). Whichever you pick, don't leave them looking like current intent.

**Outcome:** Both `git mv`'d to [plans/archive/](../archive/) with an ARCHIVED header;
Plan B's says explicitly which part was superseded and why.

---

## T9 — `harness.js` has no `exports` trailer, contradicting CLAUDE.md -- DONE

**Where:** [JazzKit/lib/harness.js:62-67](../../JazzKit/lib/harness.js#L62-L67) vs
CLAUDE.md ("Each ends with a per-file `var <name>Lib = {…}` … plus a guarded
`exports =` trailer").

**Problem:** Harmless (no macro requires it) but it makes the documented invariant false,
and `test/require-exports.test.mjs` — whose whole purpose is catching a missing trailer —
doesn't cover it either.

**Do:** Add the two-line trailer for consistency (cheapest), **or** amend CLAUDE.md to
exempt `harness.js` explicitly. Don't leave the mismatch.

---

## T10 — `npm run check` skips the most complex QML in the repo -- DONE

**Where:** [package.json:8](../../package.json#L8) —
`node scripts/check-qml.mjs JazzKit/*.qml JazzKit/lib/*.qml`.

**Problem:** `harness/test_harness.qml` (1054 lines) is never brace/paren-checked, and
`harness/manifest.json` is never validated — the checker validates a manifest only when a
`.qml` from that directory is passed in ([check-qml.mjs:67-69](../../scripts/check-qml.mjs#L67-L69)).
A syntax slip there is a silent no-op at click time, which is exactly what this tool
exists to catch.

**Do:** `... JazzKit/*.qml JazzKit/lib/*.qml harness/*.qml`. (The legacy-package-manifest
branch at [:79-84](../../scripts/check-qml.mjs#L79-L84) already handles
`harness/manifest.json`.)

---

## T11 — No single "verify everything" command -- DONE

**Where:** [package.json:5-10](../../package.json#L5-L10), CLAUDE.md dev loop,
[.github/workflows/ci.yml](../../.github/workflows/ci.yml).

**Problem:** Four separate commands, listed in three places (CLAUDE.md, README, CI), and
they've already drifted (README's QML-lint line differs from `npm run check`).

**Do:** Add `"verify": "npm test && npm run typecheck && npm run check && npm run e2e:check"`,
have CI call it as one step, and point CLAUDE.md/README at it. Also add an `engines` field
— CI pins Node 24 while `test/harness.mjs:1` still justifies the hand-rolled runner with
"Node 16 has no built-in `node --test`". Either bump the rationale comment or, on Node
≥18, drop `test/harness.mjs` for `node --test` (saves 24 lines and the custom runner's
`run()` glue in `test/run.mjs`) — the zero-dep argument is fine, the *stale reason* isn't.

---

## T12 — `scripts/e2e.sh`: `pkill -9` can kill the developer's own MuseScore -- DONE

**Where:** [scripts/e2e.sh:73-76](../../scripts/e2e.sh#L73-L76) —
`pkill -9 -f "MuseScore 4.app/Contents/MacOS"` on the `--autoclick`/`--kill` path.

**Problem:** It matches **every** running MuseScore, not the instance the script launched.
A developer with a real score open (unsaved) loses it — and the script also restores its
own blanked `session.json` over theirs ([:63-68](../../scripts/e2e.sh#L63-L68)), so the
crash-recovery path that would have saved them is gone too. The comment ("We only ever
opened a throwaway COPY, so a hard kill can never lose real work") is true of *our* copy
and false of everything else.

**Do:** Capture the launched PID (`open -na … ; pgrep -n -f "MuseScore 4.app/Contents/MacOS"`
right after launch, or launch the binary directly in the background) and kill only that.
At minimum, refuse `--kill` when a MuseScore was already running before the script started,
and fix the comment. **behaviour** — dev tooling only, but it's a data-loss path.

---

## T13 — Repo hygiene -- DONE

- [.gitignore](../../.gitignore) has **no trailing newline** (the last entry is
  `node_modules/`), and doesn't ignore `.DS_Store` — one exists at the repo root.
- `logs/musescore-run.log` sits in the working tree; `logs/` is ignored, so this is fine,
  but `scripts/start_ms.sh` has no rotation and the file grows unbounded. A `-` per-run
  timestamped filename would be one line.
- [scripts/start_ms.sh](../../scripts/start_ms.sh) is the only script with no header
  comment, while every other one has 5-15 lines of them. Two lines would make the set
  consistent.

---

## T14 — Comment volume in the harness and scripts -- DONE

`harness/test_harness.qml` carries ~250 lines of comment for ~800 lines of code, and
`scripts/e2e.sh` ~60 for ~110. Most of it earns its place (mixer-crash ordering,
`appendPart` async behaviour, the Accessibility/AppleScript notes). Two specific
exceptions, both **wrong**, not merely wordy:

- [:726-728](../../harness/test_harness.qml#L726-L728) and
  [:809-814](../../harness/test_harness.qml#L809-L814) describe pass 2 as replacing the
  rest shell **"RIGHT-TO-LEFT (re-rewinding each time)"**. `_writeDrumCueInto`
  ([effects.js:444-501](../../JazzKit/lib/effects.js#L444-L501)) now lays a shell that
  **tiles the whole measure** and walks it **forward**, exactly once — the right-to-left
  approach was the superseded fix. Rewrite both to describe the tiling invariant (that's
  what the assertions actually guard).

Beyond those, resist a general comment purge here: this file is the only executable record
of several MuseScore crash reproductions.


---

What this document left open (the T5 menu-layout check) was closed in the second pass,
along with the plugin-code side — see [03-remaining.md](03-remaining.md).
