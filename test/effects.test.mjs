import { test, eq, ok } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const Effects = loadQmlLib("../JazzKit/lib/effects.js", "effectsLib");

const DIV = 480;                 // ticks per quarter note
const WHOLE = DIV * 4;           // 1920
const Element = { CHORD: 1, REST: 2, ARTICULATION: 3, FERMATA: 4 };

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
// `add` mirrors Chord::addInternal (what cursor.add does for an ARTICULATION).
function restEl(dur) { return { type: Element.REST, duration: frac(dur), notes: [], articulations: [], small: false, add(el) { this.articulations.push(el); } }; }
// `duration` is a setter, as in the API: writing a SHORTER Fraction to a placed
// chord is Score::changeCRlen — the chord shrinks and the remainder becomes a rest.
let LIVE = null;   // the FakeScore the setter edits (the most recently made one)
function chordEl(dur, pitches, accents, ties) {
    let d = frac(dur);
    return { type: Element.CHORD, notes: pitches.map((p) => ({ pitch: p, tieForward: (ties || []).includes(p) || null })),
        articulations: (accents || []).map((s) => ({ symbol: s })), small: false, add(el) { this.articulations.push(el); },
        get duration() { return d; },
        set duration(f) {
            const ticks = Math.round((f.z / f.n) * WHOLE);
            for (const [staff, segs] of Object.entries(LIVE.staves)) {
                const seg = segs.find((s) => s.el === this);
                if (!seg || ticks >= seg.dur) continue;
                segs.push({ tick: seg.tick + ticks, dur: seg.dur - ticks, el: restEl(seg.dur - ticks) });
                segs.sort((a, b) => a.tick - b.tick);
                LIVE.ops.push({ op: "shorten", staff: Number(staff), tick: seg.tick, dur: ticks });
                seg.dur = ticks;
            }
            d = frac(ticks);
        } };
}

