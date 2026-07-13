import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import QtQuick.Controls as Ctrl

// Shared options dialog for the "To Comp …" plugins: a checkbox list of target
// instruments with Cancel / Apply. Pure UI — no MuseScore API here. The host
// builds the model (JazzKit.computeTargets) and, on `applied`, validates,
// persists, closes, and runs its action.
//
//   import "lib"
//   CompTargetsDialog {
//       id: optionsDialog
//       title: qsTr("To Comp Slashes")
//       headerText: qsTr("Add comp slashes to voice 1 of:")
//       model: targetsModel
//       onApplied: (instrumentIds) => { ... }
//   }
Window {
    id: root

    // ListModel of target rows: { label, instrumentId, checked, … }.
    property var model
    // Prompt shown above the list, e.g. "Add a cue to:".
    property string headerText: ""

    // Emitted on Apply with the instrumentIds of the checked rows (may be empty;
    // the host decides what to do about that).
    signal applied(var instrumentIds)

    width: 340
    height: Math.min(120 + (model ? model.count : 0) * 34, 520)
    modality: Qt.ApplicationModal
    flags: Qt.Dialog
    color: "#f0f0f0"

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 10

        Ctrl.Label {
            text: root.headerText
            color: "#202020"
        }

        Repeater {
            model: root.model
            delegate: Ctrl.CheckBox {
                required property var model
                required property int index

                Layout.fillWidth: true
                checked: model.checked
                text: model.label
                onClicked: root.model.setProperty(index, "checked", checked)
                // Force dark label text; the default contentItem inherits a light
                // theme colour that is invisible on this dialog's background.
                contentItem: Text {
                    text: model.label
                    color: "#202020"
                    verticalAlignment: Text.AlignVCenter
                    leftPadding: parent.indicator.width + parent.spacing
                }
            }
        }

        Item { Layout.fillHeight: true }

        RowLayout {
            Layout.alignment: Qt.AlignRight
            spacing: 8
            Ctrl.Button {
                text: qsTr("Cancel")
                onClicked: root.close()
            }
            Ctrl.Button {
                text: qsTr("Apply")
                onClicked: {
                    var ids = [];
                    for (var i = 0; i < root.model.count; ++i) {
                        var r = root.model.get(i);
                        if (r.checked) ids.push(r.instrumentId);
                    }
                    root.applied(ids);
                }
            }
        }
    }
}
