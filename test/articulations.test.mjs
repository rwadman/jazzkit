import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const Artic = loadQmlLib("../plugins/lib/articulations.js");

test("plain chord: no marcato, nothing to do", () => {
    const c = Artic.classifyChord(["articAccentAbove"]);
    eq(c.hasMarcato, false);
    eq(c.needsStaccato, false);
    eq(c.staccatoIndices, []);
});

test("marcato above, no staccato → add one, above", () => {
    const c = Artic.classifyChord(["articMarcatoAbove"]);
    eq(c.hasMarcato, true);
    eq(c.needsStaccato, true);
    eq(c.addAbove, true);
    eq(c.staccatoIndices, []);
});

test("marcato below, no staccato → add one, below", () => {
    const c = Artic.classifyChord(["articMarcatoBelow"]);
    eq(c.marcatoBelow, true);
    eq(c.needsStaccato, true);
    eq(c.addAbove, false);
});

test("marcato + existing staccato → hide it, don't add", () => {
    const c = Artic.classifyChord(["articMarcatoAbove", "articStaccatoAbove"]);
    eq(c.hasMarcato, true);
    eq(c.needsStaccato, false);
    eq(c.staccatoIndices, [1]);
});

test("staccato but no marcato → leave untouched", () => {
    const c = Artic.classifyChord(["articStaccatoAbove"]);
    eq(c.hasMarcato, false);
    eq(c.needsStaccato, false);
    // staccatoIndices is reported, but with no marcato the .qml ignores it.
    eq(c.staccatoIndices, [0]);
});

test("both marcato placements → treated as above", () => {
    const c = Artic.classifyChord(["articMarcatoAbove", "articMarcatoBelow"]);
    eq(c.addAbove, true);
    eq(c.needsStaccato, true);
});

test("all staccato spelling variants are recognised", () => {
    for (const name of Artic.STACCATO_NAMES) {
        const c = Artic.classifyChord(["articMarcatoAbove", name]);
        eq(c.needsStaccato, false, `${name} should count as a staccato`);
    }
});

test("empty / missing input is safe", () => {
    eq(Artic.classifyChord([]).hasMarcato, false);
    eq(Artic.classifyChord(undefined).hasMarcato, false);
});
