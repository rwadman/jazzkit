import QtQuick
import QtQuick.Layouts

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit

// Extension "form" action (see manifest.json): the option panel for the Autofix
// action. It edits nothing in the score — it only reads and writes the settings
// Autofix consults. Like the other JazzKit dialogs, choices are remembered PER
// SCORE as a metatag (MuseScore's bundled QML ships no Settings module we rely
// on), so they travel with the file and are saved with it.
MuseScore {
    id: root
    width: 420
    height: contentColumn.implicitHeight + 32

    // Bound to the controls (mutable so load() can populate them).
    property bool optMarcato: true
    property bool optCourtesy: true
    property int valBracket: 1     // 0 none, 1 parenthesis, 2 bracket

    property string message: ""    // non-empty => show result instead of options

    function load() {
        var guard = JazzKit.guardScore(curScore, mscoreMajorVersion, mscoreMinorVersion);
        if (guard !== "") { root.message = guard; return; }
        var s = JazzKit.loadAutofixSettings(curScore);
        root.optMarcato = s.marcato;
        root.optCourtesy = s.courtesy;
        root.valBracket = s.bracket;
    }

    function save() {
        var guard = JazzKit.guardScore(curScore, mscoreMajorVersion, mscoreMinorVersion);
        if (guard !== "") { root.message = guard; return; }
        JazzKit.saveAutofixSettings(curScore, {
            marcato: root.optMarcato, courtesy: root.optCourtesy, bracket: root.valBracket
        });
        root.message = qsTr("Saved. Run JazzKit ▸ Autofix to apply.");
    }

    Component.onCompleted: Qt.callLater(load)

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

        // --- options view (one visibility binding for the whole set) ---
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.message === ""
            spacing: 12

            StyledTextLabel {
                Layout.fillWidth: true
                text: qsTr("Fixes Autofix performs on the whole score:")
                horizontalAlignment: Text.AlignLeft
            }

            CheckBox {
                text: qsTr("Fix marcato staccatos")
                checked: root.optMarcato
                onClicked: root.optMarcato = !root.optMarcato
            }
            CheckBox {
                text: qsTr("Courtesy accidentals (add missing, remove superfluous)")
                checked: root.optCourtesy
                onClicked: root.optCourtesy = !root.optCourtesy
            }

            // MuseScore's AccidentalBracket values: 0 none, 1 parenthesis, 2 bracket.
            RowLayout {
                visible: root.optCourtesy
                spacing: 12
                StyledTextLabel { text: qsTr("Courtesy accidentals look like") }
                Repeater {
                    model: [{ label: "(♮)", value: 1 }, { label: "[♮]", value: 2 }, { label: "♮", value: 0 }]
                    delegate: RoundedRadioButton {
                        required property var modelData
                        text: modelData.label
                        checked: root.valBracket === modelData.value
                        onClicked: root.valBracket = modelData.value
                    }
                }
                Item { Layout.fillWidth: true }
            }
        }

        Item { Layout.fillHeight: true }

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
                text: qsTr("Save")
                accentButton: true
                onClicked: root.save()
            }
        }
    }
}
