import { test, eq, ok } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const Comp = loadQmlLib("../JazzKit/lib/comp.js", "compLib");
const Cmd = loadQmlLib("../JazzKit/lib/commands.js", "commandsLib");

// Compact one op into a readable token so a whole plan reads as a short trace.
function tok(op) {
    switch (op.op) {
        case "select":   return `sel ${op.a}-${op.b}@${op.staff}`;
        case "cmd":      return `cmd ${op.code}`;
        case "cueSize":  return `cue ${op.a}-${op.b}@${op.staff}`;
        case "targetEnd":return `end@${op.staff}`;
        default:         return `?${op.op}`;
    }
}
const trace = (ops) => ops.map(tok);

// A selection of beats 2-4 of a 4/4 bar at tick 0 (beat = 480): starts mid-bar,
// so it drags in a leading beat on paste.
const geomLeading = { measureTick: 0, selStart: 480, selEnd: 1920, hasLeadingBeats: true };
// A selection starting on the barline: no leading beats.
const geomOnBar = { measureTick: 0, selStart: 0, selEnd: 1920, hasLeadingBeats: false };

// --- selectionGeometry ------------------------------------------------------

test("selectionGeometry: selEnd 0 wraps to lastSegmentTick + 1", () => {
    const g = Comp.selectionGeometry({ selStart: 0, selEnd: 0, measureTick: 0, lastSegmentTick: 3839 });
    eq(g.selEnd, 3840);
});

test("selectionGeometry: a non-zero selEnd passes through unchanged", () => {
    const g = Comp.selectionGeometry({ selStart: 480, selEnd: 1920, measureTick: 0, lastSegmentTick: 9999 });
    eq(g.selEnd, 1920);
});

test("selectionGeometry: hasLeadingBeats iff selStart > measureTick", () => {
    eq(Comp.selectionGeometry({ selStart: 480, selEnd: 1920, measureTick: 0, lastSegmentTick: 0 }).hasLeadingBeats, true);
    eq(Comp.selectionGeometry({ selStart: 0, selEnd: 1920, measureTick: 0, lastSegmentTick: 0 }).hasLeadingBeats, false);
    // selStart == measureTick is on the barline, not leading.
    eq(Comp.selectionGeometry({ selStart: 1920, selEnd: 3840, measureTick: 1920, lastSegmentTick: 0 }).hasLeadingBeats, false);
});

// --- compSlashesPlan --------------------------------------------------------

test("compSlashesPlan: single target, mid-bar → copy/paste/slash + clear leading", () => {
    const ops = Comp.compSlashesPlan(Object.assign({ srcStaffIdx: 0, targets: [2] }, geomLeading), Cmd);
    eq(trace(ops), [
        "sel 0-1920@0", "cmd copy",
        "sel 0-1920@2", "cmd paste",
        "sel 480-1920@2", "cmd slash-rhythm",
        "sel 0-480@2", "cmd delete",
        "end@2",
    ]);
});

test("compSlashesPlan: selection on the barline omits the leading-beat delete", () => {
    const ops = Comp.compSlashesPlan(Object.assign({ srcStaffIdx: 0, targets: [2] }, geomOnBar), Cmd);
    eq(trace(ops), [
        "sel 0-1920@0", "cmd copy",
        "sel 0-1920@2", "cmd paste",
        "sel 0-1920@2", "cmd slash-rhythm",
        "end@2",
    ]);
});

test("compSlashesPlan: multiple targets run in order; the source staff is skipped", () => {
    const ops = Comp.compSlashesPlan(Object.assign({ srcStaffIdx: 1, targets: [1, 2, 3] }, geomOnBar), Cmd);
    // staff 1 == source is skipped; 2 then 3 in order.
    eq(ops.filter((o) => o.op === "targetEnd").map((o) => o.staff), [2, 3]);
    // The source staff is only ever a copy source (select+copy), never pasted onto.
    ok(!ops.some((o) => o.op === "targetEnd" && o.staff === 1), "source staff is never a target");
});

