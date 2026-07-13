// @ts-check
// Pure line-break placement for Format Line Breaks.
//
// No MuseScore API here. The .qml collects the visual boxes and reads the
// structural facts it needs off each one (does it end with a double barline? a
// repeat?) into plain data; this file decides which boxes get a break after
// them and returns their indices. The .qml maps those indices back to measures
// and attaches the LAYOUT_BREAKs.
//
//   QML:  import "lib/linebreaks.js" as LineBreaks

/**
 * A visual box (what shows as one measure on the page; a multirest is one box).
 * @typedef {Object} Box
 * @property {number} musicBars    Real measures the box spans (a multirest is N bars).
 * @property {boolean} endsDouble  The box's last measure ends with a double barline.
 * @property {boolean} repeatEnd   The box's last measure is an end-repeat.
 * @property {boolean} repeatStart The box's first measure is a start-repeat.
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
 * @param {Object<number, boolean>|null} boxStarts
 * @returns {{ firstIdx: number, lastIdx: number, musicBars: number }[]}
 */
function groupBoxes(measureTicks, boxStarts) {
    /** @type {{ firstIdx: number, lastIdx: number, musicBars: number }[]} */
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
 * Partition the boxes into lines by the current breaks. tag[i]: 0 none,
 * 1 structural, 2 "every N".
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
 * Fix lines shorter than minBars boxes by merging them into a neighbour, until
 * stable. A short line normally merges into the PREVIOUS line (drop the break
 * before it). But that break is only removable if it is an "every N" break
 * (tag 2) - if it is structural (tag 1) or there is no line before, the short
 * line merges into the NEXT line instead (drop the break after it). Structural
 * breaks are never removed. A merge is skipped when it would push the merged
 * line past maxBars visible boxes (0 = no limit). Mutates `tag` in place.
 * @param {number[]} tag
 * @param {number} n
 * @param {number} minBars
 * @param {number} maxBars
 * @returns {void}
 */
function minMerge(tag, n, minBars, maxBars) {
    if (minBars <= 1) return;
    var guard = 0;
    while (guard++ < 10000) {
        var lines = computeLines(tag, n);
        var acted = false;
        for (var li = 0; li < lines.length; ++li) {
            var L = lines[li];
            if (L.boxCount >= minBars) continue;

            var prev = (li > 0) ? lines[li - 1] : null;
            var next = (li < lines.length - 1) ? lines[li + 1] : null;

            var beforeRemovable = (L.s > 0 && tag[L.s - 1] === 2);
            var afterRemovable  = (L.e < n - 1 && tag[L.e] === 2);
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
 * Decide which boxes get a line break after them. Returns box indices (into
 * `boxes`) to attach a LINE break to.
 *
 * Structural breaks (double barlines / repeats) come first and split the boxes
 * into sections. Within a section, "every N" breaks fall on the everyN-bar grid
 * (bars N, 2N, 3N ... from the section start), placed at the box boundary that
 * lands on the grid line - so a 6-bar rest with N=4 keeps counting to bar 8
 * rather than breaking at 6. Finally the minimum-bars rule removes/moves breaks
 * around any line with too few boxes.
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

    // 1. Structural breaks.
    for (var i = 0; i < n; ++i) {
        var b = boxes[i];
        if (opts.atDouble && b.endsDouble) structural[i] = true;
        if (opts.atRepeats && b.repeatEnd) structural[i] = true;
        // "before start-repeat" -> break on the previous box
        if (opts.atRepeats && b.repeatStart && i > 0) structural[i - 1] = true;
    }
    structural[n - 1] = false;   // never break on the last box (nothing follows)
    for (var i = 0; i < n; ++i) if (structural[i]) tag[i] = 1;

    // 2. "Every N" breaks on the everyN-bar grid. acc is the cumulative music-bar
    // count from the section start; a break falls where acc lands on a grid line
    // (a multiple of everyN). acc is not reset after a break - only at a section
    // boundary - so the grid stays aligned across multibar rests.
    if (opts.everyN >= 1) {
        var acc = 0;
        for (var i = 0; i < n; ++i) {
            acc += boxes[i].musicBars;
            if (i === n - 1) break;                      // no break after the last box
            if (structural[i]) { acc = 0; continue; }    // section boundary: restart the grid
            if (acc % opts.everyN === 0) tag[i] = 2;
        }
    }

    // 3. Minimum bars per line: merge any too-short line into a neighbour.
    minMerge(tag, n, opts.minBars, opts.maxBars);

    /** @type {number[]} */
    var res = [];
    for (var i = 0; i < n; ++i) if (tag[i] > 0) res.push(i);
    return res;
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var linebreaksLib = {
    groupBoxes: groupBoxes,
    computeLines: computeLines,
    minMerge: minMerge,
    computeBreaks: computeBreaks
};
