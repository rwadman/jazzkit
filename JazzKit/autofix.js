// Autofix — an extension "macros" action (see manifest.json), NOT a form.
//
// A `form` action is loaded as a view, so it always opens a window; Autofix takes
// no input and has nothing to confirm, so it is a `macros` action instead: the
// script engine calls main() with no UI at all.
//
// The apiversion-1 script engine hands a macro the same bare globals the legacy
// QML plugins had (curScore, newElement, Element, SymId, Cursor, Segment,
// Accidental, quit, …) — EngravingApiV1::setup copies every property of the
// engraving API onto the global object. It has NO dialog API in v1, which is the
// point here: feedback goes to the log (scripts/mslog.sh), not to the screen.
//
// `require(path)` resolves relative to this file and returns whatever the module
// assigned to the SHARED global `exports` — the trailer every JazzKit lib ends
// with. A lib missing that trailer silently returns the previous require's object
// (that is what broke the first attempt at this file); test/require-exports.test.mjs
// emulates this loader so the trap can't come back.
var JazzKit = require("lib/jazzkit.js");
var Articulations = require("lib/articulations.js");
var Accidentals = require("lib/accidentals.js");
var Rests = require("lib/rests.js");
var Effects = require("lib/effects.js");

// The effect layer takes its MuseScore globals through a ctx (a stateless lib
// can't see them). Superset of what either fix needs.
function effectCtx() {
    return {
        curScore: curScore, newElement: newElement,
        JazzKit: JazzKit, Articulations: Articulations, Accidentals: Accidentals, Rests: Rests,
        SymId: SymId, Element: Element, Cursor: Cursor,
        Segment: Segment, Accidental: Accidental, division: division,
        cmd: cmd, removeElement: removeElement
    };
}

function main() {
    if (!curScore) { console.log("JazzKit Autofix: no score open"); quit(); return; }
    if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion)) {
        console.log("JazzKit Autofix: needs MuseScore 4.4 or later");
        quit();
        return;
    }

    var s = JazzKit.loadAutofixSettings(curScore);

    if (s.marcato) {
        var m = Effects.fixMarcatoStaccatos(effectCtx());
        console.log("JazzKit Autofix: marcato staccatos — added " + m.added
                    + " hidden, hid " + m.hidden + " existing");
    }
    if (s.courtesy) {
        var a = Effects.fixCourtesyAccidentals(effectCtx(), { bracket: s.bracket });
        console.log("JazzKit Autofix: courtesy accidentals — added " + a.added
                    + ", removed " + a.removed + " superfluous, skipped " + a.skipped);
    }
    // Notes first (Regroup rhythms also regroups rests in the bars it touches), then
    // whole-bar rests, then the remaining rest runs. A macro has no window, so the
    // cmd()s these use are allowed.
    if (s.groupNotes) {
        var n = Effects.groupNotes(effectCtx());
        console.log("JazzKit Autofix: note grouping — regrouped " + n.bars + " bar(s), skipped "
                    + n.skipped + " (fermata / slur / marked tied note)");
    }
    if (s.fullBarRests) {
        var f = Effects.fullBarRests(effectCtx());
        console.log("JazzKit Autofix: full-bar rests — " + f.bars + " bar(s)");
    }
    if (s.groupRests) {
        var g = Effects.groupRests(effectCtx());
        console.log("JazzKit Autofix: rest grouping — regrouped " + g.regrouped + " run(s)");
    }
    if (!s.marcato && !s.courtesy && !s.groupRests && !s.fullBarRests && !s.groupNotes)
        console.log("JazzKit Autofix: no fixes enabled");

    quit();
}
