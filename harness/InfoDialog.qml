import QtQuick

import MuseScore
import Muse.UiComponents

// "JazzKit says…" popup: a MessageDialog with a show(msg) method. DEV-ONLY — used
// by test_harness.qml to show its report. The shipping forms render their result
// inline instead, so this deliberately lives in harness/, not in the JazzKit bundle.
//
//   import "."
//   InfoDialog { id: infoDialog }
//   ... infoDialog.show("Done.")
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
