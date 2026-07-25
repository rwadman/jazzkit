import QtQuick

import MuseScore

import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). Single self-contained dialog:
// pick instruments AND apply, in one gesture. The cue is written note-for-note
// via the cursor + direct API (Effects.compCuesNotes) — no notation cmd()s — so
// it runs from the form (which a clipboard copy/paste could NOT, see api-gotchas)
// and carries only notes + articulations + fermatas, not slurs/dynamics/text.
//
// The dialog body is shared with comp_slashes.qml (CompTargetsForm.qml); the
// common logic (version/score guard, selection capture, row build + collect)
// lives in lib/jazzkit.js. All that is left here is the MuseScore{} root the
// manifest needs, the strings, and the effect.
MuseScore {
    id: root
    implicitWidth: 360
    width: 360

    // Assigned, never bound: the host samples implicitHeight once at show, and the
    // shipping version of this form always assigned it (see CompTargetsForm).
    function setSize() { root.implicitHeight = form.contentHeight; }

    CompTargetsForm {
        id: form
        onContentHeightChanged: root.setSize()   // anchors/margins: set by the component

        settingsTag: "jazzKitCueNotes"
        prompt: qsTr("Add a cue to:")
        resultTemplate: qsTr("Added a cue to %1 instrument(s).")
        effect: Effects.compCuesNotes

        // The plugin globals: context properties of THIS file's QML context, so
        // they are handed to the component (and to the effect layer) explicitly.
        ctx: ({
            curScore: curScore, newElement: newElement,
            Element: Element, Cursor: Cursor, division: division,
            Direction: Direction, NoteHeadGroup: NoteHeadGroup, Beam: Beam,
            mscoreMajorVersion: mscoreMajorVersion,
            mscoreMinorVersion: mscoreMinorVersion
        })

        onCloseRequested: root.quit()
    }

    // Capture + size before the host reads implicitHeight (it reads it once, at show
    // — see api-gotchas, "Extension form actions").
    Component.onCompleted: { form.start(); root.setSize(); }
}
