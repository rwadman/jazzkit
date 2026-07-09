import QtQuick

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.1"
    title: "Rhythm to Drum Comping"
    menuPath: "Plugins.Jazzify.Rhythm to Drum Comping"
    description: "Copy the selected notes into the drum part as a rhythmic comping cue (voice 3, slash notation)"

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
        title: "Jazzify"
        text: ""
        onAccepted: { close(); }
    }

//=============================================================================

    // Find the staff index of the first part that has a drum/percussion staff.
    function findDrumStaffIdx()
    {
        var parts = curScore.parts;
        for (var i = 0; i < parts.length; ++i)
        {
            if (parts[i].hasDrumStaff) return Math.floor(parts[i].startTrack / 4);
        }
        return -1;
    }

    // Select a single-staff range and confirm the selection actually landed on the
    // intended staff. The dispatched cmd()s below act on curScore.selection, so if a
    // selection ever fails to move we must abort rather than run a command against the
    // wrong (e.g. the source) staff. Returns true only when the selection is confirmed.
    function selectStaffRange(startTick, endTick, staffIdx)
    {
        curScore.selection.selectRange(startTick, endTick, staffIdx, staffIdx + 1);
        var s = curScore.selection;
        return s && s.isRange && s.startStaff === staffIdx;
    }

//=============================================================================

    function drumifySelection()
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

        var srcStaffIdx = sel.startStaff;

        var drumStaffIdx = findDrumStaffIdx();
        if (drumStaffIdx < 0)
        {
            showMessage(qsTr("No drum staff (percussion part) was found in this score."));
            return;
        }

        if (drumStaffIdx === srcStaffIdx)
        {
            showMessage(qsTr("The selection is already in the drum staff."));
            return;
        }

        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        var startTick = cursor.tick;
        // Tick of the barline the selection starts in. Pasting a range anchors at the
        // first chordrest of the target range (Paste::pasteStaffList ->
        // firstChordRestInRange); an empty drum measure holds only a full-measure rest at
        // the measure start, so a paste that starts mid-measure finds no anchor and
        // silently does nothing. We sidestep that by pasting from the measure start (where
        // that full-measure rest lives) and clearing the leading beats afterwards.
        var measureTick = cursor.measure.firstSegment.tick;
        cursor.rewind(Cursor.SELECTION_END);
        var endTick = cursor.tick;
        // rewind(SELECTION_END) wraps to tick 0 when the selection reaches the end of the score
        if (endTick === 0) endTick = curScore.lastSegment.tick + 1;

        // This mirrors the manual MuseScore workflow. Each step is a standalone command
        // (no outer startCmd wrapping) so the score is laid out between steps - wrapping
        // them together previously crashed the "move to voice 3" step. Before every step
        // we (re)select the target region and verify it, so a failed selection aborts
        // instead of modifying the wrong staff.

        // 1. Copy the source, extended left to the measure start so the paste below can
        //    anchor on the drum staff's full-measure rest (which sits at the measure start).
        if (!selectStaffRange(measureTick, endTick, srcStaffIdx))
        {
            showMessage(qsTr("Could not select the source notes. Nothing was changed."));
            return;
        }
        cmd("copy");

        // 2. Paste into the drum staff (paste converts the pitched notes to drum notes).
        if (!selectStaffRange(measureTick, endTick, drumStaffIdx))
        {
            showMessage(qsTr("Could not select the drum staff to paste into. Nothing was changed."));
            return;
        }
        cmd("paste");

        // 3. Move the selected region to voice 3. This runs right after the paste (before
        //    the leading-beats cleanup below); doing the cleanup delete first left the
        //    following selectRange incomplete, so voice-3 only moved part of the comping.
        if (!selectStaffRange(startTick, endTick, drumStaffIdx))
        {
            showMessage(qsTr("Pasted into the drum staff, but could not re-select it to move to voice 3."));
            return;
        }
        cmd("voice-3");

        // 4. Toggle rhythmic slash notation on the voice 3 drum notes.
        if (!selectStaffRange(startTick, endTick, drumStaffIdx))
        {
            showMessage(qsTr("Moved to voice 3, but could not re-select the drum staff for slash notation."));
            return;
        }
        cmd("slash-rhythm");

        // 5. Clear the leading beats we pulled in before the real selection (still in
        //    voice 1), turning them back into rests, so only the selected region carries
        //    the comping cue. The comping now lives in voice 3, outside this range.
        if (startTick > measureTick)
        {
            if (!selectStaffRange(measureTick, startTick, drumStaffIdx))
            {
                showMessage(qsTr("Applied the comping cue, but could not clear the leading beats."));
                return;
            }
            cmd("delete");
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

        drumifySelection();
    }
}
