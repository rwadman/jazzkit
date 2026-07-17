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
 * @property {*} JazzKit    jazzkit.js  (selectStaffRange, countStaves)
 * @property {*} Slashes    slashes.js  (emptyRestRegions — pure, unit-tested)
 * @property {*} [Articulations] articulations.js (classifyChord — pure, unit-tested)
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
 */

/**
 * Read each measure's timesig + voice-1 rests as plain data across [selStart,selEnd),
 * then delegate the whole-beat/alignment math to the unit-tested Slashes lib. Finds
 * the first measure from selStart (does NOT depend on the live selection).
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
// cue-sized, carrying only articulations (accents/staccato/…) — NOT the slurs,
// dynamics, text, etc. a clipboard paste drags along. Being pure cursor/API (no
// cmd()), this runs from a form, so the picker + apply live in one dialog.
//
// Limitation (v1): reproduces per-segment durations, pitches (incl. chords) and
// articulations. It does not yet re-create tuplets or ties, and assumes the
// written segments line up 1:1 with the source (true when no duration crosses a
// barline). Drum targets are left to the slash path (handled separately).

/**
 * Read the source voice-1 chord/rests across [selStart, selEnd) as plain data.
 * @param {EffectCtx} ctx  needs curScore, Cursor, Element
 * @returns {{num:number,den:number,isRest:boolean,pitches:number[],accents:*[]}[]}
 */
