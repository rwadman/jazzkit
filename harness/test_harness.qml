import QtQuick
import FileIO 3.0

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/slashes.js" as Slashes
import "lib/articulations.js" as Articulations
import "lib/accidentals.js" as Accidentals
import "lib/linebreaks.js" as LineBreaks
import "lib/effects.js" as Effects
import "lib/rests.js" as Rests
import "lib/harness.js" as H
import "."          // InfoDialog.qml — dev-only, lives beside this file

// SEMI-AUTOMATED TEST HARNESS — a DEV tool. scripts/sync-harness.sh splices it into
// the DEV-deployed JazzKit extension as an extra form action ("zz Test Harness"); the
// repo's JazzKit/ never lists it, so it never ships. It is a FORM, like the shipping
// actions, so it runs in the same UI context they do — which matters: cmd("tie")
// runs from an extension form but NOT from a legacy plugin (see api-gotchas). There is no headless way to run a MuseScore plugin (no CLI runner) and
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
// staff included), then Plugins ▸ JazzKit ▸ "zz Test Harness".
MuseScore {
    implicitWidth: 320
    implicitHeight: 80

    InfoDialog { id: infoDialog }
    FileIO { id: reportFile }

    // After appending the drum staff we return from start() so the event loop drains
    // (the mixer processes the new track while idle); this fires afterward to run the
    // cases. One-shot; interval just needs to exceed the queued mixer/layout work.
    Timer {
        id: settleTimer
        interval: 1500
        repeat: false
        // Close this form's window before any case runs: MuseScore refuses notation
        // cmd()s like "tie" while a plugin window is open, and the shipping comp
        // forms likewise quit() before their tie pass. Not from start(): at that
        // point the window isn't yet the current dialog, the close is lost and it
        // opens anyway. The JS keeps running after quit() (the report goes to a
        // file; the InfoDialog may not show once closed).
        onTriggered: { quit(); runCases(); }
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
            Accidentals: Accidentals, Accidental: Accidental,
            Segment: Segment, Element: Element, Cursor: Cursor,
            SymId: SymId, LayoutBreak: LayoutBreak, division: division, fraction: fraction,
            Rests: Rests, removeElement: removeElement,
            Direction: Direction, NoteHeadGroup: NoteHeadGroup, Beam: Beam, cmd: cmd
        };
    }

    // The comp effects as the shipping forms run them: the effect, then its ties via
    // Effects.applyTies (which needs this window CLOSED — start() quits first).
    function cues(args) {
        var res = Effects.compCuesNotes(effectCtx(), args);
        if (!res.error) Effects.applyTies(effectCtx(), res.ties || [], args);
        return res;
    }
    function slashes(args) {
        var res = Effects.compSlashesNotes(effectCtx(), args);
        if (!res.error) Effects.applyTies(effectCtx(), res.ties || [], args);
        return res;
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

    // The ChordRest segment at EXACTLY `tick`, or null. The one "find the segment at
    // this tick" walk — shared by chordAtVoice, dumpTick and fermataCount. Deliberately
    // a segment walk, not cursor.rewindToTick: that skips FORWARD past segments with no
    // element in the current track (api-gotchas), which would silently report a later
    // segment as if it were the one asked for.
    function segmentAt(tick) {
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure)
            for (var s = m.firstSegment; s; s = s.nextInMeasure)
                if (s.segmentType === Segment.ChordRest && s.tick === tick) return s;
        return null;
    }

    // The CHORD element at (staffIdx, voice, tick), or null.
    function chordAtVoice(staffIdx, voice, tick) {
        var seg = segmentAt(tick);
        if (!seg) return null;
        var el = seg.elementAt(staffIdx * 4 + voice);
        return (el && el.type === Element.CHORD) ? el : null;
    }

    // The CHORD element at (staffIdx, voice 0, tick), or null.
    function chordAt(staffIdx, tick) {
        return chordAtVoice(staffIdx, 0, tick);
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
    // NOTE: dumpVoice's `to` is INCLUSIVE and dumpVoiceN's is EXCLUSIVE, and every
    // caller passes the next measure's start tick as `to` — so dumpVoice deliberately
    // shows one segment past the range (the downbeat after it) while dumpVoiceN stops
    // short of it. Collapsing one onto the other would change what several diagnostics
    // print, so they stay two functions.
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
    // Compact dump of ONE voice of a staff across [from, to).
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
    function dumpTick(staffIdx, tick) {
        var seg = segmentAt(tick);
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

    // Raw `symbol` of each articulation on a chord. Compare against BOTH placement
    // variants: MuseScore re-picks the above/below glyph for the chord it lands on
    // (layoutArticulations → setUpArticulations), so a copied articTenutoAbove can
    // legitimately read back as articTenutoBelow.
    function artSyms(chord) {
        var out = [];
        var arts = chord ? (chord.articulations || []) : [];
        for (var i = 0; i < arts.length; ++i) out.push(arts[i].symbol);
        return out;
    }
    function hasArt(chord, symAbove, symBelow) {
        var syms = artSyms(chord);
        return syms.indexOf(symAbove) !== -1 || syms.indexOf(symBelow) !== -1;
    }

    // Number of FERMATA annotations on the segment at `tick` belonging to `track`.
    function fermataCount(track, tick) {
        var seg = segmentAt(tick);
        if (!seg) return 0;
        var ann = seg.annotations || [];
        var n = 0;
        for (var i = 0; i < ann.length; ++i)
            if (ann[i] && ann[i].type === Element.FERMATA
                && (ann[i].track === undefined || ann[i].track === track)) ++n;
        return n;
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

    // Mark the source chord at (staffIdx, tick): one articulation on the chord and
    // one fermata on its segment — the two things a comp must carry over (they live
    // in different places: chord.articulations vs segment.annotations).
    function markSource(staffIdx, tick, artSym, fermataSym) {
        curScore.startCmd();
        var ch = chordAt(staffIdx, tick);
        if (ch) { var a = newElement(Element.ARTICULATION); a.symbol = artSym; ch.add(a); }
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0;
        c.rewindToTick(tick);
        var f = newElement(Element.FERMATA); f.symbol = fermataSym; c.add(f);
        curScore.endCmd();
    }

    // The first bar's [start, end) ticks (for the comp source selection).
    function bar1Range() {
        var m = curScore.firstMeasure;
        var end = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        return { measureTick: m.firstSegment.tick, selStart: m.firstSegment.tick, selEnd: end };
    }

    // Write one bar into voice 1 of staffIdx at barTick: quarter C, an eighth
    // TRIPLET D-E-F on beat 2, quarters G and A on beats 3-4 — the tuplet source
    // every tuplet case copies. Rewinds to the BAR start (a mid-bar rewind on an
    // empty staff skips forward — api-gotchas).
    function writeTripletBar(staffIdx, barTick) {
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0; c.rewindToTick(barTick);
        c.setDuration(1, 4); c.addNote(60);
        c.addTuplet(fraction(3, 2), fraction(1, 4));
        c.setDuration(1, 8); c.addNote(62);
        c.setDuration(1, 8); c.addNote(64);
        c.setDuration(1, 8); c.addNote(65);
        c.setDuration(1, 4); c.addNote(67);
        c.setDuration(1, 4); c.addNote(69);
        curScore.endCmd();
    }

    // The measure starting at bar `n` (1-based), or null.
    function measureN(n) {
        var m = curScore.firstMeasure;
        for (var i = 1; m && i < n; ++i) m = m.nextMeasure;
        return m;
    }

    // Shared prelude of every drum-cue case: reuse the score's drum staff, append a
    // pitched source staff and make sure `bars` measures exist. Returns {drum, src},
    // or null — in which case the skip/failure has ALREADY been recorded under the
    // caller's own labels (they differ per case and are named regressions).
    function drumCueFixture(r, skipLabel, srcLabel, bars) {
        var drum = findDrumStaff();
        if (drum < 0) { H.skip(r, skipLabel, "no drum staff. " + partsDiag()); return null; }
        var src = appendPitched();
        if (src < 0) { H.check(r, srcLabel, false, "append failed"); return null; }
        ensureMeasures(bars);
        return { drum: drum, src: src };
    }

    // Drive Effects.compCuesNotes into one drum target and assert the call itself
    // succeeded; the caller asserts what landed. `p` is {drum, src, selStart, selEnd,
    // measureTick}. Returns the effect's result.
    function runDrumCue(r, label, p) {
        var res = cues({
            selStart: p.selStart, selEnd: p.selEnd, measureTick: p.measureTick, srcStaffIdx: p.src,
            targets: [{ staffIdx: p.drum, isDrum: true }]
        });
        H.check(r, label + ": no error", res.error === "", res.error || "ok");
        return res;
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

    // Fill Empty Beats into a DRUM staff — regression for "fill stopped working on
    // the drum part." A drumset drops invalid pitches silently (NoteInput::addPitch),
    // so filling with the pitched-staff SLASH_PITCH wrote NOTHING; the fill must pick
    // a VALID drum pitch. Fill an empty drum-staff bar and assert slashes appear.
    function caseFillEmptyBeatsNotesDrum(r) {
        var drum = findDrumStaff();
        if (drum < 0) { H.skip(r, "fillEmptyBeats drum: fills an empty bar", "no drum staff. " + partsDiag()); return; }
        ensureMeasures(2);
        var em = findEmptyMeasure(drum);
        if (!em) { H.skip(r, "fillEmptyBeats drum: fills an empty bar", "no all-rest measure"); return; }

        var res = Effects.fillEmptyBeatsNotes(effectCtx(), em.selStart, em.selEnd, em.staffIdx);
        H.check(r, "fillEmptyBeats drum: found + filled regions", res.regions > 0 && res.filled === res.regions && !res.selectFailed,
                "regions=" + res.regions + " filled=" + res.filled + " failed=" + res.selectFailed);
        // Drumset forces the voice by pitch, so count slashes across all voices.
        var n = 0;
        for (var v = 0; v < 4; ++v) n += chordCount(em.selStart, em.selEnd, em.staffIdx * 4 + v);
        H.check(r, "fillEmptyBeats drum: 4 beat slashes written", n === 4,
                "drum chords(all voices)=" + n + " | v0: " + dumpVoice(em.staffIdx, em.selStart, em.selEnd));
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

    // Courtesy Accidentals — Effects.fixCourtesyAccidentals (whole score). Fixture,
    // on its own staff, of the three things that must happen:
    //   bar 1 beat 1: a chromatic note   → its REQUIRED accidental must survive;
    //   bar 1 beat 2: the same note again, given a redundant accidental by hand
    //                                    → must be REMOVED;
    //   bar 2 beat 1: the diatonic spelling of that same staff line
    //                                    → must GAIN a bracketed courtesy accidental.
    // Appended instruments transpose, so we don't know the staff's key signature:
    // probe which of the two F-line spellings actually carries an accidental here
    // and build the fixture around that (one of them always does).
    function caseCourtesyAccidentals(r) {
        var staffIdx = appendPitched();
        if (staffIdx < 0) { H.check(r, "courtesy: fixture staff", false, "append failed"); return; }
        ensureMeasures(2);
        var bar2 = curScore.firstMeasure.nextMeasure;
        if (!bar2) { H.skip(r, "courtesy: adds a bracketed courtesy accidental", "no second measure"); return; }
        var t2 = bar2.firstSegment.tick;

        function writeQuarterAt(tick, pitch) {
            curScore.startCmd();
            var c = curScore.newCursor();
            c.staffIdx = staffIdx; c.voice = 0;
            c.rewindToTick(tick);
            c.setDuration(1, 4); c.addNote(pitch);
            curScore.endCmd();
        }
        function noteAt(tick, idx) {
            var ch = chordAt(staffIdx, tick + idx * 480);
            return (ch && ch.notes.length > 0) ? ch.notes[0] : null;
        }

        writeQuarterAt(0, 66);
        var probe = noteAt(0, 0);
        if (!probe) { H.check(r, "courtesy: fixture note", false, "no note written"); return; }
        var altered = probe.accidental ? 66 : 65;   // the chromatic spelling on THIS staff
        var natural = (altered === 66) ? 65 : 66;   // the one the key signature gives

        writeQuarterAt(0, altered);
        writeQuarterAt(480, altered);
        writeQuarterAt(t2, natural);

        var n1 = noteAt(0, 0), n2 = noteAt(0, 1), n3 = noteAt(t2, 0);
        if (!n1 || !n2 || !n3) { H.check(r, "courtesy: fixture notes", false, "missing note"); return; }
        // Hand the repeat a redundant accidental (MuseScore doesn't write one itself).
        curScore.startCmd();
        n2.accidentalType = n1.accidentalType;
        curScore.endCmd();
        var pitches = [n1.pitch, n2.pitch, n3.pitch];
        H.check(r, "courtesy: fixture has the required + a redundant accidental",
                !!n1.accidental && !!n2.accidental && !n3.accidental,
                "acc=[" + !!n1.accidental + "," + !!n2.accidental + "," + !!n3.accidental + "]");

        var res = Effects.fixCourtesyAccidentals(effectCtx(), { bracket: 1 });

        // Score-wide counts (other cases' staves are in range too), so assert the
        // direction, not exact totals — but a skip means a write moved a pitch and
        // had to be rolled back, which must never happen.
        H.check(r, "courtesy: added and removed something, nothing rolled back",
                res.added >= 1 && res.removed >= 1 && res.skipped === 0,
                "added=" + res.added + " removed=" + res.removed + " skipped=" + res.skipped);

        H.check(r, "courtesy: required accidental kept", !!n1.accidental,
                "accidentalType=" + n1.accidentalType);
        H.check(r, "courtesy: redundant repeat accidental removed", !n2.accidental,
                "accidentalType=" + n2.accidentalType);
        H.check(r, "courtesy: next bar gained a courtesy accidental", !!n3.accidental,
                "accidentalType=" + n3.accidentalType);
        H.check(r, "courtesy: the added accidental is bracketed (parenthesis)",
                !!n3.accidental && n3.accidental.accidentalBracket === 1,
                n3.accidental ? "bracket=" + n3.accidental.accidentalBracket : "no accidental");
        // The invariant every write is guarded by: spelling changes, sound doesn't.
        H.check(r, "courtesy: no note's pitch changed",
                n1.pitch === pitches[0] && n2.pitch === pitches[1] && n3.pitch === pitches[2],
                "before=[" + pitches.join(",") + "] after=["
                    + n1.pitch + "," + n2.pitch + "," + n3.pitch + "]");
    }

    // Rerunning the fix must be a no-op — the score already satisfies it. Guards the
    // add/remove rules against each other (a courtesy the remove pass considers
    // superfluous would show up here as endless churn).
    function caseCourtesyAccidentalsIdempotent(r) {
        var res = Effects.fixCourtesyAccidentals(effectCtx(), { bracket: 1 });
        H.check(r, "courtesy: a second run changes nothing",
                res.added === 0 && res.removed === 0 && res.skipped === 0,
                "added=" + res.added + " removed=" + res.removed + " skipped=" + res.skipped);
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
        // Beat 2 carries a staccato + a fermata: the comp must reproduce both.
        markSource(src, selStart, SymId.articStaccatoAbove, SymId.fermataAbove);

        var res = slashes({
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
        // Markings carried over: the staccato onto the slash chord, the fermata onto
        // its segment (a fermata is a segment annotation, not a chord articulation).
        H.check(r, "compSlashesNotes: source staccato copied onto the slash",
                hasArt(ch, SymId.articStaccatoAbove, SymId.articStaccatoBelow),
                "articulations=[" + artSyms(ch).join(",") + "]");
        H.check(r, "compSlashesNotes: source fermata copied", fermataCount(tgt * 4, selStart) === 1,
                "fermatas=" + fermataCount(tgt * 4, selStart));
        // …and only where the source had them: beat 3 stays bare.
        var beat3 = artSyms(chordAt(tgt, selStart + 480));
        H.check(r, "compSlashesNotes: unmarked beat stays bare",
                beat3.length === 0 && fermataCount(tgt * 4, selStart + 480) === 0,
                "articulations=[" + beat3.join(",") + "] fermatas=" + fermataCount(tgt * 4, selStart + 480));
    }

    // To Comp Slashes into a DRUM staff — regression for "no notes on the drum
    // part, mid-bar". A drumset drops invalid pitches silently, so compSlashesNotes
    // must pick a VALID drum pitch. Uses the up-front drum staff + a mid-bar range.
    function caseCompSlashesNotesDrum(r) {
        var fx = drumCueFixture(r, "compSlashesNotes drum: writes slashes mid-bar",
                                "compSlashesNotes drum: source staff", 1);
        if (!fx) return;
        var drum = fx.drum, src = fx.src;
        writeQuarters(src, [60, 62, 64, 65]);
        var m = curScore.firstMeasure;
        var barStart = m.firstSegment.tick;
        var selStart = barStart + 480;   // mid-bar (the reported failing case)
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;

        var res = slashes({
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
        markSource(src, selStart, SymId.articTenutoAbove, SymId.fermataAbove);

        var res = cues({
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
        H.check(r, "compCuesNotes: source tenuto copied",
                hasArt(atSel, SymId.articTenutoAbove, SymId.articTenutoBelow),
                "articulations=[" + artSyms(atSel).join(",") + "] want "
                + SymId.articTenutoAbove + "/" + SymId.articTenutoBelow);
        H.check(r, "compCuesNotes: source fermata copied", fermataCount(tgt * 4, selStart) === 1,
                "fermatas=" + fermataCount(tgt * 4, selStart));
    }

    // To Comp Cues into a DRUM staff — Effects.compCuesNotes writes the source rhythm
    // as closed-hi-hat CUE NOTES (cue-size, silent, stem up, slash notehead above
    // the staff) in the hi-hat's drumset voice. Whole-bar source.
    function caseCompCuesNotesDrum(r) {
        var fx = drumCueFixture(r, "compCuesNotes drum: cue notes above staff",
                                "compCuesNotes drum: source staff", 1);
        if (!fx) return;
        var drum = fx.drum, src = fx.src;
        writeQuarters(src, [60, 62, 64, 65]);
        var m = curScore.firstMeasure;
        var barStart = m.firstSegment.tick;
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        markSource(src, barStart, SymId.articStaccatoAbove, SymId.fermataAbove);

        runDrumCue(r, "compCuesNotes drum",
                   { drum: drum, src: src, selStart: barStart, selEnd: selEnd, measureTick: barStart });
        // The cue goes specifically in UI voice 3 (0-indexed 2) via cursor.add.
        // Whole-bar (cue starts at the measure boundary) is the regression: pass 1
        // lays a rest shell that TILES the whole measure, so each note beat already
        // has an exactly-sized rest for pass 2's single forward walk to swap in place
        // — all 4 beats survive; a shell that only covered part of the bar dropped one.
        var voice = 2;
        var n = chordCount(barStart, selEnd, drum * 4 + voice);
        H.check(r, "compCuesNotes drum: 4 cue notes in UI voice 3 (0-idx 2)", n === 4,
                "chords@v2=" + n + " | v2: " + dumpVoiceN(drum, 2, barStart, selEnd));
        var ch = chordAtVoice(drum, voice, barStart);
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
        // The cue chord is built by cursor.add in voice 3, so its markings must be
        // attached to that chord/track — not left on the voice-1 rest shell.
        H.check(r, "compCuesNotes drum: source staccato copied",
                hasArt(ch, SymId.articStaccatoAbove, SymId.articStaccatoBelow),
                "articulations=[" + artSyms(ch).join(",") + "]");
        H.check(r, "compCuesNotes drum: source fermata copied",
                fermataCount(drum * 4 + voice, barStart) === 1, "fermatas=" + fermataCount(drum * 4 + voice, barStart));
    }

    // Drum comp cue with a MID-BAR selection in a LATER bar (bar 2, beat 2) — the
    // case the first-bar/bar-start tests never covered. Asserts the cue lands
    // exactly at selStart (not shifted) and stems point up.
    function caseCompCuesNotesDrumMidBar(r) {
        var fx = drumCueFixture(r, "drum cue mid-bar", "drum cue mid-bar: source staff", 3);
        if (!fx) return;
        var drum = fx.drum, src = fx.src;
        writeQuarters(src, [60, 62, 64, 65, 67, 69, 71, 72]); // bars 1-2
        var m2 = curScore.firstMeasure.nextMeasure;
        var bar2 = m2.firstSegment.tick;
        var selStart = bar2 + 480;   // bar 2, beat 2 — mid-bar, not the first bar
        var selEnd = m2.nextMeasure ? m2.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;

        runDrumCue(r, "drum cue mid-bar",
                   { drum: drum, src: src, selStart: selStart, selEnd: selEnd, measureTick: bar2 });
        var voice = 2;   // UI voice 3 (0-indexed)
        var n = chordCount(selStart, selEnd, drum * 4 + voice);
        // Beats 2-4 selected → 3 cue notes, starting exactly at selStart.
        H.check(r, "drum cue mid-bar: 3 cue notes at selStart (UI voice 3)", n === 3,
                "chords@v2=" + n + " | bar2 cue voice: " + dumpVoiceN(drum, voice, bar2, selEnd));
        H.check(r, "drum cue mid-bar: NONE before selStart", chordCount(bar2, selStart, drum * 4 + voice) === 0,
                "before selStart=" + chordCount(bar2, selStart, drum * 4 + voice));
        var ch = chordAtVoice(drum, voice, selStart);
        H.check(r, "drum cue mid-bar: pitch present at selStart", ch !== null, ch ? "chord present" : "MISSING at selStart");
        // Regression: cue must sit at a ledger-free line (fixedLine >= -1), else a
        // ledger line strikes through the slash notehead.
        H.check(r, "drum cue mid-bar: no ledger line (fixedLine >= -1)", ch && ch.notes[0].fixedLine >= -1,
                ch ? "fixedLine=" + ch.notes[0].fixedLine : "no chord");
        H.check(r, "drum cue mid-bar: stems up", ch && ch.stemDirection === Direction.UP,
                ch ? "stemDirection=" + ch.stemDirection + " up=" + Direction.UP : "no chord");
    }

    // Drum comp cue for TWO EIGHTHS at the START of a later bar — regression for
    // "only the first cue note shows up, together with an 8th rest." UI voice 3 is not
    // auto-filled, so a rest shell covering only the selection left a GAP to the bar
    // end; fixing the first cue chord's invalid duration reflowed into that gap and
    // swallowed the second eighth. Pass 1 now TILES the whole measure with rests, so
    // every pass-2 swap is an exact in-place replacement and both eighths survive.
    // Bar 3 (bars 1-2 are already loaded with other cases).
    function caseCompCuesNotesDrumEighths(r) {
        var fx = drumCueFixture(r, "drum cue eighths", "drum cue eighths: source staff", 3);
        if (!fx) return;
        var drum = fx.drum, src = fx.src;
        // Two eighths at the start of bar 3 in the source; rest of the bar stays rests.
        var m3 = curScore.firstMeasure.nextMeasure.nextMeasure;
        var bar3 = m3.firstSegment.tick;
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = src; c.voice = 0; c.rewindToTick(bar3);
        c.setDuration(1, 8); c.addNote(60);
        c.setDuration(1, 8); c.addNote(62);
        curScore.endCmd();
        var selStart = bar3;
        var selEnd = bar3 + 480;   // just the two eighths

        runDrumCue(r, "drum cue eighths",
                   { drum: drum, src: src, selStart: selStart, selEnd: selEnd, measureTick: bar3 });
        var voice = 2;   // UI voice 3 (0-indexed)
        var n = chordCount(selStart, selEnd, drum * 4 + voice);
        // The bug: only 1 cue note (the first eighth) + an 8th rest. Correct: BOTH.
        H.check(r, "drum cue eighths: BOTH eighth cue notes written", n === 2,
                "chords@v2=" + n + " | bar3 cue voice: " + dumpVoiceN(drum, voice, bar3, selEnd));
        var c1 = chordAtVoice(drum, voice, selStart);
        var c2 = chordAtVoice(drum, voice, selStart + 240);
        H.check(r, "drum cue eighths: cue note at the 2nd eighth (tick+240)", c2 !== null,
                c2 ? "present" : "MISSING at selStart+240 | " + dumpVoiceN(drum, voice, bar3, selEnd));
        // Both slots must be eighths (240 ticks), not a chord that swallowed the rest.
        H.check(r, "drum cue eighths: first cue is an eighth (240t)", c1 && c1.duration && c1.duration.ticks === 240,
                c1 && c1.duration ? "ticks=" + c1.duration.ticks : "no chord");
        H.check(r, "drum cue eighths: second cue is an eighth (240t)", c2 && c2.duration && c2.duration.ticks === 240,
                c2 && c2.duration ? "ticks=" + c2.duration.ticks : "no chord");
    }

    // Drum comp cue for THREE QUARTERS at the START of a bar — regression for a
    // PARTIAL selection that leaves the rest of the bar unselected. The shell must
    // still tile the WHOLE measure (trailing fill), else the reflow corrupted the
    // middle quarter into a gap+eighth ("a 4th, empty 8th, an 8th, a 4th"). Bar 4.
    function caseCompCuesNotesDrumQuartersPartial(r) {
        var fx = drumCueFixture(r, "drum cue quarters-partial", "drum cue quarters-partial: source staff", 4);
        if (!fx) return;
        var drum = fx.drum, src = fx.src;
        var m4 = curScore.firstMeasure.nextMeasure.nextMeasure.nextMeasure;
        var bar4 = m4.firstSegment.tick;
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = src; c.voice = 0; c.rewindToTick(bar4);
        c.setDuration(1, 4); c.addNote(60);
        c.setDuration(1, 4); c.addNote(62);
        c.setDuration(1, 4); c.addNote(64);
        curScore.endCmd();
        var selStart = bar4;
        var selEnd = bar4 + 1440;   // three quarters — leaves beat 4 unselected

        runDrumCue(r, "drum cue quarters-partial",
                   { drum: drum, src: src, selStart: selStart, selEnd: selEnd, measureTick: bar4 });
        var voice = 2;
        var n = chordCount(selStart, selEnd, drum * 4 + voice);
        H.check(r, "drum cue quarters-partial: all 3 quarter cue notes", n === 3,
                "chords@v2=" + n + " | bar4 cue voice: " + dumpVoiceN(drum, voice, bar4, bar4 + 1920));
        // The corruption split the middle quarter; assert each cue is a clean 480t
        // quarter and there is NO gap between them.
        var ticks = [selStart, selStart + 480, selStart + 960];
        for (var i = 0; i < ticks.length; ++i) {
            var ch = chordAtVoice(drum, voice, ticks[i]);
            H.check(r, "drum cue quarters-partial: quarter @" + (i + 1) + " is a clean 480t",
                    ch && ch.duration && ch.duration.ticks === 480,
                    ch && ch.duration ? "ticks=" + ch.duration.ticks : "MISSING/short at " + ticks[i]
                        + " | " + dumpVoiceN(drum, voice, bar4, bar4 + 1920));
        }
    }

    // To Comp Cues over a TRIPLET — regression for "the plugins that copy notation
    // can't handle tuplets": the reader took each member's NOMINAL duration (240 for
    // a triplet eighth) and never re-created the tuplet, so the triplet became three
    // straight eighths and everything after it landed an eighth late. The selection
    // starts on the 2nd triplet note, so it also covers widening to the whole tuplet.
    function caseCompCuesNotesTuplet(r) {
        var src = appendPitched();
        var tgt = appendPitched();
        if (src < 0 || tgt < 0) { H.check(r, "cue tuplet: fixture staves", false, "append failed"); return; }
        ensureMeasures(1);
        var m = curScore.firstMeasure;
        var bar = m.firstSegment.tick;
        writeTripletBar(src, bar);
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        var res = cues({
            selStart: bar + 640, selEnd: selEnd, measureTick: bar, srcStaffIdx: src,
            targets: [{ staffIdx: tgt, isDrum: false }]
        });
        H.check(r, "cue tuplet: no error", res.error === "", res.error || "ok");
        var shape = dumpVoiceN(tgt, 0, bar, selEnd);
        var t1 = chordAt(tgt, bar + 480);
        H.check(r, "cue tuplet: widened to the tuplet start (D at beat 2)", t1 && t1.notes[0].pitch === 62,
                t1 ? "pitch=" + t1.notes[0].pitch : "no chord at beat 2 | " + shape);
        H.check(r, "cue tuplet: written as a real 3:2 tuplet", t1 && t1.tuplet && t1.tuplet.actualNotes === 3
                && t1.tuplet.normalNotes === 2, t1 ? "tuplet=" + (t1.tuplet ? t1.tuplet.actualNotes + ":" + t1.tuplet.normalNotes : "none") : shape);
        var t3 = chordAt(tgt, bar + 800);
        H.check(r, "cue tuplet: 3rd triplet note at its actual tick", t3 && t3.notes[0].pitch === 65,
                t3 ? "pitch=" + t3.notes[0].pitch : "missing | " + shape);
        var g = chordAt(tgt, bar + 960);
        H.check(r, "cue tuplet: the note after the tuplet is not shifted", g && g.notes[0].pitch === 67,
                g ? "pitch=" + g.notes[0].pitch : "no chord on beat 3 | " + shape);
        H.check(r, "cue tuplet: nothing before the tuplet", chordCount(bar, bar + 480, tgt * 4) === 0, shape);
    }

    // To Comp Slashes over the same triplet bar (whole bar): 6 slashes, the triplet
    // kept as a tuplet, beat 3 on time.
    function caseCompSlashesNotesTuplet(r) {
        var src = appendPitched();
        var tgt = appendPitched();
        if (src < 0 || tgt < 0) { H.check(r, "slash tuplet: fixture staves", false, "append failed"); return; }
        ensureMeasures(1);
        var m = curScore.firstMeasure;
        var bar = m.firstSegment.tick;
        writeTripletBar(src, bar);
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        var res = slashes({
            selStart: bar, selEnd: selEnd, measureTick: bar, srcStaffIdx: src, targets: [tgt]
        });
        H.check(r, "slash tuplet: no error", res.error === "", res.error || "ok");
        var shape = dumpVoiceN(tgt, 0, bar, selEnd);
        H.check(r, "slash tuplet: 6 slashes", chordCount(bar, selEnd, tgt * 4) === 6, shape);
        var t2 = chordAt(tgt, bar + 640);
        H.check(r, "slash tuplet: triplet slash is inside a tuplet", t2 && t2.tuplet && t2.tuplet.actualNotes === 3, shape);
        H.check(r, "slash tuplet: beat 3 on time", chordAt(tgt, bar + 960) !== null, shape);
    }

    // To Comp Cues with a lead-in no single rest spells — regression for the gap
    // rest: cursor.setDuration TRUNCATES 5/8 to a half, so the cue landed an eighth
    // early. Source: eighths; selection from the 6th eighth (5/8 into the bar).
    function caseCompCuesNotesOddLeadIn(r) {
        var src = appendPitched();
        var tgt = appendPitched();
        if (src < 0 || tgt < 0) { H.check(r, "cue 5/8 lead-in: fixture staves", false, "append failed"); return; }
        ensureMeasures(1);
        var m = curScore.firstMeasure;
        var bar = m.firstSegment.tick;
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = src; c.voice = 0; c.rewindToTick(bar);
        for (var i = 0; i < 8; ++i) { c.setDuration(1, 8); c.addNote(60 + i); }
        curScore.endCmd();
        var selStart = bar + 1200;
        var selEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        var res = cues({
            selStart: selStart, selEnd: selEnd, measureTick: bar, srcStaffIdx: src,
            targets: [{ staffIdx: tgt, isDrum: false }]
        });
        H.check(r, "cue 5/8 lead-in: no error", res.error === "", res.error || "ok");
        var shape = dumpVoiceN(tgt, 0, bar, selEnd);
        H.check(r, "cue 5/8 lead-in: nothing before selStart", chordCount(bar, selStart, tgt * 4) === 0, shape);
        var ch = chordAt(tgt, selStart);
        H.check(r, "cue 5/8 lead-in: 6th eighth lands exactly at selStart", ch && ch.notes[0].pitch === 65,
                ch ? "pitch=" + ch.notes[0].pitch : "no chord at selStart | " + shape);
    }

    // Drum comp cue over a TRIPLET (bar 5). A cue chord can't be placed inside a
    // tuplet, nor sized across the source's triplet segments, so the triplet beat is
    // left a 480-tick REST; the bar must stay aligned (beat 3 on time) and tile
    // (integrity scan). Before the sizing fix the chord's zero-length lengthen ate
    // the beat-3 slot and left a 1-tick gap.
    function caseCompCuesNotesDrumTuplet(r) {
        var fx = drumCueFixture(r, "drum cue tuplet", "drum cue tuplet: source staff", 5);
        if (!fx) return;
        var m5 = measureN(5);
        var bar5 = m5.firstSegment.tick;
        writeTripletBar(fx.src, bar5);
        var selEnd = m5.nextMeasure ? m5.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        runDrumCue(r, "drum cue tuplet", { drum: fx.drum, src: fx.src, selStart: bar5, selEnd: selEnd, measureTick: bar5 });
        var voice = 2;
        var shape = dumpVoiceN(fx.drum, voice, bar5, selEnd);
        H.check(r, "drum cue tuplet: 3 cue notes around the triplet", chordCount(bar5, selEnd, fx.drum * 4 + voice) === 3, shape);
        var seg = segmentAt(bar5 + 480);
        var t = seg ? seg.elementAt(fx.drum * 4 + voice) : null;
        H.check(r, "drum cue tuplet: the triplet beat is one quarter rest", t && t.type === Element.REST
                && t.duration.ticks === 480, shape);
        H.check(r, "drum cue tuplet: beat 3 on time", chordAtVoice(fx.drum, voice, bar5 + 960) !== null, shape);
    }

    // Drum comp cue over a drum GROOVE (bar 8): eighths in the drum staff's own
    // voice 1 put a score segment inside every quarter cue note. Regression: the
    // cue chord's zero-length lengthen (changeCRlen → makeGap) didn't count the
    // stretch up to that segment and ate the next cue slot. All 4 quarters must
    // survive as clean 480t chords, and the groove must be untouched.
    function caseCompCuesNotesDrumOverGroove(r) {
        var fx = drumCueFixture(r, "drum cue over groove", "drum cue over groove: source staff", 8);
        if (!fx) return;
        var m8 = measureN(8);
        var bar8 = m8.firstSegment.tick;
        var selEnd = m8.nextMeasure ? m8.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        // A voice-1 drum pitch for the groove (note input forces the voice by pitch).
        var part = null;
        for (var i = 0; i < curScore.parts.length; ++i)
            if (Math.floor(curScore.parts[i].startTrack / 4) === fx.drum) part = curScore.parts[i];
        var ds = part ? part.instrumentAtTick(0).drumset : null;
        var gp = -1;
        for (var p = 0; ds && p < 128 && gp < 0; ++p) if (ds.isValid(p) && ds.voice(p) === 0) gp = p;
        if (gp < 0) { H.skip(r, "drum cue over groove", "no voice-1 drum pitch"); return; }
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = fx.drum; c.voice = 0; c.rewindToTick(bar8);
        for (var k = 0; k < 8; ++k) { c.setDuration(1, 8); c.addNote(gp); }
        c.staffIdx = fx.src; c.voice = 0; c.rewindToTick(bar8);
        for (var q = 0; q < 4; ++q) { c.setDuration(1, 4); c.addNote(60 + q); }
        curScore.endCmd();
        var grooveBefore = dumpVoiceN(fx.drum, 0, bar8, selEnd);

        runDrumCue(r, "drum cue over groove", { drum: fx.drum, src: fx.src, selStart: bar8, selEnd: selEnd, measureTick: bar8 });
        var voice = 2;
        var shape = dumpVoiceN(fx.drum, voice, bar8, selEnd);
        H.check(r, "drum cue over groove: 4 cue notes", chordCount(bar8, selEnd, fx.drum * 4 + voice) === 4, shape);
        var clean = true;
        for (var b = 0; b < 4; ++b) {
            var ch = chordAtVoice(fx.drum, voice, bar8 + b * 480);
            if (!ch || ch.duration.ticks !== 480) clean = false;
        }
        H.check(r, "drum cue over groove: every cue is a clean 480t quarter", clean, shape);
        H.check(r, "drum cue over groove: groove untouched", dumpVoiceN(fx.drum, 0, bar8, selEnd) === grooveBefore,
                "before [" + grooveBefore + "] after [" + dumpVoiceN(fx.drum, 0, bar8, selEnd) + "]");
    }

    // Drum comp cue over TWO bars ending mid-bar (bar 6 through bar 7 beat 2) —
    // regression: the trailing pad filled only the FIRST measure, so bar 7's voice 3
    // was left with a gap after beat 2, the gap later cursor.add/changeCRlen reflow
    // into (see caseCompCuesNotesDrumQuartersPartial).
    function caseCompCuesNotesDrumMultiBar(r) {
        var fx = drumCueFixture(r, "drum cue multi-bar", "drum cue multi-bar: source staff", 7);
        if (!fx) return;
        var bar6 = measureN(6).firstSegment.tick;
        var m7 = measureN(7);
        var bar7 = m7.firstSegment.tick;
        var bar7End = m7.nextMeasure ? m7.nextMeasure.firstSegment.tick : curScore.lastSegment.tick;
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = fx.src; c.voice = 0; c.rewindToTick(bar6);
        for (var i = 0; i < 8; ++i) { c.setDuration(1, 4); c.addNote(60 + i); }
        curScore.endCmd();
        runDrumCue(r, "drum cue multi-bar", { drum: fx.drum, src: fx.src, selStart: bar6, selEnd: bar7 + 960, measureTick: bar6 });
        var voice = 2;
        var shape = dumpVoiceN(fx.drum, voice, bar7, bar7End);
        H.check(r, "drum cue multi-bar: 6 cue notes", chordCount(bar6, bar7End, fx.drum * 4 + voice) === 6,
                "chords=" + chordCount(bar6, bar7End, fx.drum * 4 + voice) + " | bar7: " + shape);
        // Bar 7's voice 3 must run to the barline (a rest after beat 2), not stop at beat 3.
        var seg = segmentAt(bar7 + 960);
        var tail = seg ? seg.elementAt(fx.drum * 4 + voice) : null;
        H.check(r, "drum cue multi-bar: last bar padded to the barline", tail && tail.type === Element.REST
                && tail.duration.ticks === bar7End - bar7 - 960, "bar7: " + shape);
    }

    // Fill Empty Beats past a tuplet of RESTS — regression: rests were measured by
    // their NOMINAL length, so a triplet-rest group mis-coalesced with its
    // neighbours and the empty beat 1 before it was never filled. Tuplet rests
    // themselves must be left alone (a beat slash can't go inside a tuplet).
    function caseFillEmptyBeatsTupletRests(r) {
        var staffIdx = appendPitched();
        if (staffIdx < 0) { H.check(r, "fill tuplet rests: fixture staff", false, "append failed"); return; }
        ensureMeasures(1);
        var m = curScore.firstMeasure;
        var bar = m.firstSegment.tick;
        var barEnd = m.nextMeasure ? m.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1;
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0; c.rewindToTick(bar);
        c.setDuration(1, 4); c.addRest();                       // beat 1
        c.addTuplet(fraction(3, 2), fraction(1, 4));            // beat 2: triplet of rests
        curScore.endCmd();
        var res = Effects.fillEmptyBeatsNotes(effectCtx(), bar, barEnd, staffIdx);
        var shape = dumpVoiceN(staffIdx, 0, bar, barEnd);
        H.check(r, "fill tuplet rests: beat 1 filled", chordAt(staffIdx, bar) !== null, shape);
        H.check(r, "fill tuplet rests: beats 3-4 filled", chordAt(staffIdx, bar + 960) !== null
                && chordAt(staffIdx, bar + 1440) !== null, shape);
        var seg = segmentAt(bar + 640);
        var mid = seg ? seg.elementAt(staffIdx * 4) : null;
        H.check(r, "fill tuplet rests: the tuplet is left as rests", mid && mid.type === Element.REST && mid.tuplet,
                "regions=" + res.regions + " | " + shape);
    }

    // Source for the tie cases, in voice 1 of staffIdx from barTick: quarters C, D,
    // D, E | E, then rests — D tied to D inside the bar, E tied ACROSS the barline.
    // The ties are made with cmd("tie") (a legacy plugin can dispatch it).
    function writeTiedSource(staffIdx, barTick) {
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0; c.rewindToTick(barTick);
        var pitches = [60, 62, 62, 64, 64];
        for (var i = 0; i < pitches.length; ++i) { c.setDuration(1, 4); c.addNote(pitches[i]); }
        curScore.endCmd();
        curScore.selection.clear();
        curScore.selection.select(chordAt(staffIdx, barTick + 480).notes[0]);
        curScore.selection.select(chordAt(staffIdx, barTick + 1440).notes[0], true);
        cmd("tie");
    }
    function tiedAt(staffIdx, voice, tick) {
        var ch = chordAtVoice(staffIdx, voice, tick);
        return !!(ch && ch.notes[0].tieForward);
    }

    // To Comp Cues / Slashes carry TIES — regression for "ties aren't handled":
    // the copy wrote every tied slice as a fresh attack. Ties are re-made after the
    // write with cmd("tie"). Checks the in-bar tie, the cross-barline tie, that
    // untied notes stay untied, and that no extra notes were created.
    function caseCompTies(r) {
        var src = appendPitched(), cue = appendPitched(), sl = appendPitched();
        if (src < 0 || cue < 0 || sl < 0) { H.check(r, "ties: fixture staves", false, "append failed"); return; }
        ensureMeasures(2);
        var bar = curScore.firstMeasure.firstSegment.tick;
        writeTiedSource(src, bar);
        H.check(r, "ties: fixture has both ties", tiedAt(src, 0, bar + 480) && tiedAt(src, 0, bar + 1440),
                dumpVoice(src, bar, bar + 2400));
        var p = { selStart: bar, selEnd: bar + 2400, measureTick: bar, srcStaffIdx: src };
        var r1 = cues({ selStart: p.selStart, selEnd: p.selEnd, measureTick: bar,
            srcStaffIdx: src, targets: [{ staffIdx: cue, isDrum: false }] });
        var r2 = slashes({ selStart: p.selStart, selEnd: p.selEnd, measureTick: bar,
            srcStaffIdx: src, targets: [sl] });
        H.check(r, "ties: no errors", r1.error === "" && r2.error === "", r1.error + r2.error || "ok");
        var shape = dumpVoiceN(cue, 0, bar, bar + 3840);
        H.check(r, "ties: cue D tied to D (in-bar)", tiedAt(cue, 0, bar + 480), shape);
        H.check(r, "ties: cue E tied across the barline", tiedAt(cue, 0, bar + 1440), shape);
        H.check(r, "ties: untied cue notes stay untied", !tiedAt(cue, 0, bar) && !tiedAt(cue, 0, bar + 960), shape);
        H.check(r, "ties: no extra cue notes", chordCount(bar, bar + 3840, cue * 4) === 5, shape);
        var sshape = dumpVoiceN(sl, 0, bar, bar + 3840);
        H.check(r, "ties: slashes tied like the source", tiedAt(sl, 0, bar + 480) && tiedAt(sl, 0, bar + 1440)
                && !tiedAt(sl, 0, bar) && !tiedAt(sl, 0, bar + 960), sshape);
        H.check(r, "ties: no extra slashes", chordCount(bar, bar + 3840, sl * 4) === 5, sshape);
        var sel = curScore.selection;
        H.check(r, "ties: source range re-selected afterwards", sel.isRange && sel.startStaff === src,
                "isRange=" + sel.isRange + " startStaff=" + sel.startStaff);
    }

    // A tie whose END lies outside the selection has nothing to land on: it must be
    // dropped, and cmd("tie") must NOT be handed that note (it would add a new note
    // to tie to). Selection = bar 1 only; the E→E tie crosses into bar 2.
    function caseCompTiesOutOfRange(r) {
        var src = appendPitched(), cue = appendPitched();
        if (src < 0 || cue < 0) { H.check(r, "ties out of range: fixture staves", false, "append failed"); return; }
        ensureMeasures(2);
        var m = curScore.firstMeasure;
        var bar = m.firstSegment.tick, bar2 = m.nextMeasure.firstSegment.tick;
        writeTiedSource(src, bar);
        var res = cues({ selStart: bar, selEnd: bar2, measureTick: bar,
            srcStaffIdx: src, targets: [{ staffIdx: cue, isDrum: false }] });
        var shape = dumpVoiceN(cue, 0, bar, bar2 + 1920);
        H.check(r, "ties out of range: no error", res.error === "", res.error || "ok");
        H.check(r, "ties out of range: in-range tie kept", tiedAt(cue, 0, bar + 480), shape);
        H.check(r, "ties out of range: dangling tie dropped", !tiedAt(cue, 0, bar + 1440), shape);
        H.check(r, "ties out of range: nothing written into bar 2", chordCount(bar2, bar2 + 1920, cue * 4) === 0, shape);
    }

    // Drum comp cue carries ties too (bar 9): the voice-3 cue notes share one
    // pitch, so a tied source note ties its cue note to the next.
    function caseCompTiesDrum(r) {
        var fx = drumCueFixture(r, "drum cue ties", "drum cue ties: source staff", 9);
        if (!fx) return;
        var m9 = measureN(9);
        var bar9 = m9.firstSegment.tick;
        writeTiedSource(fx.src, bar9);
        runDrumCue(r, "drum cue ties", { drum: fx.drum, src: fx.src, selStart: bar9,
                   selEnd: m9.nextMeasure ? m9.nextMeasure.firstSegment.tick : curScore.lastSegment.tick + 1, measureTick: bar9 });
        var shape = dumpVoiceN(fx.drum, 2, bar9, bar9 + 1920);
        H.check(r, "drum cue ties: tied cue note", tiedAt(fx.drum, 2, bar9 + 480), shape);
        H.check(r, "drum cue ties: untied cue note stays untied", !tiedAt(fx.drum, 2, bar9), shape);
    }

    // ---- rests (Autofix: groupRests / fullBarRests) --------------------------

    // Lengths of the rests in one voice across [from, to), in order ("|"-joined), or
    // a "chord@tick" marker where a chord interrupts.
    function restShape(staffIdx, voice, from, to) {
        var out = [];
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure)
            for (var sg = m.firstSegment; sg; sg = sg.nextInMeasure) {
                if (sg.segmentType !== Segment.ChordRest || sg.tick < from || sg.tick >= to) continue;
                var el = sg.elementAt(staffIdx * 4 + voice);
                if (!el) continue;
                out.push(el.type === Element.REST ? (el.actualDuration ? el.actualDuration.ticks : el.duration.ticks)
                                                  : "chord@" + (sg.tick - from));
            }
        return out.join("|");
    }
    // CRs of one voice in [from, to) as the elements themselves.
    function crsIn(staffIdx, voice, from, to) {
        var out = [];
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure)
            for (var sg = m.firstSegment; sg; sg = sg.nextInMeasure) {
                if (sg.segmentType !== Segment.ChordRest || sg.tick < from || sg.tick >= to) continue;
                var el = sg.elementAt(staffIdx * 4 + voice);
                if (el) out.push(el);
            }
        return out;
    }
    function harmonyCount(staffIdx, from, to) {
        var n = 0;
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure)
            for (var sg = m.firstSegment; sg; sg = sg.nextInMeasure) {
                if (sg.tick < from || sg.tick >= to) continue;
                var ann = sg.annotations || [];
                for (var i = 0; i < ann.length; ++i)
                    if (ann[i] && ann[i].type === Element.HARMONY && ann[i].track === staffIdx * 4) ++n;
            }
        return n;
    }
    function addChordSymbol(staffIdx, tick, text) {
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0; c.rewindToTick(tick);
        var h = newElement(Element.HARMONY);
        c.add(h);
        h.text = text;   // AFTER add: setting it on a detached Harmony crashes (needs a staff)
        curScore.endCmd();
    }
    // Write `items` into one voice of staffIdx from barTick: a positive number is a
    // rest of that many ticks, {note: ticks} a C of that length. Voices 2-4 are
    // reached with the empty-voice trick (rewind on voice 1, then switch).
    function writeVoice(staffIdx, voice, barTick, items) {
        curScore.startCmd();
        var c = curScore.newCursor();
        c.staffIdx = staffIdx; c.voice = 0; c.rewindToTick(barTick); c.voice = voice;
        for (var i = 0; i < items.length; ++i) {
            var it = items[i];
            var t = typeof it === "number" ? it : it.note;
            var f = Effects.ticksToFraction(t, division);
            c.setDuration(f.z, f.n);
            if (typeof it === "number") c.addRest(); else c.addNote(60);
        }
        curScore.endCmd();
    }

    // The rest-grouping PORT against MuseScore itself: a range delete refills with
    // Score::setRests, the very code Rests.restDurations ports. For each time
    // signature, fresh bars at the END of the score are filled with sixteenths, a
    // span is deleted, and MuseScore's refill must equal the port's prediction.
    function caseRestOracle(r) {
        var st = appendPitched();
        if (st < 0) { H.check(r, "rest oracle: fixture staff", false, "append failed"); return; }
        var sections = [
            { n: 4, d: 4, cases: [[240, 1680], [480, 960], [480, 1440], [1200, 720], [120, 600], [360, 1080]] },
            { n: 3, d: 4, cases: [[0, 960], [480, 960], [240, 960], [120, 1200]] },
            { n: 6, d: 8, cases: [[240, 1200], [0, 720], [480, 960], [120, 1080]] },
            { n: 2, d: 4, cases: [[240, 720], [0, 480], [120, 600]] }
        ];
        for (var si = 0; si < sections.length; ++si) {
            var sec = sections[si];
            var first = measureCount() + 1;
            curScore.startCmd(); curScore.appendMeasures(sec.cases.length + 1); curScore.endCmd();
            var m0 = measureN(first);
            curScore.startCmd();
            var tc = curScore.newCursor();
            tc.staffIdx = 0; tc.voice = 0; tc.rewindToTick(m0.firstSegment.tick);
            var ts = newElement(Element.TIMESIG);
            ts.timesig = fraction(sec.n, sec.d);
            tc.add(ts);
            curScore.endCmd();
            var bad = [];
            for (var ci = 0; ci < sec.cases.length; ++ci) {
                var mb = measureN(first + ci);
                var bar = mb.firstSegment.tick;
                var barTicks = mb.timesigNominal.ticks;
                writeVoice(st, 0, bar, (function () { var a = []; for (var k = 0; k < barTicks / 120; ++k) a.push({ note: 120 }); return a; })());
                var a0 = sec.cases[ci][0], len = sec.cases[ci][1];
                curScore.selection.selectRange(bar + a0, bar + a0 + len, st, st + 1);
                cmd("delete");
                var got = restShape(st, 0, bar + a0, bar + a0 + len);
                var want = Rests.restDurations(sec.n, sec.d, a0, len, division).join("|");
                if (got !== want) bad.push("@" + a0 + "+" + len + " MS=" + got + " port=" + want);
            }
            H.check(r, "rest oracle " + sec.n + "/" + sec.d + ": port matches MuseScore's own grouping",
                    bad.length === 0, bad.length ? bad.join("; ") : sec.cases.length + " spans agree");
        }
        curScore.selection.clear();
    }

    // Autofix "group rests": a run MuseScore would write differently is rewritten
    // its way — keeping the chord symbol on it; a run with a fermata is left alone
    // (note input would delete the fermata); a second run changes nothing.
    function caseGroupRests(r) {
        var st = appendPitched();
        if (st < 0) { H.check(r, "group rests: fixture staff", false, "append failed"); return; }
        ensureMeasures(2);
        var bar1 = measureN(1).firstSegment.tick, bar2 = measureN(2).firstSegment.tick;
        writeVoice(st, 0, bar1, [{ note: 480 }, 240, 480, 240, 480]);   // rest 720..1200 crosses beat 3
        addChordSymbol(st, bar1 + 720, "C7");
        writeVoice(st, 0, bar2, [{ note: 480 }, 240, 480, 240, 480]);
        markSource(st, bar2 + 720, SymId.articStaccatoAbove, SymId.fermataAbove);   // fermata on the rest
        var before2 = restShape(st, 0, bar2, bar2 + 1920);
        H.check(r, "group rests: fixture as written", restShape(st, 0, bar1, bar1 + 1920) === "chord@0|240|480|240|480",
                restShape(st, 0, bar1, bar1 + 1920));

        var res = Effects.groupRests(effectCtx());
        var shape = restShape(st, 0, bar1, bar1 + 1920);
        H.check(r, "group rests: regrouped as MuseScore writes it (quarter + half)", shape === "chord@0|480|960",
                shape + " | regrouped=" + res.regrouped);
        H.check(r, "group rests: chord symbol kept", harmonyCount(st, bar1, bar1 + 1920) === 1,
                "harmonies=" + harmonyCount(st, bar1, bar1 + 1920));
        H.check(r, "group rests: run with a fermata left alone", restShape(st, 0, bar2, bar2 + 1920) === before2,
                "before " + before2 + " after " + restShape(st, 0, bar2, bar2 + 1920));
        var again = Effects.groupRests(effectCtx());
        H.check(r, "group rests: a second run changes nothing (whole score)", again.regrouped === 0,
                "regrouped=" + again.regrouped);
    }

    // Autofix "whole-bar rests": a bar that is only rests (voice 1 quarters, voice 2
    // halves, a chord symbol) becomes ONE full-measure rest in voice 1 with voice 2
    // gone and the chord symbol kept; a bar whose voice 2 has a note gets a voice-1
    // bar rest and keeps voice 2; a second run changes nothing.
    function caseFullBarRests(r) {
        var st = appendPitched();
        if (st < 0) { H.check(r, "whole-bar rests: fixture staff", false, "append failed"); return; }
        ensureMeasures(2);
        var bar1 = measureN(1).firstSegment.tick, bar2 = measureN(2).firstSegment.tick;
        writeVoice(st, 0, bar1, [480, 480, 480, 480]);
        writeVoice(st, 1, bar1, [960, 960]);
        addChordSymbol(st, bar1 + 960, "F7");
        writeVoice(st, 0, bar2, [480, 480, 480, 480]);
        writeVoice(st, 1, bar2, [{ note: 960 }, 960]);
        var v2before = restShape(st, 1, bar2, bar2 + 1920);

        var res = Effects.fullBarRests(effectCtx());
        var v1 = crsIn(st, 0, bar1, bar1 + 1920);
        H.check(r, "whole-bar rests: all-rest bar is one full-measure rest", v1.length === 1 && v1[0].isFullMeasureRest === true,
                restShape(st, 0, bar1, bar1 + 1920) + " | bars=" + res.bars);
        H.check(r, "whole-bar rests: its voice-2 rests are gone", crsIn(st, 1, bar1, bar1 + 1920).length === 0,
                restShape(st, 1, bar1, bar1 + 1920));
        H.check(r, "whole-bar rests: chord symbol kept", harmonyCount(st, bar1, bar1 + 1920) === 1,
                "harmonies=" + harmonyCount(st, bar1, bar1 + 1920));
        var b2 = crsIn(st, 0, bar2, bar2 + 1920);
        H.check(r, "whole-bar rests: rest-only voice 1 under a voice-2 note is one bar rest",
                b2.length === 1 && b2[0].isFullMeasureRest === true, restShape(st, 0, bar2, bar2 + 1920));
        H.check(r, "whole-bar rests: that voice 2 is untouched", restShape(st, 1, bar2, bar2 + 1920) === v2before,
                "before " + v2before + " after " + restShape(st, 1, bar2, bar2 + 1920));
        var again = Effects.fullBarRests(effectCtx());
        H.check(r, "whole-bar rests: a second run changes nothing (whole score)", again.bars === 0, "bars=" + again.bars);
    }

    // One voice of [from, to) as "n480~ r240 …": n = chord, r = rest, the length in
    // ticks, "~" when every note is tied into the next chord.
    function rhythmShape(staffIdx, voice, from, to) {
        var out = [];
        var crs = crsIn(staffIdx, voice, from, to);
        for (var i = 0; i < crs.length; ++i) {
            var el = crs[i];
            var ticks = el.actualDuration ? el.actualDuration.ticks : el.duration.ticks;
            var tied = false;
            if (el.type === Element.CHORD) {
                tied = el.notes.length > 0;
                for (var n = 0; n < el.notes.length; ++n) if (!el.notes[n].tieForward) tied = false;
            }
            out.push((el.type === Element.CHORD ? "n" : "r") + ticks + (tied ? "~" : ""));
        }
        return out.join(" ");
    }

    // Autofix "group notes" (Regroup rhythms, bar by bar): a half note on the second
    // eighth splits at beat 3 (chord symbol kept); a quarter tied to a quarter on
    // beats 1-2 becomes a half; a half on beat 2 is fine and untouched; a bar with a
    // fermata is skipped (Regroup rhythms would delete it). A second run over the
    // WHOLE score must change nothing — the port predicting exactly what MuseScore
    // wrote is what makes that true.
    function caseGroupNotes(r) {
        var st = appendPitched();
        if (st < 0) { H.check(r, "group notes: fixture staff", false, "append failed"); return; }
        ensureMeasures(4);
        var b = [0, measureN(1).firstSegment.tick, measureN(2).firstSegment.tick,
                 measureN(3).firstSegment.tick, measureN(4).firstSegment.tick];
        writeVoice(st, 0, b[1], [{ note: 240 }, { note: 960 }, { note: 240 }, { note: 480 }]);
        addChordSymbol(st, b[1] + 240, "Dm7");
        writeVoice(st, 0, b[2], [{ note: 480 }, { note: 480 }, { note: 960 }]);
        curScore.selection.clear();
        curScore.selection.select(chordAt(st, b[2]).notes[0]);
        cmd("tie");
        writeVoice(st, 0, b[3], [{ note: 480 }, { note: 960 }, { note: 480 }]);
        writeVoice(st, 0, b[4], [{ note: 240 }, { note: 960 }, { note: 240 }, { note: 480 }]);
        markSource(st, b[4] + 240, SymId.articStaccatoAbove, SymId.fermataAbove);
        var bar = function (i) { return rhythmShape(st, 0, b[i], b[i] + 1920); };
        var before3 = bar(3), before4 = bar(4);
        H.check(r, "group notes: fixture as written", bar(1) === "n240 n960 n240 n480" && bar(2) === "n480~ n480 n960",
                "bar1 " + bar(1) + " | bar2 " + bar(2));

        var res = Effects.groupNotes(effectCtx());
        H.check(r, "group notes: half on the 2nd eighth splits at beat 3", bar(1) === "n240 n720~ n240 n240 n480",
                bar(1) + " | bars=" + res.bars + " skipped=" + res.skipped);
        H.check(r, "group notes: chord symbol kept", harmonyCount(st, b[1], b[1] + 1920) === 1,
                "harmonies=" + harmonyCount(st, b[1], b[1] + 1920));
        H.check(r, "group notes: tied quarters on beats 1-2 become a half", bar(2) === "n960 n960", bar(2));
        H.check(r, "group notes: a half on beat 2 is left alone", bar(3) === before3, "before " + before3 + " after " + bar(3));
        H.check(r, "group notes: a bar with a fermata is skipped", bar(4) === before4 && res.skipped >= 1,
                "before " + before4 + " after " + bar(4) + " skipped=" + res.skipped);
        var again = Effects.groupNotes(effectCtx());
        H.check(r, "group notes: a second run changes nothing (whole score)", again.bars === 0,
                "bars=" + again.bars);
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
    // measure corrupt. Scans EVERY measure of EVERY staff (all parts) and all 4
    // voices. For a voice that holds any ChordRest, the elements must TILE the bar
    // exactly: start at the measure tick, run contiguously (each element begins where
    // the previous ended), and end at the measure end. This catches both the
    // underfull/overfull case (a voice summing to 1680/1920) AND an internal GAP or
    // overlap that would net to the right sum ("a 4th, a 240-tick hole, an 8th, a
    // 4th" — the exact defect a plain sum misses). Empty voices (no content) are
    // fine. Reports the first offender and the total count.
    function findCorruptBar() {
        var bad = "";
        var count = 0;
        var maxStaves = JazzKit.countStaves(curScore);
        var mi = 0;
        for (var m = curScore.firstMeasure; m; m = m.nextMeasure, ++mi) {
            var mStart = m.firstSegment.tick;
            var full = m.timesigNominal.ticks;
            var mEnd = mStart + full;
            for (var s = 0; s < maxStaves; ++s) {
                for (var v = 0; v < 4; ++v) {
                    var cursorTick = mStart, seen = false, why = "";
                    for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure) {
                        if (seg.segmentType !== Segment.ChordRest) continue;
                        var el = seg.elementAt(s * 4 + v);
                        if (!el || !el.duration) continue;
                        if (!seen && seg.tick !== mStart) why = "starts at " + seg.tick + " not " + mStart;
                        else if (seen && seg.tick !== cursorTick)
                            why = (seg.tick > cursorTick ? "gap" : "overlap") + " at " + seg.tick + " (expected " + cursorTick + ")";
                        seen = true;
                        // actualDuration, not duration: a triplet eighth is NOMINALLY
                        // 240 but spans 160, so the nominal sum reports a bogus overlap.
                        cursorTick = seg.tick + (el.actualDuration ? el.actualDuration.ticks : el.duration.ticks);
                    }
                    if (seen && !why && cursorTick !== mEnd) why = "ends at " + cursorTick + " not " + mEnd;
                    if (seen && why) {
                        ++count;
                        if (!bad) bad = "measure " + (mi + 1) + " staff " + s + " voice " + (v + 1)
                                       + ": " + why + " [" + dumpVoiceN(s, v, mStart, mEnd) + "]";
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
    // drum-staff append (in start()) has had an event-loop turn to settle.
    function runCases() {
        var r = H.newReport();

        caseSelfTest(r);
        caseFillEmptyBeatsNotes(r);
        caseFillEmptyBeatsNotesDrum(r);
        caseFixMarcato(r);
        caseCompSlashesNotes(r);
        caseCompSlashesNotesDrum(r);
        caseCompCuesNotes(r);
        caseCompCuesNotesDrum(r);
        caseCompCuesNotesDrumMidBar(r);
        caseCompCuesNotesDrumEighths(r);
        caseCompCuesNotesDrumQuartersPartial(r);
        caseCompCuesNotesDrumTuplet(r);
        caseCompCuesNotesDrumMultiBar(r);
        caseCompCuesNotesDrumOverGroove(r);
        caseCompTiesDrum(r);
        // Runs AFTER the drum-cue cases on purpose: it appends a staff, and doing so
        // before the drum cue perturbs that effect's (changeCRlen-sensitive) layout and
        // corrupts its bar. Kept last so the drum cue writes in its normal context; this
        // case's own staff is independent. (The integrity scan below guards both.)
        caseFillEmptyBeatsVoice3(r);
        caseCompCuesNotesTuplet(r);
        caseCompSlashesNotesTuplet(r);
        caseCompCuesNotesOddLeadIn(r);
        caseFillEmptyBeatsTupletRests(r);
        caseCompTies(r);
        caseCompTiesOutOfRange(r);
        caseLineBreaks(r);
        // Last: these run over the WHOLE score, so let every other fixture exist
        // (and be asserted) first — that also makes them a sweep over everything the
        // other cases wrote.
        caseCourtesyAccidentals(r);
        caseCourtesyAccidentalsIdempotent(r);

        // Rest fixes last: they sweep the WHOLE score (every fixture above included),
        // and the oracle appends time-signature changes at the end.
        caseRestOracle(r);
        caseGroupRests(r);
        caseFullBarRests(r);
        caseGroupNotes(r);

        checkNoCorruptBars(r);

        var text = H.format(r);
        var path = emitReport(text);
        infoDialog.show(text + "\n\nReport written to:\n" + path
            + "\n(copy it with: scripts/harness-report.sh)."
            + "\n\nThrowaway fixture — close WITHOUT saving.");
    }

    // A form gets no onRun: start once the view is up (deferred a tick, as the
    // shipping forms do).
    Component.onCompleted: Qt.callLater(start)

    function start() {
        var guard = JazzKit.guardScore(curScore, mscoreMajorVersion, mscoreMinorVersion);
        if (guard !== "") { infoDialog.show(guard); return; }
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
