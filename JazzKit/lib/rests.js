// @ts-check
// Pure rhythm grouping for Autofix: how MuseScore itself would write a run of rests
// or a tied note.
//
// A port of MuseScore's toRhythmicDurationList
// (src/engraving/dom/durationtype.cpp: populateRhythmicList,
// splitCompoundBeatsForList, forceRhythmicSplit*, and the TimeSigFrac helpers in
// dom/sig.cpp, v4.7.x) — what Score::setRests uses when it fills a gap, e.g. after
// a range delete. Porting it (instead of inventing "proper" grouping rules) means
// Autofix groups rests exactly as MuseScore would, and the GUI harness can check
// the port against MuseScore's own output. Rests follow setRests (maxDots 1); notes
// follow Regroup rhythms (Score::regroupNotesAndRests, also maxDots 1), whose rules
// are more lenient — a note may cross one unstressed beat (a half note on beat 2 of
// 4/4 stays) but not a stressed one from off the beat (a half note on the second
// eighth splits at beat 3). Ticks use the plugin's `division` (480 per quarter).
//
// No MuseScore API here; effects.js reads the bars and acts on the ones whose
// current rhythm differs from what these functions predict.

/** BeatType, strongest first (dom/sig.h). */
var DOWNBEAT = 0, COMPOUND_STRESSED = 1, SIMPLE_STRESSED = 2, COMPOUND_UNSTRESSED = 3,
    SIMPLE_UNSTRESSED = 4, COMPOUND_SUBBEAT = 5, SUBBEAT = 6;

/**
 * A nominal time signature with MuseScore's TimeSigFrac helpers.
 * @typedef {Object} Sig
 * @property {number} num
 * @property {number} den
 * @property {number} dUnit      ticks of one denominator unit
 * @property {boolean} compound  6/8, 9/8, 12/8… (numerator > 3, divisible by 3)
 * @property {number} beat       ticks per beat (3 dUnits when compound)
 * @property {boolean} triple
 * @property {boolean} duple
 */

/**
 * @param {number} num @param {number} den @param {number} [division] @returns {Sig}
 */
function makeSig(num, den, division) {
    var dUnit = (4 * (division || 480)) / den;
    var compound = num > 3 && num % 3 === 0;
    var beatsPerMeasure = num / (compound ? 3 : 1);
    var triple = beatsPerMeasure % 3 === 0;
    return {
        num: num, den: den, dUnit: dUnit, compound: compound,
        beat: dUnit * (compound ? 3 : 1),
        triple: triple, duple: !triple && beatsPerMeasure % 2 === 0
    };
}

/** @param {Sig} sig @param {number} rtick @returns {number} a BeatType */
function beatType(sig, rtick) {
    if (rtick === 0) return DOWNBEAT;
    if (rtick % sig.dUnit !== 0) return SUBBEAT;
    if (sig.compound && rtick % sig.beat !== 0) return COMPOUND_SUBBEAT;
    var beatNum = rtick / sig.beat;
    var stress = sig.triple ? 3 : (sig.duple ? 2 : Math.floor((sig.num + 1) / 2));
    if (stress && beatNum % stress === 0) return sig.compound ? COMPOUND_STRESSED : SIMPLE_STRESSED;
    return sig.compound ? COMPOUND_UNSTRESSED : SIMPLE_UNSTRESSED;
}

/**
 * Strongest beat strictly inside (r1, r2), stepping by dUnits.
 * @param {Sig} sig @param {number} r1 @param {number} r2 @param {boolean} saveLast
 * @returns {{type:number, crossed:number, split:number}}
 */
function strongestBeatInRange(sig, r1, r2, saveLast) {
    var strongest = SUBBEAT, crossed = 0, split = 0;
    for (var r = r1 + (sig.dUnit - r1 % sig.dUnit); r < r2; r += sig.dUnit) {
        crossed++;
        var t = beatType(sig, r);
        if (t < strongest + (saveLast ? 1 : 0)) { strongest = t; split = r; }
    }
    return { type: strongest, crossed: crossed, split: split };
}