function _readSourceCRs(ctx, selStart, selEnd, srcStaffIdx) {
    var cursor = ctx.curScore.newCursor();
    cursor.staffIdx = srcStaffIdx;   // set track BEFORE rewind (api-gotchas)
    cursor.voice = 0;
    cursor.rewindToTick(selStart);

    var out = [];
    while (cursor.segment && cursor.tick < selEnd) {
        var el = cursor.element;
        if (el && el.duration) {
            var item = {
                tick: cursor.tick,   // absolute start tick (for tick-aligned pass 2)
                num: el.duration.numerator, den: el.duration.denominator,
                isRest: el.type === ctx.Element.REST, pitches: [], accents: []
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
 * Write the read source into voice 1 of one target staff: pitches/durations
 * first, then a second pass to cue-size the chords and copy their articulations.
 * @param {EffectCtx} ctx  needs curScore, newElement, Element, division
 */
function _writeCueInto(ctx, staffIdx, measureTick, selStart, selEnd, src) {
    // Pass 1 — durations + pitches.
    // We CANNOT rewindToTick(selStart) on an empty target: rewindToTick skips
    // forward past any segment with no element in this track (api-gotchas), and a
    // full-measure rest has its only segment at the MEASURE START — so a score-wide
    // segment at selStart (created by the source staff) has no target element, and
    // the cursor skips forward into the NEXT measure. Instead rewind to the measure
    // start (which always has a target chord/rest) and fill a leading rest up to
    // selStart. That both positions us and splits the spanning rest at selStart
    // (the "divide existing notes" step).
    var cur = ctx.curScore.newCursor();
    cur.staffIdx = staffIdx;
    cur.voice = 0;
    cur.rewindToTick(measureTick);
    if (cur.tick < selStart) {
        _setDurationTicks(ctx, cur, selStart - cur.tick);
        cur.addRest();
    }
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        cur.setDuration(cr.num, cr.den);
        if (cr.isRest || cr.pitches.length === 0) {
            cur.addRest();
        } else {
            cur.addNote(cr.pitches[0], false);
            for (var k = 1; k < cr.pitches.length; ++k) cur.addNote(cr.pitches[k], true);
        }
    }

    // Pass 2 — cue-size + articulations. A source note whose duration crosses a
    // barline was written as several TIED slices, so there can be more target
    // chords than source notes. Walk by TICK (not index): every cue chord in the
    // range is cue-sized, and a source note's accents go on the slice that starts
    // at that note's tick (the head of the tie group).
    var accentAt = {};   // absolute source tick -> accents[]
    for (var m = 0; m < src.length; ++m) {
        if (!src[m].isRest && src[m].accents.length) accentAt[src[m].tick] = src[m].accents;
    }

    var c2 = ctx.curScore.newCursor();
    c2.staffIdx = staffIdx;
    c2.voice = 0;
    c2.rewindToTick(selStart);
    while (c2.segment && c2.tick < selEnd) {
        var wel = c2.element;
        if (wel && wel.type === ctx.Element.CHORD) {
            try { wel.small = true; } catch (e) { }
            var acc = accentAt[c2.tick];
            if (acc) {
                for (var a = 0; a < acc.length; ++a) {
                    if (acc[a] === undefined) continue;
                    var art = ctx.newElement(ctx.Element.ARTICULATION);
                    art.symbol = acc[a];
                    c2.add(art);   // attaches to the chord at the cursor
                }
            }
        }
        c2.next();
    }
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

/**
 * The pitch to write into staffIdx. A pitched staff takes any pitch (SLASH_PITCH,
 * hidden by FIXED_LINE + play off). A DRUM staff drops invalid drum pitches
 * silently and forces the voice by pitch (api-gotchas), so we must pick a VALID
 * drum pitch — preferring one whose drumset voice is `wantVoice` so the note stays
 * in the voice we're writing. Returns -1 if a drum staff has no usable pitch.
 */
function _slashPitch(ctx, staffIdx, wantVoice) {
    var part = _partForStaff(ctx, staffIdx);
    var inst = part && part.instrumentAtTick ? part.instrumentAtTick(0) : null;
    var ds = inst ? inst.drumset : null;
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
    try { chord.stemDirection = ctx.Direction.DOWN; } catch (e) { }
    if (stemless) {
        try { chord.noStem = true; } catch (e2) { }
        try { chord.beamMode = ctx.Beam.NONE; } catch (e3) { }
    }
    var notes = chord.notes || [];
    for (var i = 0; i < notes.length; ++i) {
        var n = notes[i];
        try { n.headGroup = ctx.NoteHeadGroup.HEAD_SLASH; } catch (e4) { }
        try { n.fixed = true; } catch (e5) { }
        try { n.fixedLine = line; } catch (e6) { }
        try { n.play = false; } catch (e7) { }
        if (i > 0) { try { n.visible = false; } catch (e8) { } }   // hide all but first notehead
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
    var cur = ctx.curScore.newCursor();
    cur.staffIdx = staffIdx;
    cur.voice = 0;
    cur.rewindToTick(measureTick);
    if (cur.tick < selStart) { _setDurationTicks(ctx, cur, selStart - cur.tick); cur.addRest(); }
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        cur.setDuration(cr.num, cr.den);
        if (cr.isRest) cur.addRest();
        else cur.addNote(pitch, false);
    }

    var c2 = ctx.curScore.newCursor();
    c2.staffIdx = staffIdx;
    c2.voice = 0;
    c2.rewindToTick(selStart);
    while (c2.segment && c2.tick < selEnd) {
        if (c2.element && c2.element.type === ctx.Element.CHORD) _applySlashChord(ctx, c2.element, false, 4);
        c2.next();
    }
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
    var part = _partForStaff(ctx, staffIdx);
    var inst = part && part.instrumentAtTick ? part.instrumentAtTick(0) : null;
    var ds = inst ? inst.drumset : null;
    if (!ds) return null;                       // pitched staff
    for (var p = 0; p < 128; ++p) if (ds.isValid(p)) return p;
    return -1;                                  // drumset with no valid pitch (unexpected)
}

/** Dress a written chord as a drum cue note (cue-size, silent, stem up, above staff,
 *  NORMAL notehead). */
function _applyDrumCueChord(ctx, chord) {
    try { chord.small = true; } catch (e) { }
    try { chord.stemDirection = ctx.Direction.UP; } catch (e2) { }
    var notes = chord.notes || [];
    for (var i = 0; i < notes.length; ++i) {
        var n = notes[i];
        try { n.headGroup = ctx.NoteHeadGroup.HEAD_NORMAL; } catch (e4) { }
        try { n.fixed = true; } catch (e5) { }
        try { n.fixedLine = DRUM_CUE_LINE; } catch (e6) { }
        try { n.play = false; } catch (e7) { }
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

    // Pass 1: rest shell across [measureTick, selEnd) in voice V, recording which
    // ticks are notes (not rests). addRest goes through enterRest — no voice-forcing.
    var cur = ctx.curScore.newCursor();
    cur.staffIdx = staffIdx;
    cur.voice = 0;                      // voice 0 always has content
    cur.rewindToTick(measureTick);
    cur.voice = V;                      // switch (keeps the segment; api-gotchas empty-voice trick)
    if (cur.tick < selStart) { _setDurationTicks(ctx, cur, selStart - cur.tick); cur.addRest(); }
    var noteTicks = {};                 // tick → true at each note position
    for (var i = 0; i < src.length; ++i) {
        var cr = src[i];
        if (!cr.isRest) noteTicks[cur.tick] = true;
        cur.setDuration(cr.num, cr.den);
        cur.addRest();
    }

    // Pass 2: replace each note-beat rest with a cue chord. Rewind on voice 0 (has a
    // boundary at measureTick) then switch to voice V and walk the shell.
    var wc = ctx.curScore.newCursor();
    wc.staffIdx = staffIdx;
    wc.voice = 0;
    wc.rewindToTick(measureTick);
    wc.voice = V;
    while (wc.segment && wc.tick < selEnd) {
        if (noteTicks[wc.tick] && wc.element && wc.element.type === ctx.Element.REST) {
            var restDur = wc.element.duration;          // capture before replacing
            var chord = ctx.newElement(ctx.Element.CHORD);
            var note = ctx.newElement(ctx.Element.NOTE);
            note.pitch = pitch;
            chord.add(note);
            wc.add(chord);                              // replaces the rest at wc.track (voice V)
            try { chord.duration = restDur; } catch (e) { }   // fix invalid duration
            _applyDrumCueChord(ctx, chord);
        }
        wc.next();
    }
}

/**
 * To Comp Slashes (direct API). `targets` is an array of staff indices.
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
        _writeSlashRhythmInto(ctx, params.targets[t], params.measureTick, params.selStart, params.selEnd, src);
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

/** The measure containing `tick`, or null. */
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
    var cur = ctx.curScore.newCursor();
    cur.staffIdx = staffIdx;
    cur.voice = 0;
    cur.rewindToTick(start);
    if (cur.tick !== start) return false;   // guard: don't corrupt earlier beats

    var f = ticksToFraction(beat, ctx.division);
    for (var t = start; t < end; t += beat) {
        cur.setDuration(f.z, f.n);
        cur.addNote(SLASH_PITCH, false);
    }

    var c2 = ctx.curScore.newCursor();
    c2.staffIdx = staffIdx;
    c2.voice = 0;
    c2.rewindToTick(start);
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
 * @param {*} el      the chord element
 * @param {MS.Cursor} cursor
 * @param {boolean} wantAbove
 * @returns {boolean}
 */
function _tryAddHiddenStaccato(ctx, el, cursor, wantAbove) {
    var candidates = [];
    try { candidates = ctx.Articulations.staccatoCandidates(ctx.SymId, wantAbove); } catch (e) { candidates = []; }

    for (var j = 0; j < candidates.length; ++j) {
        var cand = candidates[j];
        if (!cand) continue;
        var s = ctx.newElement(ctx.Element.ARTICULATION);
        try { s.hidden = true; } catch (e) { }
        try { s.visible = false; } catch (e) { }
        s.symbol = cand;
        cursor.add(s);

        var articulations = el.articulations || [];
        for (var k = 0; k < articulations.length; ++k) {
            var a2 = articulations[k];
            if (!a2) continue;
            if (ctx.Articulations.articSymbol(a2) == cand) {
                try { a2.hidden = true; } catch (e) { }
                try { a2.visible = false; } catch (e) { }
                return true;
            }
        }
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
            try { a.hidden = true; } catch (e) { }
            try { a.visible = false; } catch (e) { }
        }
        result.hidden = 1;
        return result;
    }

    if (_tryAddHiddenStaccato(ctx, el, cursor, c.addAbove)) result.added = 1;
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
// (Effects touch the API, so they aren't Node-unit-tested — this trailer keeps the
// same export shape as the pure libs.)
var effectsLib = {
    compCuesNotes: compCuesNotes,
    compSlashesNotes: compSlashesNotes,
    fillEmptyBeatsNotes: fillEmptyBeatsNotes,
    ticksToFraction: ticksToFraction,
    fixMarcatoStaccatos: fixMarcatoStaccatos,
    applyLineBreaks: applyLineBreaks
};

// require()-able from an extension macro; no-op under QML import / Node loader.
if (typeof exports !== "undefined") { exports = effectsLib; }
