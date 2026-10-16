// @ts-check
// Pure line-break placement for Format Line Breaks.
//
// No MuseScore API here: line_breaks.qml reads each visual box's structural facts
// (double barline? repeat?) into plain data, this file returns the indices of the
// boxes that get a break, and effects.js:applyLineBreaks attaches the LAYOUT_BREAKs.

/**
 * A visual box (what shows as one measure on the page; a multirest is one box),
 * as structural facts — read off the score by effects.js readLineBoxes.
 * @typedef {JK.LineBox} Box
 */

/**
 * A volta's measure span in ticks: [start, end).
 * @typedef {{start:number, end:number}} VoltaSpan
 */

/**
 * Placement options from the dialog.
 * @typedef {Object} BreakOpts
 * @property {boolean} atDouble
 * @property {boolean} atRepeats
 * @property {number} everyN      0 = skip the "every N bars" rule.
 * @property {number} minBars     Minimum visible boxes per line (<=1 = no minimum).
 * @property {number} maxBars     Maximum visible boxes per line (0 = no limit).
 */

/**
 * One line: its box range [s..e] and box count.
 * @typedef {Object} Line
 * @property {number} s
 * @property {number} e
 * @property {number} boxCount
 */

/**
 * Group real measures into visual boxes (what shows as one measure on the page;
 * a multimeasure rest is one box spanning several). A measure starts a new box
 * iff its tick is a box-start (a truthy key in boxStarts); interior measures of
 * a multirest extend the current box. When boxStarts is null (no multirest info)
 * every measure is its own box. Returns index ranges into the input; the .qml
 * maps them back to measure objects.
 * @param {number[]} measureTicks
 * @param {{[tick:number]: boolean|undefined}|null} boxStarts
 * @returns {JK.BoxGroup[]}
 */
function groupBoxes(measureTicks, boxStarts) {
    /** @type {JK.BoxGroup[]} */
    var groups = [];
    var cur = null;
    for (var i = 0; i < measureTicks.length; i++) {
        if (cur === null || !boxStarts || boxStarts[measureTicks[i]]) {
            cur = { firstIdx: i, lastIdx: i, musicBars: 1 };
            groups.push(cur);
        } else {
            cur.lastIdx = i;
            cur.musicBars += 1;
        }
    }
    return groups;
}

/**
 * Per box, where the endings (voltas) are: `endingStart` (N when the box's first
 * measure starts the Nth ending of a group, else 0) and `inEnding` (the box's last
 * measure lies in an ending that another one follows). Endings form a group when
 * each starts where the previous ends. Pure.
 * @param {VoltaSpan[]} voltas
 * @param {{firstTick:number, lastTick:number}[]} boxes  first/last measure start ticks
 * @returns {{endingStart:number, inEnding:boolean}[]}
 */
function voltaFlags(voltas, boxes) {
    var vs = voltas.slice().sort(function (a, b) { return a.start - b.start; });
    /** @type {{start:number, end:number, n:number, last:boolean}[]} */
    var tagged = [];
    for (var i = 0; i < vs.length; ++i) {
        var grouped = i > 0 && vs[i].start === vs[i - 1].end;
        var n = grouped ? tagged[i - 1].n + 1 : 1;
        if (grouped) tagged[i - 1].last = false;
        tagged.push({ start: vs[i].start, end: vs[i].end, n: n, last: true });
    }
    return boxes.map(function (b) {
        var out = { endingStart: 0, inEnding: false };
        for (var k = 0; k < tagged.length; ++k) {
            var v = tagged[k];
            if (v.start === b.firstTick) out.endingStart = v.n;
            if (!v.last && v.start <= b.lastTick && b.lastTick < v.end) out.inEnding = true;
        }
        return out;
    });
}

/**
 * Partition the boxes into lines by the current breaks. tag[i]: 0 none,
 * 1 structural, 2 "every N" (or added to honour maxBars), 3 soft structural (a
 * section end that may be dropped to avoid a too-short line — see computeBreaks).
 * @param {number[]} tag
 * @param {number} n
 * @returns {Line[]}
 */
