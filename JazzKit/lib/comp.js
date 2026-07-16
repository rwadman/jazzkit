// @ts-check
// Pure step-sequencing (the "planner") for the To Comp Slashes / To Comp Cues
// plugins.
//
// No MuseScore API here. The .qml reads the selection geometry as plain numbers
// (selStart, selEnd, the measure-start tick, the last-segment tick) and the list
// of chosen target staves; this file turns that into an ORDERED LIST OF OPERATION
// DESCRIPTORS — select this range, run that cmd(), cue-size that region — with all
// the branching (leading-beat cleanup, source==target skip, drum vs pitched)
// decided here. The thin executor in effects.js walks the list and performs each
// op via the API; every decision it makes is therefore unit-tested in Node.
//
//   QML:  import "lib/comp.js" as Comp
//
// Op descriptors the executor understands:
//   { op:"select", a, b, staff, err }  selectStaffRange(a,b,staff); err on failure
//   { op:"cmd", code }                 dispatch a MuseScore action code
//   { op:"cueSize", staff, a, b }      set `small` on [a,b) of the staff (cursor walk)
//   { op:"targetEnd", staff }          bookkeeping marker: one target finished

/**
 * Raw selection reads straight off the cursor/score.
 * @typedef {Object} RawSelection
 * @property {number} selStart         Tick of the first selected chordrest.
 * @property {number} selEnd           Tick past the selection (0 = wrapped at score end).
 * @property {number} measureTick      Tick of the first segment of the start measure.
 * @property {number} lastSegmentTick  curScore.lastSegment.tick (for the wrap fallback).
 */

/**
 * Normalised selection geometry the planners consume.
 * @typedef {Object} Geometry
 * @property {number} selStart
 * @property {number} selEnd           Wrap resolved: lastSegmentTick+1 when it wrapped to 0.
 * @property {number} measureTick
 * @property {boolean} hasLeadingBeats selStart > measureTick — the paste drags in
 *                                     leading beats that must be cleared back to rests.
 */

/**
 * Resolve the raw selection reads into stable geometry:
 * - `rewind(SELECTION_END)` wraps `tick` to 0 at the end of the score, so a
 *   selEnd of 0 means "to the last segment" → lastSegmentTick + 1.
 * - a selection starting after its measure's first segment drags in leading beats
 *   on paste (the paste anchors on the target measure's full-measure rest at the
 *   measure start), which must be cleared afterwards.
 * @param {RawSelection} raw
 * @returns {Geometry}
 */
function selectionGeometry(raw) {
    var selEnd = raw.selEnd === 0 ? raw.lastSegmentTick + 1 : raw.selEnd;
    return {
        selStart: raw.selStart,
        selEnd: selEnd,
        measureTick: raw.measureTick,
        hasLeadingBeats: raw.selStart > raw.measureTick
    };
}

/**
 * Ops that copy the source rhythm, extended left to the measure start so the
 * paste can anchor on the target's full-measure rest.
 * @param {Geometry} g
 * @param {number} srcStaffIdx
 * @param {*} Cmd   commands.js (action-code constants)
 * @returns {Object[]}
 */
function _copySource(g, srcStaffIdx, Cmd) {
    return [
        { op: "select", a: g.measureTick, b: g.selEnd, staff: srcStaffIdx,
          err: "Could not re-select the source notes. Some instruments may be unchanged." },
        { op: "cmd", code: Cmd.COPY }
    ];
}

/**
 * The leading-beat cleanup ops (clear the dragged-in beats back to rests), or an
 * empty list when the selection starts on the barline.
 * @param {Geometry} g
 * @param {number} t
 * @param {*} Cmd
 * @param {string} err
 * @returns {Object[]}
 */
function _clearLeading(g, t, Cmd, err) {
    if (!g.hasLeadingBeats) return [];
    return [
        { op: "select", a: g.measureTick, b: g.selStart, staff: t, err: err },
        { op: "cmd", code: Cmd.DELETE }
    ];
}

/**
 * Plan for To Comp Slashes: per chosen target, copy the source rhythm, paste it
 * into voice 1, slashify the real region, then clear any dragged-in leading beats.
 * Targets equal to the source staff are skipped.
 * @param {Geometry & { srcStaffIdx:number, targets:number[] }} params
 * @param {*} Cmd
 * @returns {Object[]}  Flat op list; a {op:"targetEnd"} closes each target.
 */
