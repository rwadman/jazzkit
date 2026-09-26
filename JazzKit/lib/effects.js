// @ts-check
// Effect layer: the cursor/direct-API sequences that MUTATE the score, factored
// out of the .qml so both the shipping plugin AND test_harness.qml run the
// identical code path (test the real effect, not a copy). Unlike the pure libs
// (jazzkit/slashes/…) these touch the MuseScore API, so they are NOT
// Node-unit-testable against real MuseScore — they are exercised by
// test_harness.qml in the GUI (and by a fake cursor in test/effects.test.mjs). A
// stateless QML-imported lib can't see MuseScore globals, so everything an effect
// needs (curScore, the Element/Segment/Cursor/… enums, sibling libs) is passed in
// via `ctx`. Every effect is cmd()-free (direct API only), so it runs from a form.
//
//   import "lib/effects.js" as Effects   →   Effects.compCuesNotes(ctx, params)

/**
 * The MuseScore globals an effect needs, bundled by the .qml (a QML-imported JS
 * lib can't see them). Each effect uses a subset; unused members may be omitted.
 * @typedef {Object} EffectCtx
 * @property {MS.Score} curScore
 * @property {(type:number)=>*} newElement  QML newElement(Element.X) — required by
 *   every effect that builds elements (cues, drum cues, staccatos, line breaks);
 *   non-optional here so those calls type-check without a guard.
 * @property {JK.JazzKitLib} JazzKit    jazzkit.js  (countStaves)
 * @property {JK.SlashesLib} Slashes    slashes.js  (emptyRestRegions — pure, unit-tested)
 * @property {JK.ArticulationsLib} Articulations articulations.js (classifyChord — pure, unit-tested)
 * @property {JK.AccidentalsLib} Accidentals accidentals.js (planStaff — pure, unit-tested)
 * @property {JK.RestsLib} [Rests]   rests.js (restDurations/restRuns — pure, unit-tested)
 * @property {(el:any)=>void} [removeElement]  QML removeElement() (deletes a voice 2-4 rest)
 * @property {JK.QmlEnum} Segment    QML Segment enum
 * @property {JK.QmlEnum} Element    QML Element enum
 * @property {JK.QmlEnum} Cursor     QML Cursor enum
 * @property {number} [division]  ticks per quarter note (MuseScore global)
 * @property {(z:number, n:number)=>*} [fraction]  QML fraction(z, n) — needed only to
 *   re-create a tuplet (cursor.addTuplet takes Fraction wrappers)
 * @property {JK.QmlEnum} Direction    QML Direction enum (stem direction)
 * @property {JK.QmlEnum} NoteHeadGroup QML NoteHeadGroup enum (HEAD_SLASH, …)
 * @property {JK.QmlEnum} Beam         QML Beam enum (beam mode)
 * @property {MS.SymId} SymId          QML SymId enum
 * @property {JK.QmlEnum} [BarLineType]  QML BarLineType enum
 * @property {JK.QmlEnum} LayoutBreak  QML LayoutBreak enum
 * @property {JK.QmlEnum} Accidental   QML Accidental enum (NONE, FLAT, NATURAL, SHARP, …)
 * @property {(code:string)=>void} [cmd]  QML cmd() — used ONLY for the tie pass
 *   (cmd("tie"); the API can't build a tie itself — see applyTies)
 */

/**
 * The markings to reproduce at one source position: chord articulations and the
 * segment's fermatas, as SymId values (the read filters out any that came back
 * undefined, so the writers never have to re-check).
 * @typedef {{accents:MS.SymIdValue[], fermatas:MS.SymIdValue[]}} Marks
 */

/**
 * The (top-level) tuplet a source chord/rest belongs to, as plain data. Every
 * member carries the same info; the writers create the tuplet when they reach the
 * member at `start`.
 * @typedef {{start:number, actual:number, normal:number,
 *            num:number, den:number, ticks:number}} TupletInfo
 *   `actual`:`normal` is the ratio (3:2 for a triplet); `num/den` the tuplet's total
 *   span as a whole-note fraction and `ticks` the same span in ticks.
 */

/**
 * One source chord/rest read off the score, as plain data (see _readSource).
 * `ties` are the pitches whose note is tied FORWARD (to the next note).
 * `num/den` is the NOMINAL duration (an eighth inside a triplet is 1/8) — what
 * cursor.setDuration wants once the tuplet exists; `ticks` is the ACTUAL length on
 * the timeline (160 for that triplet eighth).
 * @typedef {{tick:number, num:number, den:number, ticks:number, isRest:boolean,
 *            tuplet:TupletInfo|null, pitches:number[], ties:number[], accents:MS.SymIdValue[],
 *            fermatas:MS.SymIdValue[]}} SourceCR
 */

/**
 * What _readSource hands the writers: the source CRs and the range they cover.
 * The range can be WIDER than the selection — a tuplet is copied whole or not at
 * all, so a selection that starts or ends inside one is widened to its bounds.
 * @typedef {{crs:SourceCR[], selStart:number, selEnd:number, error:string}} SourceRead
 */

/**
 * Marks looked up by source tick (see _markingsByTick). A SPARSE map — most target
 * ticks carry nothing — so the value is explicitly `|undefined`: that is what makes
 * the compiler demand the miss be handled at every lookup, which the shorthand
 * `Object<number, Marks>` would have quietly promised away.
 * @typedef {{[tick:number]: Marks|undefined}} MarksByTick
 */

// --- shared plumbing --------------------------------------------------------

/**
 * Set one property, tolerating a build that doesn't expose it. Which element
 * properties exist varies by MuseScore version, and a write to a missing one
 * throws — so every optional decoration goes through here.
 * @param {*} obj
 * @param {string} key
 * @param {*} value
 * @returns {void}
 */
function _trySet(obj, key, value) {
    try { obj[key] = value; } catch (e) { }
}

/**
 * A fresh cursor parked on (staffIdx, voice) at `tick`. The track MUST be set
 * before the rewind (api-gotchas) — rewinding first and assigning staffIdx after
 * leaves the cursor on the old track.
 * @param {EffectCtx} ctx  needs curScore
 * @param {number} staffIdx
 * @param {number} voice   0-indexed (UI voice 1 = 0)
 * @param {number} tick
 * @returns {MS.Cursor}
 */
function _cursorAt(ctx, staffIdx, voice, tick) {
    var cur = ctx.curScore.newCursor();
    cur.staffIdx = staffIdx;
    cur.voice = voice;
    cur.rewindToTick(tick);
    return cur;
}

/**
 * Read each measure's timesig + voice-1 rests as plain data across [selStart,selEnd),
 * then delegate the whole-beat/alignment math to the unit-tested Slashes lib. Finds
 * the first measure from selStart (does NOT depend on the live selection). Only
 * voice 1 is read; other voices (e.g. voice-3 comp cues) are ignored — and Slashes
 * coalesces the voice-1 rests those voices fragment, so emptiness is judged on
 * voice 1 alone.
 * @param {EffectCtx} ctx
 * @param {number} selStart
 * @param {number} selEnd    exclusive
 * @param {number} staffIdx
 * @returns {JK.Region[]}
 */
function _emptyRestRegions(ctx, selStart, selEnd, staffIdx) {
    var track = staffIdx * 4; // voice 1
    /** @type {JK.MeasureRests[]} */
    var measures = [];
    /** @type {MS.Segment|null} */
    var seg;

    var m = _measureAt(ctx, selStart);

    while (m && m.firstSegment && m.firstSegment.tick < selEnd) {
        var ts = m.timesigNominal;
        /** @type {JK.Rest[]} */
        var rests = [];
        for (seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
            if (seg.segmentType !== ctx.Segment.ChordRest) continue;
            var el = seg.elementAt(track);
            if (!el || el.type !== ctx.Element.REST) continue;
            // A rest inside a tuplet is not an empty BEAT: a beat slash written there
            // would land inside the tuplet. Leaving it out breaks the rest run, as a
            // note would.
            if (el.tuplet) continue;
            rests.push({ tick: seg.tick, durTicks: _actualTicks(el) });
        }
        measures.push({
            mStart: m.firstSegment.tick,
            numerator: ts.numerator,
            denominator: ts.denominator,
            measureTicks: ts.ticks,
            rests: rests
        });
        m = m.nextMeasure;
    }

    return ctx.Slashes.emptyRestRegions(measures, selStart, selEnd);
}

// --- To Comp Cues (direct-API, no clipboard) --------------------------------
// Write the source melody note-for-note into voice 1 of each pitched target,
// cue-sized, carrying only articulations (accent/staccato/tenuto/…) and the
// segment's fermatas — NOT the slurs,
// dynamics, text, etc. a clipboard paste drags along. Being pure cursor/API (no
// cmd()), this runs from a form, so the picker + apply live in one dialog.
//
// Reproduces per-segment durations, pitches (incl. chords), articulations,
// (single-level) tuplets and ties (after the write, via cmd("tie") — see applyTies).
// Nested tuplets are refused. A
// DRUM target has no pitch to cue, so compCuesNotes routes it to _writeDrumCueInto
// (the rhythm as cue notes in voice 3) instead; there a tuplet can't be reproduced
// and its span is left as a rest (collapseTuplets + the sizing note in
// _writeDrumCueInto).

/**
 * Symbols of the fermatas attached at `segment` in `track`. A fermata is NOT a
 * chord articulation — it lives in the SEGMENT's annotations (dom/fermata.cpp,
 * Segment::annotations), so it has to be read and written separately from
 * `chord.articulations`, and it can sit on a rest.
 * @param {EffectCtx} ctx  needs Element
 * @param {MS.Segment|null} segment
 * @param {number} track
 * @returns {MS.SymIdValue[]}
 */
