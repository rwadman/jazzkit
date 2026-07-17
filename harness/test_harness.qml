import QtQuick
import FileIO 3.0

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/slashes.js" as Slashes
import "lib/articulations.js" as Articulations
import "lib/linebreaks.js" as LineBreaks
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
            curScore: curScore, newElement: newElement,
            JazzKit: JazzKit, Slashes: Slashes, Articulations: Articulations,
            Segment: Segment, Element: Element, Cursor: Cursor,
            SymId: SymId, LayoutBreak: LayoutBreak, division: division,
            Direction: Direction, NoteHeadGroup: NoteHeadGroup, Beam: Beam
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

    // Diagnostics: compact dump of a staff's voice-0 content in [from, to], and of
    // every voice at one tick (to catch a cue written into the wrong voice/track).
    function elemTag(el) {
        if (!el) return "-";
        if (el.type === Element.CHORD) return "C" + (el.notes.length ? el.notes[0].pitch : "?") + (el.small ? "s" : "");
        if (el.type === Element.REST) return "R";
        return "?" + el.type;
    }
    function dumpVoice(staffIdx, from, to) {
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0; c.rewind(Cursor.SCORE_START);
        var out = [];
        while (c.segment) {
            if (c.tick >= from && c.tick <= to && c.element)
                out.push(c.tick + ":" + elemTag(c.element) + "/" + (c.element.duration ? c.element.duration.ticks : "?"));
            if (c.tick > to || !c.next()) break;
        }
        return out.length ? out.join(" ") : "(empty)";
    }
    function dumpTick(staffIdx, tick) {
        var seg = null;
        for (var m = curScore.firstMeasure; m && !seg; m = m.nextMeasure)
            for (var s = m.firstSegment; s; s = s.nextInMeasure)
                if (s.segmentType === Segment.ChordRest && s.tick === tick) { seg = s; break; }
        if (!seg) return "(no segment at " + tick + ")";
        var out = [];
        for (var v = 0; v < 4; ++v) out.push("v" + v + "=" + elemTag(seg.elementAt(staffIdx * 4 + v)));
        return out.join(" ");
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

    // Fill Empty Beats (direct-API) — Effects.fillEmptyBeatsNotes fills an all-rest
    // voice-1 measure with stemless beat slashes, no cmd(). Asserts the beats became
    // slash noteheads.
    function caseFillEmptyBeatsNotes(r) {
        var staffIdx = appendPitched();
        if (staffIdx < 0) { H.check(r, "fillEmptyBeatsNotes: fixture staff", false, "append failed"); return; }
        ensureMeasures(2);
        var em = findEmptyMeasure(staffIdx);
        if (!em) { H.skip(r, "fillEmptyBeatsNotes: fills an empty measure", "no all-rest measure"); return; }
        var track = em.staffIdx * 4;
        var res = Effects.fillEmptyBeatsNotes(effectCtx(), em.selStart, em.selEnd, em.staffIdx);
        H.check(r, "fillEmptyBeatsNotes: found + filled regions", res.regions > 0 && res.filled === res.regions && !res.selectFailed,
                "regions=" + res.regions + " filled=" + res.filled + " failed=" + res.selectFailed);
        var n = chordCount(em.selStart, em.selEnd, track);
        H.check(r, "fillEmptyBeatsNotes: 4 beat slashes in 4/4", n === 4, "chords=" + n);
        var ch = chordAt(em.staffIdx, em.selStart);
        H.check(r, "fillEmptyBeatsNotes: notehead is a slash", ch && ch.notes[0].headGroup === NoteHeadGroup.HEAD_SLASH,
                ch ? "headGroup=" + ch.notes[0].headGroup : "no chord");
        H.check(r, "fillEmptyBeatsNotes: stemless", ch && ch.noStem === true, ch ? "noStem=" + ch.noStem : "no chord");
    }

    // Fill Empty Beats, ignoring voice 3 — regression for "fill should ignore a
    // voice-3 comp cue when finding empty regions." Fixture: an all-rest voice 1
    // with a SYNCOPATED voice-3 rhythm laid over it (segments at off-beat ticks).
    // Region-finding must judge emptiness on voice 1 alone, so the whole bar still
    // fills with 4 beat slashes, and the voice-3 cue is left untouched.
    function caseFillEmptyBeatsVoice3(r) {
        var staffIdx = appendPitched();
        if (staffIdx < 0) { H.check(r, "fillEmptyBeats v3: fixture staff", false, "append failed"); return; }
        ensureMeasures(2);
        var em = findEmptyMeasure(staffIdx);
        if (!em) { H.skip(r, "fillEmptyBeats v3: fills over a voice-3 cue", "no all-rest measure"); return; }

        // Syncopated voice-3 rhythm: 8th rest, then notes at off-beat 240 + beats.
        // (addNote honors cursor.voice on a pitched staff; use the empty-voice trick
        // to position at the measure start in voice 3.)
        curScore.startCmd();
        var vc = curScore.newCursor();
        vc.staffIdx = staffIdx; vc.voice = 0; vc.rewindToTick(em.selStart); vc.voice = 2;
        vc.setDuration(1, 8); vc.addRest();                                   // 0..240
        vc.setDuration(1, 8); vc.addNote(72);                                 // 240..480
        vc.setDuration(1, 4); vc.addNote(72);                                 // 480..960
        vc.setDuration(1, 4); vc.addNote(72);                                 // 960..1440
        vc.setDuration(1, 4); vc.addNote(72);                                 // 1440..1920
        curScore.endCmd();
        // The cue must be a WELL-FORMED bar: exact ticks/durations summing to a full
        // measure. Counting chords alone misses a corrupt bar (right count, wrong
        // lengths) — the shape string is the real invariant, asserted before & after.
        var want = "0:R/240 240:C72/240 480:C72/480 960:C72/480 1440:C72/480";
        var v3before = dumpVoiceN(staffIdx, 2, em.selStart, em.selEnd);
        H.check(r, "fillEmptyBeats v3: cue is a well-formed bar", v3before === want,
                "want [" + want + "] got [" + v3before + "]");

        var res = Effects.fillEmptyBeatsNotes(effectCtx(), em.selStart, em.selEnd, em.staffIdx);
        H.check(r, "fillEmptyBeats v3: filled the whole bar despite voice 3",
                res.regions === 1 && res.filled === 1 && !res.selectFailed,
                "regions=" + res.regions + " filled=" + res.filled + " failed=" + res.selectFailed);
        var n = chordCount(em.selStart, em.selEnd, em.staffIdx * 4);
        H.check(r, "fillEmptyBeats v3: 4 voice-1 beat slashes", n === 4,
                "voice-1 chords=" + n + " | v1: " + dumpVoice(em.staffIdx, em.selStart, em.selEnd));
        var ch = chordAt(em.staffIdx, em.selStart);
        H.check(r, "fillEmptyBeats v3: notehead is a slash", ch && ch.notes[0].headGroup === NoteHeadGroup.HEAD_SLASH,
                ch ? "headGroup=" + ch.notes[0].headGroup : "no chord");
        var v3after = dumpVoiceN(staffIdx, 2, em.selStart, em.selEnd);
        H.check(r, "fillEmptyBeats v3: voice-3 cue untouched", v3after === v3before,
                "before [" + v3before + "] after [" + v3after + "]");
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

    // To Comp Slashes (direct-API slash notation) — Effects.compSlashesNotes writes
    // the source rhythm as middle-line slash noteheads into a target. Mid-measure
    // selection (beats 2-4) also exercises positioning.
    function caseCompSlashesNotes(r) {
        var src = appendPitched();
        var tgt = appendPitched();
        if (src < 0 || tgt < 0) { H.check(r, "compSlashesNotes: fixture staves", false, "append failed"); return; }
        ensureMeasures(1);
        writeQuarters(src, [60, 62, 64, 65]);
        var m = curScore.firstMeasure;
        var barStart = m.firstSegment.tick;
        var selStart = barStart + 480;   // beat 2
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;

        var res = Effects.compSlashesNotes(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: barStart, srcStaffIdx: src, targets: [tgt]
        });
        H.check(r, "compSlashesNotes: no error", res.error === "", res.error || "ok");
        H.check(r, "compSlashesNotes: no chord before selStart", chordCount(barStart, selStart, tgt * 4) === 0,
                "leading chords=" + chordCount(barStart, selStart, tgt * 4));
        H.check(r, "compSlashesNotes: rhythm written (3 beats)", chordCount(selStart, selEnd, tgt * 4) === 3,
                "chords=" + chordCount(selStart, selEnd, tgt * 4) + " | " + dumpVoice(tgt, 0, selEnd));
        var ch = chordAt(tgt, selStart);
        H.check(r, "compSlashesNotes: notehead is a slash", ch && ch.notes[0].headGroup === NoteHeadGroup.HEAD_SLASH,
                ch ? "headGroup=" + ch.notes[0].headGroup + " slash=" + NoteHeadGroup.HEAD_SLASH : "no chord");
        H.check(r, "compSlashesNotes: notehead fixed to a line", ch && ch.notes[0].fixed === true,
                ch ? "fixed=" + ch.notes[0].fixed : "no chord");
        H.check(r, "compSlashesNotes: slash does not play", ch && ch.notes[0].play === false,
                ch ? "play=" + ch.notes[0].play : "no chord");
    }

    // To Comp Slashes into a DRUM staff — regression for "no notes on the drum
    // part, mid-bar". A drumset drops invalid pitches silently, so compSlashesNotes
    // must pick a VALID drum pitch. Uses the up-front drum staff + a mid-bar range.
    function caseCompSlashesNotesDrum(r) {
        var drum = findDrumStaff();
        if (drum < 0) { H.skip(r, "compSlashesNotes drum: writes slashes mid-bar", "no drum staff. " + partsDiag()); return; }
        var src = appendPitched();
        if (src < 0) { H.check(r, "compSlashesNotes drum: source staff", false, "append failed"); return; }
        ensureMeasures(1);
        writeQuarters(src, [60, 62, 64, 65]);
        var m = curScore.firstMeasure;
        var barStart = m.firstSegment.tick;
        var selStart = barStart + 480;   // mid-bar (the reported failing case)
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;

        var res = Effects.compSlashesNotes(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: barStart, srcStaffIdx: src, targets: [drum]
        });
        H.check(r, "compSlashesNotes drum: no error", res.error === "", res.error || "ok");
        var total = 0;
        for (var v = 0; v < 4; ++v) total += chordCount(selStart, selEnd, drum * 4 + v);
        H.check(r, "compSlashesNotes drum: 3 slashes written mid-bar", total === 3,
                "drum chords(all voices)=" + total + " | v0: " + dumpVoice(drum, 0, selEnd)
                + " | @selStart: " + dumpTick(drum, selStart));
    }

    // To Comp Cues (direct-API note-for-note) — Effects.compCuesNotes writes the
    // source melody note-for-note into a pitched target. Uses a MID-MEASURE source
    // selection (beats 2-4) against an empty target measure to prove the cue starts
    // EXACTLY at selStart (splitting the target's full-measure rest) rather than
    // snapping to the closest segment (the measure start).
    function caseCompCuesNotes(r) {
        var src = appendPitched();
        var tgt = appendPitched();
        if (src < 0 || tgt < 0) { H.check(r, "compCuesNotes: fixture staves", false, "append failed"); return; }
        ensureMeasures(1);
        writeQuarters(src, [60, 62, 64, 65]);   // beats 1-4 of bar 1
        var m = curScore.firstMeasure;
        var barStart = m.firstSegment.tick;
        var selStart = barStart + 480;          // beat 2 (mid-measure)
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;

        var res = Effects.compCuesNotes(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: barStart, srcStaffIdx: src,
            targets: [{ staffIdx: tgt, isDrum: false }]
        });
        H.check(r, "compCuesNotes: no error", res.error === "", res.error || "ok");
        H.check(r, "compCuesNotes: one target stamped", res.targetsDone === 1, "targetsDone=" + res.targetsDone);

        // THE positioning assertion: nothing before selStart (the leading beat is a
        // rest), so the cue did NOT shift to the closest (measure) start.
        var lead = chordCount(barStart, selStart, tgt * 4);
        H.check(r, "compCuesNotes: no chord before selStart (not shifted to closest)", lead === 0,
                "leading chords before selStart=" + lead);
        // Alignment: the beat-2 source pitch (62) sits exactly at selStart.
        var atSel = chordAt(tgt, selStart);
        H.check(r, "compCuesNotes: source pitch lands at selStart", atSel && atSel.notes[0].pitch === 62,
                atSel ? "got pitch " + atSel.notes[0].pitch + ", expected 62" : "no chord at selStart");
        // Exactly the 3 selected notes were written into the target range.
        H.check(r, "compCuesNotes: exactly the selected notes written", chordCount(selStart, selEnd, tgt * 4) === 3,
                "cue chords=" + chordCount(selStart, selEnd, tgt * 4) + " | tgt v0: " + dumpVoice(tgt, 0, selEnd));
        H.check(r, "compCuesNotes: chord is cue-size", atSel && atSel.small === true,
                (atSel ? "small=" + atSel.small : "no chord") + " | tgt all-voice@480: " + dumpTick(tgt, selStart));
    }

    // The chord at (staffIdx, voice, tick), or null.
    function chordAtVoice(staffIdx, voice, tick) {
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure)
            for (var s = m.firstSegment; s; s = s.nextInMeasure)
                if (s.segmentType === Segment.ChordRest && s.tick === tick) {
                    var el = s.elementAt(staffIdx * 4 + voice);
                    return (el && el.type === Element.CHORD) ? el : null;
                }
        return null;
    }

    // To Comp Cues into a DRUM staff — Effects.compCuesNotes writes the source rhythm
    // as closed-hi-hat CUE NOTES (cue-size, silent, stem up, slash notehead above
    // the staff) in the hi-hat's drumset voice. Whole-bar source.
    function caseCompCuesNotesDrum(r) {
        var drum = findDrumStaff();
        if (drum < 0) { H.skip(r, "compCuesNotes drum: cue notes above staff", "no drum staff. " + partsDiag()); return; }
        var src = appendPitched();
        if (src < 0) { H.check(r, "compCuesNotes drum: source staff", false, "append failed"); return; }
        ensureMeasures(1);
        writeQuarters(src, [60, 62, 64, 65]);
        var m = curScore.firstMeasure;
        var barStart = m.firstSegment.tick;
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;

        var res = Effects.compCuesNotes(effectCtx(), {
            selStart: barStart, selEnd: selEnd, measureTick: barStart, srcStaffIdx: src,
            targets: [{ staffIdx: drum, isDrum: true }]
        });
        H.check(r, "compCuesNotes drum: no error", res.error === "", res.error || "ok");
        // The cue goes specifically in UI voice 3 (0-indexed 2) via cursor.add.
        // Whole-bar (cue starts at the measure boundary) is the regression: pass 2
        // must replace the rest shell right-to-left, else beat 2 is dropped.
        var voice = 2;
        var n = chordCount(barStart, selEnd, drum * 4 + voice);
        H.check(r, "compCuesNotes drum: 4 cue notes in UI voice 3 (0-idx 2)", n === 4,
                "chords@v2=" + n + " | v2: " + dumpVoiceN(drum, 2, barStart, selEnd));
        var ch = voice >= 0 ? chordAtVoice(drum, voice, barStart) : null;
        H.check(r, "compCuesNotes drum: cue-size", ch && ch.small === true, ch ? "small=" + ch.small : "no chord");
        H.check(r, "compCuesNotes drum: no per-note small-notehead flag", ch && ch.notes[0].small !== true,
                ch ? "note.small=" + ch.notes[0].small : "no chord");
        H.check(r, "compCuesNotes drum: silent (no playback)", ch && ch.notes[0].play === false,
                ch ? "play=" + ch.notes[0].play : "no chord");
        H.check(r, "compCuesNotes drum: fixed above the staff", ch && ch.notes[0].fixed === true && ch.notes[0].fixedLine < 0,
                ch ? "fixed=" + ch.notes[0].fixed + " line=" + ch.notes[0].fixedLine : "no chord");
        // Regression: a note above line -1 draws a ledger line through the slash
        // (ChordLayout::updateLedgerLines checks only line pos, not notehead). -1 is
        // the highest ledger-free spot; fixedLine=-2 struck a ledger line through it.
        H.check(r, "compCuesNotes drum: no ledger line (fixedLine >= -1)", ch && ch.notes[0].fixedLine >= -1,
                ch ? "fixedLine=" + ch.notes[0].fixedLine : "no chord");
        H.check(r, "compCuesNotes drum: normal notehead (UI voice " + (voice + 1) + ")",
                ch && ch.notes[0].headGroup === NoteHeadGroup.HEAD_NORMAL,
                ch ? "headGroup=" + ch.notes[0].headGroup + " normal=" + NoteHeadGroup.HEAD_NORMAL : "no chord");
        H.check(r, "compCuesNotes drum: stems up", ch && ch.stemDirection === Direction.UP,
                ch ? "stemDirection=" + ch.stemDirection + " up=" + Direction.UP + " down=" + Direction.DOWN : "no chord");
    }

    // Compact dump of ONE voice of a staff across [from, to].
    function dumpVoiceN(staffIdx, voice, from, to) {
        var out = [];
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure)
            for (var s = m.firstSegment; s; s = s.nextInMeasure) {
                if (s.segmentType !== Segment.ChordRest || s.tick < from || s.tick >= to) continue;
                var el = s.elementAt(staffIdx * 4 + voice);
                if (el) out.push(s.tick + ":" + elemTag(el) + "/" + (el.duration ? el.duration.ticks : "?"));
            }
        return out.length ? out.join(" ") : "(empty)";
    }

    // Drum comp cue with a MID-BAR selection in a LATER bar (bar 2, beat 2) — the
    // case the first-bar/bar-start tests never covered. Asserts the cue lands
    // exactly at selStart (not shifted) and stems point up.
    function caseCompCuesNotesDrumMidBar(r) {
        var drum = findDrumStaff();
        if (drum < 0) { H.skip(r, "drum cue mid-bar", "no drum staff. " + partsDiag()); return; }
        var src = appendPitched();
        if (src < 0) { H.check(r, "drum cue mid-bar: source staff", false, "append failed"); return; }
        ensureMeasures(3);
        writeQuarters(src, [60, 62, 64, 65, 67, 69, 71, 72]); // bars 1-2
        var m2 = curScore.firstMeasure.nextMeasure;
        var bar2 = m2.firstSegment.tick;
        var selStart = bar2 + 480;   // bar 2, beat 2 — mid-bar, not the first bar
        var selEnd = m2.nextMeasure ? m2.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;

        var res = Effects.compCuesNotes(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: bar2, srcStaffIdx: src,
            targets: [{ staffIdx: drum, isDrum: true }]
        });
        H.check(r, "drum cue mid-bar: no error", res.error === "", res.error || "ok");
        var voice = 2;   // UI voice 3 (0-indexed)
        var n = chordCount(selStart, selEnd, drum * 4 + voice);
        // Beats 2-4 selected → 3 cue notes, starting exactly at selStart.
        H.check(r, "drum cue mid-bar: 3 cue notes at selStart (UI voice 3)", n === 3,
                "chords@v2=" + n + " | bar2 cue voice: " + dumpVoiceN(drum, voice, bar2, selEnd));
        H.check(r, "drum cue mid-bar: NONE before selStart", chordCount(bar2, selStart, drum * 4 + voice) === 0,
                "before selStart=" + chordCount(bar2, selStart, drum * 4 + voice));
        var ch = voice >= 0 ? chordAtVoice(drum, voice, selStart) : null;
        H.check(r, "drum cue mid-bar: pitch present at selStart", ch !== null, ch ? "chord present" : "MISSING at selStart");
        // Regression: cue must sit at a ledger-free line (fixedLine >= -1), else a
        // ledger line strikes through the slash notehead.
        H.check(r, "drum cue mid-bar: no ledger line (fixedLine >= -1)", ch && ch.notes[0].fixedLine >= -1,
                ch ? "fixedLine=" + ch.notes[0].fixedLine : "no chord");
        H.check(r, "drum cue mid-bar: stems up", ch && ch.stemDirection === Direction.UP,
                ch ? "stemDirection=" + ch.stemDirection + " up=" + Direction.UP : "no chord");
    }

    // Format Line Breaks — Effects.applyLineBreaks attaches the LINE breaks the
    // (unit-tested) LineBreaks.computeBreaks planner decides. One box per measure,
    // "every 2 bars", over ≥6 bars → predictable break count.
    function caseLineBreaks(r) {
        ensureMeasures(6);
        var measures = [];
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure) measures.push(m);
        // The fixture may already carry breaks (e.g. the Treble-Clef template ships
        // formatted); the effect clears them, so count them up front to assert on.
        var preExisting = countLayoutBreaks(measures);

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
        H.check(r, "lineBreaks: cleared the pre-existing breaks", res.removed === preExisting,
                "removed=" + res.removed + " pre-existing=" + preExisting);
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

    // Score integrity scan: after every effect has run, no staff/voice may leave a
    // measure underfull or overfull. For each measure + each of the 4 voices, sum the
    // ChordRest durations that voice actually holds and assert it equals the measure's
    // nominal ticks (0 = the voice is simply absent, which is fine). A voice that sums
    // to e.g. 1680 in a 1920-tick bar is a corrupt bar — the exact defect (3.5 quarters)
    // that renders wrong but that elementAt spot-reads miss. Reports the first offender.
    // Returns "" if every staff/voice fills every measure, else a description of the
    // first offender (and the total count).
    function findCorruptBar() {
        var bad = "";
        var count = 0;
        var maxStaves = JazzKit.countStaves(curScore);
        var mi = 0;
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure, ++mi) {
            var full = m.timesigNominal.ticks;
            for (var s = 0; s < maxStaves; ++s) {
                for (var v = 0; v < 4; ++v) {
                    var sum = 0, seen = false;
                    for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
                        if (seg.segmentType !== Segment.ChordRest) continue;
                        var el = seg.elementAt(s * 4 + v);
                        if (!el || !el.duration) continue;
                        seen = true; sum += el.duration.ticks;
                    }
                    if (seen && sum !== full) {
                        ++count;
                        if (!bad) bad = "measure " + (mi + 1) + " staff " + s + " voice " + (v + 1)
                                       + " sums " + sum + "/" + full + " [" + dumpVoiceN(s, v, m.firstSegment.tick, m.firstSegment.tick + full) + "]";
                    }
                }
            }
        }
        return count === 0 ? "" : (count + " corrupt; first: " + bad);
    }
    function checkNoCorruptBars(r) {
        var bad = findCorruptBar();
        H.check(r, "integrity: no corrupt (under/over-full) bars in any staff/voice",
                bad === "", bad === "" ? "all bars fill their measure" : bad);
    }

    // Run every case and show/emit the report. Called from settleTimer, i.e. after the
    // drum-staff append (in onRun) has had an event-loop turn to settle.
    function runCases() {
        var r = H.newReport();

        caseSelfTest(r);
        caseFillEmptyBeatsNotes(r);
        caseFixMarcato(r);
        caseCompSlashesNotes(r);
        caseCompSlashesNotesDrum(r);
        caseCompCuesNotes(r);
        caseCompCuesNotesDrum(r);
        caseCompCuesNotesDrumMidBar(r);
        // Runs AFTER the drum-cue cases on purpose: it appends a staff, and doing so
        // before the drum cue perturbs that effect's (changeCRlen-sensitive) layout and
        // corrupts its bar. Kept last so the drum cue writes in its normal context; this
        // case's own staff is independent. (The integrity scan below guards both.)
        caseFillEmptyBeatsVoice3(r);
        caseLineBreaks(r);

        checkNoCorruptBars(r);

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
