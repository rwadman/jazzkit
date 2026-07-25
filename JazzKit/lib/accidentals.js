// @ts-check
// Pure courtesy-accidental logic for the Autofix action.
//
// No MuseScore API here. The effect layer (effects.js) reads each staff as plain
// data — one entry per sounding note, in tick/track order, grouped by measure —
// and hands it to planStaff, which decides per note whether an accidental must be
// ADDED (required, or a courtesy carried over from the previous bar), REMOVED
// (present but superfluous) or left alone. Every decision below is a plain
// function testable in Node; effects.js only executes them.
//
//   QML:  import "lib/accidentals.js" as Accidentals
//
// Model (same one MuseScore engraves by, and the one the shipped
// `courtesy_accidentals` extension uses):
//   * a "note class" is a staff position — letter + octave, e.g. "B4";
//   * a "note name" is that class's current spelling, e.g. "B", "Bb", "B#";
//   * within a measure an accidental holds for every later note of the same class
//     in the same staff (all voices); at the barline the state resets to the key
//     signature.
// A courtesy accidental is therefore one that is NOT required by that model but
// reminds the reader that a class altered in the PREVIOUS bar has reverted.

/** tpc → note name. Index is `tpc + 1` (tpc -1 = Fbb … tpc 33 = B##). */
var TPC_NAMES = [
    "Fbb", "Cbb", "Gbb", "Dbb", "Abb", "Ebb", "Bbb",
    "Fb", "Cb", "Gb", "Db", "Ab", "Eb", "Bb",
    "F", "C", "G", "D", "A", "E", "B",
    "F#", "C#", "G#", "D#", "A#", "E#", "B#",
    "F##", "C##", "G##", "D##", "A##", "E##", "B##"
];

/** The 7 natural tpcs are 13..19 (F C G D A E B); a key signature of `k` sharps
 *  (negative = flats) shifts that window by k. */
var NATURAL_TPC_MIN = 13;

/**
 * Note name for a tonal pitch class, or "" when out of range.
 * @param {number} tpc
 * @returns {string}
 */
function tpcName(tpc) {
    var n = TPC_NAMES[tpc + 1];
    return n === undefined ? "" : n;
}

/**
 * The accidental a note with this tpc needs when one must be written, as an
 * `Accidental` enum MEMBER NAME (the effect layer maps it via the QML global —
 * a pure lib can't see enums).
 * @param {number} tpc
 * @returns {string}  "FLAT2" | "FLAT" | "NATURAL" | "SHARP" | "SHARP2"
 */
function accidentalNameForTpc(tpc) {
    if (tpc < 6) return "FLAT2";
    if (tpc < 13) return "FLAT";
    if (tpc < 20) return "NATURAL";
    if (tpc < 27) return "SHARP";
    return "SHARP2";
}

/**
 * Staff position of a note: letter + octave. The octave comes from the MIDI
 * pitch, corrected for the two spellings that cross an octave boundary — Cb/Cbb
 * sound in the octave BELOW the C they are written on, B#/B## in the one above.
 * `tpc1` (concert pitch) is used for that test so it also holds for transposing
 * instruments, exactly as the shipped courtesy_accidentals plugin does.
 * @param {number} pitch  MIDI pitch
 * @param {number} tpc    written tpc (spelling shown on this staff)
 * @param {number} tpc1   concert-pitch tpc
 * @returns {{noteClass:string, noteName:string}}
 */
function noteClassOf(pitch, tpc, tpc1) {
    var octave = Math.floor(pitch / 12);
    if (tpc1 === 7 || tpc1 === 0) octave++;        // Cb, Cbb → written an octave up
    if (tpc1 === 26 || tpc1 === 33) octave--;      // B#, B## → written an octave down
    var noteName = tpcName(tpc);
    return { noteClass: noteName.charAt(0) + octave, noteName: noteName };
}

/**
 * The spelling the key signature gives a letter, e.g. keySig -2 (Bb major) → "B"
 * becomes "Bb". `keySig` is MuseScore's signed sharp count (cursor.keySignature).
 * @param {string} letter  "A".."G"
 * @param {number} keySig
 * @returns {string}
 */
function keyNameForLetter(letter, keySig) {
    var base = NATURAL_TPC_MIN + (keySig || 0);
    for (var tpc = base; tpc < base + 7; ++tpc) {
        var n = tpcName(tpc);
        if (n.charAt(0) === letter) return n;
    }
    return letter;   // unreachable for a sane key signature
}

