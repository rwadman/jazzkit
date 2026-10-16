import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const LB = loadQmlLib("../JazzKit/lib/linebreaks.js", "linebreaksLib");

// A default single-bar box with no structural markings.
function bar(over) { return Object.assign({ musicBars: 1, endsDouble: false, repeatEnd: false, repeatStart: false }, over); }
function bars(n, over) { const a = []; for (let i = 0; i < n; i++) a.push(bar(over)); return a; }

const NONE = { atDouble: false, atRepeats: false, everyN: 0, minBars: 1, maxBars: 0 };
function opts(over) { return Object.assign({}, NONE, over); }

// --- groupBoxes (measures → visual boxes) -----------------------------------

test("groupBoxes: with no MM info every measure is its own box", () => {
    eq(LB.groupBoxes([0, 1920, 3840], null), [
        { firstIdx: 0, lastIdx: 0, musicBars: 1 },
        { firstIdx: 1, lastIdx: 1, musicBars: 1 },
        { firstIdx: 2, lastIdx: 2, musicBars: 1 },
    ]);
});

test("groupBoxes: interior measures of a multirest merge into one box", () => {
    // Box starts at ticks 0 and 5760; measures at 0,1920,3840 collapse to one box.
    const groups = LB.groupBoxes([0, 1920, 3840, 5760], { 0: true, 5760: true });
    eq(groups, [
        { firstIdx: 0, lastIdx: 2, musicBars: 3 },
        { firstIdx: 3, lastIdx: 3, musicBars: 1 },
    ]);
});

test("groupBoxes: the first measure always starts a box even off-grid", () => {
    // First tick isn't in boxStarts, but index 0 still opens a box.
    eq(LB.groupBoxes([1920, 3840], { 3840: true }), [
        { firstIdx: 0, lastIdx: 0, musicBars: 1 },
        { firstIdx: 1, lastIdx: 1, musicBars: 1 },
    ]);
});

// --- everyN grid ------------------------------------------------------------

test("every 4 of 12 bars → breaks after box 3 and 7 (not the last)", () => {
    eq(LB.computeBreaks(bars(12), opts({ everyN: 4 })), [3, 7]);
});

test("everyN off → no breaks", () => {
    eq(LB.computeBreaks(bars(12), opts({ everyN: 0 })), []);
});

test("everyN counts music bars, so a multirest keeps the grid aligned", () => {
    // boxes: 1,1,[4-bar rest],1,1,1,1  → cumulative 1,2,6,7,8,9,10.
    // With N=4 the grid line at 8 falls on the box that reaches acc 8.
    const boxes = [bar(), bar(), bar({ musicBars: 4 }), bar(), bar(), bar(), bar()];
    // acc after each: 1,2,6,7,8,9,10 → 8 is a multiple of 4 at index 4.
    eq(LB.computeBreaks(boxes, opts({ everyN: 4 })), [4]);
});

// --- structural breaks ------------------------------------------------------

test("double barline forces a break when atDouble", () => {
    const boxes = bars(6);
    boxes[2].endsDouble = true;
    eq(LB.computeBreaks(boxes, opts({ atDouble: true })), [2]);
});

test("double barline ignored when atDouble is off", () => {
    const boxes = bars(6);
    boxes[2].endsDouble = true;
    eq(LB.computeBreaks(boxes, opts({ atDouble: false })), []);
});

test("end-repeat breaks after it; start-repeat breaks before it", () => {
    const boxes = bars(6);
    boxes[1].repeatEnd = true;    // break after box 1
    boxes[4].repeatStart = true;  // break before box 4 → after box 3
    eq(LB.computeBreaks(boxes, opts({ atRepeats: true })), [1, 3]);
});

test("never break on the last box even if it ends structurally", () => {
    const boxes = bars(4);
    boxes[3].endsDouble = true;
    eq(LB.computeBreaks(boxes, opts({ atDouble: true })), []);
});

test("everyN grid restarts at a structural section boundary", () => {
    // 8 bars, double barline after box 1 restarts the count; N=4 then breaks at
    // box 1 (structural) and box 5 (acc back to 4 within the new section).
    const boxes = bars(8);
    boxes[1].endsDouble = true;
    eq(LB.computeBreaks(boxes, opts({ atDouble: true, everyN: 4 })), [1, 5]);
});

// --- minBars merging --------------------------------------------------------

test("short trailing line merges back by dropping its everyN break", () => {
    // 10 bars, N=4 → breaks at 3,7 leaving a 2-box tail (boxes 8,9). minBars 3
    // drops the break at 7 so the tail joins the middle line.
    eq(LB.computeBreaks(bars(10), opts({ everyN: 4, minBars: 3 })), [3]);
});

