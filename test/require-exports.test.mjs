// Emulates MuseScore's extension module loader so the `macros` action (autofix.js)
// can be checked without the GUI.
//
// The real thing (muse_framework `internal/scriptengine.cpp` / `jsmoduleloader.cpp`):
//   * `exports` is ONE object property on the shared global, set once at engine
//     setup and NEVER reset between requires;
//   * `require(name)` resolves the path against the requiring script's directory,
//     wraps the file in `(function() { … }())` and evaluates it in that same
//     global, then hands back whatever `exports` now holds.
// So a lib that doesn't end with `exports = <lib>` returns the PREVIOUS require's
// object — which is exactly how the first macros attempt broke (articulations.js
// had no trailer, so it handed back jazzkit.js's exports and the effect died on
// `Property 'chordNames' … is not a function`). These tests fail if any lib loses
// its trailer again.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { test, eq, ok } from "./harness.mjs";

const BUNDLE = fileURLToPath(new URL("../JazzKit/", import.meta.url));

/**
 * A script engine: one shared global object (a vm context, so a script's top-level
 * `var`/`function` land on it exactly as they do on the QJSEngine global), one
 * `exports` slot, and require()d files wrapped in an IIFE. The ENTRY script is
 * evaluated unwrapped — that's why the engine can then call its `main()`.
 */
function newEngine(globals = {}) {
    const scope = vm.createContext({ exports: {}, ...globals });
    let dir = BUNDLE;

    function requireFile(path) {
        const prevDir = dir;
        dir = dirname(path);                  // resolution is relative to the requirer
        vm.runInContext("(function() {\n" + readFileSync(path, "utf8") + "\n}());", scope, path);
        dir = prevDir;
        return scope.exports;                 // shared slot — the whole point
    }

    scope.require = (name) => requireFile(resolve(dir, name));

    return {
        scope,
        require(name) { dir = BUNDLE; return requireFile(resolve(BUNDLE, name)); },
        evaluate(name) {
            dir = BUNDLE;
            const path = resolve(BUNDLE, name);
            vm.runInContext(readFileSync(path, "utf8"), scope, path);
        }
    };
}

const LIBS = [
    ["lib/jazzkit.js", ["isSupportedVersion", "loadAutofixSettings", "countStaves"]],
    ["lib/articulations.js", ["classifyChord", "chordNames", "staccatoCandidates"]],
    ["lib/accidentals.js", ["planStaff", "noteClassOf", "tpcName"]],
    ["lib/effects.js", ["fixMarcatoStaccatos", "fixCourtesyAccidentals", "applyLineBreaks"]],
    ["lib/slashes.js", ["emptyRestRegions", "beatTicks"]],
    ["lib/linebreaks.js", ["computeBreaks", "groupBoxes"]],
];

for (const [path, fns] of LIBS) {
    test(`require("${path}") returns its own exports`, () => {
        // Require jazzkit.js FIRST so a missing trailer would return that instead —
        // the exact shape of the bug.
        const e = newEngine();
        e.require("lib/jazzkit.js");
        const mod = e.require(path);
        for (const fn of fns)
            ok(typeof mod[fn] === "function", `${path} should export ${fn}(), got ${typeof mod[fn]}`);
    });
}

test("every lib require()s to a DISTINCT object (no shared-exports bleed)", () => {
    const e = newEngine();
    const seen = [];
    for (const [path] of LIBS) {
        const mod = e.require(path);
        ok(!seen.includes(mod), `${path} returned an object an earlier require already returned`);
        seen.push(mod);
    }
    eq(seen.length, LIBS.length);
});

// --- the macro itself -------------------------------------------------------

test("autofix.js loads: its require()s resolve and main() is defined", () => {
    const logged = [];
    let quit = 0;
    const e = newEngine({
        curScore: null,                       // early-out path, no API needed
        console: { log: (m) => logged.push(m) },
        quit: () => { ++quit; },
    });
    e.evaluate("autofix.js");

    ok(typeof e.scope.main === "function", "autofix.js should define main()");
    // Its module-level requires must have produced usable libs, not each other.
    ok(typeof e.scope.JazzKit.loadAutofixSettings === "function", "JazzKit lib wired up");
    ok(typeof e.scope.Articulations.chordNames === "function", "Articulations lib wired up");
    ok(typeof e.scope.Accidentals.planStaff === "function", "Accidentals lib wired up");
    ok(typeof e.scope.Effects.fixCourtesyAccidentals === "function", "Effects lib wired up");

    e.scope.main();
    eq(quit, 1, "main() should quit()");
    eq(logged, ["JazzKit Autofix: no score open"]);
});

test("autofix.js runs both fixes and reports them, honouring the settings", () => {
    const logged = [];
    const e = newEngine({
        // Only the bits loadAutofixSettings touches; the effects are stubbed below.
        curScore: { metaTag: () => JSON.stringify({ marcato: true, courtesy: true, bracket: 2 }) },
        mscoreMajorVersion: 4, mscoreMinorVersion: 7,
        console: { log: (m) => logged.push(m) },
        quit: () => { },
        newElement: () => ({}), SymId: {}, Element: {}, Cursor: {}, Segment: {}, Accidental: {},
    });
    e.evaluate("autofix.js");

    // Swap the effects for spies — this test is about the macro's wiring, not the
    // score mutations (those are the GUI harness's job).
    let bracketSeen = null;
    e.scope.Effects = {
        fixMarcatoStaccatos: () => ({ added: 2, hidden: 1 }),
        fixCourtesyAccidentals: (_ctx, opts) => { bracketSeen = opts.bracket; return { added: 3, removed: 1, skipped: 0 }; },
    };
    e.scope.main();

    eq(bracketSeen, 2, "the stored bracket style reaches the effect");
    eq(logged.length, 2);
    ok(/marcato staccatos — added 2 hidden, hid 1 existing/.test(logged[0]), logged[0]);
    ok(/courtesy accidentals — added 3, removed 1 superfluous, skipped 0/.test(logged[1]), logged[1]);
});

test("autofix.js with every fix disabled touches nothing", () => {
    const logged = [];
    const e = newEngine({
        curScore: { metaTag: () => JSON.stringify({ marcato: false, courtesy: false }) },
        mscoreMajorVersion: 4, mscoreMinorVersion: 7,
        console: { log: (m) => logged.push(m) },
        quit: () => { },
    });
    e.evaluate("autofix.js");
    e.scope.Effects = {
        fixMarcatoStaccatos: () => { throw new Error("must not run"); },
        fixCourtesyAccidentals: () => { throw new Error("must not run"); },
    };
    e.scope.main();
    eq(logged, ["JazzKit Autofix: no fixes enabled"]);
});

test("autofix.js refuses an unsupported MuseScore version", () => {
    const logged = [];
    const e = newEngine({
        curScore: { metaTag: () => null },
        mscoreMajorVersion: 4, mscoreMinorVersion: 3,
        console: { log: (m) => logged.push(m) },
        quit: () => { },
    });
    e.evaluate("autofix.js");
    e.scope.Effects = { fixMarcatoStaccatos: () => { throw new Error("must not run"); } };
    e.scope.main();
    eq(logged, ["JazzKit Autofix: needs MuseScore 4.4 or later"]);
});