/**
 * One note as planStaff sees it.
 * @typedef {Object} NoteData
 * @property {number} pitch
 * @property {number} tpc     written tpc
 * @property {number} tpc1    concert tpc
 * @property {boolean} hasAccidental   an accidental is currently engraved on it
 * @property {boolean} [tiedBack]      continuation of a tie (never needs one)
 */

/**
 * One measure of one staff: its key signature and its notes in tick/track order
 * (grace notes before the chord they decorate, all voices merged).
 * @typedef {Object} MeasureData
 * @property {number} keySig
 * @property {NoteData[]} notes
 */

/**
 * What to do with one note. `index` is its position in the flattened note stream
 * (measure by measure, in the order given) so the caller can pair a decision back
 * with the live API object.
 * @typedef {Object} AccidentalDecision
 * @property {number} index
 * @property {"add"|"remove"} action
 * @property {string} [accidentalType]  Accidental enum member name (adds only).
 * @property {boolean} [courtesy]       True when the add is a reminder, not required.
 */

/**
 * Plan the accidental edits for ONE staff.
 *
 * Per measure we track `cur[noteClass] = noteName` (what is currently sounding)
 * and carry the previous measure's table in `prev`. For each note:
 *   - a tied-back note never needs an accidental → remove any it has;
 *   - if its spelling differs from what is currently in force, an accidental is
 *     REQUIRED → add it when missing;
 *   - otherwise, if the previous measure left this class on a DIFFERENT spelling,
 *     a courtesy accidental is wanted → add it when missing (first occurrence in
 *     the bar only);
 *   - otherwise any accidental it carries is superfluous → remove it.
 * A key change wipes the carry-over (the new signature already re-states things).
 *
 * Notes with no decision are simply absent from the result.
 * @param {MeasureData[]} measures
 * @returns {AccidentalDecision[]}
 */
function planStaff(measures) {
    /** @type {AccidentalDecision[]} */
    var out = [];
    /** @type {Object<string,string>} */
    var prev = {};
    var index = 0;
    var prevKeySig = null;

    for (var mi = 0; mi < measures.length; ++mi) {
        var measure = measures[mi];
        var keySig = measure.keySig || 0;
        if (prevKeySig !== null && keySig !== prevKeySig) prev = {};
        prevKeySig = keySig;

        /** @type {Object<string,string>} */
        var cur = {};
        var notes = measure.notes || [];
        for (var ni = 0; ni < notes.length; ++ni) {
            var note = notes[ni];
            var id = index++;
            var nc = noteClassOf(note.pitch, note.tpc, note.tpc1);

            if (note.tiedBack) {
                // A tie continuation is not a new note event: it neither needs an
                // accidental nor changes what is in force, so the tables are left
                // untouched (matching MuseScore's own engraving).
                if (note.hasAccidental) out.push({ index: id, action: "remove" });
                continue;
            }

            var inForce = cur[nc.noteClass] !== undefined
                ? cur[nc.noteClass]
                : keyNameForLetter(nc.noteClass.charAt(0), keySig);
            var required = nc.noteName !== inForce;
            var carried = prev[nc.noteClass];
            var courtesy = !required && carried !== undefined && carried !== nc.noteName;

            if (required || courtesy) {
                if (!note.hasAccidental)
                    out.push({
                        index: id, action: "add",
                        accidentalType: accidentalNameForTpc(note.tpc),
                        courtesy: courtesy
                    });
            } else if (note.hasAccidental) {
                out.push({ index: id, action: "remove" });
            }

            // The carry-over is consumed by the first note of the class in this
            // bar — later ones are governed by `cur` alone.
            if (carried !== undefined) delete prev[nc.noteClass];
            cur[nc.noteClass] = nc.noteName;
        }

        prev = cur;
    }

    return out;
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var accidentalsLib = {
    TPC_NAMES: TPC_NAMES,
    tpcName: tpcName,
    accidentalNameForTpc: accidentalNameForTpc,
    noteClassOf: noteClassOf,
    keyNameForLetter: keyNameForLetter,
    planStaff: planStaff
};

// require()-able from an extension macro; no-op under QML import / Node loader.
if (typeof exports !== "undefined") { exports = accidentalsLib; }