test("structural break before a short line is never removed → merge forward", () => {
    // double barline after box 1 makes a 1-box line [0..1]? No: line0 = box0..1
    // (2 boxes). Make a truly short structural-led line: break after box 0 via
    // start-repeat on box1, plus everyN.
    const boxes = bars(6);
    boxes[1].repeatStart = true; // structural break after box 0 → line0 = [0] (1 box)
    // minBars 2: line0 has 1 box, its trailing break is structural (unremovable),
    // so it must merge FORWARD by dropping the break after box 0... which is the
    // structural one — not allowed. With no removable break, line0 stays.
    // Assert it does not throw and keeps the structural break.
    const res = LB.computeBreaks(boxes, opts({ atRepeats: true, minBars: 2 }));
    eq(res.indexOf(0) !== -1, true);
});

test("maxBars blocks a merge that would overflow the line", () => {
    // 8 bars, N=4 → breaks at 3 and (7 is last-1). Lines: [0..3]=4, [4..7]=4.
    // Add a short line via N and check maxBars caps merging.
    // 9 bars N=4: breaks at 3,7 → lines 4,4,1. minBars 2 wants to merge the 1
    // back into the previous 4-box line → would be 5 boxes; maxBars 4 blocks it.
    eq(LB.computeBreaks(bars(9), opts({ everyN: 4, minBars: 2, maxBars: 4 })), [3, 7]);
});

test("minBars 1 is a no-op (no merging)", () => {
    eq(LB.computeBreaks(bars(10), opts({ everyN: 4, minBars: 1 })), [3, 7]);
});

// --- edges ------------------------------------------------------------------

test("empty score → no breaks", () => {
    eq(LB.computeBreaks([], opts({ everyN: 4 })), []);
});

test("single box → no breaks", () => {
    eq(LB.computeBreaks(bars(1), opts({ everyN: 1, atDouble: true })), []);
});

// --- computeLines / minMerge directly --------------------------------------

test("computeLines partitions by tags and always closes the last line", () => {
    // tags: break after 1 and 4, n=6 → lines [0..1],[2..4],[5..5]
    eq(LB.computeLines([0, 2, 0, 0, 1, 0], 6), [
        { s: 0, e: 1, boxCount: 2 },
        { s: 2, e: 4, boxCount: 3 },
        { s: 5, e: 5, boxCount: 1 },
    ]);
});

test("minMerge mutates tag in place, dropping a removable short-line break", () => {
    const tag = [0, 0, 2, 0, 0, 0]; // break after box 2 → lines of 3 and 3
    LB.minMerge(tag, 6, 4, 0);      // minBars 4: both lines short, merge them
    eq(tag, [0, 0, 0, 0, 0, 0]);
});

// --- endings (voltas) -------------------------------------------------------

test("voltaFlags: numbers the endings of a group and marks all but the last", () => {
    // 1st ending = bar 8 (tick 7*1920), 2nd = bar 9; a lone volta later at bar 20.
    const W = 1920;
    const voltas = [{ start: 8 * W, end: 9 * W }, { start: 7 * W, end: 8 * W }, { start: 19 * W, end: 20 * W }];
    const boxes = [6, 7, 8, 9, 19].map((b) => ({ firstTick: b * W, lastTick: b * W }));
    eq(LB.voltaFlags(voltas, boxes), [
        { endingStart: 0, inEnding: false },
        { endingStart: 1, inEnding: true },     // 1st ending: another follows
        { endingStart: 2, inEnding: false },    // 2nd ending: the last of its group
        { endingStart: 0, inEnding: false },
        { endingStart: 1, inEnding: false },    // a lone volta is its group's last
    ]);
});

const LEADSHEET = { atDouble: true, atRepeats: true, everyN: 4, minBars: 3, maxBars: 6 };

// AABA with 1st/2nd endings: |: A (bars 1-6) |1. 7 8 :|2. 9 10 || B (11-18) || A (19-26)
function aabaWithEndings(endingBars) {
    const a = 8 - endingBars;
    const boxes = [];
    for (let i = 0; i < a; i++) boxes.push(bar(i === 0 ? { repeatStart: true } : {}));
    for (let i = 0; i < endingBars; i++)
        boxes.push(bar({ endingStart: i === 0 ? 1 : 0, inEnding: true, repeatEnd: i === endingBars - 1 }));
    for (let i = 0; i < endingBars; i++)
        boxes.push(bar({ endingStart: i === 0 ? 2 : 0, endsDouble: i === endingBars - 1 }));
    for (let i = 0; i < 8; i++) boxes.push(bar({ endsDouble: i === 7 }));
    for (let i = 0; i < 8; i++) boxes.push(bar());
    return boxes;
}

