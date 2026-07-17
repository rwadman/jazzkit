import QtQuick
import QtQuick.Layouts

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). Single self-contained dialog: pick
// instruments AND apply. The source rhythm is written as slash notation via the
// cursor + direct API (Effects.compSlashesNotes replicates Chord::setSlash) — no
// notation cmd()s — so it runs from the form (a clipboard/cmd path could not; see
// api-gotchas).
MuseScore {
    id: root
    implicitWidth: 360
    width: 360

    property string settingsTag: "jazzKitCompSlashes"

    property int selStart: 0
    property int selEnd: 0
    property int measureTick: 0
    property int srcStaffIdx: -1

    property string message: ""

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
            curScore: curScore, Element: Element, Cursor: Cursor,
            Direction: Direction, NoteHeadGroup: NoteHeadGroup, Beam: Beam,
            division: division
        };
    }

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
            if (r.checked) { ids.push(r.instrumentId); targets.push(r.staffIdx); }
        }
        if (targets.length === 0) { root.message = qsTr("Check at least one instrument."); updateSize(); return; }
        JazzKit.saveJsonTag(curScore, settingsTag, { ids: ids });

        var res = Effects.compSlashesNotes(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: measureTick,
            srcStaffIdx: srcStaffIdx, targets: targets
        });
        root.message = res.error ? qsTr(res.error)
                                 : qsTr("Added comp slashes to %1 instrument(s).").arg(res.targetsDone);
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
            text: qsTr("Comp slashes into voice 1 of:")
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