/** @param {Sig} sig @param {number} level @returns {number} */
function subbeatTicks(sig, level) {
    var t = sig.dUnit;
    while (level-- > 0) t /= 2;
    return t;
}

/** 0 on a dUnit, n on a 1/2^n subdivision, -(n) when it can't be halved further.
 *  @param {Sig} sig @param {number} rtick @returns {number} */
function subbeatLevel(sig, rtick) {
    var level = 0, t = sig.dUnit, rem = rtick % t;
    while (rem !== 0) {
        level++;
        if (t % 2 !== 0) return -level;
        t /= 2;
        rem %= t;
    }
    return level;
}

/** @param {Sig} sig @param {number} r1 @param {number} r2
 *  @returns {{level:number, split:number}} */
function strongestSubbeatLevelInRange(sig, r1, r2) {
    for (var level = 0, t = sig.dUnit; ;) {
        var n = Math.floor(r1 / t), m = Math.floor((r2 - 1) / t);
        if (m > n) return { level: level, split: m * t };
        level++;
        if (t % 2 !== 0) return { level: -level, split: 0 };
        t /= 2;
    }
}

/** Note values from a longa down to a 128th, in ticks. @param {number} division @returns {number[]} */
function _bases(division) {
    var out = [];
    for (var b = division * 16; b >= division / 32; b /= 2) out.push(b);
    return out;
}

/**
 * TDuration(l, truncate, maxDots, maxType): the longest value (≤ maxDots dots, no
 * longer a type than `maxBase`) that fits in `l`, or null.
 * @param {number} l @param {number} maxDots @param {number} division @param {number} [maxBase]
 * @returns {{ticks:number, base:number}|null}
 */
function _fit(l, maxDots, division, maxBase) {
    var bases = _bases(division);
    for (var i = 0; i < bases.length; ++i) {
        var b = bases[i];
        if (maxBase && b > maxBase) continue;
        for (var d = maxDots; d >= 0; --d) {
            var v = b * (2 - Math.pow(2, -d));
            if (v <= l && v === Math.floor(v)) return { ticks: v, base: b };
        }
    }
    return null;
}

/** toDurationList: greedy longest-first. @param {number} l @param {number} maxDots
 *  @param {number} division @returns {number[]} */
function _durationList(l, maxDots, division) {
    var out = [], maxBase = 0;
    while (l > 0) {
        var f = _fit(l, maxDots, division, maxBase);
        if (!f) break;
        out.push(f.ticks);
        l -= f.ticks;
        maxBase = f.base;
    }
    return out;
}

/** forceRhythmicSplitSimple. @param {boolean} isRest @param {number} startBeat
 *  @param {number} endBeat @param {number} beatsCrossed @param {number} strongest
 *  @returns {boolean} */
function _splitSimple(isRest, startBeat, endBeat, beatsCrossed, strongest) {
    if (strongest === SIMPLE_STRESSED) {
        if (isRest) return true;                                      // rests always split
        // notes starting or ending on a stressed beat, or on beats at both ends, stay whole
        if (startBeat <= SIMPLE_STRESSED || endBeat <= SIMPLE_STRESSED) return false;
        if (startBeat <= SIMPLE_UNSTRESSED && endBeat <= SIMPLE_UNSTRESSED) return false;
        return true;
    }
    if (strongest === SIMPLE_UNSTRESSED) {
        if (startBeat <= SIMPLE_STRESSED && endBeat <= SIMPLE_STRESSED) return false;
        if (startBeat === SUBBEAT || endBeat === SUBBEAT) return isRest || beatsCrossed > 1;
        return false;
    }
    return false;
}

/** forceRhythmicSplit. @param {Sig} sig @param {boolean} isRest @param {number} startBeat
 *  @param {number} endBeat @param {number} crossed  dUnits crossed @param {number} strongest
 *  @returns {boolean} */