test("endings: a short 2nd ending shares the 1st ending's line (no line of its own)", () => {
    // 2-bar endings: boxes 6-7 = 1st ending, 8-9 = 2nd. Before: breaks after 7 AND 9,
    // stranding the 2nd ending on a 2-bar line.
    eq(LB.computeBreaks(aabaWithEndings(2), LEADSHEET), [3, 9, 13, 17, 21]);
    // 1-bar endings likewise.
    eq(LB.computeBreaks(aabaWithEndings(1), LEADSHEET), [3, 8, 12, 16, 20]);
});

test("endings: when they don't fit one line, the 2nd ending starts a line under the 1st", () => {
    eq(LB.computeBreaks(aabaWithEndings(2), Object.assign({}, LEADSHEET, { maxBars: 4 })), [3, 7, 9, 13, 17, 21]);
});

test("endings: the 2nd ending restarts the grid where the 1st began, so the next phrase stays aligned", () => {
    // 1st ending bars 7-8, 2nd ending bars 9-10, then B with NO double barline: the
    // grid must still break B after its 4th bar (box 13), not 2 bars in.
    const boxes = aabaWithEndings(2);
    boxes[9].endsDouble = false;
    const res = LB.computeBreaks(boxes, Object.assign({}, LEADSHEET, { minBars: 1 }));
    eq(res.includes(13) && !res.includes(11), true);
});

test("endings: a 4-bar 1st/2nd ending pair lines up as two lines", () => {
    eq(LB.computeBreaks(aabaWithEndings(4), LEADSHEET), [3, 7, 11, 15, 19, 23]);
});

// --- multimeasure rests -------------------------------------------------------

test("multirests between double barlines don't get lines of their own", () => {
    // m m m m || r8 || m m m m || r16 || m m m m — each rest joins the line before it.
    const boxes = [...bars(4), bar({ musicBars: 8 }), ...bars(4), bar({ musicBars: 16 }), ...bars(4)];
    boxes[3].endsDouble = true; boxes[4].endsDouble = true; boxes[8].endsDouble = true; boxes[9].endsDouble = true;
    eq(LB.computeBreaks(boxes, LEADSHEET), [4, 9]);
});

test("consecutive multirests share a line; the music after them starts a new one", () => {
    // r8 r8 r4 then 8 bars: before, every rest landed on the grid and ended a line.
    const boxes = [bar({ musicBars: 8 }), bar({ musicBars: 8 }), bar({ musicBars: 4 }), ...bars(8)];
    eq(LB.computeBreaks(boxes, LEADSHEET), [2, 6]);
});

test("a lone multirest mid-section joins the line before it", () => {
    const boxes = [...bars(4), bar({ musicBars: 8 }), ...bars(4)];
    eq(LB.computeBreaks(boxes, LEADSHEET), [4]);
});

// --- maxBars is a real limit ----------------------------------------------------

test("maxBars splits an over-long line evenly", () => {
    eq(LB.computeBreaks(bars(10), opts({ maxBars: 6 })), [4]);            // 5 + 5, not 6 + 4
    eq(LB.computeBreaks(bars(13), opts({ maxBars: 6 })), [4, 8]);         // 5 + 4 + 4
    eq(LB.computeBreaks(bars(8), opts({ everyN: 8, maxBars: 6 })), [3]);  // N > max: 4 + 4
});

// --- pickup bars, rehearsal marks, codas ----------------------------------------

test("a pickup bar isn't counted: the first line is the pickup plus N full bars", () => {
    // Before: the pickup counted as bar 1, so every line broke one bar early.
    const boxes = [bar({ pickup: true }), ...bars(12)];
    eq(LB.computeBreaks(boxes, opts({ everyN: 4 })), [4, 8]);
});

test("a pickup alone never ends a line", () => {
    eq(LB.computeBreaks([bar({ pickup: true }), ...bars(3)], opts({ everyN: 1 })), [1, 2]);
});

test("a rehearsal mark breaks before its bar (with the double-barline option)", () => {
    const boxes = bars(12);
    boxes[6].rehearsal = true;
    eq(LB.computeBreaks(boxes, opts({ atDouble: true, everyN: 4 })), [3, 5, 9]);
    eq(LB.computeBreaks(boxes, opts({ atDouble: false, everyN: 4 })), [3, 7]);
});

test("a coda sign breaks before its bar (with the repeats option)", () => {
    const boxes = bars(10);
    boxes[8].coda = true;
    eq(LB.computeBreaks(boxes, opts({ atRepeats: true, everyN: 4 })), [3, 7]);   // already on the grid
    boxes[8].coda = false; boxes[6].coda = true;
    eq(LB.computeBreaks(boxes, opts({ atRepeats: true, everyN: 4 })), [3, 5]);
});
