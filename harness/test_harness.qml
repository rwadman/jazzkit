import QtQuick
import FileIO 3.0

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/slashes.js" as Slashes
import "lib/comp.js" as Comp
import "lib/articulations.js" as Articulations
import "lib/linebreaks.js" as LineBreaks
import "lib/commands.js" as Cmd
import "lib/effects.js" as Effects
import "lib/harness.js" as H
import "lib"

// SEMI-AUTOMATED TEST HARNESS — a DEV tool, deployed as its own MuseScore package
// (JazzKitTest, via scripts/sync-harness.sh) so it never ships in the JazzKit
// install. There is no headless way to run a MuseScore plugin (no CLI runner) and
// no plugin-side undo, so the model is: open a BLANK score, run this once.
//
// It refuses to run unless the open score has no notes, then drives EVERY JazzKit
// plugin's real effect (the extracted Effects.* code path — the same one the
// shipping plugins call) end-to-end against fixtures it builds itself. Each case
// appends its OWN part(s) and writes only its own notes, so cases can't interfere
// and order doesn't matter (there is no undo — see api-gotchas). Results are
// asserted off the live API and shown in one PASS/FAIL box. The appended parts are
// removed at the end (self-cleaning); still, close WITHOUT saving.
//
// Run: File ▸ New (any empty score — the harness adds its own instruments, drum
// staff included), then Plugins ▸ "zz Test Harness".
MuseScore {
    version: "0.3"
    title: "zz Test Harness"
    menuPath: "Plugins.zz Test Harness"
    description: "Dev harness: builds fixtures, drives every JazzKit effect, asserts results, self-cleans."
    requiresScore: true

    InfoDialog { id: infoDialog }
    FileIO { id: reportFile }

    // After appending the drum staff we return from onRun so the event loop drains
    // (the mixer processes the new track while idle); this fires afterward to run the
    // cases. One-shot; interval just needs to exceed the queued mixer/layout work.
    Timer {
        id: settleTimer
        interval: 800
        repeat: false
        onTriggered: runCases()
    }

    // Single-staff pitched instruments for fixtures. appendPitched() rotates through
    // these (round-robin via pitchedCursor) so appended parts vary rather than being
    // seven copies of one instrument; any whose append increases the staff count is
    // accepted (instruments.xml ids aren't readable here, so we try in order).
    property var instrumentCandidates: ["electric-guitar", "trumpet-b-flat", "flute", "violin", "marimba", "alto-saxophone", "trombone", "clarinet-b-flat", "viola", "guitar"]
    property int pitchedCursor: 0
    // Percussion candidates for the drum-cue case (must yield a real drum staff).
    property var drumCandidates: ["drumset", "drum-set", "percussion", "snare-drum", "marching-snare"]
    // Add a Drumset for the drum-cue case when the score has none. The trick: append
    // it up front, then YIELD to the event loop (settleTimer) before running anything.
    // Score.appendPart mutates the engraving model and the mixer's onTrackAdded slot
    // fires async; if we keep mutating (more appends, cmd()s) it runs interleaved with
    // our changes and crashes in MixerPanelModel::onTrackAdded → instrumentTrackIdList
    // (verified via analyze-crash.py). Yielding first lets the mixer settle on the
    // same idle path the manual Instruments dialog uses — which never crashes. If the
    // score already has a drum staff, we use that and skip the append.
    property bool addDrumStaff: true

    // Bundle the MuseScore globals every effect might need (each uses a subset; a
    // QML-imported JS lib can't see them). Superset of the shipping plugins' ctxs.
    function effectCtx() {
        return {
            curScore: curScore, cmd: cmd, newElement: newElement,
            Cmd: Cmd, JazzKit: JazzKit, Slashes: Slashes, Comp: Comp,
            Articulations: Articulations,
            Segment: Segment, Element: Element, Cursor: Cursor,
            SymId: SymId, LayoutBreak: LayoutBreak
        };
    }

    // ---- read-only fixture probing ------------------------------------------

    function measureCount() {
        var n = 0;
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure) ++n;
        return n;
    }

    // True if any staff/voice holds a real note (CHORD) — the emptiness guard.
    function scoreHasNotes() {
        var tracks = JazzKit.countStaves(curScore) * 4;
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure) {
            for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
                if (seg.segmentType !== Segment.ChordRest) continue;
                for (var t = 0; t < tracks; ++t) {
                    var el = seg.elementAt(t);
                    if (el && el.type === Element.CHORD) return true;
                }
            }
        }
        return false;
    }

    // First note at/after fromTick in staffIdx / voice 0, as {tick, pitch, note}, or null.
    function findNote(staffIdx, fromTick) {
        var c = curScore.newCursor();
        c.rewind(Cursor.SCORE_START);
        c.staffIdx = staffIdx; c.voice = 0;
        while (c.segment) {
            if (c.element && c.element.type === Element.CHORD
                && c.tick >= fromTick && c.element.notes.length > 0)
                return { tick: c.tick, pitch: c.element.notes[0].pitch, note: c.element.notes[0] };
            if (!c.next()) break;
        }
        return null;
    }

    // The CHORD element at (staffIdx, voice 0, tick), or null.
    function chordAt(staffIdx, tick) {
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0;
        c.rewindToTick(tick);
        return (c.element && c.element.type === Element.CHORD) ? c.element : null;
    }

    // First measure whose voice-1 of staffIdx is entirely rests, as {selStart,selEnd,staffIdx}, or null.
    function findEmptyMeasure(staffIdx) {
        var track = staffIdx * 4;
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure) {
            var any = false, allRest = true;
            for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
                if (seg.segmentType !== Segment.ChordRest) continue;
                var el = seg.elementAt(track);
                if (!el) continue;
                any = true;
                if (el.type !== Element.REST) { allRest = false; break; }
            }
            if (any && allRest) {
                var end = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
                return { selStart: m.firstSegment.tick, selEnd: end, staffIdx: staffIdx };
            }
        }
        return null;
    }

    function chordCount(start, end, track) {
        var n = 0;
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure) {
            if (m.firstSegment.tick >= end) break;
            for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
                if (seg.tick < start || seg.tick >= end) continue;
                if (seg.segmentType !== Segment.ChordRest) continue;
                var el = seg.elementAt(track);
                if (el && el.type === Element.CHORD) ++n;
            }
        }
        return n;
    }

    function countLayoutBreaks(measures) {
        var n = 0;
        for (var i = 0; i < measures.length; ++i) {
            var els = measures[i].elements || [];
            for (var j = 0; j < els.length; ++j)
                if (els[j] && els[j].type === Element.LAYOUT_BREAK) ++n;
        }
        return n;
    }

    // `visible` flag of each staccato articulation on a chord (empty = no staccato).
    function staccatoVis(chord) {
        if (!chord) return [];
        var arts = chord.articulations || [];
        var cls = Articulations.classifyChord(Articulations.chordNames(SymId, arts));
        var out = [];
        for (var k = 0; k < cls.staccatoIndices.length; ++k) {
            var a = arts[cls.staccatoIndices[k]];
            out.push(a ? a.visible : true);
        }
        return out;
    }

    // ---- fixture lifecycle (mutating) ---------------------------------------
    // Direct-API edits (appendPart/appendMeasures/cursor writes) are safe to group
    // in one startCmd/endCmd — only dispatched cmd()s must run standalone (gotchas).

    // Append one pitched single-staff part; return its staffIdx, or -1 if none took.
    function appendPitched() {
        var stavesBefore = JazzKit.countStaves(curScore);
        curScore.startCmd();
        var added = false;
        for (var k = 0; k < instrumentCandidates.length && !added; ++k) {
            var idx = (pitchedCursor + k) % instrumentCandidates.length;
            curScore.appendPart(instrumentCandidates[idx]);
            if (JazzKit.countStaves(curScore) > stavesBefore) { added = true; pitchedCursor = idx + 1; }
        }
        curScore.endCmd();
        return added ? stavesBefore : -1;
    }

    // Append a percussion part with a real drum staff; return its staffIdx, or -1.
    function appendDrum() {
        var stavesBefore = JazzKit.countStaves(curScore);
        curScore.startCmd();
        var idx = -1;
        for (var i = 0; i < drumCandidates.length && idx < 0; ++i) {
            curScore.appendPart(drumCandidates[i]);
            if (JazzKit.countStaves(curScore) > stavesBefore) {
                var p = curScore.parts[curScore.parts.length - 1];
                if (p && p.hasDrumStaff) idx = stavesBefore;
                break; // a staff appeared — stop whether or not it's a drum staff
            }
        }
        curScore.endCmd();
        return idx;
    }

    // A drum staff already in the score (loaded at open time, so its mixer channel
    // is safely initialized — unlike a mid-plugin appendPart). Returns staffIdx or -1.
    // Primary signal is part.hasDrumStaff; some builds report it inconsistently, so
    // fall back to a drum/percussion name match.
    function findDrumStaff() {
        var parts = curScore.parts;
        for (var i = 0; i < parts.length; ++i)
            if (parts[i].hasDrumStaff) return Math.floor(parts[i].startTrack / 4);
        for (var j = 0; j < parts.length; ++j) {
            var p = parts[j];
            var name = ((p.instrumentId || "") + " " + (p.partName || "") + " " + (p.longName || "")).toLowerCase();
            if (name.indexOf("drum") !== -1 || name.indexOf("percussion") !== -1)
                return Math.floor(p.startTrack / 4);
        }
        return -1;
    }

    // One-line dump of the current parts (top staff idx, name, drum flag) — used in
    // the drum-case skip so a failed detection reports what the score actually holds.
    function partsDiag() {
        var parts = curScore.parts;
        var out = parts.length + " parts:";
        for (var i = 0; i < parts.length; ++i) {
            var p = parts[i];
            out += " {" + Math.floor(p.startTrack / 4) + " " + (p.partName || p.instrumentId || "?")
                 + (p.hasDrumStaff ? " hasDrumStaff" : "") + "}";
        }
        return out;
    }

    function ensureMeasures(n) {
        var need = n - measureCount();
        if (need > 0) { curScore.startCmd(); curScore.appendMeasures(need); curScore.endCmd(); }
    }

    // Write `pitches` as consecutive quarter notes into voice 1 of staffIdx from bar 1.
    function writeQuarters(staffIdx, pitches) {
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0;
        c.rewind(Cursor.SCORE_START);
        for (var i = 0; i < pitches.length; ++i) { c.setDuration(1, 4); c.addNote(pitches[i]); }
        curScore.endCmd();
    }

    // The first bar's [start, end) ticks (for the comp source selection).
    function bar1Range() {
        var m = curScore.firstMeasure;
        var end = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        return { measureTick: m.firstSegment.tick, selStart: m.firstSegment.tick, selEnd: end };
    }

    // Note: no part-teardown. removeParts while the just-added instruments' samplers
    // are still async-initializing is extra churn on the same mixer path that crashes
    // (above); the fixture is thrown away when the score is closed unsaved, so we just
    // leave the appended parts in place.

    // ---- cases (each builds its own part(s)) --------------------------------

    // Self-test: proves the engine (select element → cmd() → read back).
    function caseSelfTest(r) {
        var staffIdx = appendPitched();
        if (staffIdx < 0) { H.skip(r, "self-test: select+cmd+read-back", "no instrument id worked"); return; }
        ensureMeasures(1);
        writeQuarters(staffIdx, [60]); // middle C
        var n0 = findNote(staffIdx, 0);
        if (!n0) { H.skip(r, "self-test: select+cmd+read-back", "no seed note"); return; }
        curScore.selection.clear();
        curScore.selection.select(n0.note);
        cmd("pitch-up");
        var n1 = findNote(staffIdx, 0);
        H.check(r, "self-test: pitch-up raises pitch", n1 && n1.pitch === n0.pitch + 1,
                "expected " + (n0.pitch + 1) + ", got " + (n1 ? n1.pitch : "?"));
    }

    // Fill Empty Beats — Effects.fillEmptyBeats fills an all-rest voice-1 measure.
    function caseFillEmptyBeats(r) {
        var staffIdx = appendPitched();
        if (staffIdx < 0) { H.check(r, "fillEmptyBeats: fixture staff", false, "append failed"); return; }
        ensureMeasures(2);
        var em = findEmptyMeasure(staffIdx);
        if (!em) { H.skip(r, "fillEmptyBeats: fills an empty measure", "no all-rest measure"); return; }
        var track = em.staffIdx * 4;
        var before = chordCount(em.selStart, em.selEnd, track);
        if (!JazzKit.selectStaffRange(curScore, em.selStart, em.selEnd, em.staffIdx)) {
            H.check(r, "fillEmptyBeats: select target measure", false, "selectStaffRange false"); return;
        }
        var res = Effects.fillEmptyBeats(effectCtx(), em.selStart, em.selEnd, em.staffIdx);
        H.check(r, "fillEmptyBeats: found fillable regions", res.regions > 0, "regions=" + res.regions);
        H.check(r, "fillEmptyBeats: filled, no select failure", res.filled === res.regions && !res.selectFailed,
                "filled=" + res.filled + "/" + res.regions);
        var after = chordCount(em.selStart, em.selEnd, track);
        H.check(r, "fillEmptyBeats: empty beats became slashes", after > before,
                "voice-1 chords " + before + " → " + after);
    }

    // Fix Marcato Staccatos — Effects.fixMarcatoStaccatos (whole score). Fixture:
    // a marcato-only chord and a marcato+visible-staccato chord. Only this case
    // adds marcatos, so the {added, hidden} counts are order-independent.
    function caseFixMarcato(r) {
        var staffIdx = appendPitched();
        if (staffIdx < 0) { H.check(r, "marcato: fixture staff", false, "append failed"); return; }
        ensureMeasures(1);

        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0; c.rewind(Cursor.SCORE_START);
        c.setDuration(1, 4); c.addNote(60);
        c.setDuration(1, 4); c.addNote(62);
        // chord 1 (tick 0): marcato only
        c.rewindToTick(0);
        var a1 = newElement(Element.ARTICULATION); a1.symbol = SymId.articMarcatoAbove; c.add(a1);
        // chord 2 (tick 480): marcato + a visible staccato
        c.rewindToTick(480);
        var a2 = newElement(Element.ARTICULATION); a2.symbol = SymId.articMarcatoAbove; c.add(a2);
        var a3 = newElement(Element.ARTICULATION); a3.symbol = SymId.articStaccatoAbove; c.add(a3);
        curScore.endCmd();

        var res = Effects.fixMarcatoStaccatos(effectCtx());
        H.check(r, "marcato: added one hidden staccato", res.added === 1, "added=" + res.added);
        H.check(r, "marcato: hid one visible staccato", res.hidden === 1, "hidden=" + res.hidden);

        var v1 = staccatoVis(chordAt(staffIdx, 0));
        var v2 = staccatoVis(chordAt(staffIdx, 480));
        H.check(r, "marcato: marcato-only chord gained a hidden staccato", v1.length > 0 && v1[0] === false,
                "visibilities=[" + v1.join(",") + "]");
        H.check(r, "marcato: pre-existing staccato is now hidden", v2.length > 0 && v2[0] === false,
                "visibilities=[" + v2.join(",") + "]");
    }

    // To Comp Slashes — Effects.compSlashes stamps the source rhythm as slashes
    // into voice 1 of a target staff. Source = full bar-1 rhythm.
    function caseCompSlashes(r) {
        var src = appendPitched();
        var tgt = appendPitched();
        if (src < 0 || tgt < 0) { H.check(r, "compSlashes: fixture staves", false, "append failed"); return; }
        ensureMeasures(1);
        writeQuarters(src, [60, 62, 64, 65]);
        var g = bar1Range();
        var before = chordCount(g.selStart, g.selEnd, tgt * 4);

        var res = Effects.compSlashes(effectCtx(), {
            selStart: g.selStart, selEnd: g.selEnd, measureTick: g.measureTick,
            lastSegmentTick: curScore.lastSegment.tick, srcStaffIdx: src, targets: [tgt]
        });
        H.check(r, "compSlashes: no error", res.error === "", res.error || "ok");
        H.check(r, "compSlashes: one target stamped", res.targetsDone === 1, "targetsDone=" + res.targetsDone);
        var after = chordCount(g.selStart, g.selEnd, tgt * 4);
        H.check(r, "compSlashes: target got slash chords", after > before, "chords " + before + " → " + after);
        H.check(r, "compSlashes: source rhythm intact", chordCount(g.selStart, g.selEnd, src * 4) === 4,
                "source chords=" + chordCount(g.selStart, g.selEnd, src * 4));
    }

    // To Comp Cues (pitched) — Effects.compCues stamps a cue-size copy into a
    // pitched target.
    function caseCompCuesPitched(r) {
        var src = appendPitched();
        var tgt = appendPitched();
        if (src < 0 || tgt < 0) { H.check(r, "compCues pitched: fixture staves", false, "append failed"); return; }
        ensureMeasures(1);
        writeQuarters(src, [60, 62, 64, 65]);
        var g = bar1Range();

        var res = Effects.compCues(effectCtx(), {
            selStart: g.selStart, selEnd: g.selEnd, measureTick: g.measureTick,
            lastSegmentTick: curScore.lastSegment.tick, srcStaffIdx: src,
            targets: [{ staffIdx: tgt, isDrum: false }]
        });
        H.check(r, "compCues pitched: no error", res.error === "", res.error || "ok");
        H.check(r, "compCues pitched: one target stamped", res.targetsDone === 1, "targetsDone=" + res.targetsDone);
        var ch = chordAt(tgt, g.selStart);
        H.check(r, "compCues pitched: target has a chord", ch !== null, ch ? "chord present" : "none");
        H.check(r, "compCues pitched: chord is cue-size", ch && ch.small === true, ch ? "small=" + ch.small : "no chord");
        H.check(r, "compCues pitched: notehead is cue-size",
                ch && ch.notes && ch.notes.length > 0 && ch.notes[0].small === true,
                ch && ch.notes && ch.notes.length > 0 ? "note.small=" + ch.notes[0].small : "no note");
    }

    // To Comp Cues (drum) — Effects.compCues stamps a voice-3 rhythmic cue + voice-1
    // time slashes into a drum staff. Skips gracefully if no drum staff can be built
    // (drum staves are flaky — see api-gotchas; downgrade to a full H.skip if needed).
    function caseCompCuesDrum(r) {
        // The drum staff was appended up front in onRun and the mixer let settle
        // (see settleTimer); here we just locate it.
        var drum = findDrumStaff();
        if (drum < 0) {
            H.skip(r, "compCues drum: rhythmic comping cue",
                   "no drum staff (addDrumStaff off, or the append did not take). " + partsDiag());
            return;
        }
        var src = appendPitched();
        if (src < 0) { H.check(r, "compCues drum: source staff", false, "append failed"); return; }
        ensureMeasures(1);
        writeQuarters(src, [60, 62, 64, 65]);
        var g = bar1Range();

        var res = Effects.compCues(effectCtx(), {
            selStart: g.selStart, selEnd: g.selEnd, measureTick: g.measureTick,
            lastSegmentTick: curScore.lastSegment.tick, srcStaffIdx: src,
            targets: [{ staffIdx: drum, isDrum: true }]
        });
        H.check(r, "compCues drum: no error", res.error === "", res.error || "ok");
        H.check(r, "compCues drum: one target stamped", res.targetsDone === 1, "targetsDone=" + res.targetsDone);
        H.check(r, "compCues drum: voice-3 comping chords", chordCount(g.selStart, g.selEnd, drum * 4 + 2) > 0,
                "voice-3 chords=" + chordCount(g.selStart, g.selEnd, drum * 4 + 2));
        H.check(r, "compCues drum: voice-1 time slashes", chordCount(g.measureTick, g.selEnd, drum * 4) > 0,
                "voice-1 chords=" + chordCount(g.measureTick, g.selEnd, drum * 4));
    }

    // Format Line Breaks — Effects.applyLineBreaks attaches the LINE breaks the
    // (unit-tested) LineBreaks.computeBreaks planner decides. One box per measure,
    // "every 2 bars", over ≥6 bars → predictable break count.
    function caseLineBreaks(r) {
        ensureMeasures(6);
        var measures = [];
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure) measures.push(m);

        var boxes = [];
        for (var i = 0; i < measures.length; ++i)
            boxes.push({ musicBars: 1, endsDouble: false, repeatEnd: false, repeatStart: false });
        var idxs = LineBreaks.computeBreaks(boxes, { atDouble: false, atRepeats: false, everyN: 2, minBars: 0, maxBars: 0 });
        var breakMeasures = [];
        for (var j = 0; j < idxs.length; ++j) breakMeasures.push(measures[idxs[j]]);
        H.check(r, "lineBreaks: planner predicts breaks", breakMeasures.length > 0, "predicted=" + breakMeasures.length);

        var res = Effects.applyLineBreaks(effectCtx(), measures, breakMeasures);
        H.check(r, "lineBreaks: added the planned breaks", res.added === breakMeasures.length,
                "added=" + res.added + " expected=" + breakMeasures.length);
        H.check(r, "lineBreaks: cleared no pre-existing breaks", res.removed === 0, "removed=" + res.removed);
        H.check(r, "lineBreaks: LAYOUT_BREAK elements match plan", countLayoutBreaks(measures) === breakMeasures.length,
                "found=" + countLayoutBreaks(measures));
    }

    // ---- entry --------------------------------------------------------------

    // Write the report to a file so it can be COPIED (the InfoDialog box can't be, and
    // plugin console.log doesn't reach the MuseScore log in this build). Tries known
    // FileIO methods (userProjectsPath is newer and may be absent — homePath/tempPath
    // are the stable ones) and known-writable dirs, first that takes wins. Returns the
    // path scripts/harness-report.sh should read (it checks the same locations).
    function reportDirs() {
        var dirs = [];
        try { dirs.push(reportFile.homePath() + "/Documents/MuseScore4/Scores"); } catch (e) {}
        try { dirs.push(reportFile.tempPath()); } catch (e2) {}
        try { dirs.push(reportFile.homePath()); } catch (e3) {}
        return dirs;
    }
    function emitReport(text) {
        var dirs = reportDirs();
        for (var i = 0; i < dirs.length; ++i) {
            var path = dirs[i] + "/jazzkit-harness-report.txt";
            try {
                reportFile.source = path;
                if (reportFile.write(text + "\n")) return path;
            } catch (e) { /* try the next dir */ }
        }
        return "(could not write report file — dirs tried: " + dirs.join(", ") + ")";
    }

    // Run every case and show/emit the report. Called from settleTimer, i.e. after the
    // drum-staff append (in onRun) has had an event-loop turn to settle.
    function runCases() {
        var r = H.newReport();

        caseSelfTest(r);
        caseFillEmptyBeats(r);
        caseFixMarcato(r);
        caseCompSlashes(r);
        caseCompCuesPitched(r);
        caseCompCuesDrum(r);
        caseLineBreaks(r);

        var text = H.format(r);
        var path = emitReport(text);
        infoDialog.show(text + "\n\nReport written to:\n" + path
            + "\n(copy it with: scripts/harness-report.sh)."
            + "\n\nThrowaway fixture — close WITHOUT saving.");
    }

    onRun: {
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion)) {
            infoDialog.show(qsTr("This plugin is for MuseScore 4.4 or later"));
            return;
        }
        if (scoreHasNotes()) {
            infoDialog.show(qsTr("Refusing to run: the open score already contains notes.\n"
                + "Open a blank score (File ▸ New) so the harness can build a throwaway fixture."));
            return;
        }

        // Add the drum staff BEFORE anything else, then return so the event loop
        // drains and the mixer processes the new track while idle (see settleTimer /
        // addDrumStaff). Running the cases synchronously here instead would crash the
        // mixer. If the score already has a drum staff, we reuse it (no append).
        if (addDrumStaff && findDrumStaff() < 0) appendDrum();
        settleTimer.start();
    }
}
