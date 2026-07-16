import QtQuick

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/commands.js" as Cmd
import "lib/comp.js" as Comp
import "lib/effects.js" as Effects
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
    // the shared, unit-tested JazzKit/lib/jazzkit.js.
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
    property int selEnd: 0            // raw cursor read (0 = wrapped at score end)
    property int lastSegmentTick: 0   // for the wrap fallback (Comp.selectionGeometry)
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
        // unit-tested logic (JazzKit/lib/jazzkit.js); we only feed it into the model.
        var rows = JazzKit.computeTargets(curScore.parts, srcStaffIdx, loadEnabledIds());
        for (var i = 0; i < rows.length; ++i) targetsModel.append(rows[i]);
    }

//=============================================================================
// Bundle the MuseScore globals the effect layer needs (a QML-imported JS lib
// can't see them). The step sequencing — copy, paste, the leading-beat cleanup,
// cue-size (pitched) vs voice-3 comping (drum) — lives in the pure, unit-tested
// comp.js; this .qml only reads the selection, dispatches, and reports.

    function effectCtx()
    {
        return {
            curScore: curScore, cmd: cmd,
            Cmd: Cmd, JazzKit: JazzKit, Comp: Comp, Element: Element
        };
    }

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

        var res = Effects.compCues(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: measureTick,
            lastSegmentTick: lastSegmentTick, srcStaffIdx: srcStaffIdx, targets: targets
        });
        if (res.error) infoDialog.show(qsTr(res.error));
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
        selEnd = cursor.tick;   // raw; Comp.selectionGeometry resolves the end-of-score wrap
        lastSegmentTick = curScore.lastSegment.tick;

        buildTargets();

        if (targetsModel.count === 0)
        {
            infoDialog.show(qsTr("No comping instruments (piano, bass, drums, …) other than the selected staff were found."));
            return;
        }

        optionsDialog.show();
    }
}