function _forceSplit(sig, isRest, startBeat, endBeat, crossed, strongest) {
    if (strongest <= SIMPLE_STRESSED && !sig.triple && !sig.duple) return true;
    if (isRest && strongest <= SIMPLE_UNSTRESSED && sig.num === 2) return true;
    if (isRest && strongest <= SIMPLE_UNSTRESSED && sig.triple) return true;
    if (!sig.compound) return _splitSimple(isRest, startBeat, endBeat, crossed, strongest);
    switch (strongest) {
    case COMPOUND_STRESSED: return _splitSimple(isRest, startBeat, endBeat, Math.floor(crossed / 3), SIMPLE_STRESSED);
    case COMPOUND_UNSTRESSED: return false;
    case COMPOUND_SUBBEAT:
        if (startBeat <= COMPOUND_UNSTRESSED && endBeat <= COMPOUND_UNSTRESSED) return false;
        if (isRest && startBeat > COMPOUND_UNSTRESSED) return true;
        return _splitSimple(isRest, startBeat, endBeat, crossed, SIMPLE_UNSTRESSED);
    default: return _splitSimple(isRest, startBeat, endBeat, crossed, strongest);
    }
}

/** populateRhythmicList. @param {number[]} out @param {boolean} isRest @param {number} l
 *  @param {number} r1 @param {Sig} sig @param {number} maxDots @param {number} division
 *  @returns {void} */
function _populate(out, isRest, l, r1, sig, maxDots, division) {
    var r2 = r1 + l;
    var startLevel = subbeatLevel(sig, r1), endLevel = subbeatLevel(sig, r2);
    var crossed = strongestSubbeatLevelInRange(sig, r1, r2);
    var split = crossed.split;
    if (startLevel < 0 || endLevel < 0 || crossed.level < 0) {
        Array.prototype.push.apply(out, _durationList(l, maxDots, division));
        return;
    }
    var need = crossed.level < startLevel && crossed.level < endLevel;
    if (startLevel === endLevel && crossed.level === startLevel - 1) need = false;
    if (startLevel === endLevel && crossed.level === startLevel - 2) {
        var st = subbeatTicks(sig, startLevel - 1);
        need = (st - r1 % st) !== (r1 % st);
    }
    if (!need && crossed.level === 0) {
        var startBeat = beatType(sig, r1), endBeat = beatType(sig, r2);
        var sb = strongestBeatInRange(sig, r1, r2, startBeat <= SIMPLE_UNSTRESSED);
        if (sb.crossed > 0) split = sb.split;   // MS only overwrites it when a beat is crossed
        need = _forceSplit(sig, isRest, startBeat, endBeat, sb.crossed, sb.type);
    }
    if (!need) {
        var f = _fit(l, maxDots, division);
        if (f && f.ticks === l) { out.push(l); return; }
    }
    if (!(r1 < split && split < r2)) {
        Array.prototype.push.apply(out, _durationList(l, maxDots, division));
        return;
    }
    _populate(out, isRest, split - r1, r1, sig, maxDots, division);
    _populate(out, isRest, r2 - split, split, sig, maxDots, division);
}

/** splitCompoundBeatsForList. @param {number[]} out @param {boolean} isRest @param {number} l
 *  @param {number} r1 @param {Sig} sig @param {number} maxDots @param {number} division
 *  @returns {void} */
function _splitCompound(out, isRest, l, r1, sig, maxDots, division) {
    var r2 = r1 + l;
    if (beatType(sig, r1) > COMPOUND_UNSTRESSED) {
        var toNext = sig.beat - r1 % sig.beat;
        if (l > toNext) {
            _populate(out, isRest, toNext, r1, sig, maxDots, division);
            _splitCompound(out, isRest, l - toNext, r1 + toNext, sig, maxDots, division);
            return;
        }
    }
    if (beatType(sig, r2) > COMPOUND_UNSTRESSED) {
        var past = r2 % sig.beat;
        if (l > past) {
            _populate(out, isRest, l - past, r1, sig, maxDots, division);
            _populate(out, isRest, past, r2 - past, sig, maxDots, division);
            return;
        }
    }
    _populate(out, isRest, l, r1, sig, maxDots, division);
}

/**
 * The pieces (tick lengths, in order) MuseScore writes for a rest gap / a tied note
 * of `len` ticks starting `rtick` ticks into a bar of `num/den` (toRhythmicDurationList,
 * maxDots 1). For a rest filling the WHOLE bar MuseScore writes one full-measure rest
 * instead; callers handle that.
 * @param {boolean} isRest
 * @param {number} num @param {number} den @param {number} rtick @param {number} len
 * @param {number} [division]
 * @returns {number[]}
 */