function _readFermatas(ctx, segment, track) {
    /** @type {MS.SymIdValue[]} */
    var out = [];
    if (!segment) return out;
    var ann = segment.annotations || [];
    for (var i = 0; i < ann.length; ++i) {
        var a = ann[i];
        if (!a || a.type !== ctx.Element.FERMATA) continue;
        if (a.track !== undefined && a.track !== track) continue;   // other staff/voice
        if (a.symbol === undefined) continue;   // nothing to reproduce
        out.push(a.symbol);
    }
    return out;
}

/**
 * A chord/rest's length on the timeline, in ticks. `duration` is NOMINAL (a triplet
 * eighth reads 240); `actualDuration` applies the tuplet ratio (160).
 * @param {MS.Element} el @returns {number}
 */
function _actualTicks(el) {
    return el.actualDuration ? el.actualDuration.ticks : el.duration.ticks;
}

var NESTED_TUPLET_ERROR = "Nested tuplets can't be copied yet.";

/**
 * The tuplet `el` belongs to, as plain data, or null. Its start tick comes from its
 * first member's segment (Tuplet has no tick property before 4.6); `fallbackTick`
 * covers a build where that walk comes back empty.
 * @param {MS.Element|null} el
 * @param {number} fallbackTick
 * @returns {TupletInfo|null}
 */
function _tupletInfo(el, fallbackTick) {
    var tp = el ? el.tuplet : null;
    if (!tp) return null;
    var first = tp.elements && tp.elements.length ? tp.elements[0] : null;
    var start = (first && first.parent && first.parent.tick !== undefined) ? first.parent.tick : fallbackTick;
    return {
        start: start, actual: tp.actualNotes, normal: tp.normalNotes,
        num: tp.duration.numerator, den: tp.duration.denominator, ticks: tp.duration.ticks
    };
}

/**
 * Read the source voice-1 chord/rests across [selStart, selEnd) as plain data.
 * `accents` are the chord's articulations (staccato, tenuto, accent, …);
 * `fermatas` are the segment's, read for rests too. A tuplet cut by either end of
 * the selection is read whole (the range widens to its bounds — a tuplet can't
 * cross a barline, so it never leaves the measure). Nested tuplets are refused.
 * @param {EffectCtx} ctx  needs curScore, Cursor, Element
 * @param {number} selStart
 * @param {number} selEnd   exclusive
 * @param {number} srcStaffIdx
 * @returns {SourceRead}
 */
function _readSource(ctx, selStart, selEnd, srcStaffIdx) {
    var track = srcStaffIdx * 4;   // voice 1
    var start = selStart, end = selEnd;
    var cursor = _cursorAt(ctx, srcStaffIdx, 0, start);
    var head = cursor.segment ? _tupletInfo(cursor.element, cursor.tick) : null;
    if (head && head.start < start) {           // selection starts mid-tuplet
        start = head.start;
        cursor = _cursorAt(ctx, srcStaffIdx, 0, start);
    }

    /** @type {SourceCR[]} */
    var out = [];
    while (cursor.segment && cursor.tick < end) {
        var el = cursor.element;
        if (el && el.duration) {
            if (el.tuplet && el.tuplet.tuplet)
                return { crs: [], selStart: start, selEnd: end, error: NESTED_TUPLET_ERROR };
            var tup = _tupletInfo(el, cursor.tick);
            if (tup && tup.start + tup.ticks > end) end = tup.start + tup.ticks;   // ends mid-tuplet
            /** @type {SourceCR} */
            var item = {
                tick: cursor.tick,   // absolute start tick (for tick-aligned pass 2)
                num: el.duration.numerator, den: el.duration.denominator,
                ticks: _actualTicks(el), tuplet: tup,
                isRest: el.type === ctx.Element.REST, pitches: [], ties: [], accents: [],
                fermatas: _readFermatas(ctx, cursor.segment, track)
            };
            if (el.type === ctx.Element.CHORD) {
                var notes = el.notes || [];
                for (var i = 0; i < notes.length; ++i) {
                    item.pitches.push(notes[i].pitch);
                    if (notes[i].tieForward) item.ties.push(notes[i].pitch);
                }
                var arts = el.articulations || [];
                for (var j = 0; j < arts.length; ++j) {
                    var sym = arts[j].symbol;
                    if (sym !== undefined) item.accents.push(sym);   // nothing to reproduce
                }
            }
            out.push(item);
        }
        cursor.next();
    }
    return { crs: out, selStart: start, selEnd: end, error: "" };
}

/**
 * source tick -> the markings to reproduce there. A source note whose duration
 * crosses a barline is written as several TIED slices, so the writers walk by
 * TICK: the markings land on the slice that starts at the source tick (the head
 * of the tie group), never on the tail.
 * @param {SourceCR[]} src
 * @returns {MarksByTick}
 */
function _markingsByTick(src) {
    /** @type {MarksByTick} */
    var at = {};
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        var accents = cr.isRest ? [] : cr.accents;   // a rest can't take articulations
        var fermatas = cr.fermatas;
        if (accents.length || fermatas.length) at[cr.tick] = { accents: accents, fermatas: fermatas };
    }
    return at;
}

/**
 * Reproduce one source position's markings on a written chord/rest: articulations
 * onto the chord (`chord.add` == what Cursor::add does for ARTICULATION), fermatas
 * onto the segment at the cursor's track (`cursor.add`, the default branch).
 * A rest takes the fermatas only — articulations need a chord.
 * @param {EffectCtx} ctx  needs newElement, Element
 * @param {MS.Cursor} cursor
 * @param {MS.Element|null} chord  the written chord, or null on a rest
 * @param {Marks} [marks]
 * @returns {void}
 */
function _addMarkings(ctx, cursor, chord, marks) {
    if (!marks) return;                 // no markings at this tick (a sparse map)
    var accents = marks.accents;
    for (var a = 0; chord && a < accents.length; ++a) {
        var art = ctx.newElement(ctx.Element.ARTICULATION);
        art.symbol = accents[a];
        chord.add(art);
    }
    var fermatas = marks.fermatas;
    for (var f = 0; f < fermatas.length; ++f) {
        var fer = ctx.newElement(ctx.Element.FERMATA);
        fer.symbol = fermatas[f];
        cursor.add(fer);   // attaches to the segment at the cursor
    }
}

/** @param {number} a @param {number} b @returns {number} */
function _gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a || 1; }

/**
 * Convert a tick count to the {z, n} whole-note fraction cursor.setDuration wants
 * (division = ticks per quarter note, so a whole note = division*4). Pure — the
 * numeric core of the mid-measure split, unit-tested.
 * @param {number} ticks
 * @param {number} [division]  ticks per quarter note; defaults to 480
 * @returns {JK.Fraction}
 */
function ticksToFraction(ticks, division) {
    var whole = (division || 480) * 4;
    var g = _gcd(ticks, whole);
    return { z: ticks / g, n: whole / g };
}

/**
 * Split a span of `ticks` into plain (undotted) note values, longest first — the
 * rests that fill it. cursor.setDuration can't take an arbitrary length: it builds a
 * TDuration, which silently TRUNCATES one it can't spell (5/8 → a half), leaving
 * the cursor short and every later write early. Pure, unit-tested. `leftover` is
 * what no value down to a 128th could cover (non-zero only for a span that isn't a
 * sum of plain values, i.e. a caller bug or a tuplet remainder).
 * @param {number} ticks
 * @param {number} [division]  ticks per quarter note; defaults to 480
 * @returns {{chunks:number[], leftover:number}}
 */
function splitRestTicks(ticks, division) {
    var whole = (division || 480) * 4;
    /** @type {number[]} */
    var chunks = [];
    var left = ticks;
    for (var v = whole; left > 0 && v >= whole / 128 && v === Math.floor(v); v /= 2) {
        while (left >= v) { chunks.push(v); left -= v; }
    }
    return { chunks: chunks, leftover: left };
}

/**
 * Write rests covering `ticks` from the cursor (see splitRestTicks; a leftover
 * is refused up front by _readCheckedSource, never written).
 * @param {EffectCtx} ctx  needs division
 * @param {MS.Cursor} cur
 * @param {number} ticks
 * @returns {void}
 */
function _addRestTicks(ctx, cur, ticks) {
    var chunks = splitRestTicks(ticks, ctx.division).chunks;
    for (var i = 0; i < chunks.length; ++i) {
        var f = ticksToFraction(chunks[i], ctx.division);
        cur.setDuration(f.z, f.n);
        cur.addRest();
    }
}

var ALIGN_ERROR = "Couldn't line the copy up with the source (unsupported rhythm before the selection).";
var FRACTION_ERROR = "Copying tuplets needs MuseScore's fraction() — not available here.";

/**
 * Read the source and refuse, BEFORE anything is written, whatever the writers
 * could only get half right: an empty selection, a nested tuplet, a lead-in gap
 * that plain rests can't fill, or tuplets without ctx.fraction. Checked up front
 * so a failure never leaves one target written and the next not.
 * @param {EffectCtx} ctx
 * @param {JK.CompRegion} params
 * @returns {SourceRead}
 */
function _readCheckedSource(ctx, params) {
    var read = _readSource(ctx, params.selStart, params.selEnd, params.srcStaffIdx);
    if (read.error) return read;
    if (read.crs.length === 0) { read.error = "Nothing to copy in the selection."; return read; }
    if (splitRestTicks(read.selStart - params.measureTick, ctx.division).leftover !== 0) {
        read.error = ALIGN_ERROR; return read;
    }
    for (var i = 0; i < read.crs.length; ++i)
        if (read.crs[i].tuplet && !ctx.fraction) { read.error = FRACTION_ERROR; return read; }
    return read;
}

