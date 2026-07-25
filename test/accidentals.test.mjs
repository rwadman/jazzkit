import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const Acc = loadQmlLib("../JazzKit/lib/accidentals.js", "accidentalsLib");

// tpc reference (tpcName index = tpc + 1): 12 Bb, 13 F, 14 C, 15 G, 16 D, 17 A,
// 18 E, 19 B, 20 F#, 21 C#, 26 B#, 7 Cb.
const TPC = { Bb: 12, F: 13, C: 14, G: 15, D: 16, A: 17, E: 18, B: 19, Fs: 20, Cs: 21, Bs: 26, Cb: 7, Eb: 11 };

/** A note as planStaff sees it. Pitch only matters for the octave. */
function note(tpc, pitch, { acc = false, tied = false, tpc1 = tpc } = {}) {
    return { pitch, tpc, tpc1, hasAccidental: acc, tiedBack: tied };
}
const measure = (notes, keySig = 0) => ({ keySig, notes });

// --- naming / classification ------------------------------------------------

test("tpcName maps the tpc range", () => {
    eq(Acc.tpcName(TPC.C), "C");
    eq(Acc.tpcName(TPC.Bb), "Bb");
    eq(Acc.tpcName(TPC.Cs), "C#");
    eq(Acc.tpcName(-1), "Fbb");
    eq(Acc.tpcName(33), "B##");
    eq(Acc.tpcName(99), "");
});

test("accidentalNameForTpc covers every alteration band", () => {
    eq(Acc.accidentalNameForTpc(0), "FLAT2");     // Cbb
    eq(Acc.accidentalNameForTpc(TPC.Bb), "FLAT");
    eq(Acc.accidentalNameForTpc(TPC.C), "NATURAL");
    eq(Acc.accidentalNameForTpc(TPC.Cs), "SHARP");
    eq(Acc.accidentalNameForTpc(33), "SHARP2");   // B##
});

test("noteClassOf is letter + octave", () => {
    eq(Acc.noteClassOf(60, TPC.C, TPC.C), { noteClass: "C5", noteName: "C" });
    eq(Acc.noteClassOf(61, TPC.Cs, TPC.Cs), { noteClass: "C5", noteName: "C#" });
});

test("noteClassOf corrects the octave for Cb and B#", () => {
    // Cb sounds a semitone below C5 (pitch 59) but is WRITTEN on the C5 line.
    eq(Acc.noteClassOf(59, TPC.Cb, TPC.Cb).noteClass, "C5");
    // B# sounds at C5 (pitch 60) but is written on the B4 line.
    eq(Acc.noteClassOf(60, TPC.Bs, TPC.Bs).noteClass, "B4");
});

test("keyNameForLetter follows the key signature", () => {
    eq(Acc.keyNameForLetter("B", 0), "B");
    eq(Acc.keyNameForLetter("B", -1), "Bb");   // F major
    eq(Acc.keyNameForLetter("E", -2), "Eb");   // Bb major
    eq(Acc.keyNameForLetter("F", 1), "F#");    // G major
    eq(Acc.keyNameForLetter("C", 1), "C");
});

// --- the plan ---------------------------------------------------------------

test("nothing to do in a plain diatonic bar", () => {
    eq(Acc.planStaff([measure([note(TPC.C, 60), note(TPC.D, 62), note(TPC.E, 64)])]), []);
});

test("alteration in bar 1 → courtesy natural on the same class in bar 2", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true })]),
        measure([note(TPC.F, 65)])
    ]);
    eq(plan, [{ index: 1, action: "add", accidentalType: "NATURAL", courtesy: true }]);
});

test("courtesy is bracket-worthy only on the FIRST occurrence in the bar", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true })]),
        measure([note(TPC.F, 65), note(TPC.F, 65)])
    ]);
    eq(plan.length, 1);
    eq(plan[0].index, 1);
});

test("carry-over is per note class, not per letter (octave matters)", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true })]),   // F#5
        measure([note(TPC.F, 53)])                    // F3 — different class, untouched
    ]);
    eq(plan, []);
});

test("a required accidental is never proposed for removal", () => {
    // Key C; F# in bar 2 with its accidental present → nothing to do.
    eq(Acc.planStaff([
        measure([note(TPC.F, 65)]),
        measure([note(TPC.Fs, 66, { acc: true })])
    ]), []);
});

test("a required accidental that is missing gets added", () => {
    eq(Acc.planStaff([measure([note(TPC.Fs, 66)])]),
        [{ index: 0, action: "add", accidentalType: "SHARP", courtesy: false }]);
});

test("repeat of an altered note in the same bar: second accidental is superfluous", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true }), note(TPC.Fs, 66, { acc: true })])
    ]);
    eq(plan, [{ index: 1, action: "remove" }]);
});

test("an accidental that only restates the key signature is superfluous", () => {
    // Bb major (2 flats): a written Eb is redundant.
    eq(Acc.planStaff([measure([note(TPC.Eb, 63, { acc: true })], -2)]),
        [{ index: 0, action: "remove" }]);
});

test("in-key note needs an accidental after the class was altered in the bar", () => {
    // F major: Bb is in key. B natural, then Bb again → the Bb must be restated.
    const plan = Acc.planStaff([
        measure([note(TPC.B, 71, { acc: true }), note(TPC.Bb, 70)], -1)
    ]);
    eq(plan, [{ index: 1, action: "add", accidentalType: "FLAT", courtesy: false }]);
});

test("tied-back notes never carry an accidental and never alter the state", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true })]),
        // The tie continuation keeps its accidental (wrongly) → remove; and it must
        // NOT consume bar 1's carry-over, so the next F still gets its courtesy.
        measure([note(TPC.Fs, 66, { acc: true, tied: true }), note(TPC.F, 65)])
    ]);
    eq(plan, [
        { index: 1, action: "remove" },
        { index: 2, action: "add", accidentalType: "NATURAL", courtesy: true }
    ]);
});

test("a key change wipes the carry-over (the new signature restates it)", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true })], 0),
        measure([note(TPC.Fs, 66)], 1)   // G major: F# is in key now, no courtesy
    ]);
    eq(plan, []);
});

test("an accidental already serving as a courtesy is left alone", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true })]),
        measure([note(TPC.F, 65, { acc: true })])   // already the courtesy natural
    ]);
    eq(plan, []);
});

test("adds and removals coexist in one plan, indexed across the whole staff", () => {
    const plan = Acc.planStaff([
        measure([note(TPC.Fs, 66, { acc: true })]),
        // 1: courtesy natural wanted; 2: same class again, its accidental is stale.
        measure([note(TPC.F, 65), note(TPC.F, 65, { acc: true })])
    ]);
    eq(plan, [
        { index: 1, action: "add", accidentalType: "NATURAL", courtesy: true },
        { index: 2, action: "remove" }
    ]);
});

test("empty input is safe", () => {
    eq(Acc.planStaff([]), []);
    eq(Acc.planStaff([measure([])]), []);
});
