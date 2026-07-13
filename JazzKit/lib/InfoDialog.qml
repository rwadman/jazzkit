import QtQuick

import MuseScore
import Muse.UiComponents

// Shared "JazzKit says…" popup for all plugins: a MessageDialog with a show(msg)
// method. Replaces the per-plugin showMessage() function + MessageDialog block.
//
//   import "lib"
//   InfoDialog { id: infoDialog }
//   ... infoDialog.show(qsTr("Done."))
MessageDialog {
    visible: false
    title: "JazzKit"
    text: ""
    onAccepted: { close(); }

    function show(message) {
        text = message;
        open();
    }
}
