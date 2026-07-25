import QtQuick
import QtQuick.Layouts

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). Single self-contained dialog: pick
// instruments AND apply. The source rhythm (with its articulations and fermatas)
// is written as slash notation via the cursor + direct API
// (Effects.compSlashesNotes replicates Chord::setSlash) — no notation cmd()s — so
// it runs from the form (a clipboard/cmd path could not; see api-gotchas).
//
// Shares its shape with comp_cues.qml; the common logic (version/score guard,
// selection capture, row build + collect) lives in lib/jazzkit.js.
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

    function effectCtx() {
        return {
            curScore: curScore, newElement: newElement,
            Element: Element, Cursor: Cursor,
            Direction: Direction, NoteHeadGroup: NoteHeadGroup, Beam: Beam,
            division: division
        };
    }

    function capture() {
        var guard = JazzKit.guardScore(curScore, mscoreMajorVersion, mscoreMinorVersion);
        if (guard !== "") { root.message = guard; return; }

        var sel = JazzKit.captureSingleStaffRange(curScore, Cursor);
        if (!sel.ok) { root.message = sel.error; return; }
        selStart = sel.selStart;
        selEnd = sel.selEnd;
        measureTick = sel.measureTick;
        srcStaffIdx = sel.staffIdx;

        var saved = JazzKit.loadJsonTag(curScore, settingsTag);
        var rows = JazzKit.computeTargets(curScore.parts, srcStaffIdx,
                                          (saved && saved.ids !== undefined) ? saved.ids : null);
        targetsModel.clear();
        for (var i = 0; i < rows.length; ++i) targetsModel.append(rows[i]);
        if (targetsModel.count === 0)
            root.message = qsTr("No comping instruments (piano, bass, drums, …) other than the selected staff were found.");
    }

    Component.onCompleted: { capture(); updateSize(); }

    function apply() {
        var rows = [];
        for (var i = 0; i < targetsModel.count; ++i) rows.push(targetsModel.get(i));
        var picked = JazzKit.selectedTargets(rows);
        if (picked.targets.length === 0) {
            root.message = qsTr("Check at least one instrument."); updateSize(); return;
        }
        JazzKit.saveJsonTag(curScore, settingsTag, { ids: picked.ids });

        var res = Effects.compSlashesNotes(effectCtx(), {
            selStart: selStart, selEnd: selEnd, measureTick: measureTick,
            srcStaffIdx: srcStaffIdx, targets: picked.targets
        });
        root.message = res.error ? res.error
                                 : qsTr("Added comp slashes to %1 instrument(s).").arg(res.targetsDone);
        updateSize();
    }

    ColumnLayout {
        id: contentColumn
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        // --- result view ---
        StyledTextLabel {
            Layout.fillWidth: true
            visible: root.message !== ""
            text: root.message
            wrapMode: Text.WordWrap
        }

        // --- picker view ---
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.message === ""
            spacing: 12

            StyledTextLabel {
                Layout.fillWidth: true
                text: qsTr("Comp slashes into voice 1 of:")
            }

            Repeater {
                model: targetsModel
                delegate: CheckBox {
                    required property var model
                    required property int index
                    Layout.fillWidth: true
                    text: model.label
                    checked: model.checked
                    onClicked: targetsModel.setProperty(index, "checked", !model.checked)
                }
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
