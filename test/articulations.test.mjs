import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const Artic = loadQmlLib("../JazzKit/lib/articulations.js", "articulationsLib");

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

// --- symbol resolution (SymId injected as a fake) ---------------------------

// Stand-in for the MuseScore SymId enum: numeric values, like current MS.
const SymId = {
    articMarcatoAbove: 1, articMarcatoBelow: 2,
    articStaccatAbove: 3, articStaccatoAbove: 4,
    articStaccatBelow: 5, articStaccatoBelow: 6,
    articStaccat: 7, articStaccato: 8,
};

test("articSymbol reads .symbol, falls back to toString, then empty", () => {
    eq(Artic.articSymbol({ symbol: 3 }), 3);
    eq(Artic.articSymbol({ toString: () => "articStaccato" }), "articStaccato");
    eq(Artic.articSymbol(null), "");
});

test("canonicalName maps a numeric SymId value to its name", () => {
    eq(Artic.canonicalName(SymId, { symbol: 1 }), "articMarcatoAbove");
    eq(Artic.canonicalName(SymId, { symbol: 4 }), "articStaccatoAbove");
});

test("canonicalName passes a name string through unchanged", () => {
    eq(Artic.canonicalName(SymId, { symbol: "articMarcatoBelow" }), "articMarcatoBelow");
});

test("canonicalName stringifies an unknown numeric symbol", () => {
    eq(Artic.canonicalName(SymId, { symbol: 99 }), "99");
});

test("chordNames resolves every articulation on a chord", () => {
    const names = Artic.chordNames(SymId, [{ symbol: 1 }, { symbol: 3 }, { symbol: "articStaccato" }]);
    eq(names, ["articMarcatoAbove", "articStaccatAbove", "articStaccato"]);
});

test("chordNames output feeds classifyChord end-to-end", () => {
    // A chord with marcato-above and an existing staccato → hide it, don't add.
    const c = Artic.classifyChord(Artic.chordNames(SymId, [{ symbol: 1 }, { symbol: 3 }]));
    eq(c.hasMarcato, true);
    eq(c.needsStaccato, false);
    eq(c.staccatoIndices, [1]);
});

test("staccatoCandidates prefers the requested placement, then generics", () => {
    eq(Artic.staccatoCandidates(SymId, true), [3, 4, 7, 8]);
    eq(Artic.staccatoCandidates(SymId, false), [5, 6, 7, 8]);
});
