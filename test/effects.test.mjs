import { test, eq, ok } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const Effects = loadQmlLib("../JazzKit/lib/effects.js", "effectsLib");

const DIV = 480;                 // ticks per quarter note
const WHOLE = DIV * 4;           // 1920
const Element = { CHORD: 1, REST: 2, ARTICULATION: 3 };

// --- ticksToFraction (pure: the numeric core of the mid-measure split) ------

test("ticksToFraction: quarter, half, whole, dotted-quarter reduce correctly", () => {
    eq(Effects.ticksToFraction(480, DIV), { z: 1, n: 4 });
    eq(Effects.ticksToFraction(960, DIV), { z: 1, n: 2 });
    eq(Effects.ticksToFraction(1920, DIV), { z: 1, n: 1 });
    eq(Effects.ticksToFraction(720, DIV), { z: 3, n: 8 });   // dotted quarter
    eq(Effects.ticksToFraction(160, DIV), { z: 1, n: 12 });  // triplet eighth
});

test("ticksToFraction: division defaults to 480 when omitted", () => {
    eq(Effects.ticksToFraction(480, undefined), { z: 1, n: 4 });
});

// --- A minimal fake score/cursor to drive the API-touching cue writer -------
// Each staff is a sorted list of segments { tick, dur, el }. A write splits the
// spanning segment (this is what makes the mid-measure positioning testable).

function frac(ticks) { return { ticks, numerator: Effects.ticksToFraction(ticks, DIV).z, denominator: Effects.ticksToFraction(ticks, DIV).n }; }
function restEl(dur) { return { type: Element.REST, duration: frac(dur), notes: [], articulations: [], small: false }; }
function chordEl(dur, pitches, accents) {
    return { type: Element.CHORD, duration: frac(dur), notes: pitches.map((p) => ({ pitch: p })), articulations: (accents || []).map((s) => ({ symbol: s })), small: false };
}

class FakeCursor {
    constructor(score) { this.score = score; this.staffIdx = 0; this.voice = 0; this.tick = 0; this._i = 0; this._dur = { z: 1, n: 4 }; this._lastChord = null; }
    get _segs() { return this.score.staves[this.staffIdx] || (this.score.staves[this.staffIdx] = []); }
    rewindToTick(t) {
        const segs = this._segs; let i = 0;
        for (let k = 0; k < segs.length; k++) if (segs[k].tick <= t) i = k;
        this._i = i; this.tick = segs.length ? segs[i].tick : t;
    }
    get segment() { return this._i < this._segs.length ? { tick: this._segs[this._i].tick } : null; }
    get element() { return this._i < this._segs.length ? this._segs[this._i].el : null; }
    next() { this._i++; const s = this._segs; this.tick = this._i < s.length ? s[this._i].tick : Infinity; return this._i < s.length; }
    setDuration(z, n) { this._dur = { z, n }; }
    _durTicks() { return Math.round((this._dur.z / this._dur.n) * WHOLE); }
    addRest() { this._write("rest", [], this._durTicks()); }
    addNote(pitch, addToChord) {
        if (addToChord && this._lastChord) { this._lastChord.notes.push({ pitch }); this.score.ops.push({ op: "addToChord", staff: this.staffIdx, pitch }); return; }
        this._write("chord", [pitch], this._durTicks());
    }
    add(el) { const cur = this.element; if (cur) cur.articulations.push(el); this.score.ops.push({ op: "accent", staff: this.staffIdx, tick: this.tick, sym: el.symbol }); }
    // Like MuseScore note input: a duration crossing a barline (multiple of WHOLE)
    // is written as several tied slices, one per measure.
    _write(kind, pitches, Dtot) {
        const T0 = this.tick; let start = T0, remaining = Dtot, head = null;
        while (remaining > 0) {
            const nextBar = (Math.floor(start / WHOLE) + 1) * WHOLE;
            const d = Math.min(remaining, nextBar - start);
            const el = kind === "chord" ? chordEl(d, pitches, []) : restEl(d);
            this._insertSplit(start, d, el);
            this.score.ops.push({ op: kind, staff: this.staffIdx, tick: start, dur: d, pitches: pitches.slice() });
            if (!head) head = el;
            start += d; remaining -= d;
        }
        this._lastChord = kind === "chord" ? head : null;
        this.tick = T0 + Dtot;
        const segs = this._segs; this._i = segs.findIndex((s) => s.tick === this.tick); if (this._i < 0) this._i = segs.length;
    }
    _insertSplit(T, D, el) {
        const out = [];
        for (const s of this._segs) {
            const sEnd = s.tick + s.dur;
            if (sEnd <= T || s.tick >= T + D) { out.push(s); continue; }
            if (s.tick < T) out.push({ tick: s.tick, dur: T - s.tick, el: restEl(T - s.tick) });
            if (sEnd > T + D) out.push({ tick: T + D, dur: sEnd - (T + D), el: restEl(sEnd - (T + D)) });
        }
        out.push({ tick: T, dur: D, el });
        out.sort((a, b) => a.tick - b.tick);
        this.score.staves[this.staffIdx] = out;
    }
}

class FakeScore { constructor() { this.staves = {}; this.ops = []; this.parts = []; } newCursor() { return new FakeCursor(this); } startCmd() {} endCmd() {} }

