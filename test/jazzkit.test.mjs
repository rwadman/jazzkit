import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const JazzKit = loadQmlLib("../plugins/lib/jazzkit.js");

// --- isSupportedVersion -----------------------------------------------------

test("version gate: MS3 and 4.3 rejected, 4.4+ accepted", () => {
    eq(JazzKit.isSupportedVersion(3, 6), false);
    eq(JazzKit.isSupportedVersion(4, 3), false);
    eq(JazzKit.isSupportedVersion(4, 4), true);
    eq(JazzKit.isSupportedVersion(4, 7), true);
    eq(JazzKit.isSupportedVersion(5, 0), true);
});

// --- isCompInstrument -------------------------------------------------------

test("drum staff is always a comp instrument", () => {
    eq(JazzKit.isCompInstrument({ hasDrumStaff: true, instrumentId: "drumset" }), true);
});

test("pitched comp instruments matched by keyword", () => {
    eq(JazzKit.isCompInstrument({ instrumentId: "keyboard.piano.grand" }), true);
    eq(JazzKit.isCompInstrument({ instrumentId: "pluck.guitar.electric" }), true);
    eq(JazzKit.isCompInstrument({ instrumentId: "wind.reed.saxophone.alto" }), false);
});

test("comp match is case-insensitive and substring-based", () => {
    eq(JazzKit.isCompInstrument({ instrumentId: "Fender-RHODES" }), true);
});

test("missing / empty part is not a comp instrument", () => {
    eq(JazzKit.isCompInstrument(null), false);
    eq(JazzKit.isCompInstrument({}), false);
    eq(JazzKit.isCompInstrument({ instrumentId: "" }), false);
});

// --- selectStaffRange (curScore injected as a fake) -------------------------

function fakeScore(result) {
    const calls = [];
    return {
        calls,
        selection: {
            selectRange(a, b, s0, s1) {
                calls.push([a, b, s0, s1]);
                Object.assign(this, result);
            }
        }
    };
}

test("selectStaffRange: uses [i, i+1) and confirms the landed staff", () => {
    const sc = fakeScore({ isRange: true, startStaff: 2 });
    eq(JazzKit.selectStaffRange(sc, 480, 1920, 2), true);
    eq(sc.calls, [[480, 1920, 2, 3]]);
});

test("selectStaffRange: aborts when selection lands on the wrong staff", () => {
    const sc = fakeScore({ isRange: true, startStaff: 5 });
    eq(JazzKit.selectStaffRange(sc, 0, 480, 2), false);
});

test("selectStaffRange: aborts when the range didn't take", () => {
    const sc = fakeScore({ isRange: false, startStaff: 2 });
    eq(JazzKit.selectStaffRange(sc, 0, 480, 2), false);
});

// --- loadJsonTag / saveJsonTag (metatag persistence) ------------------------

// A score whose metatags are a plain map, plus optional part/excerpt scores that
// record what got mirrored into them.
function fakeMetaScore(tags = {}, excerpts) {
    return {
        metaTag: (k) => (k in tags ? tags[k] : ""),
        setMetaTag: (k, v) => { tags[k] = v; },
        tags,
        excerpts
    };
}

test("loadJsonTag: round-trips an object written by saveJsonTag", () => {
    const sc = fakeMetaScore();
    JazzKit.saveJsonTag(sc, "jazzKit", { ids: ["piano", "bass"] });
    eq(JazzKit.loadJsonTag(sc, "jazzKit"), { ids: ["piano", "bass"] });
});

test("loadJsonTag: null for no score / absent tag / bad JSON", () => {
    eq(JazzKit.loadJsonTag(null, "jazzKit"), null);
    eq(JazzKit.loadJsonTag(fakeMetaScore(), "jazzKit"), null);
    eq(JazzKit.loadJsonTag(fakeMetaScore({ jazzKit: "{not json" }), "jazzKit"), null);
});

test("saveJsonTag: mirrors the value into every part/excerpt", () => {
    const partA = fakeMetaScore({ jazzKit: "stale" });
    const partB = fakeMetaScore();
    const sc = fakeMetaScore({}, [{ partScore: partA }, { partScore: partB }]);

    JazzKit.saveJsonTag(sc, "jazzKit", { d: true });
    const expected = JSON.stringify({ d: true });
    eq(sc.tags.jazzKit, expected);
    eq(partA.tags.jazzKit, expected); // overwrites a value the part set on its own
    eq(partB.tags.jazzKit, expected);
});

test("saveJsonTag: tolerates missing excerpts and null partScore", () => {
    JazzKit.saveJsonTag(fakeMetaScore(), "jazzKit", { d: true }); // no excerpts key
    const sc = fakeMetaScore({}, [{ partScore: null }]);
    JazzKit.saveJsonTag(sc, "jazzKit", { d: true });
    eq(sc.tags.jazzKit, JSON.stringify({ d: true }));
});

test("saveJsonTag: no score is a no-op (no throw)", () => {
    JazzKit.saveJsonTag(null, "jazzKit", { d: true });
});
