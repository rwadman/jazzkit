import QtQuick
import QtQuick.Layouts

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/articulations.js" as Articulations
import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). Unlike a legacy menu plugin, a
// form gets NO onRun — it is loaded as a view, so the work runs from
// Component.onCompleted (deferred a tick with Qt.callLater so the view is
// realized before we mutate the score). Fix Marcato Staccatos takes no options,
// so the form is just a result readout. Editing is pure direct-API
// (newElement) — no cmd() — which is the pattern proven safe from a form.
MuseScore {
    id: root
    width: 400
    height: contentColumn.implicitHeight + 32

    property string resultText: qsTr("Working…")

    // Same ctx shape the effect layer expects (a QML-imported JS lib can't see
    // the MuseScore globals, so we pass them in). Identical to the legacy plugin.
    function effectCtx() {
        return {
            curScore: curScore, newElement: newElement,
            JazzKit: JazzKit, Articulations: Articulations,
            SymId: SymId, Element: Element, Cursor: Cursor
        };
    }

    function runEffect() {
        if (!curScore) { root.resultText = qsTr("Open a score first."); return; }
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion)) {
            root.resultText = qsTr("This plugin is for MuseScore 4.4 or later");
            return;
        }
        var total = Effects.fixMarcatoStaccatos(effectCtx());
        root.resultText = qsTr("Added %1 hidden staccatos, hid %2 existing staccatos.")
                            .arg(total.added).arg(total.hidden);
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