test("compSlashesPlan: no targets → empty plan", () => {
    eq(Comp.compSlashesPlan(Object.assign({ srcStaffIdx: 0, targets: [] }, geomOnBar), Cmd), []);
});

test("compSlashesPlan: only-target-is-source → empty plan", () => {
    eq(Comp.compSlashesPlan(Object.assign({ srcStaffIdx: 2, targets: [2] }, geomOnBar), Cmd), []);
});

// --- compCuePitchedOps ------------------------------------------------------

test("compCuePitchedOps: paste, clear leading, cue-size the pasted region", () => {
    eq(trace(Comp.compCuePitchedOps(geomLeading, 3, Cmd)), [
        "sel 0-1920@3", "cmd paste",
        "sel 0-480@3", "cmd delete",
        "cue 480-1920@3",
    ]);
});

test("compCuePitchedOps: on the barline → no delete, cue covers the whole selection", () => {
    eq(trace(Comp.compCuePitchedOps(geomOnBar, 3, Cmd)), [
        "sel 0-1920@3", "cmd paste",
        "cue 0-1920@3",
    ]);
});

// --- compCueDrumOps ---------------------------------------------------------

test("compCueDrumOps: paste → voice-3 → slash-rhythm → clear leading → slash-fill", () => {
    eq(trace(Comp.compCueDrumOps(geomLeading, 4, Cmd)), [
        "sel 0-1920@4", "cmd paste",
        "sel 480-1920@4", "cmd voice-3",
        "sel 480-1920@4", "cmd slash-rhythm",
        "sel 0-480@4", "cmd delete",
        "sel 0-1920@4", "cmd slash-fill",
    ]);
});

test("compCueDrumOps: the voice-3 move precedes the leading-beat delete", () => {
    const codes = Comp.compCueDrumOps(geomLeading, 4, Cmd).filter((o) => o.op === "cmd").map((o) => o.code);
    ok(codes.indexOf(Cmd.VOICE_3) < codes.indexOf(Cmd.DELETE), "voice-3 must come before delete");
});

test("compCueDrumOps: on the barline omits the delete step", () => {
    const codes = Comp.compCueDrumOps(geomOnBar, 4, Cmd).filter((o) => o.op === "cmd").map((o) => o.code);
    eq(codes, [Cmd.PASTE, Cmd.VOICE_3, Cmd.SLASH_RHYTHM, Cmd.SLASH_FILL]);
});

// --- compCuesPlan (dispatch) ------------------------------------------------

test("compCuesPlan: dispatches drum vs pitched per target and skips the source", () => {
    const params = Object.assign({
        srcStaffIdx: 0,
        targets: [{ staffIdx: 0, isDrum: false }, { staffIdx: 2, isDrum: false }, { staffIdx: 4, isDrum: true }],
    }, geomOnBar);
    const ops = Comp.compCuesPlan(params, Cmd);
    // source (0) skipped; pitched target 2 has a cueSize, drum target 4 has voice-3.
    eq(ops.filter((o) => o.op === "targetEnd").map((o) => o.staff), [2, 4]);
    ok(ops.some((o) => o.op === "cueSize" && o.staff === 2), "pitched target cue-sized");
    ok(ops.some((o) => o.op === "cmd" && o.code === Cmd.VOICE_3 && true), "drum target moved to voice 3");
    ok(!ops.some((o) => o.op === "cueSize" && o.staff === 4), "drum target is not cue-sized");
});

test("compCuesPlan: each target begins with a source copy", () => {
    const params = Object.assign({
        srcStaffIdx: 0, targets: [{ staffIdx: 2, isDrum: false }, { staffIdx: 4, isDrum: true }],
    }, geomOnBar);
    const ops = Comp.compCuesPlan(params, Cmd);
    // Two copies of the source, one per target.
    eq(ops.filter((o) => o.op === "cmd" && o.code === Cmd.COPY).length, 2);
});