/**
 * Pass 1, shared by every writer: fill the gap from the cursor up to selStart, then
 * write one chord/rest per source CR via `writeCR(cursor, cr)` (the cursor's input
 * duration is already set). A source tuplet is re-created (cursor.addTuplet) when
 * its first member comes up, so the members' NOMINAL durations then fill it exactly.
 * The source must have passed _readCheckedSource.
 *
 * The cursor must be parked at the MEASURE start, not at selStart: we CANNOT
 * rewindToTick(selStart) on an empty target — rewindToTick skips forward past any
 * segment with no element in this track (api-gotchas), and a full-measure rest has
 * its only segment at the MEASURE START, so a score-wide segment at selStart
 * (created by the source staff) has no target element and the cursor skips forward
 * into the NEXT measure. The leading rest both positions us and splits the spanning
 * rest at selStart (the "divide existing notes" step).
 * @param {EffectCtx} ctx  needs division
 * @param {MS.Cursor} cur
 * @param {number} selStart
 * @param {SourceCR[]} src
 * @param {(cursor:MS.Cursor, cr:SourceCR)=>void} writeCR
 * @returns {void}
 */
function _writeSource(ctx, cur, selStart, src, writeCR) {
    if (cur.tick < selStart) _addRestTicks(ctx, cur, selStart - cur.tick);
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        var tup = cr.tuplet;
        if (tup && cr.tick === tup.start && ctx.fraction)
            cur.addTuplet(ctx.fraction(tup.actual, tup.normal), ctx.fraction(tup.num, tup.den));
        cur.setDuration(cr.num, cr.den);
        writeCR(cur, cr);
    }
}

/**
 * The drum cue can't place a chord INSIDE a tuplet (its cursor.add route builds a
 * chord with no tuplet link — see _writeDrumCueInto), so each source tuplet becomes
 * ONE CR spanning the whole group: a note if any member is one, carrying the head
 * member's markings. The bar stays aligned; the tuplet's inner rhythm is lost. (In
 * practice the writer then leaves that span a rest: the source's own tuplet
 * segments sit inside it, and a cue chord can't be sized across them.) Pure.
 * @param {SourceCR[]} src
 * @returns {SourceCR[]}
 */
function collapseTuplets(src) {
    /** @type {SourceCR[]} */
    var out = [];
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        var tup = cr.tuplet;
        if (!tup) { out.push(cr); continue; }
        if (cr.tick !== tup.start) {           // a later member: fold it into the group
            var group = out[out.length - 1];
            if (group && !cr.isRest && group.isRest) { group.isRest = false; group.pitches = cr.pitches.slice(); }
            if (group) group.ties = cr.ties.slice();   // a tie LEAVING the group starts at its last member
            continue;
        }
        out.push({
            tick: tup.start, num: tup.num, den: tup.den, ticks: tup.ticks, tuplet: null,
            isRest: cr.isRest, pitches: cr.pitches.slice(), ties: cr.ties.slice(),
            accents: cr.accents.slice(), fermatas: cr.fermatas.slice()
        });
    }
    return out;
}

/**
 * Pass 2, shared by every writer: walk what pass 1 wrote and decorate it, then
 * reproduce the source markings there.
 *
 * The walk is by TICK, not by index: a source note whose duration crosses a barline
 * was written as several TIED slices, so there can be more target chords than source
 * CRs. `atCR(cursor, element)` decorates the written CR and returns the chord the
 * markings belong on (null for a rest), so the markings land on the slice that
 * starts at the source tick — the head of the tie group, never the tail.
 * @param {EffectCtx} ctx  needs newElement, Element
 * @param {MS.Cursor} cur
 * @param {number} selStart
 * @param {number} selEnd   exclusive
 * @param {MarksByTick} markAt
 * @param {(cursor:MS.Cursor, element:MS.Element|null)=>MS.Element|null} atCR  the chord the
 *   markings belong on, or null for a rest
 * @returns {void}
 */
function _decorateWritten(ctx, cur, selStart, selEnd, markAt, atCR) {
    while (cur.segment && cur.tick < selEnd) {
        var chord = atCR(cur, cur.element);
        if (cur.tick >= selStart) _addMarkings(ctx, cur, chord, markAt[cur.tick]);
        cur.next();
    }
}

// --- ties ------------------------------------------------------------------
// The API can't build a tie: a Tie element needs its end note, which nothing
// exposes (note.add(tie) crashes in undoAddElement). So the writers only PLAN
// ties (returned as CompResult.ties) and applyTies makes them with ONE cmd("tie") —
// MuseScore's own "Add tie", which ties each selected note to the next note of the
// same pitch. cmd("tie") is refused while a plugin window is open, so the CALLER
// closes its form first (quit()) and then calls applyTies; the form's JS keeps
// running after quit() (verified in the GUI; see api-gotchas).
// cmd("tie") must not see a note it can't tie: a selected note that is already tied is
// UN-tied, and one with no next same-pitch note may be tied to some later
// selected note (or grow a new one) — so applyTies selects only notes whose
// next written note provably continues the tie.

/**
 * Which source ties a copy can carry: a tied note whose NEXT source CR starts
 * right where it ends and holds the same pitch (a tie out of the copied range,
 * or into a rest, has nothing to land on). Returns one entry per tie; with
 * `onePerCR` (the slash / drum writers, which write a single note per chord)
 * at most one per CR, pitch -1. Pure.
 * @param {SourceCR[]} src
 * @param {boolean} onePerCR
 * @returns {{tick:number, nextTick:number, pitch:number}[]}
 */
function planTies(src, onePerCR) {
    /** @type {{tick:number, nextTick:number, pitch:number}[]} */
    var out = [];
    for (var i = 0; i + 1 < src.length; ++i) {
        var cr = src[i], nx = src[i + 1];
        if (cr.isRest || nx.isRest || nx.tick !== cr.tick + cr.ticks) continue;
        for (var k = 0; k < cr.ties.length; ++k) {
            if (nx.pitches.indexOf(cr.ties[k]) === -1) continue;
            out.push({ tick: cr.tick, nextTick: nx.tick, pitch: onePerCR ? -1 : cr.ties[k] });
            if (onePerCR) break;
        }
    }
    return out;
}

/**
 * The planned ties for one target staff.
 * @param {SourceCR[]} src @param {number} staffIdx @param {number} voice
 * @param {number} pitch  the written pitch, or -1 to keep the source pitch
 * @returns {JK.TiePlan[]}
 */
function _tiePlans(src, staffIdx, voice, pitch) {
    var ts = planTies(src, pitch !== -1);
    /** @type {JK.TiePlan[]} */
    var out = [];
    for (var i = 0; i < ts.length; ++i)
        out.push({ staffIdx: staffIdx, voice: voice, tick: ts[i].tick, nextTick: ts[i].nextTick,
                   pitch: pitch !== -1 ? pitch : ts[i].pitch });
    return out;
}

/**
 * The ChordRest segment at exactly `tick`, or null.
 * @param {EffectCtx} ctx  needs curScore, Segment @param {number} tick @returns {MS.Segment|null}
 */
function _segmentAt(ctx, tick) {
    var m = _measureAt(ctx, tick);
    for (var s = m ? m.firstSegment : null; s; s = s.nextInMeasure)
        if (s.tick === tick && s.segmentType === ctx.Segment.ChordRest) return s;
    return null;
}

/**
 * The note of `pitch` in the chord at (tick, track), or null.
 * @param {EffectCtx} ctx @param {number} tick @param {number} track @param {number} pitch
 * @returns {MS.Note|null}
 */
function _noteAt(ctx, tick, track, pitch) {
    var seg = _segmentAt(ctx, tick);
    var el = seg ? seg.elementAt(track) : null;
    if (!el || el.type !== ctx.Element.CHORD) return null;
    var notes = el.notes || [];
    for (var i = 0; i < notes.length; ++i) if (notes[i].pitch === pitch) return notes[i];
    return null;
}

/**
 * The start note of a planned tie, or null when the tie can't be made safely
 * (missing, already tied, or no same-pitch note at nextTick in the same voice).
 * @param {EffectCtx} ctx @param {JK.TiePlan} plan @returns {MS.Note|null}
 */
function _tieStartNote(ctx, plan) {
    for (var v = 0; v < 4; ++v) {
        if (plan.voice >= 0 && v !== plan.voice) continue;
        var track = plan.staffIdx * 4 + v;
        var n = _noteAt(ctx, plan.tick, track, plan.pitch);
        if (!n || n.tieForward) continue;
        if (_noteAt(ctx, plan.nextTick, track, plan.pitch)) return n;
    }
    return null;
}

/**
 * Tie every planned note in ONE cmd("tie") (one undo step), then put the user's
 * source selection back. Call it AFTER the effect (selection changes are refused
 * while a command is open) and after closing the calling form (cmd("tie") is
 * refused while a plugin window is open). A no-op without ctx.cmd (the Node tests).
 * @param {EffectCtx} ctx
 * @param {JK.TiePlan[]} plans
 * @param {JK.CompRegion} params  the source range, to restore the selection
 * @returns {void}
 */
function applyTies(ctx, plans, params) {
    if (!ctx.cmd || plans.length === 0) return;
    /** @type {MS.Note[]} */
    var notes = [];
    for (var i = 0; i < plans.length; ++i) {
        var n = _tieStartNote(ctx, plans[i]);
        if (n) notes.push(n);
    }
    if (notes.length === 0) return;
    var sel = ctx.curScore.selection;
    sel.clear();
    for (var j = 0; j < notes.length; ++j) sel.select(notes[j], j > 0);
    ctx.cmd("tie");
    sel.selectRange(params.selStart, Math.min(params.selEnd, ctx.curScore.lastSegment.tick),
                    params.srcStaffIdx, params.srcStaffIdx + 1);
}

/**
 * Write the read source into voice 1 of one target staff: pitches/durations
 * first, then a second pass to cue-size the chords and copy their articulations.
 * @param {EffectCtx} ctx  needs curScore, newElement, Element, division
 * @param {number} staffIdx
 * @param {number} measureTick  start of the measure containing selStart
 * @param {number} selStart
 * @param {number} selEnd       exclusive
 * @param {SourceCR[]} src
 * @returns {JK.TiePlan[]}  the ties to add once the command is closed
 */
