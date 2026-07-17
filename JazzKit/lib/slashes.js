// @ts-check
// Pure rhythm helpers for Fill Empty Beats with Slashes.
//
// No MuseScore API here. The .qml walks the score and reads out, per measure,
// its time signature and voice-1 rest segments as plain data; this file does the
// beat math and whole-beat alignment. The .qml then runs slash-fill on each
// returned region.
//
//   QML:  import "lib/slashes.js" as Slashes

/**
 * One rest segment in voice 1: its start tick and duration in ticks.
 * @typedef {Object} Rest
 * @property {number} tick
 * @property {number} durTicks
 */

/**
 * A measure reduced to what region-finding needs.
 * @typedef {Object} MeasureRests
 * @property {number} mStart        Tick of the measure's first segment.
 * @property {number} numerator     Time-signature numerator.
 * @property {number} denominator   Time-signature denominator.
 * @property {number} measureTicks  Total ticks in the measure (timesig.ticks).
 * @property {Rest[]} rests         Voice-1 rest segments, in order.
 */

/**
 * Beat length in ticks, mirroring MuseScore's slash-fill: compound meters
 * (denominator > 4 and numerator divisible by 3) group in threes.
 * @param {number} numerator
 * @param {number} denominator
 * @param {number} measureTicks
 * @returns {number}
 */
function beatTicks(numerator, denominator, measureTicks) {
    var n = (denominator > 4 && numerator % 3 === 0) ? 3 : 1;
    return Math.floor(measureTicks * n / numerator);
}

/**
 * Collect the [start, end) tick ranges of voice-1 rests within the selection
 * that are whole-beat aligned. Each such range is a run where voice 1 is empty;
 * running slash-fill on it fills those beats into voice 1 without disturbing
 * existing voice-1 notes elsewhere. Rests that share a beat with a note
 * (off-beat / sub-beat) fail the alignment test and are skipped.
 * @param {MeasureRests[]} measures
 * @param {number} selStart
 * @param {number} selEnd
 * @returns {{ start: number, end: number }[]}
 */
function emptyRestRegions(measures, selStart, selEnd) {
    /** @type {{ start: number, end: number }[]} */
    var regions = [];
    for (var i = 0; i < measures.length; i++) {
        var m = measures[i];
        var beat = beatTicks(m.numerator, m.denominator, m.measureTicks);
        if (beat <= 0) continue;

        for (var j = 0; j < m.rests.length; j++) {
            var st = m.rests[j].tick;
            var dur = m.rests[j].durTicks;

            // Clip to the selection.
            var rs = Math.max(st, selStart);
            var re = Math.min(st + dur, selEnd);
            if (re <= rs) continue;

            // Only whole beats: aligned to a beat boundary and a beat multiple.
            if ((rs - m.mStart) % beat !== 0) continue;
            if ((re - rs) % beat !== 0) continue;

            regions.push({ start: rs, end: re });
        }
    }
    return regions;
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var slashesLib = {
    beatTicks: beatTicks,
    emptyRestRegions: emptyRestRegions
};

// require()-able from an extension macro; no-op under QML import / Node loader.
if (typeof exports !== "undefined") { exports = slashesLib; }
