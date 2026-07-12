// Shared pure helpers for JazzKit plugins.
//
// NOTHING here touches a MuseScore global directly: anything API-bound (curScore)
// is passed in as an argument. That keeps this file a valid stateless QML JS
// library AND lets Node unit-test every function with plain fakes.
//
//   QML:   import "lib/jazzkit.js" as JazzKit   →  JazzKit.isCompInstrument(part)
//   Node:  loadQmlLib("../plugins/lib/jazzkit.js")  (see test/load-qml-lib.mjs)

// All JazzKit plugins require MuseScore 4.4+.
function isSupportedVersion(major, minor) {
    if (major <= 3) return false;
    if (major === 4 && minor < 4) return false;
    return true;
}

// Heuristic: is this part a chord/comping instrument we'd stamp a rhythm onto?
var COMP_KEYWORDS = ["piano", "keyboard", "organ", "synth", "harpsichord", "celesta",
    "clavinet", "accordion", "rhodes", "wurl", "guitar", "bass",
    "vibraphone", "vibes", "marimba", "banjo", "ukulele", "mandolin", "harp", "comp", "komp"];

function isCompInstrument(part) {
    if (!part) return false;
    if (part.hasDrumStaff) return true;
    var id = (part.instrumentId || "").toLowerCase();
    for (var i = 0; i < COMP_KEYWORDS.length; i++)
        if (id.indexOf(COMP_KEYWORDS[i]) !== -1) return true;
    return false;
}

// Select a single-staff range and confirm the selection actually landed on the
// intended staff. The dispatched cmd()s act on curScore.selection, so a failed
// selection must abort rather than run against the wrong staff.
function selectStaffRange(curScore, startTick, endTick, staffIdx) {
    curScore.selection.selectRange(startTick, endTick, staffIdx, staffIdx + 1);
    var s = curScore.selection;
    return !!(s && s.isRange && s.startStaff === staffIdx);
}

// --- Persisted dialog choices (MS's bundled QML has no Settings module) ------
// Stored as a score metatag: recalled whenever the score is open and saved into
// the file on save. The plugin shapes its own object; these handle the JSON and
// the part/excerpt mirroring.

// Read a JSON object previously stored with saveJsonTag. Returns the parsed
// object, or null when there's no score / the tag is absent / it won't parse.
function loadJsonTag(curScore, tag) {
    if (!curScore) return null;
    var raw = curScore.metaTag(tag);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

// Persist a JSON object as a score metatag, mirrored to every part/excerpt.
// Reading a metatag already falls back to the master score, so writing from the
// main score reaches every part; the mirror loop also overwrites any value a
// part set on its own. (The API has no upward link from a part to the master, so
// a change made while viewing a part cannot propagate and stays local to it.)
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

var JazzKitExports = {
    isSupportedVersion: isSupportedVersion,
    COMP_KEYWORDS: COMP_KEYWORDS,
    isCompInstrument: isCompInstrument,
    selectStaffRange: selectStaffRange,
    loadJsonTag: loadJsonTag,
    saveJsonTag: saveJsonTag
};