function _writeCueInto(ctx, staffIdx, measureTick, selStart, selEnd, src) {
    _writeSource(ctx, _cursorAt(ctx, staffIdx, 0, measureTick), selStart, src, function (cur, cr) {
        if (cr.isRest || cr.pitches.length === 0) {
            cur.addRest();
        } else {
            cur.addNote(cr.pitches[0], false);
            for (var k = 1; k < cr.pitches.length; ++k) cur.addNote(cr.pitches[k], true);
        }
    });

    _decorateWritten(ctx, _cursorAt(ctx, staffIdx, 0, selStart), selStart, selEnd,
        _markingsByTick(src), function (_cur, el) {
            if (!el || el.type !== ctx.Element.CHORD) return null;
            _trySet(el, "small", true);      // every cue slice is cue-sized
            return el;
        });
    return _tiePlans(src, staffIdx, 0, -1);
}

/**
 * To Comp Cues (direct API). `targets` is an array of { staffIdx, isDrum }.
 * Pitched parts get a note-for-note cue; drum parts have no pitch to cue, so they
 * get the source rhythm as cue notes in voice 3 (_writeDrumCueInto).
 * @param {EffectCtx} ctx  needs curScore, newElement, Element, Segment, Cursor, Direction, NoteHeadGroup, division, fraction
 * @param {JK.CompParams} params
 * @returns {JK.CompResult}
 */
function compCuesNotes(ctx, params) {
    var read = _readCheckedSource(ctx, params);
    if (read.error) return { targetsDone: 0, error: read.error };
    var src = read.crs;

    ctx.curScore.startCmd();
    var done = 0;
    /** @type {JK.TiePlan[]} */
    var ties = [];
    for (var t = 0; t < params.targets.length; ++t) {
        var tgt = params.targets[t];
        ties = ties.concat(tgt.isDrum
            ? _writeDrumCueInto(ctx, tgt.staffIdx, params.measureTick, read.selStart, read.selEnd, src)
            : _writeCueInto(ctx, tgt.staffIdx, params.measureTick, read.selStart, read.selEnd, src));
        ++done;
    }
    ctx.curScore.endCmd();
    return { targetsDone: done, error: "", ties: ties };
}

// --- To Comp Slashes (direct-API slash notation, no cmd) --------------------
// Replicates MuseScore's Chord::setSlash(flag=true, stemless) via the exposed
// note/chord properties, so it runs from a form. Middle-line note per beat with a
// slash notehead; playback off. `line` is the staff's middle line (4 for a 5-line
// staff). Pitch is irrelevant (fixed to the line + play off), so we write a
// constant one.
var SLASH_PITCH = 71;    // B4 — arbitrary; FIXED_LINE + PLAY=false hide its effect

/**
 * The part whose staves include staffIdx, or null.
 * @param {EffectCtx} ctx @param {number} staffIdx @returns {MS.Part|null}
 */
function _partForStaff(ctx, staffIdx) {
    var parts = ctx.curScore.parts;
    for (var i = 0; i < parts.length; ++i) {
        var p = parts[i];
        if (staffIdx >= Math.floor(p.startTrack / 4) && staffIdx < Math.floor(p.endTrack / 4)) return p;
    }
    return null;
}

/**
 * The drumset of the staff's instrument, or null on a pitched staff.
 * @param {EffectCtx} ctx @param {number} staffIdx @returns {MS.Drumset|null}
 */
function _drumsetFor(ctx, staffIdx) {
    var part = _partForStaff(ctx, staffIdx);
    var inst = part && part.instrumentAtTick ? part.instrumentAtTick(0) : null;
    return inst ? inst.drumset : null;
}

/**
 * The pitch to write into staffIdx. A pitched staff takes any pitch (SLASH_PITCH,
 * hidden by FIXED_LINE + play off). A DRUM staff drops invalid drum pitches
 * silently and forces the voice by pitch (api-gotchas), so we must pick a VALID
 * drum pitch — preferring one whose drumset voice is `wantVoice` so the note stays
 * in the voice we're writing. Returns -1 if a drum staff has no usable pitch.
 * @param {EffectCtx} ctx
 * @param {number} staffIdx
 * @param {number} wantVoice  0-indexed
 * @returns {number}  a MIDI pitch, or -1
 */
function _slashPitch(ctx, staffIdx, wantVoice) {
    var ds = _drumsetFor(ctx, staffIdx);
    if (!ds) return SLASH_PITCH;   // pitched staff
    var first = -1;
    for (var p = 0; p < 128; ++p) {
        if (!ds.isValid(p)) continue;
        if (first < 0) first = p;
        if (ds.voice(p) === wantVoice) return p;
    }
    return first;   // no voice-match; any valid drum pitch (may land in another voice)
}

/**
 * Apply slash notation to one written chord. Voice-1 case: stem down, notehead on
 * the middle line. stemless=false keeps the stem (rhythmic slashes); true drops it
 * (beat slashes).
 * @param {EffectCtx} ctx  needs Direction, NoteHeadGroup, Beam
 * @param {MS.Element} chord
 * @param {boolean} stemless
 * @param {number} line   staff line for the notehead (4 = middle of a 5-line staff)
 * @returns {void}
 */
function _applySlashChord(ctx, chord, stemless, line) {
    _trySet(chord, "stemDirection", ctx.Direction.DOWN);
    if (stemless) {
        _trySet(chord, "noStem", true);
        _trySet(chord, "beamMode", ctx.Beam.NONE);
    }
    var notes = chord.notes || [];
    for (var i = 0; i < notes.length; ++i) {
        var n = notes[i];
        _trySet(n, "headGroup", ctx.NoteHeadGroup.HEAD_SLASH);
        _trySet(n, "fixed", true);
        _trySet(n, "fixedLine", line);
        _trySet(n, "play", false);
        if (i > 0) _trySet(n, "visible", false);   // hide all but first notehead
    }
}

/**
 * Write the source rhythm as rhythmic slashes into voice 1 of one target staff.
 * Same positioning as _writeCueInto (rewind to measure start, fill to selStart);
 * chords → a single slash note, rests stay rests; then slash every written chord.
 * @param {EffectCtx} ctx  needs curScore, Element, Direction, NoteHeadGroup
 * @param {number} staffIdx
 * @param {number} measureTick
 * @param {number} selStart
 * @param {number} selEnd   exclusive
 * @param {SourceCR[]} src
 * @returns {JK.TiePlan[]}  the ties to add once the command is closed
 */
function _writeSlashRhythmInto(ctx, staffIdx, measureTick, selStart, selEnd, src) {
    var pitch = _slashPitch(ctx, staffIdx, 0);   // valid drum pitch on a drum staff
    _writeSource(ctx, _cursorAt(ctx, staffIdx, 0, measureTick), selStart, src, function (cur, cr) {
        if (cr.isRest) cur.addRest();
        else cur.addNote(pitch, false);
    });

    // Pass 2 — slash-ify, and carry the source's markings (staccato, tenuto,
    // fermata, …) onto the matching slash / rest.
    _decorateWritten(ctx, _cursorAt(ctx, staffIdx, 0, selStart), selStart, selEnd,
        _markingsByTick(src), function (_cur, el) {
            if (!el || el.type !== ctx.Element.CHORD) return null;
            _applySlashChord(ctx, el, false, 4);
            return el;
        });
    // A drum staff forces the voice by pitch, so the slash may sit in any voice.
    return pitch < 0 ? [] : _tiePlans(src, staffIdx, -1, pitch);
}

// --- Drum comp cue (direct-API cue notes in voice 3, above the staff) --------
// The cue is the source RHYTHM shown in the drum staff's UPPER comping voice
// (UI voice 3), dressed as a cue: cue-size, no playback, stems up, a normal
// notehead fixed just above the staff. A drum staff can't take the melody pitches
// (dropped) or reach voice 3 via note INPUT (`cursor.addNote` → `NoteInput::addPitch`
// forces the voice by pitch and no default-kit pitch maps to voice 3). But
// `cursor.add(chord)` places a plugin-built ChordRest at `cursor.track` WITHOUT
// note-input — no voice-forcing — so we reach voice 3 directly (verified in the
// harness). The only catch: a fresh Chord has DurationType::V_INVALID and the sole
// duration setter (`chord.duration` → `changeCRlen`) needs the chord already placed.
// So we (1) lay a REST SHELL in voice 3 via `cursor.addRest` (goes through
// `enterRest`, no forcing; advances + segments the voice), then (2) walk the shell
// and REPLACE note-beat rests with chords via `cursor.add`, fixing each chord's
// duration to the rest it replaced. All inside the caller's startCmd/endCmd so
// layout is deferred until the durations are valid.

// Fixed staff line for the cue. Line 0 = top line, -1 = the space just above it,
// -2 = the first LEDGER line above. MuseScore draws ledger lines for any note above
// line -1 (ChordLayout::updateLedgerLines) regardless of notehead, so -2 would strike
// a ledger line through the slash. -1 is the highest ledger-free position above the staff.
var DRUM_CUE_LINE = -1;

/** Any VALID drum pitch to carry the cue (voice is set explicitly, so it doesn't
 *  matter which). The note is invisible as a pitch (fixed above the staff, slash
 *  notehead, silent). Returns -1 if the drumset has no valid pitch, or null on a
 *  pitched staff (no drumset → caller falls back to the slash writer).
 *  @param {EffectCtx} ctx @param {number} staffIdx @returns {number|null} */
function _drumCuePitch(ctx, staffIdx) {
    var ds = _drumsetFor(ctx, staffIdx);
    if (!ds) return null;                       // pitched staff
    for (var p = 0; p < 128; ++p) if (ds.isValid(p)) return p;
    return -1;                                  // drumset with no valid pitch (unexpected)
}

