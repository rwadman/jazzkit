// @ts-check
// Shared pure helpers for JazzKit plugins.
//
// NOTHING here touches a MuseScore global directly: anything API-bound (curScore)
// is passed in as an argument. That keeps this file a valid stateless QML JS
// library AND lets Node unit-test every function with plain fakes.
//
//   QML:   import "lib/jazzkit.js" as JazzKit   →  JazzKit.isCompInstrument(part)
//   Node:  loadQmlLib("../JazzKit/lib/jazzkit.js", "jazzkitLib")  (test/load-qml-lib.mjs)
//
// Types are JSDoc + `// @ts-check`: `npm run typecheck` (tsc --checkJs) verifies
// them with no build step, so the file QML loads is the file we edit. The
// external MuseScore shapes (MS.Part, MS.Score, …) are modelled in musescore.d.ts.

/**
 * One checkbox row for the comp-target dialog (our shape, not MuseScore's).
 * @typedef {Object} TargetRow
 * @property {string} label
 * @property {string} instrumentId
 * @property {number} staffIdx
 * @property {boolean} isDrum
 * @property {boolean} checked
 */

/**
 * All JazzKit plugins require MuseScore 4.4+.
 * @param {number} major
 * @param {number} minor
 * @returns {boolean}
 */
function isSupportedVersion(major, minor) {
    if (major <= 3) return false;
    if (major === 4 && minor < 4) return false;
    return true;
}

/**
 * Number of staves to iterate, tolerating the several names MuseScore versions
 * expose for it (nstaves / nStaves / staffCount / staves.length); 16 as a last
 * resort so a rename in a future version degrades to "process the first 16"
 * rather than nothing.
 * @param {MS.Score} score
 * @returns {number}
 */
function countStaves(score) {
    if (typeof score.nstaves === 'number') return score.nstaves;
    if (typeof score.nStaves === 'number') return score.nStaves;
    if (typeof score.staffCount === 'number') return score.staffCount;
    if (score.staves && typeof score.staves.length === 'number') return score.staves.length;
    return 16;
}

// Keywords that mark a chord/comping instrument we'd stamp a rhythm onto.
var COMP_KEYWORDS = ["piano", "keyboard", "organ", "synth", "harpsichord", "celesta",
    "clavinet", "accordion", "rhodes", "wurl", "guitar", "bass",
    "vibraphone", "vibes", "marimba", "banjo", "ukulele", "mandolin", "harp", "comp", "komp"];

/**
 * Heuristic: is this part a chord/comping instrument?
 * @param {MS.Part|null|undefined} part
 * @returns {boolean}
 */
function isCompInstrument(part) {
    if (!part) return false;
    if (part.hasDrumStaff) return true;
    var id = (part.instrumentId || "").toLowerCase();
    for (var i = 0; i < COMP_KEYWORDS.length; i++)
        if (id.indexOf(COMP_KEYWORDS[i]) !== -1) return true;
    return false;
}

/**
 * Select a single-staff range and confirm the selection actually landed on the
 * intended staff. The dispatched cmd()s act on curScore.selection, so a failed
 * selection must abort rather than run against the wrong staff.
 * @param {MS.Score} curScore
 * @param {number} startTick
 * @param {number} endTick
 * @param {number} staffIdx
 * @returns {boolean}
 */
function selectStaffRange(curScore, startTick, endTick, staffIdx) {
    curScore.selection.selectRange(startTick, endTick, staffIdx, staffIdx + 1);
    var s = curScore.selection;
    return !!(s && s.isRange && s.startStaff === staffIdx);
}

/**
 * Build the checkbox rows for the comp-target dialog (shared by To Comp Slashes
 * and To Comp Cues): every comp instrument except the staff we're copying from,
 * each with its initial checked state. Pure — the .qml only feeds the result
 * into its ListModel.
 * @param {MS.Part[]} parts
 * @param {number} srcStaffIdx   Staff we're copying the rhythm from (never a target).
 * @param {string[]|null} savedIds   Remembered enabled ids, or null on first run (→ all checked).
 * @returns {TargetRow[]}
 */
function computeTargets(parts, srcStaffIdx, savedIds) {
    /** @type {TargetRow[]} */
    var rows = [];
    for (var i = 0; i < parts.length; ++i) {
        var p = parts[i];
        if (!isCompInstrument(p)) continue;

        var partStart = Math.floor(p.startTrack / 4);
        var partEnd = Math.floor(p.endTrack / 4); // exclusive
        // Never target the staff we're copying the rhythm from.
        if (srcStaffIdx >= partStart && srcStaffIdx < partEnd) continue;

        var id = p.instrumentId || "";
        rows.push({
            label: (p.longName && p.longName.length) ? p.longName : (p.partName || ""),
            instrumentId: id,
            staffIdx: partStart, // top staff of the part
            isDrum: p.hasDrumStaff ? true : false,
            checked: savedIds ? (savedIds.indexOf(id) !== -1) : true
        });
    }
    return rows;
}

// --- Persisted dialog choices (MS's bundled QML has no Settings module) ------
// Stored as a score metatag: recalled whenever the score is open and saved into
// the file on save. The plugin shapes its own object; these handle the JSON and
// the part/excerpt mirroring.

/**
 * Read a JSON object previously stored with saveJsonTag.
 * @param {MS.Score|null|undefined} curScore
 * @param {string} tag
 * @returns {any}   Parsed object, or null when there's no score / the tag is absent / it won't parse.
 */
function loadJsonTag(curScore, tag) {
    if (!curScore) return null;
    var raw = curScore.metaTag(tag);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * Persist a JSON object as a score metatag, mirrored to every part/excerpt.
 * Reading a metatag already falls back to the master score, so writing from the
 * main score reaches every part; the mirror loop also overwrites any value a
 * part set on its own. (The API has no upward link from a part to the master, so
 * a change made while viewing a part cannot propagate and stays local to it.)
 * @param {MS.Score|null|undefined} curScore
 * @param {string} tag
 * @param {any} obj
 * @returns {void}
 */
function saveJsonTag(curScore, tag, obj) {
    if (!curScore) return;
    var val = JSON.stringify(obj);
    curScore.setMetaTag(tag, val);
    var ex = curScore.excerpts;
    if (ex) {
        for (var i = 0; i < ex.length; ++i) {
            var ps = ex[i].partScore;
            if (ps) ps.setMetaTag(tag, val);
        }
    }
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var jazzkitLib = {
    isSupportedVersion: isSupportedVersion,
    countStaves: countStaves,
    COMP_KEYWORDS: COMP_KEYWORDS,
    isCompInstrument: isCompInstrument,
    selectStaffRange: selectStaffRange,
    computeTargets: computeTargets,
    loadJsonTag: loadJsonTag,
    saveJsonTag: saveJsonTag
};

// Also expose as a CommonJS-style module so an extension macro can `require()`
// this lib. `exports` is a global only in the extension's script engine; the QML
// import and the Node test loader read the top-level declarations instead, and
// the typeof guard keeps this a harmless no-op there.
if (typeof exports !== "undefined") { exports = jazzkitLib; }
