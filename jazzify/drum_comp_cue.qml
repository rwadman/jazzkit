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
        cursor.rewind(Cursor.SELECTION_END);
        var endTick = cursor.tick;
        // rewind(SELECTION_END) wraps to tick 0 when the selection reaches the end of the score
        if (endTick === 0) endTick = curScore.lastSegment.tick + 1;

        // This mirrors the manual MuseScore workflow. Each step is a standalone command
        // (no outer startCmd wrapping) so the score is laid out between steps - wrapping
        // them together previously crashed the "move to voice 3" step. Before every step
        // we (re)select the target region and verify it, so a failed selection aborts
        // instead of modifying the wrong staff. Nothing outside the drum staff is
        // changed except the clipboard (the copy of the source selection).

        // 1. Copy the source selection.
        if (!selectStaffRange(startTick, endTick, srcStaffIdx))
        {
            showMessage(qsTr("Could not select the source notes. Nothing was changed."));
            return;
        }
        cmd("copy");

        // 2. Make sure the drum staff has a chordrest that begins exactly at startTick,
        // so the range paste below has an anchor. Pasting a range anchors at the first
        // chordrest of the target range (Paste::pasteStaffList -> firstChordRestInRange);
        // an empty drum measure holds only a full-measure rest at the measure start, so a
        // mid-measure paste finds no anchor there and silently does nothing (this is why
        // partial-bar selections failed). We can't rewindToTick onto the empty drum voice
        // (it skips forward past segments with no element in the track), so instead we
        // rewind a cursor to the selection start - which lands on the real source segment
        // at startTick - then retarget it to voice 1 of the drum staff (setStaffIdx /
        // setVoice only change the track, keeping the segment) and write a rest. That
        // splits the drum rest at startTick. It only touches the region we overwrite next.
        var boundary = curScore.newCursor();
        boundary.rewind(Cursor.SELECTION_START);
        var firstDur = boundary.element ? boundary.element.duration : null;
        boundary.staffIdx = drumStaffIdx;
        boundary.voice = 0;
        if (firstDur)
            boundary.setDuration(firstDur.numerator, firstDur.denominator);
        else
            boundary.setDuration(1, 16);
        boundary.addRest();

        // 3. Paste into the drum staff (paste converts the pitched notes to drum notes).
        if (!selectStaffRange(startTick, endTick, drumStaffIdx))
        {
            showMessage(qsTr("Could not select the drum staff to paste into. Nothing was changed."));
            return;
        }
        cmd("paste");

        // 4. Move the pasted drum notes to voice 3.
        if (!selectStaffRange(startTick, endTick, drumStaffIdx))
        {
            showMessage(qsTr("Pasted into the drum staff, but could not re-select it to move to voice 3."));
            return;
        }
        cmd("voice-3");

        // 5. Toggle rhythmic slash notation on the voice 3 drum notes.
        if (!selectStaffRange(startTick, endTick, drumStaffIdx))
        {
            showMessage(qsTr("Moved to voice 3, but could not re-select the drum staff for slash notation."));
            return;
        }
        cmd("slash-rhythm");
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
