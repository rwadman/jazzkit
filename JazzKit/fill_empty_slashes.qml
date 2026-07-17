import QtQuick
import QtQuick.Layouts

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/slashes.js" as Slashes
import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). No options: fills the empty voice-1
// beats of the selection with stemless beat slashes via the cursor + direct API
// (Effects.fillEmptyBeatsNotes replicates slash-fill) — no notation cmd()s — so it
// runs from a form and can show a result. Runs on load (deferred a tick).
MuseScore {
    id: root
    implicitWidth: 400
    width: 400
    height: contentColumn.implicitHeight + 32

    property string resultText: qsTr("Working…")

    function effectCtx() {
        return {
            curScore: curScore, Cursor: Cursor, Segment: Segment, Element: Element,
            Slashes: Slashes, Direction: Direction, NoteHeadGroup: NoteHeadGroup,
            Beam: Beam, division: division
        };
    }

    function runEffect() {
        if (!curScore) { root.resultText = qsTr("Open a score first."); return; }
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion)) {
            root.resultText = qsTr("This plugin is for MuseScore 4.4 or later"); return;
        }

        var sel = curScore.selection;
        if (!sel || !sel.isRange || sel.elements.length === 0) {
            root.resultText = qsTr("Please select a range of notes first."); return;
        }
        if (sel.endStaff - sel.startStaff !== 1) {
            root.resultText = qsTr("Please select notes in a single staff only."); return;
        }

        var staffIdx = sel.startStaff;
        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        var selStart = cursor.tick;
        cursor.rewind(Cursor.SELECTION_END);
        var selEnd = cursor.tick;
        if (selEnd === 0) selEnd = curScore.lastSegment.tick + 1;

        var res = Effects.fillEmptyBeatsNotes(effectCtx(), selStart, selEnd, staffIdx);
        if (res.regions === 0) {
            root.resultText = qsTr("No empty beats in voice 1 to fill.");
        } else if (res.selectFailed) {
            root.resultText = qsTr("Filled %1 region(s); some beats could not be filled.").arg(res.filled);
        } else {
            root.resultText = qsTr("Filled %1 empty region(s) with slashes.").arg(res.filled);
        }
    }

    Component.onCompleted: Qt.callLater(runEffect)

    ColumnLayout {
        id: contentColumn
        anchors.fill: parent
        anchors.margins: 16
        spacing: 16

        StyledTextLabel {
            Layout.fillWidth: true
            text: root.resultText
            horizontalAlignment: Text.AlignLeft
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true
            Item { Layout.fillWidth: true }
            FlatButton {
                text: qsTr("Close")
                onClicked: root.quit()
            }
        }
    }
}
