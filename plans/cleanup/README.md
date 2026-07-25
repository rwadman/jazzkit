# JazzKit cleanup backlog

A review of the whole repo (2026-07-25, commit `2c07ee9`) for **superfluous comments,
dead code, unnecessary complication, duplication, bloat and best-practice drift**.
Findings are split into two hand-off documents:

- [01-plugin-code.md](01-plugin-code.md) — `JazzKit/` (the shipping bundle): forms,
  the macro, `lib/*.js`.
- [02-harness-and-tooling.md](02-harness-and-tooling.md) — `harness/`, `test/`,
  `scripts/`, CI, README/CLAUDE.md, `plans/`.
- [03-remaining.md](03-remaining.md) — what the first pass left open, and how the
  second pass closed it. **Nothing is open any more**; read it before touching comp-form
  dialog sizing (P8c) or `_tryAddHiddenStaccato` (P11), which is where the surprises
  were.

Each item has an ID (`P1`, `T3`, …), a location, why it's a problem, and the proposed
change. Nothing here is a behaviour change request: every item is meant to leave the
plugin doing exactly what it does today, unless explicitly marked **behaviour**.

## Status (closed 2026-07-25)

Headers are marked `-- DONE`, `-- PARTLY DONE`, `-- WON'T DO` or `-- NOT DONE`, each with
an **Outcome** note. Of the 29 items: **26 done**, 3 declined with reasons (P6, P8c, P13).
P4, P11 and the T5 residual were finished in the second pass and verified in the GUI
(comp dialogs, the harness run, the Plugins menu).

Checks: `npm run verify` green — `npm test` **128 passed**, `npm run typecheck` clean,
`npm run check` clean (covering `harness/*.qml` too), `npm run e2e:check` **OK**
(`HARNESS PASSED — 75 ok.`, re-stamped for the current `effects.js`).

## State at time of review

`npm test` (119 tests), `npm run typecheck`, `npm run check` all pass.
`harness/acceptance.json` records `HARNESS PASSED — 75 ok.`

## Guardrails for the implementing agent

1. **Re-run the GUI harness after touching tracked source.**
   `scripts/e2e-fingerprint.mjs` hashes `harness/test_harness.qml`,
   `harness/fixtures/blank.mscz` and `JazzKit/lib/{effects,articulations,linebreaks,slashes,jazzkit}.js`.
   Any edit to those makes `npm run e2e:check` (and therefore CI) fail until
   `scripts/e2e.sh` is re-run in the GUI and the new `harness/acceptance.json` is
   committed. Batch edits to those files so the GUI run is needed once, not eight times.
   (See **T1** — `accidentals.js` is missing from that list and should be added.)
2. **Every bug fixed gets a regression test** (CLAUDE.md). Pure logic → `test/`;
   API/layout → an assertion in `harness/test_harness.qml`.
3. **Verify before you delete a comment.** Much of the commentary in `effects.js` and
   `api-gotchas.md` documents non-obvious MuseScore API traps with source citations —
   that is the most valuable text in the repo. Only the items listed below are
   flagged as restatement-of-code; do not do a general comment purge.
4. Run all three checks after each item:
   ```bash
   npm test && npm run typecheck && npm run check
   ```
5. Forms cannot dispatch notation `cmd()`s and get no `onRun` — do not "simplify"
   any effect back onto `cmd()`/clipboard.

## Suggested order

| Order | Items | Why first |
| --- | --- | --- |
| 1 | T1, T5–T9 (docs, `.env.example`, fingerprint gap) | Zero risk, no GUI re-run needed |
| 2 | P1–P3 (dead code, stale comments) | Small, isolated |
| 3 | P4–P8 (duplication in `lib/` + forms) | The bulk of the win; one GUI re-run at the end |
| 4 | T2–T4 (harness dedup) | Needs the same GUI re-run |
| 5 | P9–P12, T10+ (optional/structural) | Judgement calls, do last |
