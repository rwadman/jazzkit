import QtQuick
import QtQuick.Layouts

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). Single self-contained dialog:
// pick instruments AND apply, in one gesture. The cue is written note-for-note
// via the cursor + direct API (Effects.compCuesNotes) — no notation cmd()s — so
// it runs from the form (which a clipboard copy/paste could NOT, see api-gotchas)
// and carries only notes + articulations, not slurs/dynamics/text.
MuseScore {
    id: root
    implicitWidth: 360
    width: 360

    property string settingsTag: "jazzKitCueNotes"

    // Captured selection geometry (read once at load).
    property int selStart: 0
    property int selEnd: 0
    property int measureTick: 0   // start of the measure containing selStart
    property int srcStaffIdx: -1

    property string message: ""   // non-empty => show message instead of picker

    readonly property int rowHeight: 40
    readonly property int chromeHeight: 130
    function updateSize() {
        root.implicitHeight = (root.message !== "" || targetsModel.count === 0)
            ? 180
            : chromeHeight + targetsModel.count * rowHeight;
    }

    ListModel { id: targetsModel }

    function loadEnabledIds() {
        var s = JazzKit.loadJsonTag(curScore, settingsTag);
        return (s && s.ids !== undefined) ? s.ids : null;
    }

    function effectCtx() {
        return {
            curScore: curScore, newElement: newElement,
            Element: Element, Cursor: Cursor, division: division
        };
    }

    // Validate + capture the selection, then build the instrument list.
    function capture() {
        if (!curScore) { root.message = qsTr("Open a score first."); return; }
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion)) {
            root.message = qsTr("This plugin is for MuseScore 4.4 or later"); return;
        }
        var sel = curScore.selection;
        if (!sel || !sel.isRange || sel.elements.length === 0) {
            root.message = qsTr("Please select a range of notes first."); return;
        }
        if (sel.endStaff - sel.startStaff !== 1) {
            root.message = qsTr("Please select notes in a single staff only."); return;
        }
        srcStaffIdx = sel.startStaff;

        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        selStart = cursor.tick;
        measureTick = cursor.measure.firstSegment.tick;
        cursor.rewind(Cursor.SELECTION_END);
        selEnd = cursor.tick;
        if (selEnd === 0) selEnd = curScore.lastSegment.tick + 1;

        targetsModel.clear();
        var rows = JazzKit.computeTargets(curScore.parts, srcStaffIdx, loadEnabledIds());
        for (var i = 0; i < rows.length; ++i) targetsModel.append(rows[i]);
        if (targetsModel.count === 0)
            root.message = qsTr("No comping instruments (piano, bass, drums, …) other than the selected staff were found.");
    }

    Component.onCompleted: { capture(); updateSize(); }

    function apply() {
        var ids = [];
        var targets = [];
        for (var i = 0; i < targetsModel.count; ++i) {
            var r = targetsModel.get(i);
            if (r.checked) { ids.push(r.instrumentId); targets.push({ staffIdx: r.staffIdx, isDrum: r.isDrum }); }
        }
        if (targets.length === 0) { root.message = qsTr("Check at least one instrument."); updateSize(); return; }
        JazzKit.saveJsonTag(curScore, settingsTag, { ids: ids });

        var res = Effects.compCuesNotes(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: measureTick,
            srcStaffIdx: srcStaffIdx, targets: targets
        });
        root.message = res.error ? qsTr(res.error)
                                 : qsTr("Added a cue to %1 instrument(s).").arg(res.targetsDone);
        updateSize();
    }

    ColumnLayout {
        id: contentColumn
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        StyledTextLabel {
            Layout.fillWidth: true
            visible: root.message !== ""
            text: root.message
            wrapMode: Text.WordWrap
        }

        StyledTextLabel {
            Layout.fillWidth: true
            visible: root.message === ""
            text: qsTr("Add a cue to:")
        }

        Repeater {
            model: targetsModel
            delegate: CheckBox {
                required property var model
                required property int index
                visible: root.message === ""
                Layout.fillWidth: true
                text: model.label
                checked: model.checked
                onClicked: targetsModel.setProperty(index, "checked", !model.checked)
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Item { Layout.fillWidth: true }
            FlatButton {
                text: root.message === "" ? qsTr("Cancel") : qsTr("Close")
                onClicked: root.quit()
            }
            FlatButton {
                visible: root.message === ""
                text: qsTr("Apply")
                accentButton: true
                onClicked: root.apply()
            }
        }
    }
}
