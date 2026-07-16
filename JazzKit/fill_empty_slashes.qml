import QtQuick

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/slashes.js" as Slashes
import "lib/commands.js" as Cmd
import "lib/effects.js" as Effects
import "lib"

MuseScore {
    version: "0.1"
    title: "Fill Empty Beats with Slashes"
    menuPath: "Plugins.Fill Empty Beats with Slashes"
    categoryCode: "JazzKit"
    description: "Like Fill with Slashes, but only fills the beats of voice 1 that have no notes — existing voice 1 notes are left untouched."

//=============================================================================

    InfoDialog { id: infoDialog }

//=============================================================================

    // Bundle the MuseScore globals the effect layer needs (a QML-imported JS lib
    // can't see them). Same object shape test_harness.qml builds — that's what lets
    // both drive the identical Effects.fillEmptyBeats code path.
    function effectCtx()
    {
        return {
            curScore: curScore, cmd: cmd,
            Cmd: Cmd, JazzKit: JazzKit, Slashes: Slashes,
            Segment: Segment, Element: Element, Cursor: Cursor
        };
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

        var res = Effects.fillEmptyBeats(effectCtx(), selStart, selEnd, staffIdx);

        if (res.regions === 0)
        {
            infoDialog.show(qsTr("No empty beats in voice 1 to fill."));
            return;
        }
        if (res.selectFailed)
        {
            infoDialog.show(qsTr("Could not select a region to fill. Some beats may be unfilled."));
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
