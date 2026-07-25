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
        if (!curScore) { root.message = qsTr("Open a score first."); return; }
        var s = JazzKit.loadAutofixSettings(curScore);
        root.optMarcato = s.marcato;
        root.optCourtesy = s.courtesy;
        root.valBracket = s.bracket;
    }

    function save() {
        if (!curScore) { root.message = qsTr("Open a score first."); return; }
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

        // --- options view ---
        StyledTextLabel {
            Layout.fillWidth: true
            visible: root.message === ""
            text: qsTr("Fixes Autofix performs on the whole score:")
            horizontalAlignment: Text.AlignLeft
        }

        CheckBox {
            visible: root.message === ""
            text: qsTr("Fix marcato staccatos")
            checked: root.optMarcato
            onClicked: root.optMarcato = !root.optMarcato
        }
        CheckBox {
            visible: root.message === ""
            text: qsTr("Courtesy accidentals (add missing, remove superfluous)")
            checked: root.optCourtesy
            onClicked: root.optCourtesy = !root.optCourtesy
        }

        RowLayout {
            visible: root.message === "" && root.optCourtesy
            spacing: 12
            StyledTextLabel { text: qsTr("Courtesy accidentals look like") }
            RoundedRadioButton {
                text: qsTr("(♮)")
                checked: root.valBracket === 1
                onClicked: root.valBracket = 1
            }
            RoundedRadioButton {
                text: qsTr("[♮]")
                checked: root.valBracket === 2
                onClicked: root.valBracket = 2
            }
            RoundedRadioButton {
                text: qsTr("♮")
                checked: root.valBracket === 0
                onClicked: root.valBracket = 0
            }
            Item { Layout.fillWidth: true }
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