class FakeCursor {
    constructor(score) { this.score = score; this.staffIdx = 0; this.voice = 0; this.tick = 0; this._i = 0; this._dur = { z: 1, n: 4 }; this._lastChord = null; }
    get _segs() { return this.score.staves[this.staffIdx] || (this.score.staves[this.staffIdx] = []); }
    rewindToTick(t) {
        // The real one crashes here (null segment from tick2leftSegment).
        if (t >= this.score.lastSegment.tick) throw new Error("rewindToTick past the end of the score: " + t);
        const segs = this._segs; let i = 0;
        for (let k = 0; k < segs.length; k++) if (segs[k].tick <= t) i = k;
        this._i = i; this.tick = segs.length ? segs[i].tick : t;
    }
    get track() { return this.staffIdx * 4 + this.voice; }
    // The real Segment carries the fermatas (annotations); the chord carries the articulations.
    get segment() {
        if (this._i >= this._segs.length) return null;
        const s = this._segs[this._i];
        if (!s.annotations) s.annotations = [];
        return s;
    }
    get element() { return this._i < this._segs.length ? this._segs[this._i].el : null; }
    next() { this._i++; const s = this._segs; this.tick = this._i < s.length ? s[this._i].tick : Infinity; return this._i < s.length; }
    // Cursor::setDuration builds a TDuration, which (release build) TRUNCATES a
    // length no single value spells to the longest one that fits: 5/8 → 1/2.
    setDuration(z, n) {
        const want = z / n;
        let best = null;
        for (let base = 1; base <= 128; base *= 2)
            for (let dots = 0; dots <= 3; dots++) {
                const v = (2 - 1 / 2 ** dots) / base;   // base note with `dots` dots
                if (v <= want + 1e-12 && (!best || v > best.v)) best = { v, z: 2 ** (dots + 1) - 1, n: base * 2 ** dots };
            }
        this._dur = best ? { z: best.z, n: best.n } : { z, n };
    }
    _durTicks() { return Math.round((this._dur.z / this._dur.n) * WHOLE); }
    addRest() { this._write("rest", [], this._durTicks()); }
    addNote(pitch, addToChord) {
        if (addToChord && this._lastChord) { this._lastChord.notes.push({ pitch }); this.score.ops.push({ op: "addToChord", staff: this.staffIdx, pitch }); return; }
        this._write("chord", [pitch], this._durTicks());
    }
    // Cursor::add: a FERMATA goes to the segment (default branch), an ARTICULATION to the chord.
    add(el) {
        if (el.type === Element.FERMATA) {
            const seg = this.segment;
            if (!seg) return;
            el.track = this.track;
            seg.annotations.push(el);
            this.score.ops.push({ op: "fermata", staff: this.staffIdx, tick: this.tick, sym: el.symbol });
            return;
        }
        const cur = this.element; if (cur) cur.articulations.push(el);
        this.score.ops.push({ op: "accent", staff: this.staffIdx, tick: this.tick, sym: el.symbol });
    }
    // Cursor::addTuplet: the next writes are NOMINAL durations squeezed by the
    // ratio until the tuplet's span is used up (the real one pre-fills rests; the
    // writes then overwrite them, so the fake just scales).
    addTuplet(ratio, dur) {
        const span = Math.round((dur.z / dur.n) * WHOLE);
        this.score.ops.push({ op: "tuplet", staff: this.staffIdx, tick: this.tick, ratio: [ratio.z, ratio.n], dur: span });
        this._tuplet = { end: this.tick + span, actual: ratio.z, normal: ratio.n };
    }
    // Like MuseScore note input: a duration crossing a barline (multiple of WHOLE)
    // is written as several tied slices, one per measure.
    _write(kind, pitches, Dtot) {
        if (this._tuplet) Dtot = Dtot * this._tuplet.normal / this._tuplet.actual;
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
        if (this._tuplet && this.tick >= this._tuplet.end) this._tuplet = null;
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

// Four 4/4 bars (firstMeasure / nextMeasure / lastSegment are what _measureAt walks).
class FakeScore {
    constructor() {
        this.staves = {}; this.ops = []; this.parts = []; LIVE = this;
        let next = null;
        for (let b = 3; b >= 0; b--) next = { firstSegment: { tick: b * WHOLE, segmentType: 0 }, nextMeasure: next };
        this.firstMeasure = next;
        this.lastSegment = { tick: 4 * WHOLE };
    }
    newCursor() { return new FakeCursor(this); } startCmd() {} endCmd() {}
}

const Direction = { DOWN: "DOWN", UP: "UP" };
const NoteHeadGroup = { HEAD_SLASH: "HEAD_SLASH", HEAD_NORMAL: "HEAD_NORMAL" };
const Beam = { NONE: "NONE" };
function makeCtx(score) {
    return { curScore: score, division: DIV, Element, Direction, NoteHeadGroup, Beam, Segment: { ChordRest: 1 },
             fraction: (z, n) => ({ z, n }),
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

// Same, plus a fermata on the beat-2 source chord's SEGMENT and one on the
// beat-3 REST (fermatas are segment annotations, so a rest can carry one).
function markedScenario() {
    const score = scenario();
    const fer = (t) => ({ type: Element.FERMATA, symbol: "fer", track: 0 });
    score.staves[0][0].annotations = [fer()];   // chord @480
    score.staves[0][1].annotations = [fer()];   // rest  @960
    return score;
}
function fermatasAt(score, staff, tick) {
    const seg = score.staves[staff].find((s) => s.tick === tick);
    return ((seg && seg.annotations) || []).filter((a) => a.type === Element.FERMATA).map((a) => a.symbol);
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

// --- markings (articulations + fermatas) carried by every comp path ---------

test("compCuesNotes: fermatas are copied onto the cue — including over a rest", () => {
    const score = markedScenario();
    Effects.compCuesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(fermatasAt(score, 1, 480), ["fer"]);    // on the cue chord's segment
    eq(fermatasAt(score, 1, 960), ["fer"]);    // …and over the rest
    eq(fermatasAt(score, 1, 1440), []);        // nowhere else
});

test("compSlashesNotes: slashes carry the source articulations and fermatas", () => {
    const score = markedScenario();
    const res = Effects.compSlashesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [1],
    });
    eq(res.targetsDone, 1);
    const slash = score.staves[1].find((s) => s.tick === 480);
    eq(slash.el.notes[0].headGroup, "HEAD_SLASH");
    eq(slash.el.articulations.map((a) => a.symbol), ["acc"]);   // accent onto the slash
    eq(fermatasAt(score, 1, 480), ["fer"]);
    eq(fermatasAt(score, 1, 960), ["fer"]);                     // fermata over the rest
    // The unmarked beat-4 slash stays bare.
    const bare = score.staves[1].find((s) => s.tick === 1440);
    eq(bare.el.articulations.length, 0);
    eq(fermatasAt(score, 1, 1440), []);
});

// Both comp forms hand over the same `targets` rows, so compSlashesNotes takes the
// bare staff index the harness/older callers pass AND compCuesNotes's {staffIdx,…}.
test("compSlashesNotes: accepts a bare staff index and a {staffIdx} row alike", () => {
    const write = (targets) => {
        const score = scenario();
        const res = Effects.compSlashesNotes(makeCtx(score), {
            selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets,
        });
        eq(res.targetsDone, 1);
        return score.staves[1].filter((s) => s.el.type === Element.CHORD)
            .map((c) => [c.tick, c.el.notes[0].headGroup]);
    };
    const expected = [[480, "HEAD_SLASH"], [1440, "HEAD_SLASH"]];
    eq(write([1]), expected);
    eq(write([{ staffIdx: 1, isDrum: false }]), expected);
    eq(write([{ staffIdx: 1, isDrum: true }]), expected);   // isDrum is the slash writer's business
});

test("compCuesNotes: markings land on the tie HEAD slice, never the tail", () => {
    const score = new FakeScore();
    // A half note with an accent + fermata on beat 4, spilling into bar 2.
    score.staves[0] = [{
        tick: 1440, dur: 960, el: chordEl(960, [64], ["acc"]),
        annotations: [{ type: Element.FERMATA, symbol: "fer", track: 0 }],
    }];
    score.staves[1] = [
        { tick: 0, dur: WHOLE, el: restEl(WHOLE) },
        { tick: WHOLE, dur: WHOLE, el: restEl(WHOLE) },
    ];
    Effects.compCuesNotes(makeCtx(score), {
        selStart: 1440, selEnd: 2400, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(fermatasAt(score, 1, 1440), ["fer"]);
    eq(fermatasAt(score, 1, 1920), []);        // tail slice unmarked
});

test("markings from another staff's fermata are not copied", () => {
    const score = markedScenario();
    score.staves[0][2].annotations = [{ type: Element.FERMATA, symbol: "other", track: 8 }];  // staff 2
    Effects.compCuesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(fermatasAt(score, 1, 1440), []);
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

// --- splitRestTicks / gap fill (setDuration truncates what it can't spell) ----

test("splitRestTicks: a gap no single value spells becomes plain values, longest first", () => {
    eq(Effects.splitRestTicks(1200, DIV), { chunks: [960, 240], leftover: 0 });   // 5/8
    eq(Effects.splitRestTicks(480, DIV), { chunks: [480], leftover: 0 });
    eq(Effects.splitRestTicks(2400, DIV), { chunks: [1920, 480], leftover: 0 });  // 5/4 bar
    eq(Effects.splitRestTicks(0, DIV), { chunks: [], leftover: 0 });
});

test("splitRestTicks: reports what plain values can't cover", () => {
    eq(Effects.splitRestTicks(160, DIV).leftover > 0, true);   // a triplet eighth
});

test("compCuesNotes: a 5/8 lead-in is written as rests that END exactly at selStart", () => {
    const score = new FakeScore();
    score.staves[0] = [{ tick: 1200, dur: 240, el: chordEl(240, [60], []) }];
    score.staves[1] = [{ tick: 0, dur: WHOLE, el: restEl(WHOLE) }];
    Effects.compCuesNotes(makeCtx(score), {
        selStart: 1200, selEnd: 1440, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    const writes = score.ops.filter((o) => o.staff === 1);
    // Before the fix: one truncated half rest (960) and the note at 960, an eighth early.
    eq(writes.map((w) => [w.op, w.tick, w.dur]), [["rest", 0, 960], ["rest", 960, 240], ["chord", 1200, 240]]);
});

// --- tuplets ----------------------------------------------------------------
// A source tuplet group: members at their actual ticks, each reporting its NOMINAL
// duration (as MuseScore does) plus actualDuration and a shared tuplet whose first
// member's parent segment carries the start tick.
function tupletSegs(start, actual, normal, span, members) {
    const nominalOf = (m) => m.nominal;
    const tuplet = { actualNotes: actual, normalNotes: normal, duration: frac(span), elements: [], tuplet: null };
    const segs = [];
    let t = start;
    for (const m of members) {
        const nominal = nominalOf(m);
        const real = nominal * normal / actual;
        const el = m.pitches ? chordEl(nominal, m.pitches, m.accents || []) : restEl(nominal);
        el.tuplet = tuplet;
        el.actualDuration = { ticks: real };
        el.parent = { tick: t };
        tuplet.elements.push(el);
        segs.push({ tick: t, dur: real, el });
        t += real;
    }
    return segs;
}
// Source bar: quarter C, an eighth-triplet D E F on beat 2, a quarter G on beat 3.
function tripletScenario() {
    const score = new FakeScore();
    score.staves[0] = [
        { tick: 0, dur: 480, el: chordEl(480, [60], []) },
        ...tupletSegs(480, 3, 2, 480, [{ nominal: 240, pitches: [62], accents: ["acc"] }, { nominal: 240, pitches: [64] }, { nominal: 240, pitches: [65] }]),
        { tick: 960, dur: 480, el: chordEl(480, [67], []) },
    ];
    score.staves[1] = [{ tick: 0, dur: WHOLE, el: restEl(WHOLE) }];
    return score;
}
const cueTo1 = (score, selStart, selEnd, ctx) => Effects.compCuesNotes(ctx || makeCtx(score), {
    selStart, selEnd, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
});

test("compCuesNotes: a triplet is re-created, not flattened to straight eighths", () => {
    const score = tripletScenario();
    const res = cueTo1(score, 0, 1440);
    eq(res.error, "");
    const writes = score.ops.filter((o) => o.staff === 1 && o.op !== "accent");
    eq(writes.map((w) => [w.op, w.tick, w.dur]), [
        ["chord", 0, 480],
        ["tuplet", 480, 480],
        ["chord", 480, 160], ["chord", 640, 160], ["chord", 800, 160],
        ["chord", 960, 480],     // before the fix: 1200 — everything after the triplet drifted
    ]);
    eq(writes[1].ratio, [3, 2]);
    // Markings follow the actual ticks: the accent is on the first triplet note.
    eq(score.staves[1].find((s) => s.tick === 480).el.articulations.map((a) => a.symbol), ["acc"]);
});

test("compSlashesNotes: the triplet survives as slashes too", () => {
    const score = tripletScenario();
    Effects.compSlashesNotes(makeCtx(score), { selStart: 0, selEnd: 1440, measureTick: 0, srcStaffIdx: 0, targets: [1] });
    const chords = score.staves[1].filter((s) => s.el.type === Element.CHORD);
    eq(chords.map((c) => [c.tick, c.dur]), [[0, 480], [480, 160], [640, 160], [800, 160], [960, 480]]);
    eq(score.ops.filter((o) => o.op === "tuplet").length, 1);
});

test("compCuesNotes: a selection starting inside a tuplet copies the whole tuplet", () => {
    const score = tripletScenario();
    cueTo1(score, 640, 1440);   // starts on the 2nd triplet note
    const writes = score.ops.filter((o) => o.staff === 1 && o.op !== "accent");
    eq(writes.map((w) => [w.op, w.tick, w.dur]), [
        ["rest", 0, 480],       // lead-in only up to the tuplet's start
        ["tuplet", 480, 480],
        ["chord", 480, 160], ["chord", 640, 160], ["chord", 800, 160],
        ["chord", 960, 480],
    ]);
});

test("compCuesNotes: a selection ending inside a tuplet copies the whole tuplet", () => {
    const score = tripletScenario();
    cueTo1(score, 0, 640);      // ends after the 1st triplet note
    const chords = score.staves[1].filter((s) => s.el.type === Element.CHORD);
    eq(chords.map((c) => [c.tick, c.dur]), [[0, 480], [480, 160], [640, 160], [800, 160]]);
});

test("compCuesNotes: nested tuplets are refused before anything is written", () => {
    const score = tripletScenario();
    score.staves[0][1].el.tuplet.tuplet = { actualNotes: 3, normalNotes: 2 };
    const res = cueTo1(score, 0, 1440);
    ok(/Nested tuplets/.test(res.error));
    eq(score.ops.length, 0);
});

test("compCuesNotes: tuplets without ctx.fraction are refused before anything is written", () => {
    const score = tripletScenario();
    const ctx = makeCtx(score);
    delete ctx.fraction;
    const res = cueTo1(score, 0, 1440, ctx);
    ok(res.error);
    eq(score.ops.length, 0);
});

test("collapseTuplets: a tuplet group becomes one CR over its span, a note if any member is", () => {
    const tup = { start: 480, actual: 3, normal: 2, num: 1, den: 4, ticks: 480 };
    const cr = (tick, isRest, extra) => Object.assign({ tick, num: 1, den: 8, ticks: 160, isRest, tuplet: tup,
        pitches: isRest ? [] : [60], ties: [], accents: [], fermatas: [] }, extra);
    const plain = { tick: 0, num: 1, den: 4, ticks: 480, isRest: false, tuplet: null, pitches: [60], ties: [], accents: [], fermatas: [] };
    const out = Effects.collapseTuplets([plain, cr(480, true, { fermatas: ["fer"] }), cr(640, false), cr(800, true)]);
    eq(out.length, 2);
    eq(out[0], plain);
    eq([out[1].tick, out[1].num, out[1].den, out[1].ticks, out[1].isRest, out[1].tuplet], [480, 1, 4, 480, false, null]);
    eq(out[1].fermatas, ["fer"]);   // the head member's markings
});

// --- ties (planned here, made by cmd("tie") after the write — GUI-verified) ----

const crAt = (tick, ticks, pitches, ties) => ({ tick, num: 1, den: 4, ticks, isRest: !pitches, tuplet: null,
    pitches: pitches || [], ties: ties || [], accents: [], fermatas: [] });

test("planTies: a tie into the next same-pitch note is carried", () => {
    eq(Effects.planTies([crAt(0, 480, [62], [62]), crAt(480, 480, [62])], false),
       [{ tick: 0, nextTick: 480, pitch: 62 }]);
});

test("planTies: a chord ties only the pitches that continue", () => {
    eq(Effects.planTies([crAt(0, 480, [60, 64], [60, 64]), crAt(480, 480, [60, 65])], false),
       [{ tick: 0, nextTick: 480, pitch: 60 }]);
});

test("planTies: nothing to land on — tie out of the range, into a rest, or across a gap", () => {
    eq(Effects.planTies([crAt(0, 480, [62], [62])], false), []);                          // last CR
    eq(Effects.planTies([crAt(0, 480, [62], [62]), crAt(480, 480, null)], false), []);    // rest next
    eq(Effects.planTies([crAt(0, 480, [62], [62]), crAt(960, 480, [62])], false), []);    // not adjacent
});

test("planTies: one tie per CR for the single-note writers (slashes, drum cue)", () => {
    eq(Effects.planTies([crAt(0, 480, [60, 64], [60, 64]), crAt(480, 480, [60, 64])], true),
       [{ tick: 0, nextTick: 480, pitch: -1 }]);
});

// --- partial bars: nothing outside the selection is touched -------------------

const vcr = (tick, end, isRest, inTuplet) => ({ tick, end, isRest: !!isRest, inTuplet: !!inTuplet });

test("planLeadIn: a CR starting at selStart needs no lead-in", () => {
    eq(Effects.planLeadIn([vcr(0, 960), vcr(960, 1920, true)], 0, 960, DIV, true), { from: 960, mode: "at", error: "" });
});

test("planLeadIn: a covering rest is overwritten from ITS start, not the bar start", () => {
    // Beats 1-2 already comped; selection at beat 4 inside the half rest on 3-4.
    eq(Effects.planLeadIn([vcr(0, 480), vcr(480, 960), vcr(960, 1920, true)], 0, 1440, DIV, true),
       { from: 960, mode: "rests", error: "" });
});

test("planLeadIn: a covering chord is shortened (keeps its attack); without fraction() it falls back to rests", () => {
    eq(Effects.planLeadIn([vcr(0, 960)], 0, 480, DIV, true), { from: 0, mode: "shorten", keep: 480, error: "" });
    eq(Effects.planLeadIn([vcr(0, 960)], 0, 480, DIV, false), { from: 0, mode: "rests", error: "" });
    eq(Effects.planLeadIn([vcr(0, 1920)], 0, 720, DIV, true).keep, 720);     // a dotted quarter is one value
});

test("planLeadIn: a lead no single value spells keeps the longest that fits, then rests", () => {
    // 5/8: changeCRlen can't take it in one piece (it would overlap itself), so the
    // note becomes a half and an eighth rest follows. Before: the note was lost.
    eq(Effects.planLeadIn([vcr(0, 1920)], 0, 1200, DIV, true), { from: 0, mode: "shorten", keep: 960, error: "" });
});

test("longestValue: plain or dotted, never longer than the span or a whole note", () => {
    eq(Effects.longestValue(1200, DIV), 960);
    eq(Effects.longestValue(1440, DIV), 1440);   // dotted half
    eq(Effects.longestValue(2400, DIV), 1920);
    eq(Effects.longestValue(240, DIV), 240);
    eq(Effects.longestValue(360, DIV), 360);     // dotted eighth
});

test("planLeadIn: an empty voice (or a gap) is filled from the end of its last CR", () => {
    eq(Effects.planLeadIn([], 1920, 2400, DIV, true), { from: 1920, mode: "gap", error: "" });
    eq(Effects.planLeadIn([vcr(1920, 2400)], 1920, 2880, DIV, true), { from: 2400, mode: "gap", error: "" });
});

test("planLeadIn: a target tuplet across selStart is refused", () => {
    ok(/tuplet/.test(Effects.planLeadIn([vcr(0, 480), vcr(480, 640, false, true), vcr(640, 800, false, true)], 0, 560, DIV, true).error));
});

test("planTrail: pad to the next CR, to the end of a CR the copy cut into, else to the barline", () => {
    eq(Effects.planTrail([vcr(0, 960), vcr(960, 1920)], 960, 1920), { to: 960, error: "" });    // next CR starts there
    eq(Effects.planTrail([vcr(0, 480), vcr(480, 1440), vcr(1440, 1920)], 960, 1920), { to: 1440, error: "" });
    eq(Effects.planTrail([vcr(0, 480), vcr(1440, 1920)], 960, 1920), { to: 1440, error: "" }); // gap, then a CR
    eq(Effects.planTrail([], 960, 1920), { to: 1920, error: "" });
    ok(/tuplet/.test(Effects.planTrail([vcr(800, 960, false, true), vcr(960, 1120, false, true)], 1040, 1920).error));
});

test("compCuesNotes: beats already comped before selStart are kept (no rewrite from the bar start)", () => {
    const score = scenario();                 // source: beats 2-4
    score.staves[1] = [                       // target: an earlier cue on beat 1, rests after
        { tick: 0, dur: 480, el: Object.assign(chordEl(480, [55], []), { small: true }) },
        { tick: 480, dur: 1440, el: restEl(1440) },
    ];
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 960, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(res.error, "");
    const writes = score.ops.filter((o) => o.staff === 1 && (o.op === "rest" || o.op === "chord"));
    eq(writes[0], { op: "rest", staff: 1, tick: 480, dur: 480, pitches: [] });   // lead-in from the rest's start
    const head = score.staves[1].find((s) => s.tick === 0);
    eq([head.el.type, head.el.notes[0].pitch, head.dur], [Element.CHORD, 55, 480]);   // untouched
});

test("compCuesNotes: a target note spanning selStart is shortened, not overwritten", () => {
    const score = scenario();                 // source: beats 2-4
    score.staves[1] = [{ tick: 0, dur: 960, el: chordEl(960, [55], []) }, { tick: 960, dur: 960, el: restEl(960) }];
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 480, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(res.error, "");
    eq(score.ops.find((o) => o.staff === 1), { op: "shorten", staff: 1, tick: 0, dur: 480 });
    const head = score.staves[1].find((s) => s.tick === 0);
    eq([head.el.notes[0].pitch, head.dur], [55, 480]);
    eq(score.staves[1].find((s) => s.tick === 480).el.notes[0].pitch, 60);   // the cue starts on time
});

test("compCuesNotes: a target tuplet across selStart is refused before anything is written", () => {
    const score = scenario();
    score.staves[1] = [   // a target triplet over 1200..1680; the selection starts on beat 4 (1440)
        { tick: 0, dur: 1200, el: restEl(1200) },
        ...tupletSegs(1200, 3, 2, 480, [{ nominal: 240 }, { nominal: 240 }, { nominal: 240 }]),
        { tick: 1680, dur: 240, el: restEl(240) },
    ];
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 1440, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    ok(/tuplet/.test(res.error));
    eq(score.ops.length, 0);
});

// --- ties across the selection edge (joining an earlier run's comp) ----------

test("compCuesNotes: a source tie INTO selStart is planned from the previous note (an earlier run's cue)", () => {
    const score = new FakeScore();
    score.staves[0] = [   // C | D~ | D | E, quarters; the selection is beats 3-4
        { tick: 0, dur: 480, el: chordEl(480, [60], []) },
        { tick: 480, dur: 480, el: chordEl(480, [62], [], [62]) },
        { tick: 960, dur: 480, el: chordEl(480, [62], []) },
        { tick: 1440, dur: 480, el: chordEl(480, [64], [], [64]) },
        { tick: 1920, dur: 480, el: chordEl(480, [64], []) },
    ];
    score.staves[1] = [{ tick: 0, dur: WHOLE, el: restEl(WHOLE) }, { tick: WHOLE, dur: WHOLE, el: restEl(WHOLE) }];
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 960, selEnd: 1920, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(res.ties.map((t) => [t.tick, t.nextTick, t.pitch, t.mark]), [
        [480, 960, 62, "cue"],      // into the selection, from the note before it
        [1440, 1920, 64, "cue"],    // out of it, onto the note after it
    ]);
});

test("withEdges: adds the neighbours only where they exist", () => {
    const a = crAt(0, 480, [60]), b = crAt(480, 480, [62]), c = crAt(960, 480, [64]);
    eq(Effects.withEdges([b], { before: a, after: c }), [a, b, c]);
    eq(Effects.withEdges([b], { before: null, after: null }), [b]);
});

test("compCuesNotes: a 5/8 lead into a target whole note keeps it as a half, then an eighth rest", () => {
    const score = new FakeScore();
    score.staves[0] = [{ tick: 1200, dur: 240, el: chordEl(240, [60], []) }];
    score.staves[1] = [{ tick: 0, dur: WHOLE, el: chordEl(WHOLE, [55], []) }];
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: 1200, selEnd: 1440, measureTick: 0, srcStaffIdx: 0, targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(res.error, "");
    const shape = score.staves[1].map((x) => [x.tick, x.dur, x.el.type === Element.CHORD ? x.el.notes[0].pitch : "r"]);
    eq(shape, [[0, 960, 55], [960, 240, "r"], [1200, 240, 60], [1440, 480, "r"]]);
});

test("compCuesNotes: a selection running to the END of the score never rewinds past it", () => {
    // Regression: reading the source note after the selection rewound to selEnd =
    // lastSegment.tick + 1, which crashes MuseScore (the fake throws likewise).
    const score = new FakeScore();
    const last = 3 * WHOLE;   // the last bar
    score.staves[0] = [{ tick: last, dur: WHOLE, el: chordEl(WHOLE, [60], []) }];
    score.staves[1] = [{ tick: last, dur: WHOLE, el: restEl(WHOLE) }];
    const res = Effects.compCuesNotes(makeCtx(score), {
        selStart: last, selEnd: score.lastSegment.tick + 1, measureTick: last, srcStaffIdx: 0,
        targets: [{ staffIdx: 1, isDrum: false }],
    });
    eq(res.error, "");
    eq(score.staves[1].find((x) => x.tick === last).el.notes[0].pitch, 60);
});