function computeLines(tag, n) {
    /** @type {Line[]} */
    var lines = [];
    var s = 0;
    for (var i = 0; i < n; ++i) {
        if (tag[i] > 0 || i === n - 1) {
            lines.push({ s: s, e: i, boxCount: i - s + 1 });
            s = i + 1;
        }
    }
    return lines;
}

/**
 * Fix short lines by merging them into a neighbour, until stable. A line is short
 * when it has fewer than minBars boxes, or holds nothing but multimeasure rests (a
 * rest never gets a line of its own if it fits next to something). A short line
 * normally merges into the PREVIOUS line (drop the break before it). But that
 * break is only removable if it is an "every N" or soft break (tag 2/3) - if it is
 * structural (tag 1) or there is no line before, the short line merges into the
 * NEXT line instead (drop the break after it). Structural breaks are never
 * removed. A merge is skipped when it would push the merged line past maxBars
 * visible boxes (0 = no limit). Mutates `tag` in place.
 * @param {number[]} tag
 * @param {number} n
 * @param {number} minBars
 * @param {number} maxBars
 * @param {boolean[]} [restBox]  restBox[i]: box i is a multimeasure rest
 * @returns {void}
 */
function minMerge(tag, n, minBars, maxBars, restBox) {
    var removable = function (/** @type {number} */ t) { return t === 2 || t === 3; };
    var guard = 0;
    while (guard++ < 10000) {
        var lines = computeLines(tag, n);
        var acted = false;
        for (var li = 0; li < lines.length; ++li) {
            var L = lines[li];
            var allRest = !!restBox;
            for (var b = L.s; allRest && b <= L.e; ++b) if (!(restBox && restBox[b])) allRest = false;
            if (L.boxCount >= minBars && !allRest) continue;

            var prev = (li > 0) ? lines[li - 1] : null;
            var next = (li < lines.length - 1) ? lines[li + 1] : null;

            var beforeRemovable = (L.s > 0 && removable(tag[L.s - 1]));
            var afterRemovable  = (L.e < n - 1 && removable(tag[L.e]));
            var canBefore = beforeRemovable && prev && (maxBars <= 0 || prev.boxCount + L.boxCount <= maxBars);
            var canAfter  = afterRemovable  && next && (maxBars <= 0 || L.boxCount + next.boxCount <= maxBars);

            var dropIdx = -1;
            if (beforeRemovable)          // prefer merging into the previous line
                dropIdx = canBefore ? (L.s - 1) : (canAfter ? L.e : -1);
            else if (canAfter)            // structural / no break before -> merge into next
                dropIdx = L.e;

            if (dropIdx >= 0) { tag[dropIdx] = 0; acted = true; break; }
        }
        if (!acted) break;
    }
}

/**
 * Split every line longer than maxBars boxes into the fewest lines that fit, as
 * evenly as possible (10 boxes, max 6 → 5 + 5, not 6 + 4). Mutates `tag`.
 * @param {number[]} tag @param {number} n @param {number} maxBars @returns {void}
 */
function maxSplit(tag, n, maxBars) {
    if (maxBars <= 0) return;
    var lines = computeLines(tag, n);
    for (var li = 0; li < lines.length; ++li) {
        var L = lines[li];
        if (L.boxCount <= maxBars) continue;
        var parts = Math.ceil(L.boxCount / maxBars);
        var at = L.s - 1;
        for (var p = 0; p < parts - 1; ++p) {
            at += Math.ceil((L.e - at) / (parts - p));
            tag[at] = 2;
        }
    }
}

/**
 * Decide which boxes get a line break after them. Returns box indices (into
 * `boxes`) to attach a LINE break to.
 *
 * Structural breaks come first and split the boxes into sections: double
 * barlines and the bar before a rehearsal mark (atDouble), repeats and the bar
 * before a coda sign (atRepeats). Two kinds are SOFT — dropped when they would leave a short line:
 * the end-repeat closing a 1st ending (the 2nd ending may share its line), and a
 * section end next to a multimeasure rest (a rest doesn't need a line of its own).
 * Within a section, "every N" breaks fall on the everyN-bar grid (bars N, 2N, 3N
 * ... from the section start), placed at the box boundary that lands on the grid
 * line - so a 6-bar rest with N=4 keeps counting to bar 8 rather than breaking at
 * 6. A grid line falling between two multirests is skipped (the next one counts),
 * so consecutive rests don't each end a line. A 2nd (3rd, …) ending restarts the
 * count where the 1st ending started — it replaces those bars, so the phrases
 * after it stay on the grid. A pickup bar adds nothing to the count, so the
 * first line holds the pickup plus N full bars. Then lines over maxBars are split evenly, and the
 * minimum-bars rule removes/moves breaks around any line that is too short.
 * @param {Box[]} boxes
 * @param {BreakOpts} opts
 * @returns {number[]}
 */
