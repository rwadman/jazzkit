// @ts-check
// Effect layer: the cmd()/cursor sequences that MUTATE the score, factored out of
// the .qml so both the shipping plugin AND test_harness.qml run the identical code
// path (test the real effect, not a copy). Unlike the pure libs (jazzkit/slashes/…)
// these touch the MuseScore API, so they are NOT Node-unit-testable — they are
// exercised by test_harness.qml in the GUI. A stateless QML-imported lib can't see
// MuseScore globals, so everything an effect needs (curScore, cmd, the
// Element/Segment/Cursor enums, sibling libs) is passed in via `ctx`.
//
//   import "lib/effects.js" as Effects   →   Effects.fillEmptyBeats(ctx, a, b, s)

/**
 * The MuseScore globals an effect needs, bundled by the .qml (a QML-imported JS
 * lib can't see them). Each effect uses a subset; unused members may be omitted.
 * @typedef {Object} EffectCtx
 * @property {MS.Score} curScore
 * @property {(code:string)=>void} cmd    dispatch a MuseScore action code
 * @property {(type:number)=>*} [newElement]  QML newElement(Element.X)
 * @property {*} Cmd        commands.js (action-code constants)
 * @property {*} JazzKit    jazzkit.js  (selectStaffRange, countStaves)
 * @property {*} Slashes    slashes.js  (emptyRestRegions — pure, unit-tested)
 * @property {*} [Comp]     comp.js     (comp planners — pure, unit-tested)
 * @property {*} [Articulations] articulations.js (classifyChord — pure, unit-tested)
 * @property {*} Segment    QML Segment enum
 * @property {*} Element    QML Element enum
 * @property {*} Cursor     QML Cursor enum
 * @property {*} [SymId]        QML SymId enum
 * @property {*} [BarLineType]  QML BarLineType enum
 * @property {*} [LayoutBreak]  QML LayoutBreak enum
 */

/**
 * Read each measure's timesig + voice-1 rests as plain data across [selStart,selEnd),
 * then delegate the whole-beat/alignment math to the unit-tested Slashes lib. Requires
 * the selection to be active (rewinds to SELECTION_START to find the first measure).
 * @param {EffectCtx} ctx
 * @returns {{start:number,end:number}[]}
 */