const Direction = { DOWN: "DOWN", UP: "UP" };
const NoteHeadGroup = { HEAD_SLASH: "HEAD_SLASH", HEAD_NORMAL: "HEAD_NORMAL" };
const Beam = { NONE: "NONE" };
function makeCtx(score) {
    return { curScore: score, division: DIV, Element, Direction, NoteHeadGroup, Beam,
             newElement: (type) => ({ type, symbol: undefined }) };
}

// Source: quarter C(60)+accent, quarter rest, quarter D(62), at beats 2-4 of a
// 4/4 bar (ticks 480..1920). Target: one full-measure rest at tick 0.
function scenario() {
    const score = new FakeScore();
    score.staves[0] = [
        { tick: 480, dur: 480, el: chordEl(480, [60], ["acc"]) },
        { tick: 960, dur: 480, el: restEl(480) },
        { tick: 1440, dur: 480, el: chordEl(480, [62], []) },
    ];
    score.staves[1] = [{ tick: 0, dur: WHOLE, el: restEl(WHOLE) }];
    return score;
}

// --- compCuesNotes: mid-measure positioning ---------------------------------

test("compCuesNotes: splits the target's full-measure rest so the cue starts exactly at selStart", () => {
    const score = scenario();
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(res.targetsDone, 1);

    const writes = score.ops.filter((o) => o.staff === 1 && (o.op === "rest" || o.op === "chord"));
    // First target write is the leading GAP rest: tick 0, duration 480 (beat 1),
    // creating a boundary at selStart=480 — the fix for "starts at the closest
    // time point".
    eq(writes[0], { op: "rest", staff: 1, tick: 0, dur: 480, pitches: [] });
    // Then the cue, note-for-note at the exact source ticks.
    eq(writes[1], { op: "chord", staff: 1, tick: 480, dur: 480, pitches: [60] });
    eq(writes[2], { op: "rest", staff: 1, tick: 960, dur: 480, pitches: [] });
    eq(writes[3], { op: "chord", staff: 1, tick: 1440, dur: 480, pitches: [62] });
});

test("compCuesNotes: cue chords are cue-sized and carry the source articulations", () => {
    const score = scenario();
    Effects.compCuesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    const seg = score.staves[1].find((s) => s.tick === 480);
    ok(seg && seg.el.type === Element.CHORD);
    eq(seg.el.small, true);
    eq(seg.el.articulations.map((a) => a.symbol), ["acc"]);   // accent copied
    // The rest that follows carries no articulation and isn't cue-sized.
    const restSeg = score.staves[1].find((s) => s.tick === 960);
    eq(restSeg.el.small, false);
});

test("compCuesNotes: a selection starting on the barline needs no leading gap rest", () => {
    const score = new FakeScore();
    score.staves[0] = [{ tick: 0, dur: 480, el: chordEl(480, [60], []) }];
    score.staves[1] = [{ tick: 0, dur: WHOLE, el: restEl(WHOLE) }];
    Effects.compCuesNotes(makeCtx(score), {
        selStart: 0, selEnd: 480, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    const writes = score.ops.filter((o) => o.staff === 1);
    eq(writes[0], { op: "chord", staff: 1, tick: 0, dur: 480, pitches: [60] });  // no leading rest
});

test("compCuesNotes: a note crossing a barline is kept as tied slices — cue-sized, accent on the head only", () => {
    const score = new FakeScore();
    // Source: a half note E(64) with an accent on beat 4 (tick 1440), spilling into bar 2.
    score.staves[0] = [{ tick: 1440, dur: 960, el: chordEl(960, [64], ["acc"]) }];
    // Target: two empty bars.
    score.staves[1] = [
        { tick: 0, dur: WHOLE, el: restEl(WHOLE) },
        { tick: WHOLE, dur: WHOLE, el: restEl(WHOLE) },
    ];
    Effects.compCuesNotes(makeCtx(score), {
        selStart: 1440, selEnd: 2400, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    const chords = score.staves[1].filter((s) => s.el.type === Element.CHORD);
    // Two tied slices: [1440,1920) in bar 1 and [1920,2400) in bar 2.
    eq(chords.map((c) => [c.tick, c.dur]), [[1440, 480], [1920, 480]]);
    eq(chords.every((c) => c.el.small === true), true);              // every slice cue-sized
    eq(chords[0].el.articulations.map((a) => a.symbol), ["acc"]);    // accent on the head slice
    eq(chords[1].el.articulations.length, 0);                        // NOT on the tail slice
});

test("compCuesNotes: a drum target gets a slash-rhythm comp, not a pitched cue", () => {
    const score = scenario();   // src: chord@480(+acc), rest@960, chord@1440
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: true }],
    });
    eq(res.targetsDone, 1);
    const chords = score.staves[1].filter((s) => s.el.type === Element.CHORD);
    // Source chords (beats 2 and 4) became slash noteheads; the beat-3 rest stayed.
    eq(chords.map((c) => c.tick), [480, 1440]);
    eq(chords.every((c) => c.el.notes[0].headGroup === "HEAD_SLASH"), true);   // slashed, not cue-size
    eq(chords.every((c) => c.el.small !== true), true);
});

test("compCuesNotes: empty selection reports an error, writes nothing", () => {
    const score = new FakeScore();
    score.staves[0] = [];
    score.staves[1] = [{ tick: 0, dur: WHOLE, el: restEl(WHOLE) }];
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    ok(res.error);
    eq(score.ops.length, 0);
});
