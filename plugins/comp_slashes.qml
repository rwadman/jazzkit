import QtQuick

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib"

MuseScore {
    version: "0.1"
    title: "To Comp Slashes"
    menuPath: "Plugins.To Comp Slashes"
    description: "Copy the selected rhythm into voice 1 of the chosen comping instruments (piano, bass, drums, …) as rhythmic slash notation. Beats without a note become rests. Choices are remembered per instrument."
    requiresScore: true

//=============================================================================
// Messaging

    InfoDialog { id: infoDialog }

//=============================================================================
// Persisted choices: the instrumentIds enabled on the last run, stored as a metatag
// on the score (same mechanism as line_breaks.qml — MS's bundled QML has no Settings
// module). Recalls whenever the score is open and is saved into the file on save.

    property string settingsTag: "jazzKitCompSlashes"

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
    // dragged-in leading beats afterwards (same trick as drum_comp_cue).
    property int measureTick: 0
    property int srcStaffIdx: -1

    // Instruments the checkboxes represent. Roles: label, instrumentId, staffIdx, checked.
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
// Stamp the captured rhythm into voice 1 of every chosen target. Runs only after
// the options window is closed, so the notation view is the active context again —
// otherwise the paste / slash-rhythm actions have no handler ("no one can handle").

    function stamp()
    {
        var targets = [];
        for (var i = 0; i < targetsModel.count; ++i)
        {
            var r = targetsModel.get(i);
            if (r.checked) targets.push(r.staffIdx);
        }
        if (targets.length === 0) return; // nothing checked → no-op

        // Per target: copy the source rhythm, paste into voice 1, slashify the real
        // region, then clear the dragged-in leading beats back to rests. Each cmd()
        // is standalone (no outer startCmd) so the score lays out between steps —
        // wrapping them together crashes MS (see api-gotchas).
        for (var j = 0; j < targets.length; ++j)
        {
            var t = targets[j];
            if (t === srcStaffIdx) continue; // guarded in buildTargets, belt-and-braces

            if (!JazzKit.selectStaffRange(curScore, measureTick, selEnd, srcStaffIdx))
            {
                infoDialog.show(qsTr("Could not re-select the source notes. Some instruments may be unchanged."));
                return;
            }
            cmd("copy");

            if (!JazzKit.selectStaffRange(curScore, measureTick, selEnd, t))
            {
                infoDialog.show(qsTr("Could not select a target staff. Some instruments may be unchanged."));
                return;
            }
            cmd("paste");

            if (!JazzKit.selectStaffRange(curScore, selStart, selEnd, t))
            {
                infoDialog.show(qsTr("Pasted, but could not apply slash notation. Some instruments may be unchanged."));
                return;
            }
            cmd("slash-rhythm");

            if (selStart > measureTick)
            {
                if (!JazzKit.selectStaffRange(curScore, measureTick, selStart, t))
                {
                    infoDialog.show(qsTr("Applied the rhythm, but could not clear the leading beats."));
                    return;
                }
                cmd("delete");
            }
        }
    }

//=============================================================================

    CompTargetsDialog
    {
        id: optionsDialog
        title: qsTr("To Comp Slashes")
        headerText: qsTr("Add comp slashes to voice 1 of:")
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
            // context; otherwise paste / slash-rhythm have no handler.
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
