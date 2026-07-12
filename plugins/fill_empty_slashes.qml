import QtQuick

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.1"
    title: "Fill Empty Beats with Slashes"
    menuPath: "Plugins.Fill Empty Beats with Slashes"
    description: "Like Fill with Slashes, but only fills the beats of voice 1 that have no notes — existing voice 1 notes are left untouched."

//=============================================================================

    function showMessage(message)
    {
        infoDialog.text = message;
        infoDialog.open();
    }

    MessageDialog
    {
        id: infoDialog
        visible: false
        title: "JazzKit"
        text: ""
        onAccepted: { close(); }
    }

//=============================================================================

    // Select a single-staff range and confirm the selection landed on the intended
    // staff. The dispatched slash-fill acts on curScore.selection, so a failed
    // selection must abort rather than run against the wrong region.
    function selectStaffRange(startTick, endTick, staffIdx)
    {
        curScore.selection.selectRange(startTick, endTick, staffIdx, staffIdx + 1);
        var s = curScore.selection;
        return s && s.isRange && s.startStaff === staffIdx;
    }

//=============================================================================

    // Collect the [start, end) tick ranges of voice-1 rests within the selection
    // that are whole-beat aligned. Each such range is a run where voice 1 is empty;
    // running slash-fill on it fills those beats into voice 1 (the first all-rest
    // voice) without disturbing existing voice-1 notes elsewhere.
    //
    // Rests that share a beat with a note (off-beat / sub-beat rests) are skipped:
    // that beat is not "without notes in voice 1", so it must stay as the user wrote it.
    function collectEmptyRestRegions(selStart, selEnd, staffIdx)
    {
        var track = staffIdx * 4; // voice 1
        var regions = [];

        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        var m = cursor.measure;

        while (m && m.firstSegment && m.firstSegment.tick < selEnd)
        {
            var mStart = m.firstSegment.tick;
            var ts = m.timesigNominal;
            var d = ts.denominator;
            var num = ts.numerator;
            // Mirror slash-fill's beat unit: compound meters group in threes.
            var n = (d > 4 && num % 3 === 0) ? 3 : 1;
            var beat = Math.floor(ts.ticks * n / num);

            for (var seg = m.firstSegment; seg; seg = seg.nextInMeasure)
            {
                if (seg.segmentType !== Segment.ChordRest) continue;

                var el = seg.elementAt(track);
                if (!el || el.type !== Element.REST) continue;

                var st = seg.tick;
                var dur = el.duration.ticks;

                // Clip to the selection.
                var rs = Math.max(st, selStart);
                var re = Math.min(st + dur, selEnd);
                if (re <= rs) continue;

                // Only whole beats: aligned to a beat boundary and a beat multiple.
                if (beat <= 0) continue;
                if ((rs - mStart) % beat !== 0) continue;
                if ((re - rs) % beat !== 0) continue;

                regions.push({ start: rs, end: re });
            }

            m = m.nextMeasure;
        }

        return regions;
    }

//=============================================================================

    function fillEmptyBeats()
    {
        var sel = curScore.selection;
        if (!sel || !sel.isRange || sel.elements.length === 0)
        {
            showMessage(qsTr("Please select a range of notes first."));
            return;
        }

        if (sel.endStaff - sel.startStaff !== 1)
        {
            showMessage(qsTr("Please select notes in a single staff only."));
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
            showMessage(qsTr("No empty beats in voice 1 to fill."));
            return;
        }

        // Fill each region with a standalone slash-fill (each cmd() lays out between
        // steps; never wrap them in one startCmd). Re-select and verify before each.
        for (var i = 0; i < regions.length; ++i)
        {
            if (!selectStaffRange(regions[i].start, regions[i].end, staffIdx))
            {
                showMessage(qsTr("Could not select a region to fill. Some beats may be unfilled."));
                return;
            }
            cmd("slash-fill");
        }
    }

//=============================================================================

    onRun:
    {
        if ((mscoreMajorVersion <= 3) || (mscoreMajorVersion == 4 && mscoreMinorVersion < 4))
        {
            showMessage(qsTr("This plugin is for MuseScore 4.4 or later"));
            return;
        }

        fillEmptyBeats();
    }
}
