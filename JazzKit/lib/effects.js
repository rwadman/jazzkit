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
 * @property {(type:number)=>*} [newElement]  QML newElement(Element.X)
 * @property {*} JazzKit    jazzkit.js  (countStaves)
 * @property {*} Slashes    slashes.js  (emptyRestRegions — pure, unit-tested)
 * @property {*} [Articulations] articulations.js (classifyChord — pure, unit-tested)
 * @property {*} [Accidentals] accidentals.js (planStaff — pure, unit-tested)
 * @property {*} Segment    QML Segment enum
 * @property {*} Element    QML Element enum
 * @property {*} Cursor     QML Cursor enum
 * @property {number} [division]  ticks per quarter note (MuseScore global)
 * @property {*} [Direction]    QML Direction enum (stem direction)
 * @property {*} [NoteHeadGroup] QML NoteHeadGroup enum (HEAD_SLASH, …)
 * @property {*} [Beam]         QML Beam enum (beam mode)
 * @property {*} [SymId]        QML SymId enum
 * @property {*} [BarLineType]  QML BarLineType enum
 * @property {*} [LayoutBreak]  QML LayoutBreak enum
 * @property {*} [Accidental]   QML Accidental enum (NONE, FLAT, NATURAL, SHARP, …)
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
 * @returns {{start:number,end:number}[]}
 */
