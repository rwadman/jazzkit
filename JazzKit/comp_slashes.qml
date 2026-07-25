import QtQuick

import MuseScore

import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). Single self-contained dialog: pick
// instruments AND apply. The source rhythm (with its articulations and fermatas)
// is written as slash notation via the cursor + direct API
// (Effects.compSlashesNotes replicates Chord::setSlash) — no notation cmd()s — so
// it runs from the form (a clipboard/cmd path could not; see api-gotchas).
//
// The dialog body is shared with comp_cues.qml (CompTargetsForm.qml); the common
// logic (version/score guard, selection capture, row build + collect) lives in
// lib/jazzkit.js.
MuseScore {
    id: root
    implicitWidth: 360
    width: 360

    // Assigned, never bound — see comp_cues.qml / CompTargetsForm.
    function setSize() { root.implicitHeight = form.contentHeight; }

    CompTargetsForm {
        id: form
        onContentHeightChanged: root.setSize()   // anchors/margins: set by the component

        settingsTag: "jazzKitCompSlashes"
        prompt: qsTr("Comp slashes into voice 1 of:")
        resultTemplate: qsTr("Added comp slashes to %1 instrument(s).")
        effect: Effects.compSlashesNotes

        ctx: ({
            curScore: curScore, newElement: newElement,
            Element: Element, Cursor: Cursor, division: division,
            Direction: Direction, NoteHeadGroup: NoteHeadGroup, Beam: Beam,
            mscoreMajorVersion: mscoreMajorVersion,
            mscoreMinorVersion: mscoreMinorVersion
        })

        onCloseRequested: root.quit()
    }

    Component.onCompleted: { form.start(); root.setSize(); }
}