/** Dress a written chord as a drum cue note (cue-size, silent, stem up, above staff,
 *  NORMAL notehead).
 *  @param {EffectCtx} ctx @param {MS.Element} chord @returns {void} */
function _applyDrumCueChord(ctx, chord) {
    _trySet(chord, "small", true);
    _trySet(chord, "stemDirection", ctx.Direction.UP);
    var notes = chord.notes || [];
    for (var i = 0; i < notes.length; ++i) {
        var n = notes[i];
        _trySet(n, "headGroup", ctx.NoteHeadGroup.HEAD_NORMAL);
        _trySet(n, "fixed", true);
        _trySet(n, "fixedLine", DRUM_CUE_LINE);
        _trySet(n, "play", false);
    }
}

var DRUM_CUE_VOICE = 2;   // 0-indexed → UI voice 3 (the upper comping voice)

/**
 * Write the source rhythm as a drum comp cue into UI voice 3 of one drum staff.
 * Rest-shell + cursor.add (see the block comment above). Must run inside the
 * caller's startCmd/endCmd (compCuesNotes wraps it) — the transient invalid-duration
 * chords are only valid once `chord.duration` is set, before layout at endCmd.
 * @param {EffectCtx} ctx  needs curScore, newElement, Element, Direction, NoteHeadGroup, division
 * @param {number} staffIdx
 * @param {number} measureTick
 * @param {number} selStart
 * @param {number} selEnd   exclusive
 * @param {SourceCR[]} src
 * @returns {JK.TiePlan[]}  the ties to add once the command is closed
 */
function _writeDrumCueInto(ctx, staffIdx, measureTick, selStart, selEnd, src) {
    var pitch = _drumCuePitch(ctx, staffIdx);
    if (pitch === null) return _writeSlashRhythmInto(ctx, staffIdx, measureTick, selStart, selEnd, src);
    if (pitch < 0) return [];                   // drumset but no valid pitch
    var V = DRUM_CUE_VOICE;

    // Pass 1: rest shell that TILES THE WHOLE MEASURE in voice V — leading gap up to
    // selStart, the source rhythm, then a trailing rest to the measure end. Voice V
    // (unlike voice 1) is NOT auto-filled, so a partial shell leaves a GAP; that gap
    // is what a later `cursor.add`/`changeCRlen` reflows into, corrupting the bar
    // (two eighths at the bar start dropped the 2nd note; three quarters split the
    // middle into a gap+eighth). A complete tiling means every replacement is an
    // exact in-place swap. addRest goes through enterRest — no voice-forcing.
    // The trailing rest pads the measure the source ENDS in (not the one it starts
    // in — a multi-bar selection would otherwise leave its last bar gapped).
    // Tuplets are collapsed first: a chord can't be placed inside one (collapseTuplets).
    src = collapseTuplets(src);
    var last = src[src.length - 1];
    var writtenEnd = last.tick + last.ticks;
    var mEnd = _measureEndTick(ctx, writtenEnd - 1);
    var cur = _cursorAt(ctx, staffIdx, 0, measureTick);   // voice 0 always has content
    cur.voice = V;                      // switch (keeps the segment; api-gotchas empty-voice trick)
    /** @type {{[tick:number]: boolean|undefined}} */
    var noteTicks = {};                 // set at each note position; absent elsewhere
    _writeSource(ctx, cur, selStart, src, function (c, cr) {
        if (!cr.isRest) noteTicks[c.tick] = true;
        // A collapsed tuplet can span a length no single value spells (5/16); then
        // the shell is several rests and the cue note takes the first.
        if (_isSpellable(cr.num, cr.den)) c.addRest();
        else _addRestTicks(ctx, c, cr.ticks);
    });
    if (writtenEnd < mEnd) _addRestTicks(ctx, cur, mEnd - writtenEnd);

    // Pass 2: replace each note-beat rest with a cue chord. Rewind on voice 0 (has a
    // boundary at measureTick) then switch to voice V and walk the shell. Since the
    // shell fully tiles the measure, each note-beat swap is exact — no reflow shifts
    // the segments the cursor still has to visit.
    var wc = _cursorAt(ctx, staffIdx, 0, measureTick);
    wc.voice = V;
    // The markings go on the chord built here (a plugin-owned chord is already in the
    // score after wc.add, so chord.add undo-adds normally); fermatas go via the
    // cursor, onto the segment — hence the `selStart` guard on the leading shell rest.
    //
    // Sizing the chord: a fresh chord is ZERO ticks long, so `chord.duration = D` is
    // a "lengthen" (Score::changeCRlen → makeGap). makeGap counts the chord's own
    // span only from the first score segment AFTER the chord's tick — when another
    // staff has a segment inside the span (a drum groove's eighths, a source triplet)
    // the stretch from the chord to that segment goes uncounted, so makeGap keeps
    // going and eats the NEXT cue slot (verified in the harness). Sizing it first to
    // exactly that stretch (`lead`) and then to D makes every stretch count. `lead`
    // must be one note value; when it isn't (a tuplet on another staff), the slot is
    // left a rest — a missing cue note beats a corrupt bar.
    _decorateWritten(ctx, wc, selStart, selEnd, _markingsByTick(src), function (c, el) {
        if (!noteTicks[c.tick] || !el || el.type !== ctx.Element.REST || !c.segment) return null;
        var restDur = el.duration;                  // capture before replacing
        var lead = _firstInnerSegTick(ctx, c.segment, c.tick + restDur.ticks) - c.tick;
        var leadF = ticksToFraction(lead, ctx.division);
        var twoStep = lead < restDur.ticks;
        if (twoStep && (!ctx.fraction || !_isSpellable(leadF.z, leadF.n))) return null;
        var chord = ctx.newElement(ctx.Element.CHORD);
        var note = ctx.newElement(ctx.Element.NOTE);
        note.pitch = pitch;
        chord.add(note);
        c.add(chord);                               // replaces the rest at c.track (voice V)
        if (twoStep && ctx.fraction) _trySet(chord, "duration", ctx.fraction(leadF.z, leadF.n));
        _trySet(chord, "duration", restDur);        // fix invalid duration
        _applyDrumCueChord(ctx, chord);
        return chord;
    });
    return _tiePlans(src, staffIdx, V, pitch);
}

/**
 * Tick of the first ChordRest segment strictly after `seg` and before `end` (any
 * staff), or `end` when there is none.
 * @param {EffectCtx} ctx  needs Segment
 * @param {MS.Segment} seg
 * @param {number} end
 * @returns {number}
 */
function _firstInnerSegTick(ctx, seg, end) {
    for (var s = seg.nextInMeasure; s && s.tick < end; s = s.nextInMeasure)
        if (s.segmentType === ctx.Segment.ChordRest) return s.tick;
    return end;
}

/**
 * The first tick after the measure that contains `tick` (its exclusive end).
 * @param {EffectCtx} ctx @param {number} tick @returns {number}
 */
function _measureEndTick(ctx, tick) {
    var m = _measureAt(ctx, tick);
    if (!m) return tick;
    return _measureStartOrEnd(ctx, m.nextMeasure);
}

/**
 * A measure's start tick, or — for a missing next measure — the score's end: the
 * tick of its last segment (the final barline). Not `+ 1`: that is the exclusive
 * bound a SELECTION uses, but as a measure end it is one tick past the bar, and a
 * pad written up to it is a tick too long. Shared by the two "where does this
 * measure end" walks.
 * @param {EffectCtx} ctx @param {MS.Measure|null} m @returns {number}
 */
function _measureStartOrEnd(ctx, m) {
    return (m && m.firstSegment) ? m.firstSegment.tick : ctx.curScore.lastSegment.tick;
}

/**
 * Whether num/den is ONE note value (plain or up to triple-dotted) — what
 * cursor.setDuration can take without truncating. Pure.
 * @param {number} num @param {number} den @returns {boolean}
 */
function _isSpellable(num, den) {
    var g = _gcd(num, den);
    var n = num / g, d = den / g;
    if ((d & (d - 1)) !== 0) return false;          // denominator must be a power of two
    return n === 1 || n === 3 || n === 7 || n === 15;
}

/**
 * To Comp Slashes (direct API). `targets` rows are either a bare staff index or the
 * `{staffIdx, isDrum}` object compCuesNotes takes (`isDrum` is irrelevant here — the
 * slash writer already picks a valid drum pitch), so both forms share one row shape.
 * @param {EffectCtx} ctx  needs curScore, Element, Cursor, Direction, NoteHeadGroup, division
 * @param {JK.SlashParams} params
 * @returns {JK.CompResult}
 */
function compSlashesNotes(ctx, params) {
    var read = _readCheckedSource(ctx, params);
    if (read.error) return { targetsDone: 0, error: read.error };

    ctx.curScore.startCmd();
    var done = 0;
    /** @type {JK.TiePlan[]} */
    var ties = [];
    for (var t = 0; t < params.targets.length; ++t) {
        var tgt = params.targets[t];
        var s = (typeof tgt === "number") ? tgt : tgt.staffIdx;
        ties = ties.concat(_writeSlashRhythmInto(ctx, s, params.measureTick, read.selStart, read.selEnd, read.crs));
        ++done;
    }
    ctx.curScore.endCmd();
    return { targetsDone: done, error: "", ties: ties };
}

// --- Fill Empty Beats with Slashes (direct-API beat slashes) ----------------
// slash-fill via the API: fill each whole-beat-aligned run of voice-1 rests with
// one stemless slash per beat. Runs from a form. Unlike the comp writers the
// target is the user's OWN staff with existing notes, so we must NOT overwrite
// anything before a region — but a region always starts on a real rest segment,
// so rewindToTick(region.start) lands exactly there (no gap-fill, which would
// clobber earlier beats).

/** The measure containing `tick`, or null. Walks from firstMeasure every call, so
 *  a per-region caller is O(measures × regions) — fine at score scale; revisit with
 *  a cached measure list only if a long score ever feels slow.
 *  @param {EffectCtx} ctx @param {number} tick @returns {MS.Measure|null} */
