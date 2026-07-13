import { test, eq } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const Slashes = loadQmlLib("../JazzKit/lib/slashes.js", "slashesLib");

// 4/4 with MuseScore's 480 ticks/quarter → 1920 ticks/measure, beat = 480.
function measure(over) {
    return Object.assign({ mStart: 0, numerator: 4, denominator: 4, measureTicks: 1920, rests: [] }, over);
}

// --- beatTicks --------------------------------------------------------------

test("beatTicks: simple meters beat on the denominator unit", () => {
    eq(Slashes.beatTicks(4, 4, 1920), 480);   // quarter
    eq(Slashes.beatTicks(3, 4, 1440), 480);   // quarter
    eq(Slashes.beatTicks(2, 2, 1920), 960);   // half
});

test("beatTicks: compound meters (den>4, num%3==0) group in threes", () => {
    eq(Slashes.beatTicks(6, 8, 1440), 720);   // dotted quarter (3×eighth)
    eq(Slashes.beatTicks(9, 8, 2160), 720);
    eq(Slashes.beatTicks(12, 8, 2880), 720);
});

test("beatTicks: 5/8 and 7/8 stay on the eighth (num not divisible by 3)", () => {
    eq(Slashes.beatTicks(5, 8, 1200), 240);   // eighth
    eq(Slashes.beatTicks(7, 8, 1680), 240);
});

// --- emptyRestRegions -------------------------------------------------------

test("a full-measure rest becomes one region", () => {
    const m = measure({ rests: [{ tick: 0, durTicks: 1920 }] });
    eq(Slashes.emptyRestRegions([m], 0, 1920), [{ start: 0, end: 1920 }]);
});

test("a beat-aligned run of rests is kept; off-beat rests are dropped", () => {
    // Beat 480. A rest at tick 0 len 480 (beat 1) is aligned; a rest at 600 (mid
    // beat 2) is not beat-aligned and is skipped.
    const m = measure({ rests: [{ tick: 0, durTicks: 480 }, { tick: 600, durTicks: 240 }] });
    eq(Slashes.emptyRestRegions([m], 0, 1920), [{ start: 0, end: 480 }]);
});

test("regions are clipped to the selection", () => {
    // Whole-measure rest, but the selection is beats 2-3 (480..1440).
    const m = measure({ rests: [{ tick: 0, durTicks: 1920 }] });
    eq(Slashes.emptyRestRegions([m], 480, 1440), [{ start: 480, end: 1440 }]);
});

test("a sub-beat clip whose length isn't a beat multiple is dropped", () => {
    // Rest spans the whole bar but the selection start (240) is mid-beat, so the
    // clipped start is not on a beat boundary → skipped.
    const m = measure({ rests: [{ tick: 0, durTicks: 1920 }] });
    eq(Slashes.emptyRestRegions([m], 240, 1920), []);
});

test("second measure offsets alignment by its own mStart", () => {
    const m2 = measure({ mStart: 1920, rests: [{ tick: 1920, durTicks: 480 }] });
    eq(Slashes.emptyRestRegions([m2], 0, 3840), [{ start: 1920, end: 2400 }]);
});

test("degenerate beat (0 ticks) yields no regions, no divide-by-zero", () => {
    const m = measure({ numerator: 4, measureTicks: 0, rests: [{ tick: 0, durTicks: 480 }] });
    eq(Slashes.emptyRestRegions([m], 0, 1920), []);
});

test("no rests / empty input → no regions", () => {
    eq(Slashes.emptyRestRegions([measure()], 0, 1920), []);
    eq(Slashes.emptyRestRegions([], 0, 1920), []);
});
