import QtQuick

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib"

MuseScore {
    version: "0.1"
    title: "To Comp Cues"
    menuPath: "Plugins.To Comp Cues"
    description: "Copy the selected passage into the chosen instruments. Pitched instruments receive a cue-size copy of the notes; drum/percussion parts receive a rhythmic comping cue (voice 3 slash notation, voice 1 time slashes). Choices are remembered per instrument."
    requiresScore: true

//=============================================================================
// Messaging

    InfoDialog { id: infoDialog }

//=============================================================================
// Persisted choices: the instrumentIds enabled on the last run, stored as a metatag
// on the score (same mechanism as comp_slashes.qml / line_breaks.qml — MS's bundled
// QML has no Settings module). Recalls whenever the score is open, saved into the
// file on save. Own tag so it is remembered independently of comp_slashes.

    property string settingsTag: "jazzKitCueNotes"

    // null → first run, default all checked. JSON + excerpt mirroring live in
    // the shared, unit-tested plugins/lib/jazzkit.js.
    function loadEnabledIds()
    {
        var s = JazzKit.loadJsonTag(curScore, settingsTag);
        return (s && s.ids !== undefined) ? s.ids : null;
    }

    function saveEnabledIds(ids)
    {
        JazzKit.saveJsonTag(curScore, settingsTag, { ids: ids });
    }

//=============================================================================
// Captured selection (read once at launch — the dialog must not depend on the
// score selection surviving user interaction with the checkboxes).

    property int selStart: 0
    property int selEnd: 0
    // Tick of the barline the selection starts in. Pasting a range anchors on the
    // first chordrest of the target range; an empty target measure holds only a
    // full-measure rest at the measure start, so a mid-measure paste finds no anchor
    // and silently does nothing. We paste from the measure start and clear the
    // dragged-in leading beats afterwards (same trick as comp_slashes).
    property int measureTick: 0
    property int srcStaffIdx: -1

    // Instruments the checkboxes represent. Roles: label, instrumentId, staffIdx, isDrum, checked.
    ListModel { id: targetsModel }

//=============================================================================

    function buildTargets()
    {
        targetsModel.clear();
        // Which parts to offer + their initial checked state is pure, shared,
        // unit-tested logic (plugins/lib/jazzkit.js); we only feed it into the model.
        var rows = JazzKit.computeTargets(curScore.parts, srcStaffIdx, loadEnabledIds());
        for (var i = 0; i < rows.length; ++i) targetsModel.append(rows[i]);
    }

//=============================================================================

    // Cue-size the pasted content on staffIdx across [startTick, endTick). No action
    // code exists for "cue size" — it is the elements' `small` property (its API
    // docstring is literally "Whether this element is cue size"). We walk voice 1
    // (always populated after a paste) with a cursor and set small on each chord/rest
    // and every notehead. Wrapped in one startCmd/endCmd (a single logical edit — not
    // a nest of cmd()s, which is the crash case in api-gotchas).
    function makeCueSize(staffIdx, startTick, endTick)
    {
        var cursor = curScore.newCursor();
        cursor.staffIdx = staffIdx;
        cursor.voice = 0; // set track BEFORE rewind (rewindToTick uses the current track)
        cursor.rewindToTick(startTick);

        curScore.startCmd();
        while (cursor.element && cursor.tick < endTick)
        {
            var e = cursor.element;
            e.small = true;
            if (e.type === Element.CHORD && e.notes)
                for (var k = 0; k < e.notes.length; ++k) e.notes[k].small = true;
            if (!cursor.next()) break;
        }
        curScore.endCmd();
    }

//=============================================================================

    // Pitched target: paste a cue-size copy of the source notes into voice 1.
    function pitchedCue(t)
    {
        if (!JazzKit.selectStaffRange(curScore, measureTick, selEnd, t))
        {
            infoDialog.show(qsTr("Could not select a target staff. Some instruments may be unchanged."));
            return false;
        }
        cmd("paste");

        // Clear the dragged-in leading beats (voice 1) back to rests.
        if (selStart > measureTick)
        {
            if (!JazzKit.selectStaffRange(curScore, measureTick, selStart, t))
            {
                infoDialog.show(qsTr("Pasted, but could not clear the leading beats."));
                return false;
            }
            cmd("delete");
        }

        makeCueSize(t, selStart, selEnd);
        return true;
    }

    // Drum/percussion target: paste as a rhythmic comping cue — voice 3 slash
    // notation over the passage, voice 1 filled with time slashes (see api-gotchas
    // for why each cmd() runs standalone rather than under one startCmd).
    function drumComp(t)
    {
        // Paste converts the pitched notes to drum notes.
        if (!JazzKit.selectStaffRange(curScore, measureTick, selEnd, t))
        {
            infoDialog.show(qsTr("Could not select the drum staff to paste into. Some instruments may be unchanged."));
            return false;
        }
        cmd("paste");

        // Move the pasted region to voice 3 (before the leading-beats cleanup — doing
        // the delete first left the re-selection incomplete, moving only part of it).
        if (!JazzKit.selectStaffRange(curScore, selStart, selEnd, t))
        {
            infoDialog.show(qsTr("Pasted into the drum staff, but could not re-select it to move to voice 3."));
            return false;
        }
        cmd("voice-3");

        // Rhythmic slash notation on the voice 3 drum notes.
        if (!JazzKit.selectStaffRange(curScore, selStart, selEnd, t))
        {
            infoDialog.show(qsTr("Moved to voice 3, but could not re-select the drum staff for slash notation."));
            return false;
        }
        cmd("slash-rhythm");

        // Clear the leading beats we dragged in (still voice 1) back to rests; the
        // comping now lives in voice 3, outside this range.
        if (selStart > measureTick)
        {
            if (!JazzKit.selectStaffRange(curScore, measureTick, selStart, t))
            {
                infoDialog.show(qsTr("Applied the comping cue, but could not clear the leading beats."));
                return false;
            }
            cmd("delete");
        }

        // Fill voice 1 across the touched region with time slashes so it reads as
        // "keep time" under the voice-3 accents.
        if (!JazzKit.selectStaffRange(curScore, measureTick, selEnd, t))
        {
            infoDialog.show(qsTr("Applied the comping cue, but could not fill voice 1 with slashes."));
            return false;
        }
        cmd("slash-fill");
        return true;
    }

//=============================================================================
// Stamp the captured passage into every chosen target. Runs only after the options
// window is closed, so the notation view is the active context again — otherwise the
// paste / voice / slash actions have no handler ("no one can handle").

    function stamp()
    {
        var targets = [];
        for (var i = 0; i < targetsModel.count; ++i)
        {
            var r = targetsModel.get(i);
            if (r.checked) targets.push({ staffIdx: r.staffIdx, isDrum: r.isDrum });
        }
        if (targets.length === 0) return; // nothing checked → no-op

        for (var j = 0; j < targets.length; ++j)
        {
            var t = targets[j].staffIdx;
            if (t === srcStaffIdx) continue; // guarded in buildTargets, belt-and-braces

            // Copy the source, extended left to the measure start so the paste can
            // anchor on the target's full-measure rest (which sits at the measure start).
            if (!JazzKit.selectStaffRange(curScore, measureTick, selEnd, srcStaffIdx))
            {
                infoDialog.show(qsTr("Could not re-select the source notes. Some instruments may be unchanged."));
                return;
            }
            cmd("copy");

            var ok = targets[j].isDrum ? drumComp(t) : pitchedCue(t);
            if (!ok) return; // the branch already reported why
        }
    }

//=============================================================================

    CompTargetsDialog
    {
        id: optionsDialog
        title: qsTr("To Comp Cues")
        headerText: qsTr("Add a cue to:")
        model: targetsModel

        onApplied: (instrumentIds) =>
        {
            if (instrumentIds.length === 0)
            {
                infoDialog.show(qsTr("Check at least one instrument."));
                return;
            }
            saveEnabledIds(instrumentIds);
            // Close BEFORE stamping so the notation view regains the active
            // context; otherwise paste / voice / slash have no handler.
            optionsDialog.close();
            stamp();
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

        srcStaffIdx = sel.startStaff;

        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        selStart = cursor.tick;
        measureTick = cursor.measure.firstSegment.tick;
        cursor.rewind(Cursor.SELECTION_END);
        selEnd = cursor.tick;
        // rewind(SELECTION_END) wraps to tick 0 at the end of the score.
        if (selEnd === 0) selEnd = curScore.lastSegment.tick + 1;

        buildTargets();

        if (targetsModel.count === 0)
        {
            infoDialog.show(qsTr("No comping instruments (piano, bass, drums, …) other than the selected staff were found."));
            return;
        }

        optionsDialog.show();
    }
}
