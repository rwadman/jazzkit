import QtQuick

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/articulations.js" as Articulations
import "lib/effects.js" as Effects
import "lib"

MuseScore {
    version: "0.2"
    title: "Fix Marcato Staccatos"
    menuPath: "Plugins.Fix Marcato Staccatos"
    description: "Make score align better with jazz conventions"

//=============================================================================

    InfoDialog { id: infoDialog }

//=============================================================================
// Bundle the MuseScore globals the effect layer needs (a QML-imported JS lib
// can't see them). The per-chord decision (marcato present? staccato present?
// add above/below?) is the pure, unit-tested Articulations.classifyChord; the
// traversal + side effects live in effects.js. SymId is a MuseScore global this
// .qml sees but a stateless JS library can't, so we pass it in.

    function effectCtx()
    {
        return {
            curScore: curScore, newElement: newElement,
            JazzKit: JazzKit, Articulations: Articulations,
            SymId: SymId, Element: Element, Cursor: Cursor
        };
    }

//=============================================================================

    onRun:
    {
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion))
        {
            infoDialog.show(qsTr("This plugin is for MuseScore 4.4 or later"));
            return;
        }

        var total = Effects.fixMarcatoStaccatos(effectCtx());
        infoDialog.show(qsTr("Added %1 hidden staccatos, hid %2 existing staccatos.")
                    .arg(total.added).arg(total.hidden));
    }
}
