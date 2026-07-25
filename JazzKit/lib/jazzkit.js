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

/** The one wording for the version refusal — shared by every entry point. */
var MIN_VERSION_TEXT = "This plugin is for MuseScore 4.4 or later";

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
 * Number of staves to iterate. `nstaves` is the documented name on 4.4+, which is
 * the only range we run in; 0 (do nothing) if it's ever missing — callers use this
 * as a `staffIdx` loop bound, so a guessed count would read staves that don't exist.
 * @param {MS.Score} score
 * @returns {number}
 */
function countStaves(score) {
    return score.nstaves || 0;
}

/**
 * The shared entry guard: "" when the plugin may run, else the message to show.
 * @param {MS.Score|null|undefined} curScore
 * @param {number} major
 * @param {number} minor
 * @returns {string}
 */
function guardScore(curScore, major, minor) {
    if (!curScore) return "Open a score first.";
    if (!isSupportedVersion(major, minor)) return MIN_VERSION_TEXT;
    return "";
}

/**
 * The selection capture every range-based action starts with: verify there IS a
 * single-staff range selection and read out its tick bounds, the containing
 * measure's start tick (the writers rewind there, not to selStart — see effects.js)
 * and the staff. `Cursor` is the QML enum, injected (a stateless lib can't see it).
 * @param {MS.Score} curScore
 * @param {JK.QmlEnum} Cursor
 * @returns {JK.SelectionRange}
 */
function captureSingleStaffRange(curScore, Cursor) {
    var sel = curScore.selection;
    if (!sel || !sel.isRange || sel.elements.length === 0)
        return { ok: false, error: "Please select a range of notes first." };
    if (sel.endStaff - sel.startStaff !== 1)
        return { ok: false, error: "Please select notes in a single staff only." };

    var cursor = curScore.newCursor();
    cursor.rewind(Cursor.SELECTION_START);
    var selStart = cursor.tick;
    // A range selection always sits in a measure with segments; fall back to
    // selStart rather than throwing if a build ever reports otherwise.
    var m = cursor.measure;
    var measureTick = (m && m.firstSegment) ? m.firstSegment.tick : selStart;
    cursor.rewind(Cursor.SELECTION_END);
    var selEnd = cursor.tick;
    // A selection running to the end of the score reports tick 0 — treat it as "past
    // the last segment" rather than an empty range.
    if (selEnd === 0) selEnd = curScore.lastSegment.tick + 1;

    return {
        ok: true, selStart: selStart, selEnd: selEnd,
        measureTick: measureTick, staffIdx: sel.startStaff
    };
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

/**
 * Inverse of computeTargets: from the dialog's rows, the instrument ids to
 * remember and the target rows to hand an effect. Both comp actions take the same
 * `{staffIdx, isDrum}` shape.
 * @param {TargetRow[]} rows
 * @returns {JK.SelectedTargets}
 */
function selectedTargets(rows) {
    var ids = [], targets = [];
    for (var i = 0; i < rows.length; ++i) {
        var r = rows[i];
        if (!r.checked) continue;
        ids.push(r.instrumentId);
        targets.push({ staffIdx: r.staffIdx, isDrum: !!r.isDrum });
    }
    return { ids: ids, targets: targets };
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

// --- Autofix settings -------------------------------------------------------
// Which fixes the Autofix action runs, shared by autofix.qml (reads) and
// autofix_settings.qml (reads + writes). Stored with the same per-score metatag
// mechanism as the other dialogs' choices, so the defaults below apply to a score
// that has never had the settings form opened.

var AUTOFIX_TAG = "jazzKitAutofix";

/** Defaults for a score with no stored Autofix settings.
 *  bracket: 0 none, 1 parenthesis, 2 bracket (MuseScore's AccidentalBracket). */
var AUTOFIX_DEFAULTS = { marcato: true, courtesy: true, bracket: 1 };

/**
 * Autofix settings for a score, with every missing/garbled field filled from the
 * defaults (so a partially-written tag can never disable a fix by accident).
 * @param {MS.Score|null|undefined} curScore
 * @returns {JK.AutofixSettings}
 */
function loadAutofixSettings(curScore) {
    var s = loadJsonTag(curScore, AUTOFIX_TAG) || {};
    var bracket = parseInt(s.bracket, 10);
    if (!(bracket >= 0 && bracket <= 2)) bracket = AUTOFIX_DEFAULTS.bracket;
    return {
        marcato: s.marcato === undefined ? AUTOFIX_DEFAULTS.marcato : !!s.marcato,
        courtesy: s.courtesy === undefined ? AUTOFIX_DEFAULTS.courtesy : !!s.courtesy,
        bracket: bracket
    };
}

/**
 * Persist Autofix settings (normalised first, so what we write is what a later
 * load returns).
 * @param {MS.Score|null|undefined} curScore
 * @param {JK.AutofixSettings} settings
 * @returns {void}
 */
function saveAutofixSettings(curScore, settings) {
    saveJsonTag(curScore, AUTOFIX_TAG, {
        marcato: !!settings.marcato,
        courtesy: !!settings.courtesy,
        bracket: (settings.bracket >= 0 && settings.bracket <= 2)
            ? settings.bracket : AUTOFIX_DEFAULTS.bracket
    });
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var jazzkitLib = {
    MIN_VERSION_TEXT: MIN_VERSION_TEXT,
    isSupportedVersion: isSupportedVersion,
    guardScore: guardScore,
    captureSingleStaffRange: captureSingleStaffRange,
    countStaves: countStaves,
    COMP_KEYWORDS: COMP_KEYWORDS,
    isCompInstrument: isCompInstrument,
    computeTargets: computeTargets,
    selectedTargets: selectedTargets,
    loadJsonTag: loadJsonTag,
    saveJsonTag: saveJsonTag,
    AUTOFIX_TAG: AUTOFIX_TAG,
    AUTOFIX_DEFAULTS: AUTOFIX_DEFAULTS,
    loadAutofixSettings: loadAutofixSettings,
    saveAutofixSettings: saveAutofixSettings
};

// Export trailer — MANDATORY, see api-gotchas "macros actions".
if (typeof exports !== "undefined") { exports = jazzkitLib; }