function rhythmDurations(isRest, num, den, rtick, len, division) {
    var div = division || 480;
    var sig = makeSig(num, den, div);
    /** @type {number[]} */
    var out = [];
    if (len <= 0) return out;
    if (sig.compound) _splitCompound(out, isRest, len, rtick, sig, 1, div);
    else _populate(out, isRest, len, rtick, sig, 1, div);
    return out;
}

/** rhythmDurations for rests (Score::setRests' grouping of a partial bar).
 *  @param {number} num @param {number} den @param {number} rtick @param {number} len
 *  @param {number} [division] @returns {number[]} */
function restDurations(num, den, rtick, len, division) {
    return rhythmDurations(true, num, den, rtick, len, division);
}

/** rhythmDurations for a note (Regroup rhythms' grouping of a tie chain).
 *  @param {number} num @param {number} den @param {number} rtick @param {number} len
 *  @param {number} [division] @returns {number[]} */
function noteDurations(num, den, rtick, len, division) {
    return rhythmDurations(false, num, den, rtick, len, division);
}

/**
 * Maximal runs of consecutive plain rests in ONE voice of one bar (tuplet members,
 * and anything that isn't a rest, break a run). Pure.
 * @param {{rtick:number, ticks:number, isRest:boolean, inTuplet:boolean}[]} crs  in order
 * @returns {{start:number, end:number, lengths:number[]}[]}
 */
function restRuns(crs) {
    var out = [], cur = null;
    for (var i = 0; i < crs.length; ++i) {
        var c = crs[i];
        if (!c.isRest || c.inTuplet) { cur = null; continue; }
        if (cur && cur.end === c.rtick) { cur.end += c.ticks; cur.lengths.push(c.ticks); continue; }
        cur = { start: c.rtick, end: c.rtick + c.ticks, lengths: [c.ticks] };
        out.push(cur);
    }
    return out;
}

/** Same lengths in the same order. @param {number[]} a @param {number[]} b @returns {boolean} */
function sameLengths(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Would Regroup rhythms change this voice of this bar? It rewrites every run of
 * plain rests and every chain of tied chords (tuplet members are left alone), so
 * the bar changes iff some run/chain isn't already written the way
 * rhythmDurations says. A rest run filling the whole bar counts as fine when it is
 * one piece. `tiedNext`: every note of the chord is tied into the NEXT chord. Pure.
 * @param {number} num @param {number} den
 * @param {{rtick:number, ticks:number, isRest:boolean, inTuplet:boolean, tiedNext:boolean}[]} crs
 * @param {number} barTicks
 * @param {number} [division]
 * @returns {boolean}
 */
function voiceNeedsRegroup(num, den, crs, barTicks, division) {
    var i = 0;
    while (i < crs.length) {
        var c = crs[i];
        if (c.inTuplet) { ++i; continue; }
        var start = c.rtick, lengths = [c.ticks], end = c.rtick + c.ticks, j = i + 1;
        while (j < crs.length && !crs[j].inTuplet && crs[j].rtick === end
               && (c.isRest ? crs[j].isRest : (!crs[j].isRest && crs[j - 1].tiedNext))) {
            lengths.push(crs[j].ticks);
            end += crs[j].ticks;
            ++j;
        }
        var whole = c.isRest && start === 0 && end === barTicks;
        var want = whole ? [barTicks] : rhythmDurations(c.isRest, num, den, start, end - start, division);
        if (!sameLengths(lengths, want)) return true;
        i = j;
    }
    return false;
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var restsLib = {
    makeSig: makeSig,
    beatType: beatType,
    restDurations: restDurations,
    noteDurations: noteDurations,
    voiceNeedsRegroup: voiceNeedsRegroup,
    restRuns: restRuns,
    sameLengths: sameLengths
};

// Export trailer — MANDATORY, see api-gotchas "macros actions".
if (typeof exports !== "undefined") { exports = restsLib; }
