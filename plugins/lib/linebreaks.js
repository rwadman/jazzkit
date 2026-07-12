// Pure line-break placement for Format Line Breaks.
//
// No MuseScore API here. The .qml collects the visual boxes and reads the
// structural facts it needs off each one (does it end with a double barline? a
// repeat?) into plain data; this file decides which boxes get a break after
// them and returns their indices. The .qml maps those indices back to measures
// and attaches the LAYOUT_BREAKs.
//
//   QML:  import "lib/linebreaks.js" as LineBreaks
//
// A `box` here is: { musicBars, endsDouble, repeatEnd, repeatStart }
//   musicBars   - real measures the box spans (a multirest is one box, N bars)
//   endsDouble  - the box's last measure ends with a double barline
//   repeatEnd   - the box's last measure is an end-repeat
//   repeatStart - the box's first measure is a start-repeat
// `opts` is: { atDouble, atRepeats, everyN, minBars, maxBars }

// Partition the boxes into lines by the current breaks. Each line records its
// box range [s..e] and box count (both min and max rules count visible boxes,
// a multirest being one box). tag[i]: 0 none, 1 structural, 2 "every N".
function computeLines(tag, n) {
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

// Fix lines shorter than minBars boxes by merging them into a neighbour, until
// stable. A short line normally merges into the PREVIOUS line (drop the break
// before it). But that break is only removable if it is an "every N" break
// (tag 2) - if it is structural (tag 1) or there is no line before, the short
// line merges into the NEXT line instead (drop the break after it). Structural
// breaks are never removed. A merge is skipped when it would push the merged
// line past maxBars visible boxes (0 = no limit). Mutates `tag` in place.
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

// Decide which boxes get a line break after them. Returns box indices (into
// `boxes`) to attach a LINE break to.
//
// Structural breaks (double barlines / repeats) come first and split the boxes
// into sections. Within a section, "every N" breaks fall on the everyN-bar grid
// (bars N, 2N, 3N ... from the section start), placed at the box boundary that
// lands on the grid line - so a 6-bar rest with N=4 keeps counting to bar 8
// rather than breaking at 6. Finally the minimum-bars rule removes/moves breaks
// around any line with too few boxes.
function computeBreaks(boxes, opts) {
    var n = boxes.length;
    if (n === 0) return [];

    var tag = [];
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

    var res = [];
    for (var i = 0; i < n; ++i) if (tag[i] > 0) res.push(i);
    return res;
}

var JazzKitExports = {
    computeLines: computeLines,
    minMerge: minMerge,
    computeBreaks: computeBreaks
};