function compSlashesPlan(params, Cmd) {
    /** @type {Object[]} */
    var ops = [];
    for (var i = 0; i < params.targets.length; ++i) {
        var t = params.targets[i];
        if (t === params.srcStaffIdx) continue; // never stamp onto the source staff

        ops = ops.concat(_copySource(params, params.srcStaffIdx, Cmd));
        ops.push({ op: "select", a: params.measureTick, b: params.selEnd, staff: t,
                   err: "Could not select a target staff. Some instruments may be unchanged." });
        ops.push({ op: "cmd", code: Cmd.PASTE });
        ops.push({ op: "select", a: params.selStart, b: params.selEnd, staff: t,
                   err: "Pasted, but could not apply slash notation. Some instruments may be unchanged." });
        ops.push({ op: "cmd", code: Cmd.SLASH_RHYTHM });
        ops = ops.concat(_clearLeading(params, t, Cmd,
            "Applied the rhythm, but could not clear the leading beats."));
        ops.push({ op: "targetEnd", staff: t });
    }
    return ops;
}

/**
 * Pitched cue for one target: paste a copy of the source, clear leading beats,
 * then mark the pasted region cue-size (`small`).
 * @param {Geometry} g
 * @param {number} t
 * @param {*} Cmd
 * @returns {Object[]}
 */
function compCuePitchedOps(g, t, Cmd) {
    /** @type {Object[]} */
    var ops = [
        { op: "select", a: g.measureTick, b: g.selEnd, staff: t,
          err: "Could not select a target staff. Some instruments may be unchanged." },
        { op: "cmd", code: Cmd.PASTE }
    ];
    ops = ops.concat(_clearLeading(g, t, Cmd, "Pasted, but could not clear the leading beats."));
    ops.push({ op: "cueSize", staff: t, a: g.selStart, b: g.selEnd });
    return ops;
}

/**
 * Drum comping cue for one target: paste (converting pitches to drum notes), move
 * the region to voice 3, slashify it, clear leading beats, then fill voice 1 with
 * time slashes. Voice-3 move happens before the leading-beat cleanup (doing the
 * delete first left the re-selection incomplete — see comp_cues history).
 * @param {Geometry} g
 * @param {number} t
 * @param {*} Cmd
 * @returns {Object[]}
 */
function compCueDrumOps(g, t, Cmd) {
    /** @type {Object[]} */
    var ops = [
        { op: "select", a: g.measureTick, b: g.selEnd, staff: t,
          err: "Could not select the drum staff to paste into. Some instruments may be unchanged." },
        { op: "cmd", code: Cmd.PASTE },
        { op: "select", a: g.selStart, b: g.selEnd, staff: t,
          err: "Pasted into the drum staff, but could not re-select it to move to voice 3." },
        { op: "cmd", code: Cmd.VOICE_3 },
        { op: "select", a: g.selStart, b: g.selEnd, staff: t,
          err: "Moved to voice 3, but could not re-select the drum staff for slash notation." },
        { op: "cmd", code: Cmd.SLASH_RHYTHM }
    ];
    ops = ops.concat(_clearLeading(g, t, Cmd,
        "Applied the comping cue, but could not clear the leading beats."));
    ops.push({ op: "select", a: g.measureTick, b: g.selEnd, staff: t,
               err: "Applied the comping cue, but could not fill voice 1 with slashes." });
    ops.push({ op: "cmd", code: Cmd.SLASH_FILL });
    return ops;
}

/**
 * Plan for To Comp Cues: per chosen target, copy the source then dispatch to the
 * drum or pitched cue sequence. Targets equal to the source staff are skipped.
 * @param {Geometry & { srcStaffIdx:number, targets:{staffIdx:number,isDrum:boolean}[] }} params
 * @param {*} Cmd
 * @returns {Object[]}  Flat op list; a {op:"targetEnd"} closes each target.
 */
function compCuesPlan(params, Cmd) {
    /** @type {Object[]} */
    var ops = [];
    for (var i = 0; i < params.targets.length; ++i) {
        var t = params.targets[i];
        if (t.staffIdx === params.srcStaffIdx) continue;

        ops = ops.concat(_copySource(params, params.srcStaffIdx, Cmd));
        ops = ops.concat(t.isDrum ? compCueDrumOps(params, t.staffIdx, Cmd)
                                  : compCuePitchedOps(params, t.staffIdx, Cmd));
        ops.push({ op: "targetEnd", staff: t.staffIdx });
    }
    return ops;
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var compLib = {
    selectionGeometry: selectionGeometry,
    compSlashesPlan: compSlashesPlan,
    compCuePitchedOps: compCuePitchedOps,
    compCueDrumOps: compCueDrumOps,
    compCuesPlan: compCuesPlan
};
