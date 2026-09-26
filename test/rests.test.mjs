import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const R = loadQmlLib("../JazzKit/lib/rests.js", "restsLib");
// The rests MuseScore's setRests writes for a gap of `len` ticks at `at` in num/den.
const rests = (num, den, at, len) => R.restDurations(num, den, at, len, 480);

// These follow MuseScore's own grouping (a port of toRhythmicDurationList); the GUI
// harness checks the port against MuseScore's actual range-delete refill.

test("4/4: a half rest only on beats 1-2 or 3-4, never across beat 3", () => {
    eq(rests(4, 4, 0, 960), [960]);
    eq(rests(4, 4, 960, 960), [960]);
    eq(rests(4, 4, 480, 960), [480, 480]);          // beats 2-3
    eq(rests(4, 4, 480, 1440), [480, 960]);         // beats 2-4: quarter + half
});

test("4/4: an off-beat rest run fills to the beat, then whole beats", () => {
    eq(rests(4, 4, 240, 1680), [240, 480, 960]);
    eq(rests(4, 4, 1200, 720), [240, 480]);
});

test("3/4: rests never merge across a beat", () => {
    eq(rests(3, 4, 0, 960), [480, 480]);
    eq(rests(3, 4, 480, 960), [480, 480]);
});

test("2/4: rests don't cross the middle of the bar", () => {
    eq(rests(2, 4, 240, 720), [240, 480]);
});

test("compound meters: dotted-quarter beats", () => {
    eq(rests(6, 8, 0, 720), [720]);
    eq(rests(6, 8, 720, 720), [720]);
    eq(rests(6, 8, 240, 1200), [240, 240, 720]);
    eq(rests(12, 8, 0, 1440), [1440]);
});

test("restDurations always fills the gap exactly", () => {
    for (const [n, d] of [[4, 4], [3, 4], [2, 4], [6, 8], [12, 8], [5, 4], [7, 8]]) {
        const bar = n * 1920 / d;
        for (let at = 0; at < bar; at += 120)
            for (let len = 120; at + len <= bar; len += 120) {
                if (at === 0 && len === bar) continue;   // a whole bar is a full-measure rest
                eq(rests(n, d, at, len).reduce((a, b) => a + b, 0), len, `${n}/${d} @${at} len ${len}`);
            }
    }
});

test("restRuns: consecutive plain rests form a run; notes and tuplet rests break it", () => {
    const cr = (rtick, ticks, isRest, inTuplet) => ({ rtick, ticks, isRest, inTuplet: !!inTuplet });
    eq(R.restRuns([cr(0, 480, false), cr(480, 240, true), cr(720, 240, true), cr(960, 480, false),
                   cr(1440, 160, true, true), cr(1600, 320, true)]),
       [{ start: 480, end: 960, lengths: [240, 240] }, { start: 1600, end: 1920, lengths: [320] }]);
});

test("sameLengths", () => {
    eq(R.sameLengths([480, 960], [480, 960]), true);
    eq(R.sameLengths([480, 480, 480], [480, 960]), false);
});

// --- notes (Regroup rhythms' rules: more lenient than rests) ------------------

const notes = (num, den, at, len) => R.noteDurations(num, den, at, len, 480);

test("notes: a half note on beat 2 of 4/4 stays whole, one on the second eighth splits at beat 3", () => {
    eq(notes(4, 4, 480, 960), [960]);
    eq(notes(4, 4, 240, 960), [720, 240]);
});

test("notes: level-1 syncopation is fine (a quarter on the & of 1), crossing beat 3 from off the beat is not", () => {
    eq(notes(4, 4, 240, 480), [480]);
    eq(notes(4, 4, 720, 480), [240, 240]);
});

test("notes: dotted values that start on a strong beat stay", () => {
    eq(notes(4, 4, 0, 1440), [1440]);
    eq(notes(4, 4, 480, 1440), [1440]);
});

test("notes: 3/4 lets a half note sit on beat 2 (rests would split)", () => {
    eq(notes(3, 4, 480, 960), [960]);
    eq(rests(3, 4, 480, 960), [480, 480]);
});

const crN = (rtick, ticks, extra) => Object.assign({ rtick, ticks, isRest: false, inTuplet: false, tiedNext: false }, extra);

test("voiceNeedsRegroup: a quarter tied to a quarter on beats 1-2 wants to be a half note", () => {
    eq(R.voiceNeedsRegroup(4, 4, [crN(0, 480, { tiedNext: true }), crN(480, 480), crN(960, 960)], 1920, 480), true);
});

test("voiceNeedsRegroup: a well-written bar needs nothing", () => {
    eq(R.voiceNeedsRegroup(4, 4, [crN(0, 480), crN(480, 960), crN(1440, 480)], 1920, 480), false);
    eq(R.voiceNeedsRegroup(4, 4, [crN(0, 240), crN(240, 720, { tiedNext: true }), crN(960, 240), crN(1200, 720)], 1920, 480), false);
});

test("voiceNeedsRegroup: a half note on the second eighth is flagged", () => {
    eq(R.voiceNeedsRegroup(4, 4, [crN(0, 240), crN(240, 960), crN(1200, 720)], 1920, 480), true);
});

test("voiceNeedsRegroup: tuplet members are left alone; a whole-bar rest is fine", () => {
    eq(R.voiceNeedsRegroup(4, 4, [crN(0, 160, { inTuplet: true }), crN(160, 160, { inTuplet: true }),
                                  crN(320, 160, { inTuplet: true }), crN(480, 1440)], 1920, 480), false);
    eq(R.voiceNeedsRegroup(4, 4, [{ rtick: 0, ticks: 1920, isRest: true, inTuplet: false, tiedNext: false }], 1920, 480), false);
});