function _measureAt(ctx, tick) {
    var m = ctx.curScore.firstMeasure;
    while (m) {
        var mStart = m.firstSegment ? m.firstSegment.tick : 0;
        var mEnd = _measureStartOrEnd(ctx, m.nextMeasure);
        if (tick >= mStart && tick < mEnd) return m;
        m = m.nextMeasure;
    }
    return null;
}

/**
 * Fill [start, end) (a whole-beat run of rests) with stemless beat slashes.
 * @param {EffectCtx} ctx
 * @param {number} staffIdx
 * @param {number} start
 * @param {number} end    exclusive
 * @param {number} beat   ticks per beat
 * @returns {boolean}  false when nothing was written (no usable pitch / bad landing)
 */
function _writeBeatSlashes(ctx, staffIdx, start, end, beat) {
    // A drum staff drops invalid drum pitches silently (NoteInput::addPitch) and
    // forces the voice by pitch, so SLASH_PITCH (a pitched-staff constant) would
    // write nothing on drums — pick a valid voice-1 drum pitch instead.
    var pitch = _slashPitch(ctx, staffIdx, 0);
    if (pitch < 0) return false;            // drum staff with no usable pitch

    var cur = _cursorAt(ctx, staffIdx, 0, start);
    if (cur.tick !== start) return false;   // guard: don't corrupt earlier beats

    var f = ticksToFraction(beat, ctx.division);
    for (var t = start; t < end; t += beat) {
        cur.setDuration(f.z, f.n);
        cur.addNote(pitch, false);
    }

    var c2 = _cursorAt(ctx, staffIdx, 0, start);
    while (c2.segment && c2.tick < end) {
        if (c2.element && c2.element.type === ctx.Element.CHORD) _applySlashChord(ctx, c2.element, true, 4);
        c2.next();
    }
    return true;
}

/**
 * Fill the empty voice-1 beats of [selStart, selEnd) in staffIdx with slashes.
 * @param {EffectCtx} ctx  needs curScore, Cursor, Segment, Element, Slashes, Direction, NoteHeadGroup, Beam, division
 * @param {number} selStart
 * @param {number} selEnd   exclusive
 * @param {number} staffIdx
 * @returns {JK.FillResult}
 */
function fillEmptyBeatsNotes(ctx, selStart, selEnd, staffIdx) {
    var regions = _emptyRestRegions(ctx, selStart, selEnd, staffIdx);
    if (regions.length === 0) return { regions: 0, filled: 0, selectFailed: false };

    ctx.curScore.startCmd();
    var filled = 0, failed = false;
    for (var i = 0; i < regions.length; ++i) {
        var reg = regions[i];
        var m = _measureAt(ctx, reg.start);
        var ts = m ? m.timesigNominal : null;
        var beat = ts ? ctx.Slashes.beatTicks(ts.numerator, ts.denominator, ts.ticks) : (ctx.division || 480);
        if (_writeBeatSlashes(ctx, staffIdx, reg.start, reg.end, beat)) ++filled;
        else failed = true;
    }
    ctx.curScore.endCmd();
    return { regions: regions.length, filled: filled, selectFailed: failed };
}

// --- Fix Marcato Staccatos --------------------------------------------------
// The per-chord decision (marcato present? staccato present? add above/below?)
// is the pure, unit-tested Articulations.classifyChord. This is the traversal +
// side effects: iterate every staff/voice/chord and hide or add the staccato.

/**
 * Try to add a hidden staccato to a chord, matching the marcato placement. Adds
 * the first candidate SymId that takes, then hides it.
 * @param {EffectCtx} ctx
 * @param {MS.Cursor} cursor   positioned on the chord
 * @param {boolean} wantAbove
 * @returns {boolean}
 */
function _tryAddHiddenStaccato(ctx, cursor, wantAbove) {
    /** @type {MS.SymIdValue[]} */
    var candidates = [];
    try { candidates = ctx.Articulations.staccatoCandidates(ctx.SymId, wantAbove); } catch (e) { candidates = []; }

    for (var j = 0; j < candidates.length; ++j) {
        var cand = candidates[j];
        if (!cand) continue;
        var s = ctx.newElement(ctx.Element.ARTICULATION);
        // The flags set BEFORE cursor.add are the ones that stick: cursor.add
        // attaches the very element we built, so there is nothing to look up again
        // afterwards. (This used to be hedged both ways — a post-add rescan of
        // el.articulations re-set the same two flags. The harness assertions
        // "marcato: marcato-only chord gained a hidden staccato" and "…pre-existing
        // staccato is now hidden" are what tell the two halves apart.)
        _trySet(s, "hidden", true);
        _trySet(s, "visible", false);
        s.symbol = cand;
        cursor.add(s);
        return true;
    }
    return false;
}

/**
 * For a marcato chord, hide any existing staccatos or add a hidden one.
 * @param {EffectCtx} ctx
 * @param {MS.Element|null} el
 * @param {MS.Cursor} cursor
 * @returns {JK.StaccatoResult}
 */
function _processMarcatoStaccato(ctx, el, cursor) {
    var result = { added: 0, hidden: 0 };
    if (!el || el.type != ctx.Element.CHORD) return result;

    var articulations = el.articulations || [];
    var c = ctx.Articulations.classifyChord(ctx.Articulations.chordNames(ctx.SymId, articulations));
    if (!c.hasMarcato) return result;

    if (c.staccatoIndices.length > 0) {
        for (var k = 0; k < c.staccatoIndices.length; ++k) {
            var a = articulations[c.staccatoIndices[k]];
            if (!a) continue;
            _trySet(a, "hidden", true);
            _trySet(a, "visible", false);
        }
        result.hidden = 1;
        return result;
    }

    if (_tryAddHiddenStaccato(ctx, cursor, c.addAbove)) result.added = 1;
    return result;
}

/**
 * Ensure every marcato chord in the score carries a (hidden) staccato: walk all
 * staves/voices/chords once inside a single startCmd/endCmd.
 * @param {EffectCtx} ctx
 * @returns {JK.StaccatoResult}
 */
function fixMarcatoStaccatos(ctx) {
    ctx.curScore.startCmd();

    var cursor = ctx.curScore.newCursor();
    var total = { added: 0, hidden: 0 };

    var maxStaves = ctx.JazzKit.countStaves(ctx.curScore);
    for (var staffIdx = 0; staffIdx < maxStaves; ++staffIdx) {
        for (var voice = 0; voice < 4; ++voice) {
            cursor.staffIdx = staffIdx;
            cursor.voice = voice;
            cursor.rewind(ctx.Cursor.SCORE_START);
            while (cursor.segment) {
                var el = cursor.element;
                if (el && el.type == ctx.Element.CHORD) {
                    var res = _processMarcatoStaccato(ctx, el, cursor);
                    total.added += res.added;
                    total.hidden += res.hidden;
                }
                cursor.next();
            }
        }
    }

    ctx.curScore.endCmd();
    return total;
}

// --- Courtesy Accidentals ---------------------------------------------------
// The musical decision (required? courtesy? superfluous?) is the pure,
// unit-tested Accidentals.planStaff. This is the traversal (read one staff as
// plain data, apply the plan) plus the API mutations.
//
// `note.accidentalType = X` routes to EditNote::changeAccidental, which
// (verified in the MuseScore source):
//   * NONE → removes the accidental AND re-derives the pitch from the measure's
//     accidental state — so removing a REQUIRED accidental silently transposes
//     the note. Every write below is therefore pitch-guarded and rolled back if
//     the pitch moved; that is the invariant this effect must never break.
//   * a type matching the sounding pitch → adds a USER-role accidental,
//     displayed unconditionally (exactly what a courtesy accidental is), pitch
//     unchanged.

/** True for an unpitched percussion staff, where accidentals are meaningless.
 *  @param {EffectCtx} ctx @param {number} staffIdx @returns {boolean} */
function _isDrumStaff(ctx, staffIdx) {
    return !!_drumsetFor(ctx, staffIdx);
}

/** Append plain note data (+ the live objects, index-aligned) for one chord.
 *  @param {MS.Note[]|undefined} notes
 *  @param {JK.NoteData[]} data  plain data for Accidentals.planStaff
 *  @param {MS.Note[]} live  index-aligned live notes to apply the plan to
 *  @returns {void} */
function _pushNoteData(notes, data, live) {
    var ns = notes || [];
    for (var i = 0; i < ns.length; ++i) {
        var n = ns[i];
        data.push({
            pitch: n.pitch, tpc: n.tpc, tpc1: n.tpc1,
            hasAccidental: !!n.accidental,
            tiedBack: !!n.tieBack
        });
        live.push(n);
    }
}

/**
 * Read one staff as the measure/note data Accidentals.planStaff expects, with an
 * index-aligned array of the live Note objects to apply the plan to. Notes of all
 * four voices are merged in tick-then-track order (an accidental holds for the
 * whole staff, not one voice), grace notes ahead of the chord they decorate.
 * @param {EffectCtx} ctx  needs curScore, Segment, Element
 * @param {number} staffIdx
 * @returns {{measures:JK.MeasureData[], live:MS.Note[]}}
 */
