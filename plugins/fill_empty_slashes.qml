import QtQuick

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/slashes.js" as Slashes
import "lib"

MuseScore {
    version: "0.1"
    title: "Fill Empty Beats with Slashes"
    menuPath: "Plugins.Fill Empty Beats with Slashes"
    description: "Like Fill with Slashes, but only fills the beats of voice 1 that have no notes — existing voice 1 notes are left untouched."

//=============================================================================

    InfoDialog { id: infoDialog }

//=============================================================================

    // Collect the [start, end) tick ranges of voice-1 rests within the selection
    // that are whole-beat aligned. Each such range is a run where voice 1 is empty;
    // running slash-fill on it fills those beats into voice 1 (the first all-rest
    // voice) without disturbing existing voice-1 notes elsewhere.
    //
    // Rests that share a beat with a note (off-beat / sub-beat rests) are skipped:
    // that beat is not "without notes in voice 1", so it must stay as the user wrote it.
    // Walk the score to read each measure's timesig + voice-1 rests as plain data
    // (the effect part); the beat math and whole-beat alignment that decides the
    // fillable regions live in the typed, unit-tested slashes.js.
    function collectEmptyRestRegions(selStart, selEnd, staffIdx)
    {
        var track = staffIdx * 4; // voice 1
        var measures = [];

        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        var m = cursor.measure;

        while (m && m.firstSegment && m.firstSegment.tick < selEnd)
        {
            var ts = m.timesigNominal;
            var rests = [];
            for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure)
            {
                if (seg.segmentType !== Segment.ChordRest) continue;
                var el = seg.elementAt(track);
                if (!el || el.type !== Element.REST) continue;
                rests.push({ tick: seg.tick, durTicks: el.duration.ticks });
            }

            measures.push({
                mStart: m.firstSegment.tick,
                numerator: ts.numerator,
                denominator: ts.denominator,
                measureTicks: ts.ticks,
                rests: rests
            });

            m = m.nextMeasure;
        }

        return Slashes.emptyRestRegions(measures, selStart, selEnd);
    }

//=============================================================================

    function fillEmptyBeats()
    {
        var sel = curScore.selection;
        if (!sel || !sel.isRange || sel.elements.length === 0)
        {
            infoDialog.show(qsTr("Please select a range of notes first."));
            return;
        }

        if (sel.endStaff - sel.startStaff !== 1)
        {
            infoDialog.show(qsTr("Please select notes in a single staff only."));
            return;
        }

        var staffIdx = sel.startStaff;

        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        var selStart = cursor.tick;
        cursor.rewind(Cursor.SELECTION_END);
        var selEnd = cursor.tick;
        // rewind(SELECTION_END) wraps to tick 0 at the end of the score.
        if (selEnd === 0) selEnd = curScore.lastSegment.tick + 1;

        // Collect all regions up front, from the original state. Filling one region
        // adds notes only at its own ticks, so later regions' ticks stay valid.
        var regions = collectEmptyRestRegions(selStart, selEnd, staffIdx);

        if (regions.length === 0)
        {
            infoDialog.show(qsTr("No empty beats in voice 1 to fill."));
            return;
        }

        // Fill each region with a standalone slash-fill (each cmd() lays out between
        // steps; never wrap them in one startCmd). Re-select and verify before each.
        for (var i = 0; i < regions.length; ++i)
        {
            if (!JazzKit.selectStaffRange(curScore, regions[i].start, regions[i].end, staffIdx))
            {
                infoDialog.show(qsTr("Could not select a region to fill. Some beats may be unfilled."));
                return;
            }
            cmd("slash-fill");
        }
    }

//=============================================================================

    onRun:
    {
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion))
        {
            infoDialog.show(qsTr("This plugin is for MuseScore 4.4 or later"));
            return;
        }

        fillEmptyBeats();
    }
}
