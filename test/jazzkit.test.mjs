import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const JazzKit = loadQmlLib("../JazzKit/lib/jazzkit.js", "jazzkitLib");

// --- isSupportedVersion -----------------------------------------------------

test("version gate: MS3 and 4.3 rejected, 4.4+ accepted", () => {
    eq(JazzKit.isSupportedVersion(3, 6), false);
    eq(JazzKit.isSupportedVersion(4, 3), false);
    eq(JazzKit.isSupportedVersion(4, 4), true);
    eq(JazzKit.isSupportedVersion(4, 7), true);
    eq(JazzKit.isSupportedVersion(5, 0), true);
});

// --- countStaves ------------------------------------------------------------

test("countStaves reads nstaves", () => {
    eq(JazzKit.countStaves({ nstaves: 4 }), 4);
});

test("countStaves is 0 (process nothing) when nstaves is absent", () => {
    // It's used as a staffIdx loop bound — a guessed count would walk staves that
    // don't exist.
    eq(JazzKit.countStaves({}), 0);
    eq(JazzKit.countStaves({ nstaves: 0 }), 0);
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

// --- guardScore (the shared entry guard) ------------------------------------

test("guardScore: passes with a score on a supported version", () => {
    eq(JazzKit.guardScore({}, 4, 4), "");
});

test("guardScore: no score wins over the version check", () => {
    eq(JazzKit.guardScore(null, 3, 6), "Open a score first.");
});

test("guardScore: an old version reports the one canonical wording", () => {
    eq(JazzKit.guardScore({}, 4, 3), JazzKit.MIN_VERSION_TEXT);
    eq(JazzKit.MIN_VERSION_TEXT, "This plugin is for MuseScore 4.4 or later");
});

// --- captureSingleStaffRange (curScore + the Cursor enum injected) ----------

const Cursor = { SCORE_START: 0, SELECTION_START: 1, SELECTION_END: 2 };

// A score whose cursor reports `ticks[SELECTION_START]` / `ticks[SELECTION_END]`
// and a measure starting at `measureTick`.
function fakeRangeScore(sel, ticks, measureTick = 0, lastTick = 3840) {
    return {
        selection: sel,
        lastSegment: { tick: lastTick },
        newCursor() {
            return {
                tick: 0,
                measure: { firstSegment: { tick: measureTick } },
                rewind(mode) { this.tick = ticks[mode]; }
            };
        }
    };
}

const RANGE = { isRange: true, elements: [{}], startStaff: 2, endStaff: 3 };

test("captureSingleStaffRange: reads the ticks, the measure start and the staff", () => {
    const sc = fakeRangeScore(RANGE, { 1: 960, 2: 1920 }, 480);
    eq(JazzKit.captureSingleStaffRange(sc, Cursor),
        { ok: true, selStart: 960, selEnd: 1920, measureTick: 480, staffIdx: 2 });
});

test("captureSingleStaffRange: selEnd 0 means 'to the end of the score'", () => {
    const sc = fakeRangeScore(RANGE, { 1: 960, 2: 0 }, 960, 3840);
    eq(JazzKit.captureSingleStaffRange(sc, Cursor).selEnd, 3841);
});

test("captureSingleStaffRange: no range selection", () => {
    const err = { ok: false, error: "Please select a range of notes first." };
    eq(JazzKit.captureSingleStaffRange(fakeRangeScore(null, {}), Cursor), err);
    eq(JazzKit.captureSingleStaffRange(
        fakeRangeScore({ isRange: false, elements: [{}], startStaff: 0, endStaff: 1 }, {}), Cursor), err);
    // A "range" with nothing in it (e.g. selected past the last measure).
    eq(JazzKit.captureSingleStaffRange(
        fakeRangeScore({ isRange: true, elements: [], startStaff: 0, endStaff: 1 }, {}), Cursor), err);
});

test("captureSingleStaffRange: a multi-staff selection is refused", () => {
    const sc = fakeRangeScore({ isRange: true, elements: [{}], startStaff: 0, endStaff: 2 }, {});
    eq(JazzKit.captureSingleStaffRange(sc, Cursor),
        { ok: false, error: "Please select notes in a single staff only." });
});

// --- computeTargets (comp dialog rows) --------------------------------------

// MuseScore-part-like fake. staffIdx i → startTrack i*4.
function part(over) {
    return Object.assign({
        instrumentId: "keyboard.piano", startTrack: 0, endTrack: 4,
        longName: "", partName: "Part", hasDrumStaff: false
    }, over);
}

test("computeTargets: only comp instruments, source staff excluded", () => {
    const parts = [
        part({ instrumentId: "wind.reed.saxophone", startTrack: 0, endTrack: 4 }), // not comp
        part({ instrumentId: "keyboard.piano", startTrack: 4, endTrack: 8, partName: "Piano" }),
        part({ instrumentId: "pluck.bass", startTrack: 8, endTrack: 12, partName: "Bass" }), // source
    ];
    const rows = JazzKit.computeTargets(parts, /* srcStaffIdx */ 2, /* saved */ null);
    eq(rows.length, 1);
    eq(rows[0].staffIdx, 1);        // piano's top staff (startTrack 4 / 4)
    eq(rows[0].label, "Piano");
});

test("selectedTargets: only checked rows, as {staffIdx, isDrum} + their ids", () => {
    const rows = [
        { instrumentId: "keyboard.piano", staffIdx: 1, isDrum: false, checked: true },
        { instrumentId: "pluck.bass", staffIdx: 2, isDrum: false, checked: false },
        { instrumentId: "drumset", staffIdx: 3, isDrum: true, checked: true },
    ];
    eq(JazzKit.selectedTargets(rows), {
        ids: ["keyboard.piano", "drumset"],
        targets: [{ staffIdx: 1, isDrum: false }, { staffIdx: 3, isDrum: true }],
    });
});

test("selectedTargets: nothing checked → empty lists", () => {
    eq(JazzKit.selectedTargets([{ instrumentId: "x", staffIdx: 0, isDrum: false, checked: false }]),
        { ids: [], targets: [] });
    eq(JazzKit.selectedTargets([]), { ids: [], targets: [] });
});

test("selectedTargets: a missing isDrum is coerced to false", () => {
    eq(JazzKit.selectedTargets([{ instrumentId: "x", staffIdx: 0, checked: true }]).targets,
        [{ staffIdx: 0, isDrum: false }]);
});

test("computeTargets: null saved → all checked (first run)", () => {
    const rows = JazzKit.computeTargets([part({ partName: "Piano" })], -1, null);
    eq(rows[0].checked, true);
});

test("computeTargets: saved ids drive the checked state", () => {
    const parts = [
        part({ instrumentId: "keyboard.piano", startTrack: 0, endTrack: 4 }),
        part({ instrumentId: "pluck.guitar", startTrack: 4, endTrack: 8 }),
    ];
    const rows = JazzKit.computeTargets(parts, -1, ["keyboard.piano"]);
    eq(rows.map((r) => r.checked), [true, false]);
});

test("computeTargets: longName preferred over partName; drum flagged", () => {
    const rows = JazzKit.computeTargets(
        [part({ instrumentId: "drumset", longName: "Drum Set", partName: "Drums", hasDrumStaff: true })],
        -1, null);
    eq(rows[0].label, "Drum Set");
    eq(rows[0].isDrum, true);
});

test("computeTargets: multi-staff source part excluded across its whole span", () => {
    // Piano spans staves 0-1 (startTrack 0, endTrack 8); selecting staff 1 is still the source.
    const parts = [part({ instrumentId: "keyboard.piano", startTrack: 0, endTrack: 8 })];
    eq(JazzKit.computeTargets(parts, 1, null).length, 0);
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

// --- Autofix settings (shared by autofix.qml and autofix_settings.qml) -------

test("loadAutofixSettings: defaults when nothing is stored (and with no score)", () => {
    eq(JazzKit.loadAutofixSettings(fakeMetaScore()), JazzKit.AUTOFIX_DEFAULTS);
    eq(JazzKit.loadAutofixSettings(null), JazzKit.AUTOFIX_DEFAULTS);
});

test("autofix settings round-trip", () => {
    const sc = fakeMetaScore();
    JazzKit.saveAutofixSettings(sc, { marcato: false, courtesy: true, bracket: 2 });
    eq(JazzKit.loadAutofixSettings(sc), { marcato: false, courtesy: true, bracket: 2 });
});

test("loadAutofixSettings: a partial tag keeps the defaults for what's missing", () => {
    const sc = fakeMetaScore({ [JazzKit.AUTOFIX_TAG]: JSON.stringify({ marcato: false }) });
    eq(JazzKit.loadAutofixSettings(sc), { marcato: false, courtesy: true, bracket: 1 });
});

test("loadAutofixSettings: an out-of-range bracket falls back to the default", () => {
    const sc = fakeMetaScore({ [JazzKit.AUTOFIX_TAG]: JSON.stringify({ bracket: 9 }) });
    eq(JazzKit.loadAutofixSettings(sc).bracket, 1);
    const sc2 = fakeMetaScore({ [JazzKit.AUTOFIX_TAG]: "{not json" });
    eq(JazzKit.loadAutofixSettings(sc2), JazzKit.AUTOFIX_DEFAULTS);
});

test("saveAutofixSettings: bracket 0 (no bracket) survives the round-trip", () => {
    const sc = fakeMetaScore();
    JazzKit.saveAutofixSettings(sc, { marcato: true, courtesy: true, bracket: 0 });
    eq(JazzKit.loadAutofixSettings(sc).bracket, 0);
});