function _readStaffForAccidentals(ctx, staffIdx) {
    var cursor = ctx.curScore.newCursor();
    cursor.staffIdx = staffIdx;      // set track BEFORE rewind (api-gotchas)
    cursor.voice = 0;

    /** @type {JK.MeasureData[]} */
    var measures = [];
    /** @type {MS.Note[]} */
    var live = [];
    /** @type {MS.Segment|null} */
    var seg;
    for (var m = ctx.curScore.firstMeasure; m; m = m.nextMeasure) {
        if (!m.firstSegment) continue;
        // Voice 1 always has content, so this lands on the measure start and the
        // cursor can report the key signature in force there.
        cursor.rewindToTick(m.firstSegment.tick);
        /** @type {JK.NoteData[]} */
        var notes = [];
        for (seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
            if (seg.segmentType !== ctx.Segment.ChordRest) continue;
            for (var v = 0; v < 4; ++v) {
                var el = seg.elementAt(staffIdx * 4 + v);
                if (!el || el.type !== ctx.Element.CHORD) continue;
                var graces = el.graceNotes || [];
                for (var g = 0; g < graces.length; ++g) _pushNoteData(graces[g].notes, notes, live);
                _pushNoteData(el.notes, notes, live);
            }
        }
        measures.push({ keySig: cursor.keySignature || 0, notes: notes });
    }
    return { measures: measures, live: live };
}

/**
 * Write an accidental onto a note, rolling back if it moved the pitch.
 * @param {EffectCtx} ctx  needs Accidental
 * @param {MS.Note} note
 * @param {string} typeName   an Accidental enum member name (FLAT, NATURAL, …)
 * @param {number} bracket    accidentalBracket: 0 none, 1 parenthesis, 2 bracket
 * @returns {boolean} true when the accidental was applied
 */
function _setAccidental(ctx, note, typeName, bracket) {
    var type = ctx.Accidental[typeName];
    if (type === undefined) return false;
    var pitch = note.pitch;
    note.accidentalType = type;
    if (note.pitch !== pitch) {                     // shouldn't happen — never leave it wrong
        _trySet(note, "accidentalType", ctx.Accidental.NONE);
        return false;
    }
    if (bracket && note.accidental) {
        _trySet(note.accidental, "accidentalBracket", bracket);
    }
    return true;
}

/**
 * Drop a superfluous accidental, restoring it if the pitch moved (which means it
 * was load-bearing after all and our model was wrong about this note).
 * @param {EffectCtx} ctx  needs Accidental
 * @param {MS.Note} note
 * @returns {boolean} true when the accidental was removed
 */
function _clearAccidental(ctx, note) {
    var pitch = note.pitch;
    var was = note.accidentalType;
    note.accidentalType = ctx.Accidental.NONE;
    if (note.pitch !== pitch) {
        _trySet(note, "accidentalType", was);
        return false;
    }
    return true;
}

/**
 * Courtesy accidentals across the whole score: add one wherever a note class
 * altered in the previous bar reappears un-altered, and remove any accidental
 * that has become superfluous. Unpitched percussion staves are skipped. One
 * startCmd/endCmd for the lot.
 * @param {EffectCtx} ctx  needs curScore, Segment, Element, Accidental, JazzKit, Accidentals
 * @param {{bracket?:number}} [opts]  accidentalBracket for ADDED courtesies
 *                                    (0 none, 1 parenthesis, 2 bracket)
 * @returns {JK.CourtesyResult}
 */
function fixCourtesyAccidentals(ctx, opts) {
    var bracket = (opts && opts.bracket !== undefined) ? opts.bracket : 1;
    var total = { added: 0, removed: 0, skipped: 0 };

    ctx.curScore.startCmd();
    var maxStaves = ctx.JazzKit.countStaves(ctx.curScore);
    for (var staffIdx = 0; staffIdx < maxStaves; ++staffIdx) {
        if (_isDrumStaff(ctx, staffIdx)) continue;
        var read = _readStaffForAccidentals(ctx, staffIdx);
        var plan = ctx.Accidentals.planStaff(read.measures);
        for (var i = 0; i < plan.length; ++i) {
            var d = plan[i];
            var note = read.live[d.index];
            if (!note) continue;
            // planStaff always names the accidental on an "add"; a decision that
            // somehow lacks one is counted as skipped rather than indexing the
            // Accidental enum with undefined.
            var ok = (d.action === "add")
                ? (d.accidentalType !== undefined &&
                    _setAccidental(ctx, note, d.accidentalType, d.courtesy ? bracket : 0))
                : _clearAccidental(ctx, note);
            if (!ok) ++total.skipped;
            else if (d.action === "add") ++total.added;
            else ++total.removed;
        }
    }
    ctx.curScore.endCmd();
    return total;
}

// --- Notes: Regroup rhythms, only where it helps (Autofix) -----------------
// MuseScore's "Regroup rhythms" (cmd("reset-groupings"), Score::regroupNotesAndRests)
// rewrites every rest run and tie chain in its range the way toRhythmicDurationList
// wants it. Run over a whole score it rewrites everything, and through note input
// it DELETES fermatas and slurs inside each rewritten span and drops articulations
// from every chord of a tie chain but the first. So groupNotes runs it per staff and
// bar, only on bars it would change (Rests.voiceNeedsRegroup — the port of the same
// rules) and never on a bar where it could lose something: a fermata on the staff, a
// slur starting or ending there, or a tied-INTO chord carrying articulations/lyrics.

/**
 * Staff/tick of every slur end point (the chords a slur starts and ends on).
 * @param {EffectCtx} ctx @returns {{staffIdx:number, tick:number}[]}
 */
function _slurEnds(ctx) {
    var out = [];
    var sp = ctx.curScore.spanners || [];
    for (var i = 0; i < sp.length; ++i) {
        var s = sp[i];
        if (!s || s.type !== ctx.Element.SLUR) continue;
        var ends = [s.startElement, s.endElement];
        for (var k = 0; k < 2; ++k) {
            var e = ends[k];
            var seg = e ? (e.type === ctx.Element.NOTE ? e.parent && e.parent.parent : e.parent) : null;
            if (seg && seg.tick !== undefined) out.push({ staffIdx: Math.floor(e.track / 4), tick: seg.tick });
        }
    }
    return out;
}

/**
 * Regroup notes (and rests) by the time signature, MuseScore's way, bar by bar.
 * One cmd("reset-groupings") — one undo step — per bar changed. Needs ctx.cmd
 * outside an open command and outside an open plugin window (the Autofix macro).
 * @param {EffectCtx} ctx  needs curScore, Segment, Element, JazzKit, Rests, cmd, division
 * @returns {{bars:number, skipped:number}}  `skipped`: bars that needed it but were unsafe
 */
function groupNotes(ctx) {
    var R = /** @type {JK.RestsLib} */ (ctx.Rests);
    if (!ctx.cmd) return { bars: 0, skipped: 0 };
    var slurs = _slurEnds(ctx);
    /** @type {{staffIdx:number, mStart:number, mEnd:number}[]} */
    var plan = [];
    var skipped = 0;
    var nStaves = ctx.JazzKit.countStaves(ctx.curScore);
    for (var staffIdx = 0; staffIdx < nStaves; ++staffIdx) {
        for (var m = ctx.curScore.firstMeasure; m; m = m.nextMeasure) {
            var ts = m.timesigNominal;
            var bar = _readBar(ctx, m, staffIdx);
            if (bar.mEnd - bar.mStart !== ts.ticks) continue;            // pickup / irregular bar
            var needs = false, unsafe = false;
            for (var v = 0; v < 4; ++v) {
                var crs = bar.voices[v].map(function (c) {
                    var notes = c.isRest ? [] : (c.el.notes || []);
                    var tiedNext = notes.length > 0, tiedBack = notes.length > 0;
                    for (var n = 0; n < notes.length; ++n) {
                        if (!notes[n].tieForward) tiedNext = false;
                        if (!notes[n].tieBack) tiedBack = false;
                    }
                    if (tiedBack && (((c.el.articulations || []).length > 0) || ((c.el.lyrics || []).length > 0)))
                        unsafe = true;                                  // regroup would drop them
                    if (c.keep) unsafe = true;                          // hidden rest / fermata
                    return { rtick: c.rtick, ticks: c.ticks, isRest: c.isRest, inTuplet: c.inTuplet, tiedNext: tiedNext };
                });
                if (R.voiceNeedsRegroup(ts.numerator, ts.denominator, crs, ts.ticks, ctx.division)) needs = true;
            }
            if (!needs) continue;
            for (var s = m.firstSegment; s && !unsafe; s = s.nextInMeasure)
                for (var t = 0; t < 4; ++t)
                    if (_readFermatas(ctx, s, staffIdx * 4 + t).length) unsafe = true;
            for (var k = 0; k < slurs.length && !unsafe; ++k)
                if (slurs[k].staffIdx === staffIdx && slurs[k].tick >= bar.mStart && slurs[k].tick < bar.mEnd) unsafe = true;
            if (unsafe) { ++skipped; continue; }
            plan.push({ staffIdx: staffIdx, mStart: bar.mStart, mEnd: bar.mEnd });
        }
    }
    var sel = ctx.curScore.selection;
    for (var p = 0; p < plan.length; ++p) {
        // The end tick is the next bar's start (or, for the last bar, the score's end,
        // which resolves to "no segment" = to the end) — the range is exactly the bar.
        if (!sel.selectRange(plan[p].mStart, plan[p].mEnd, plan[p].staffIdx, plan[p].staffIdx + 1)) continue;
        ctx.cmd("reset-groupings");
    }
    sel.clear();
    return { bars: plan.length, skipped: skipped };
}

// --- Rests: grouping + whole-bar rests (Autofix) ---------------------------
// Two fixes, both matching what MuseScore itself writes:
//  * groupRests — each run of plain rests in a voice is rewritten the way
//    Score::setRests would fill that gap (Rests.restDurations, a port of MuseScore's
//    toRhythmicDurationList). Written with cursor note input, which keeps chord
//    symbols / staff text / dynamics on the rests' segments (they are time-anchored
//    text) but DELETES fermatas inside the rewritten span — so a run with a fermata,
//    a hidden rest or a tuplet is left alone. A range cmd("delete") would group the
//    same way but also delete chord symbols in the range, so it is not used.
//  * fullBarRests — a bar whose every voice holds only rests becomes ONE
//    full-measure rest (voice 1) and nothing else: the voice 2-4 rests are removed
//    (removeElement), then cmd("full-measure-rest") replaces voice 1's rests. That
//    command is the only way to make a full-measure rest (a rest's duration TYPE
//    can't be set through the API); it is run per bar with that bar's first rest
//    selected (a plugin selectRange ends on a chord/rest segment, which the
//    command's range path rejects). Needs ctx.cmd outside any open command and
//    outside an open plugin window (the Autofix macro has none).