function computeBreaks(boxes, opts) {
    var n = boxes.length;
    if (n === 0) return [];

    /** @type {number[]} */
    var tag = [];
    /** @type {boolean[]} */
    var structural = [];
    for (var i = 0; i < n; ++i) { tag.push(0); structural.push(false); }

    /** @type {boolean[]} */
    var restBox = [];
    for (var i = 0; i < n; ++i) restBox.push(boxes[i].musicBars > 1);   // a multirest box

    // 1. Structural breaks: hard (tag 1) or soft (tag 3).
    /** @type {boolean[]} */
    var hard = [];
    for (var i = 0; i < n; ++i) hard.push(false);
    for (var i = 0; i < n; ++i) {
        var b = boxes[i];
        if (opts.atDouble && b.endsDouble) { structural[i] = true; hard[i] = true; }
        // a rehearsal mark starts a section; a coda sign starts the coda
        if (((opts.atDouble && b.rehearsal) || (opts.atRepeats && b.coda)) && i > 0) {
            structural[i - 1] = true; hard[i - 1] = true;
        }
        if (opts.atRepeats && b.repeatEnd) {
            structural[i] = true;
            if (!b.inEnding) hard[i] = true;             // a 1st ending's :| stays soft
        }
        // "before start-repeat" -> break on the previous box
        if (opts.atRepeats && b.repeatStart && i > 0) { structural[i - 1] = true; hard[i - 1] = true; }
    }
    structural[n - 1] = false;   // never break on the last box (nothing follows)
    for (var i = 0; i < n; ++i) {
        if (!structural[i]) continue;
        var byRest = restBox[i] || (i + 1 < n && restBox[i + 1]);
        tag[i] = (hard[i] && !byRest) ? 1 : 3;
    }

    // 2. "Every N" breaks on the everyN-bar grid. acc is the cumulative music-bar
    // count from the section start; a break falls where acc lands on a grid line
    // (a multiple of everyN). acc is not reset after a break - only at a section
    // boundary - so the grid stays aligned across multibar rests. A 1st ending's
    // :| is no section boundary: the next ending restarts acc from where the 1st
    // ending began (endingAcc).
    if (opts.everyN >= 1) {
        var acc = 0, endingAcc = 0;
        for (var i = 0; i < n; ++i) {
            var es = boxes[i].endingStart || 0;
            if (es === 1) endingAcc = acc;
            else if (es > 1) acc = endingAcc;
            if (!boxes[i].pickup) acc += boxes[i].musicBars;   // a pickup isn't a bar of the phrase
            if (i === n - 1) break;                      // no break after the last box
            if (structural[i]) {                         // section boundary: restart the grid
                if (!boxes[i].inEnding) acc = 0;
                continue;
            }
            if (acc > 0 && acc % opts.everyN === 0 && !(restBox[i] && restBox[i + 1])) tag[i] = 2;
        }
    }

    // 3. Maximum bars per line, then the minimum: split any too-long line, merge
    // any too-short one (or a rests-only one) into a neighbour.
    maxSplit(tag, n, opts.maxBars);
    minMerge(tag, n, opts.minBars, opts.maxBars, restBox);

    /** @type {number[]} */
    var res = [];
    for (var i = 0; i < n; ++i) if (tag[i] > 0) res.push(i);
    return res;
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var linebreaksLib = {
    groupBoxes: groupBoxes,
    computeLines: computeLines,
    voltaFlags: voltaFlags,
    minMerge: minMerge,
    maxSplit: maxSplit,
    computeBreaks: computeBreaks
};

// Export trailer — MANDATORY, see api-gotchas "macros actions".
if (typeof exports !== "undefined") { exports = linebreaksLib; }