function _emptyRestRegions(ctx, selStart, selEnd, staffIdx) {
    var track = staffIdx * 4; // voice 1
    var measures = [];

    var cursor = ctx.curScore.newCursor();
    cursor.rewind(ctx.Cursor.SELECTION_START);
    var m = cursor.measure;

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

/**
 * Fill the empty whole-beat voice-1 rests of [selStart,selEnd) on staffIdx with
 * slashes. One standalone slash-fill per region (each cmd() lays out between steps —
 * never wrap them in one startCmd; see api-gotchas). Caller must have validated the
 * selection; the effect returns a result object rather than showing dialogs so the
 * harness can assert on it.
 * @param {EffectCtx} ctx
 * @returns {{regions:number, filled:number, selectFailed:boolean}}
 *          regions = fillable regions found; filled = regions slash-filled;
 *          selectFailed = a re-select mid-loop returned false (partial fill).
 */
function fillEmptyBeats(ctx, selStart, selEnd, staffIdx) {
    // Collect up front, from the original state: filling a region adds notes only at
    // its own ticks, so later regions' ticks stay valid.
    var regions = _emptyRestRegions(ctx, selStart, selEnd, staffIdx);
    var filled = 0;

    for (var i = 0; i < regions.length; ++i) {
        if (!ctx.JazzKit.selectStaffRange(ctx.curScore, regions[i].start, regions[i].end, staffIdx)) {
            return { regions: regions.length, filled: filled, selectFailed: true };
        }
        ctx.cmd(ctx.Cmd.SLASH_FILL);
        ++filled;
    }
    return { regions: regions.length, filled: filled, selectFailed: false };
}

// --- Comp plugins (To Comp Slashes / To Comp Cues) --------------------------
// The step SEQUENCE (what to select, which cmd(), the leading-beat/drum/pitched
// branches) is decided by the pure, unit-tested planners in comp.js. These
// executors just walk the returned op list and perform each op via the API.

/**
 * Cue-size the content on staffIdx across [startTick, endTick): set `small` on
 * each voice-1 chord/rest and every notehead. There is no action code for "cue
 * size" — it is the elements' `small` property. Wrapped in one startCmd/endCmd (a
 * single logical edit — not a nest of cmd()s, the crash case in api-gotchas).
 * @param {EffectCtx} ctx
 * @returns {void}
 */
function _makeCueSize(ctx, staffIdx, startTick, endTick) {
    var cursor = ctx.curScore.newCursor();
    cursor.staffIdx = staffIdx;
    cursor.voice = 0; // set track BEFORE rewind (rewindToTick uses the current track)
    cursor.rewindToTick(startTick);

    ctx.curScore.startCmd();
    while (cursor.element && cursor.tick < endTick) {
        var e = cursor.element;
        e.small = true;
        if (e.type === ctx.Element.CHORD && e.notes)
            for (var k = 0; k < e.notes.length; ++k) e.notes[k].small = true;
        if (!cursor.next()) break;
    }
    ctx.curScore.endCmd();
}

/**
 * Walk a planner's op list, performing each op and counting completed targets.
 * A failed selection aborts (the dispatched cmd()s act on curScore.selection, so
 * running against the wrong staff would corrupt it) and returns the op's message.
 * @param {EffectCtx} ctx
 * @param {Object[]} ops
 * @returns {{targetsDone:number, error:string}}
 */
function _runPlan(ctx, ops) {
    var done = 0;
    for (var i = 0; i < ops.length; ++i) {
        var op = ops[i];
        if (op.op === "select") {
            if (!ctx.JazzKit.selectStaffRange(ctx.curScore, op.a, op.b, op.staff))
                return { targetsDone: done, error: op.err };
        } else if (op.op === "cmd") {
            ctx.cmd(op.code);
        } else if (op.op === "cueSize") {
            _makeCueSize(ctx, op.staff, op.a, op.b);
        } else if (op.op === "targetEnd") {
            ++done;
        }
    }
    return { targetsDone: done, error: "" };
}

/**
 * Build the planner params (normalised geometry + source/targets) from the raw
 * selection reads the .qml passes in.
 * @param {EffectCtx} ctx
 * @param {*} params  { selStart, selEnd, measureTick, lastSegmentTick, srcStaffIdx, targets }
 * @returns {*}
 */
function _compParams(ctx, params) {
    var geom = ctx.Comp.selectionGeometry(params);
    geom.srcStaffIdx = params.srcStaffIdx;
    geom.targets = params.targets;
    return geom;
}

/**
 * To Comp Slashes: stamp the captured rhythm as slash notation into voice 1 of
 * every chosen target. `targets` is an array of staff indices.
 * @param {EffectCtx} ctx
 * @param {*} params
 * @returns {{targetsDone:number, error:string}}
 */
function compSlashes(ctx, params) {
    return _runPlan(ctx, ctx.Comp.compSlashesPlan(_compParams(ctx, params), ctx.Cmd));
}

/**
 * To Comp Cues: stamp the captured passage into every chosen target — a cue-size
 * copy for pitched parts, a voice-3 rhythmic comping cue for drum parts.
 * `targets` is an array of { staffIdx, isDrum }.
 * @param {EffectCtx} ctx
 * @param {*} params
 * @returns {{targetsDone:number, error:string}}
 */
function compCues(ctx, params) {
    return _runPlan(ctx, ctx.Comp.compCuesPlan(_compParams(ctx, params), ctx.Cmd));
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
    fillEmptyBeats: fillEmptyBeats,
    compSlashes: compSlashes,
    compCues: compCues,
    fixMarcatoStaccatos: fixMarcatoStaccatos,
    applyLineBreaks: applyLineBreaks
};