function _emptyRestRegions(ctx, selStart, selEnd, staffIdx) {
    var track = staffIdx * 4; // voice 1
    var measures = [];

    var m = _measureAt(ctx, selStart);

    while (m && m.firstSegment && m.firstSegment.tick < selEnd) {
        var ts = m.timesigNominal;
        var rests = [];
        for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
            if (seg.segmentType !== ctx.Segment.ChordRest) continue;
            var el = seg.elementAt(track);
            if (!el || el.type !== ctx.Element.REST) continue;
            rests.push({ tick: seg.tick, durTicks: el.duration.ticks });
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
// Limitation (v1): reproduces per-segment durations, pitches (incl. chords) and
// articulations. It does not yet re-create tuplets or ties, and assumes the
// written segments line up 1:1 with the source (true when no duration crosses a
// barline). A DRUM target has no pitch to cue, so compCuesNotes routes it to
// _writeDrumCueInto (the rhythm as cue notes in voice 3) instead.

/**
 * Symbols of the fermatas attached at `segment` in `track`. A fermata is NOT a
 * chord articulation — it lives in the SEGMENT's annotations (dom/fermata.cpp,
 * Segment::annotations), so it has to be read and written separately from
 * `chord.articulations`, and it can sit on a rest.
 * @param {EffectCtx} ctx  needs Element
 * @returns {*[]}  SymId values
 */
function _readFermatas(ctx, segment, track) {
    var out = [];
    if (!segment) return out;
    var ann = segment.annotations || [];
    for (var i = 0; i < ann.length; ++i) {
        var a = ann[i];
        if (!a || a.type !== ctx.Element.FERMATA) continue;
        if (a.track !== undefined && a.track !== track) continue;   // other staff/voice
        out.push(a.symbol);
    }
    return out;
}

/**
 * Read the source voice-1 chord/rests across [selStart, selEnd) as plain data.
 * `accents` are the chord's articulations (staccato, tenuto, accent, …);
 * `fermatas` are the segment's, read for rests too.
 * @param {EffectCtx} ctx  needs curScore, Cursor, Element
 * @returns {{num:number,den:number,isRest:boolean,pitches:number[],accents:*[],fermatas:*[]}[]}
 */
function _readSourceCRs(ctx, selStart, selEnd, srcStaffIdx) {
    var track = srcStaffIdx * 4;   // voice 1
    var cursor = _cursorAt(ctx, srcStaffIdx, 0, selStart);

    var out = [];
    while (cursor.segment && cursor.tick < selEnd) {
        var el = cursor.element;
        if (el && el.duration) {
            var item = {
                tick: cursor.tick,   // absolute start tick (for tick-aligned pass 2)
                num: el.duration.numerator, den: el.duration.denominator,
                isRest: el.type === ctx.Element.REST, pitches: [], accents: [],
                fermatas: _readFermatas(ctx, cursor.segment, track)
            };
            if (el.type === ctx.Element.CHORD) {
                var notes = el.notes || [];
                for (var i = 0; i < notes.length; ++i) item.pitches.push(notes[i].pitch);
                var arts = el.articulations || [];
                for (var j = 0; j < arts.length; ++j) item.accents.push(arts[j].symbol);
            }
            out.push(item);
        }
        cursor.next();
    }
    return out;
}

/**
 * source tick -> the markings to reproduce there. A source note whose duration
 * crosses a barline is written as several TIED slices, so the writers walk by
 * TICK: the markings land on the slice that starts at the source tick (the head
 * of the tie group), never on the tail.
 * @param {{tick:number,isRest:boolean,accents:*[],fermatas:*[]}[]} src
 */
function _markingsByTick(src) {
    var at = {};
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        var accents = cr.isRest ? [] : (cr.accents || []);
        var fermatas = cr.fermatas || [];
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
 */
function _addMarkings(ctx, cursor, chord, marks) {
    if (!marks) return;
    var accents = marks.accents || [];
    for (var a = 0; chord && a < accents.length; ++a) {
        if (accents[a] === undefined) continue;
        var art = ctx.newElement(ctx.Element.ARTICULATION);
        art.symbol = accents[a];
        chord.add(art);
    }
    var fermatas = marks.fermatas || [];
    for (var f = 0; f < fermatas.length; ++f) {
        if (fermatas[f] === undefined) continue;
        var fer = ctx.newElement(ctx.Element.FERMATA);
        fer.symbol = fermatas[f];
        cursor.add(fer);   // attaches to the segment at the cursor
    }
}

function _gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a || 1; }

/**
 * Convert a tick count to the {z, n} whole-note fraction cursor.setDuration wants
 * (division = ticks per quarter note, so a whole note = division*4). Pure — the
 * numeric core of the mid-measure split, unit-tested.
 * @returns {{z:number, n:number}}
 */
function ticksToFraction(ticks, division) {
    var whole = (division || 480) * 4;
    var g = _gcd(ticks, whole);
    return { z: ticks / g, n: whole / g };
}

/** Set the cursor input duration to `ticks`, as a fraction of a whole note. */
function _setDurationTicks(ctx, cur, ticks) {
    var f = ticksToFraction(ticks, ctx.division);
    cur.setDuration(f.z, f.n);
}

/**
 * Pass 1, shared by every writer: fill the gap from the cursor up to selStart, then
 * write one chord/rest per source CR via `writeCR(cursor, cr)` (the cursor's input
 * duration is already set).
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
 * @param {*} writeCR  function(cursor, cr)
 */
function _writeSource(ctx, cur, selStart, src, writeCR) {
    if (cur.tick < selStart) {
        _setDurationTicks(ctx, cur, selStart - cur.tick);
        cur.addRest();
    }
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        cur.setDuration(cr.num, cr.den);
        writeCR(cur, cr);
    }
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
 * @param {*} atCR  function(cursor, element) -> chord|null
 */
function _decorateWritten(ctx, cur, selStart, selEnd, markAt, atCR) {
    while (cur.segment && cur.tick < selEnd) {
        var chord = atCR(cur, cur.element);
        if (cur.tick >= selStart) _addMarkings(ctx, cur, chord, markAt[cur.tick]);
        cur.next();
    }
}

/**
 * Write the read source into voice 1 of one target staff: pitches/durations
 * first, then a second pass to cue-size the chords and copy their articulations.
 * @param {EffectCtx} ctx  needs curScore, newElement, Element, division
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
        _markingsByTick(src), function (cur, el) {
            if (!el || el.type !== ctx.Element.CHORD) return null;
            _trySet(el, "small", true);      // every cue slice is cue-sized
            return el;
        });
}

/**
 * To Comp Cues (direct API). `targets` is an array of { staffIdx, isDrum }.
 * Pitched parts get a note-for-note cue; drum parts have no pitch to cue, so they
 * get the source rhythm as a slash comp (the same slash writer as To Comp Slashes,
 * which handles the drumset's valid-pitch/voice constraints).
 * @param {EffectCtx} ctx  needs curScore, newElement, Element, Cursor, Direction, NoteHeadGroup, division
 * @param {*} params  { selStart, selEnd, measureTick, srcStaffIdx, targets }
 * @returns {{targetsDone:number, error:string}}
 */
function compCuesNotes(ctx, params) {
    var src = _readSourceCRs(ctx, params.selStart, params.selEnd, params.srcStaffIdx);
    if (src.length === 0) return { targetsDone: 0, error: "Nothing to copy in the selection." };

    ctx.curScore.startCmd();
    var done = 0;
    for (var t = 0; t < params.targets.length; ++t) {
        var tgt = params.targets[t];
        if (tgt.isDrum) _writeDrumCueInto(ctx, tgt.staffIdx, params.measureTick, params.selStart, params.selEnd, src);
        else _writeCueInto(ctx, tgt.staffIdx, params.measureTick, params.selStart, params.selEnd, src);
        ++done;
    }
    ctx.curScore.endCmd();
    return { targetsDone: done, error: "" };
}

// --- To Comp Slashes (direct-API slash notation, no cmd) --------------------
// Replicates MuseScore's Chord::setSlash(flag=true, stemless) via the exposed
// note/chord properties, so it runs from a form. Middle-line note per beat with a
// slash notehead; playback off. `line` is the staff's middle line (4 for a 5-line
// staff). Pitch is irrelevant (fixed to the line + play off), so we write a
// constant one.
var SLASH_PITCH = 71;    // B4 — arbitrary; FIXED_LINE + PLAY=false hide its effect

/** The part whose staves include staffIdx, or null. */
function _partForStaff(ctx, staffIdx) {
    var parts = ctx.curScore.parts;
    for (var i = 0; i < parts.length; ++i) {
        var p = parts[i];
        if (staffIdx >= Math.floor(p.startTrack / 4) && staffIdx < Math.floor(p.endTrack / 4)) return p;
    }
    return null;
}

/** The drumset of the staff's instrument, or null on a pitched staff. */
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
        _markingsByTick(src), function (cur, el) {
            if (!el || el.type !== ctx.Element.CHORD) return null;
            _applySlashChord(ctx, el, false, 4);
            return el;
        });
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
 *  pitched staff (no drumset → caller falls back to the slash writer). */
function _drumCuePitch(ctx, staffIdx) {
    var ds = _drumsetFor(ctx, staffIdx);
    if (!ds) return null;                       // pitched staff
    for (var p = 0; p < 128; ++p) if (ds.isValid(p)) return p;
    return -1;                                  // drumset with no valid pitch (unexpected)
}

/** Dress a written chord as a drum cue note (cue-size, silent, stem up, above staff,
 *  NORMAL notehead). */
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
 */
function _writeDrumCueInto(ctx, staffIdx, measureTick, selStart, selEnd, src) {
    var pitch = _drumCuePitch(ctx, staffIdx);
    if (pitch === null) { _writeSlashRhythmInto(ctx, staffIdx, measureTick, selStart, selEnd, src); return; }
    if (pitch < 0) return;                      // drumset but no valid pitch
    var V = DRUM_CUE_VOICE;

    // Pass 1: rest shell that TILES THE WHOLE MEASURE in voice V — leading gap up to
    // selStart, the source rhythm, then a trailing rest to the measure end. Voice V
    // (unlike voice 1) is NOT auto-filled, so a partial shell leaves a GAP; that gap
    // is what a later `cursor.add`/`changeCRlen` reflows into, corrupting the bar
    // (two eighths at the bar start dropped the 2nd note; three quarters split the
    // middle into a gap+eighth). A complete tiling means every replacement is an
    // exact in-place swap. addRest goes through enterRest — no voice-forcing.
    var mEnd = _measureEndTick(ctx, measureTick);
    var cur = _cursorAt(ctx, staffIdx, 0, measureTick);   // voice 0 always has content
    cur.voice = V;                      // switch (keeps the segment; api-gotchas empty-voice trick)
    var noteTicks = {};                 // tick → true at each note position
    _writeSource(ctx, cur, selStart, src, function (c, cr) {
        if (!cr.isRest) noteTicks[c.tick] = true;
        c.addRest();
    });
    if (cur.tick < mEnd) { _setDurationTicks(ctx, cur, mEnd - cur.tick); cur.addRest(); }

    // Pass 2: replace each note-beat rest with a cue chord. Rewind on voice 0 (has a
    // boundary at measureTick) then switch to voice V and walk the shell. Since the
    // shell fully tiles the measure, each note-beat swap is exact — no reflow shifts
    // the segments the cursor still has to visit.
    var wc = _cursorAt(ctx, staffIdx, 0, measureTick);
    wc.voice = V;
    // The markings go on the chord built here (a plugin-owned chord is already in the
    // score after wc.add, so chord.add undo-adds normally); fermatas go via the
    // cursor, onto the segment — hence the `selStart` guard on the leading shell rest.
    _decorateWritten(ctx, wc, selStart, selEnd, _markingsByTick(src), function (c, el) {
        if (!noteTicks[c.tick] || !el || el.type !== ctx.Element.REST) return null;
        var restDur = el.duration;                  // capture before replacing
        var chord = ctx.newElement(ctx.Element.CHORD);
        var note = ctx.newElement(ctx.Element.NOTE);
        note.pitch = pitch;
        chord.add(note);
        c.add(chord);                               // replaces the rest at c.track (voice V)
        _trySet(chord, "duration", restDur);        // fix invalid duration
        _applyDrumCueChord(ctx, chord);
        return chord;
    });
}

/** The first tick after the measure that contains `tick` (its exclusive end). */
function _measureEndTick(ctx, tick) {
    var m = _measureAt(ctx, tick);
    if (!m) return tick;
    return m.nextMeasure ? m.nextMeasure.firstSegment.tick : (ctx.curScore.lastSegment.tick + 1);
}

/**
 * To Comp Slashes (direct API). `targets` rows are either a bare staff index or the
 * `{staffIdx, isDrum}` object compCuesNotes takes (`isDrum` is irrelevant here — the
 * slash writer already picks a valid drum pitch), so both forms share one row shape.
 * @param {EffectCtx} ctx  needs curScore, Element, Cursor, Direction, NoteHeadGroup, division
 * @param {*} params  { selStart, selEnd, measureTick, srcStaffIdx, targets }
 * @returns {{targetsDone:number, error:string}}
 */
function compSlashesNotes(ctx, params) {
    var src = _readSourceCRs(ctx, params.selStart, params.selEnd, params.srcStaffIdx);
    if (src.length === 0) return { targetsDone: 0, error: "Nothing to copy in the selection." };

    ctx.curScore.startCmd();
    var done = 0;
    for (var t = 0; t < params.targets.length; ++t) {
        var tgt = params.targets[t];
        var s = (typeof tgt === "number") ? tgt : tgt.staffIdx;
        _writeSlashRhythmInto(ctx, s, params.measureTick, params.selStart, params.selEnd, src);
        ++done;
    }
    ctx.curScore.endCmd();
    return { targetsDone: done, error: "" };
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
 *  a cached measure list only if a long score ever feels slow. */
function _measureAt(ctx, tick) {
    var m = ctx.curScore.firstMeasure;
    while (m) {
        var mStart = m.firstSegment.tick;
        var mEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : (ctx.curScore.lastSegment.tick + 1);
        if (tick >= mStart && tick < mEnd) return m;
        m = m.nextMeasure;
    }
    return null;
}

/** Fill [start, end) (a whole-beat run of rests) with stemless beat slashes. */
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
 * @returns {{regions:number, filled:number, selectFailed:boolean}}
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
 * @param {*} el
 * @param {MS.Cursor} cursor
 * @returns {{added:number, hidden:number}}
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
 * @returns {{added:number, hidden:number}}
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

/** True for an unpitched percussion staff, where accidentals are meaningless. */
function _isDrumStaff(ctx, staffIdx) {
    return !!_drumsetFor(ctx, staffIdx);
}

/** Append plain note data (+ the live objects, index-aligned) for one chord. */
function _pushNoteData(notes, data, live) {
    for (var i = 0; i < (notes ? notes.length : 0); ++i) {
        var n = notes[i];
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
 * @returns {{measures:*[], live:*[]}}
 */
function _readStaffForAccidentals(ctx, staffIdx) {
    var cursor = ctx.curScore.newCursor();
    cursor.staffIdx = staffIdx;      // set track BEFORE rewind (api-gotchas)
    cursor.voice = 0;

    var measures = [], live = [];
    for (var m = ctx.curScore.firstMeasure; m; m = m.nextMeasure) {
        if (!m.firstSegment) continue;
        // Voice 1 always has content, so this lands on the measure start and the
        // cursor can report the key signature in force there.
        cursor.rewindToTick(m.firstSegment.tick);
        var notes = [];
        for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
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
 * @returns {{added:number, removed:number, skipped:number}}
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
            var ok = (d.action === "add")
                ? _setAccidental(ctx, note, d.accidentalType, d.courtesy ? bracket : 0)
                : _clearAccidental(ctx, note);
            if (!ok) ++total.skipped;
            else if (d.action === "add") ++total.added;
            else ++total.removed;
        }
    }
    ctx.curScore.endCmd();
    return total;
}

// --- Format Line Breaks -----------------------------------------------------
// The placement algorithm (which boxes get a break) is the pure, unit-tested
// LineBreaks.computeBreaks; the .qml passes in the already-computed measures to
// clear and the measures to break at. This executor only applies them.

/**
 * Clear every existing layout break in `measures`, then add a LINE break to each
 * measure in `breakMeasures`. One startCmd/endCmd (a single logical edit).
 * @param {EffectCtx} ctx
 * @param {*[]} measures        measures whose existing breaks are cleared
 * @param {*[]} breakMeasures   measures to attach a new LINE break to
 * @returns {{removed:number, added:number}}
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
    fixMarcatoStaccatos: fixMarcatoStaccatos,
    fixCourtesyAccidentals: fixCourtesyAccidentals,
    applyLineBreaks: applyLineBreaks
};

// Export trailer — MANDATORY, see api-gotchas "macros actions".
if (typeof exports !== "undefined") { exports = effectsLib; }