/**
 * One measure of one staff, read as plain data per voice.
 * @param {EffectCtx} ctx @param {MS.Measure} m @param {number} staffIdx
 * @returns {{mStart:number, mEnd:number, voices:{rtick:number, ticks:number, isRest:boolean,
 *   inTuplet:boolean, keep:boolean, el:MS.Element}[][]}}
 */
function _readBar(ctx, m, staffIdx) {
    var mStart = m.firstSegment ? m.firstSegment.tick : 0;
    var mEnd = _measureStartOrEnd(ctx, m.nextMeasure);
    /** @type {{rtick:number, ticks:number, isRest:boolean, inTuplet:boolean, keep:boolean, el:MS.Element}[][]} */
    var voices = [[], [], [], []];
    for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
        if (seg.segmentType !== ctx.Segment.ChordRest) continue;
        for (var v = 0; v < 4; ++v) {
            var track = staffIdx * 4 + v;
            var el = seg.elementAt(track);
            if (!el || !el.duration) continue;
            var isRest = el.type === ctx.Element.REST;
            voices[v].push({
                rtick: seg.tick - mStart, ticks: _actualTicks(el), isRest: isRest,
                inTuplet: !!el.tuplet, el: el,
                // a rest a rewrite could damage: hidden, or carrying a fermata
                keep: isRest && (el.visible === false || _readFermatas(ctx, seg, track).length > 0)
            });
        }
    }
    return { mStart: mStart, mEnd: mEnd, voices: voices };
}

/**
 * Regroup every run of plain rests (all staves, all voices) the way MuseScore would
 * fill it. Bars whose voice is ONLY rests are left to fullBarRests; irregular bars
 * (pickups) are skipped. One startCmd/endCmd.
 * @param {EffectCtx} ctx  needs curScore, Segment, Element, Rests, JazzKit, division
 * @returns {{regrouped:number}}
 */
function groupRests(ctx) {
    var R = /** @type {JK.RestsLib} */ (ctx.Rests);
    var regrouped = 0;
    ctx.curScore.startCmd();
    var nStaves = ctx.JazzKit.countStaves(ctx.curScore);
    for (var staffIdx = 0; staffIdx < nStaves; ++staffIdx) {
        for (var m = ctx.curScore.firstMeasure; m; m = m.nextMeasure) {
            var ts = m.timesigNominal;
            var bar = _readBar(ctx, m, staffIdx);
            if (bar.mEnd - bar.mStart !== ts.ticks) continue;            // pickup / irregular bar
            for (var v = 0; v < 4; ++v) {
                var crs = bar.voices[v];
                var onlyRests = true;
                for (var i = 0; i < crs.length; ++i) if (!crs[i].isRest) onlyRests = false;
                if (onlyRests) continue;                                   // fullBarRests' job
                var runs = R.restRuns(crs.map(function (c) {
                    return { rtick: c.rtick, ticks: c.ticks, isRest: c.isRest && !c.keep, inTuplet: c.inTuplet };
                }));
                for (var r = 0; r < runs.length; ++r) {
                    var run = runs[r];
                    var want = R.restDurations(ts.numerator, ts.denominator, run.start, run.end - run.start, ctx.division);
                    var sum = 0;
                    for (var k = 0; k < want.length; ++k) sum += want[k];
                    if (sum !== run.end - run.start || R.sameLengths(run.lengths, want)) continue;
                    var cur = _cursorAt(ctx, staffIdx, v, bar.mStart + run.start);
                    if (cur.tick !== bar.mStart + run.start) continue;     // didn't land on the run
                    for (var w = 0; w < want.length; ++w) {
                        var f = ticksToFraction(want[w], ctx.division);
                        cur.setDuration(f.z, f.n);
                        cur.addRest();
                    }
                    ++regrouped;
                }
            }
        }
    }
    ctx.curScore.endCmd();
    return { regrouped: regrouped };
}

/**
 * What fullBarRests will do, per staff and bar, for each VOICE that holds only rests
 * (no chords, no tuplet — full-measure-rest removes tuplet members without their
 * tuplet). Such a voice becomes one full-measure rest (`targets`: its first rest,
 * which the command is run on — it must start the bar), unless the WHOLE bar is
 * rests, in which case voices 2-4 are simply removed (`extra`) and only voice 1
 * keeps a bar rest. A voice that already is one full-measure rest is left alone.
 * @param {EffectCtx} ctx
 * @returns {{targets:MS.Element[], extra:MS.Element[], bars:number}}
 */
function _planFullBarRests(ctx) {
    /** @type {MS.Element[]} */
    var targets = [];
    /** @type {MS.Element[]} */
    var extra = [];
    var bars = 0;
    var nStaves = ctx.JazzKit.countStaves(ctx.curScore);
    for (var staffIdx = 0; staffIdx < nStaves; ++staffIdx) {
        for (var m = ctx.curScore.firstMeasure; m; m = m.nextMeasure) {
            var bar = _readBar(ctx, m, staffIdx);
            /** @type {boolean[]} */
            var onlyRests = [];
            var allRests = bar.voices[0].length > 0;
            for (var v = 0; v < 4; ++v) {
                var crs = bar.voices[v], ok = crs.length > 0;
                for (var i = 0; i < crs.length; ++i) if (!crs[i].isRest || crs[i].inTuplet) ok = false;
                onlyRests.push(ok);
                if (crs.length > 0 && !ok) allRests = false;
            }
            var changed = false;
            for (var w = 0; w < 4; ++w) {
                if (!onlyRests[w]) continue;
                var vc = bar.voices[w];
                if (w > 0 && allRests) {
                    for (var j = 0; j < vc.length; ++j) extra.push(vc[j].el);
                    changed = true;
                    continue;
                }
                if (vc.length === 1 && vc[0].el.isFullMeasureRest === true) continue;   // already done
                if (vc[0].rtick !== 0) continue;             // the command needs the bar's first rest
                targets.push(vc[0].el);
                changed = true;
            }
            if (changed) ++bars;
        }
    }
    return { targets: targets, extra: extra, bars: bars };
}

/**
 * Every voice that is only rests in a bar becomes one full-measure rest; in a bar
 * that is only rests altogether, voices 2-4 go and voice 1 keeps one bar rest.
 * @param {EffectCtx} ctx  needs curScore, Segment, Element, JazzKit, cmd, removeElement
 * @returns {{bars:number}}  bars changed
 */
function fullBarRests(ctx) {
    if (!ctx.cmd || !ctx.removeElement) return { bars: 0 };
    var plan = _planFullBarRests(ctx);
    if (plan.bars === 0) return { bars: 0 };
    if (plan.extra.length) {
        ctx.curScore.startCmd();
        for (var i = 0; i < plan.extra.length; ++i) ctx.removeElement(plan.extra[i]);
        ctx.curScore.endCmd();
    }
    var sel = ctx.curScore.selection;
    for (var k = 0; k < plan.targets.length; ++k) {
        sel.clear();
        sel.select(plan.targets[k]);
        ctx.cmd("full-measure-rest");
    }
    sel.clear();
    return { bars: plan.bars };
}

// --- Format Line Breaks -----------------------------------------------------
// The placement algorithm (which boxes get a break) is the pure, unit-tested
// LineBreaks.computeBreaks; the .qml passes in the already-computed measures to
// clear and the measures to break at. This executor only applies them.

/**
 * Clear every existing layout break in `measures`, then add a LINE break to each
 * measure in `breakMeasures`. One startCmd/endCmd (a single logical edit).
 * @param {EffectCtx} ctx
 * @param {MS.Measure[]} measures    measures whose existing breaks are cleared
 * @param {MS.Measure[]} breakMeasures  measures to attach a new LINE break to
 * @returns {JK.LineBreakResult}
 */
function applyLineBreaks(ctx, measures, breakMeasures) {
    ctx.curScore.startCmd();

    var removed = 0;
    for (var i = 0; i < measures.length; ++i) {
        var els = measures[i].elements;
        var toRemove = [];
        for (var j = 0; j < els.length; ++j) {
            var e = els[j];
            if (e && e.type === ctx.Element.LAYOUT_BREAK) toRemove.push(e);
        }
        for (var k = 0; k < toRemove.length; ++k) { measures[i].remove(toRemove[k]); ++removed; }
    }

    var added = 0;
    for (var b = 0; b < breakMeasures.length; ++b) {
        var lb = ctx.newElement(ctx.Element.LAYOUT_BREAK);
        lb.layoutBreakType = ctx.LayoutBreak.LINE;
        breakMeasures[b].add(lb);
        ++added;
    }

    ctx.curScore.endCmd();
    return { removed: removed, added: added };
}

// Exposed for the Node loader / harness; QML reaches the functions by name directly.
var effectsLib = {
    compCuesNotes: compCuesNotes,
    compSlashesNotes: compSlashesNotes,
    fillEmptyBeatsNotes: fillEmptyBeatsNotes,
    ticksToFraction: ticksToFraction,
    splitRestTicks: splitRestTicks,
    planTies: planTies,
    applyTies: applyTies,
    groupRests: groupRests,
    groupNotes: groupNotes,
    fullBarRests: fullBarRests,
    collapseTuplets: collapseTuplets,
    fixMarcatoStaccatos: fixMarcatoStaccatos,
    fixCourtesyAccidentals: fixCourtesyAccidentals,
    applyLineBreaks: applyLineBreaks
};

// Export trailer — MANDATORY, see api-gotchas "macros actions".
if (typeof exports !== "undefined") { exports = effectsLib; }
