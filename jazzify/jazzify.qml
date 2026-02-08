import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.2"
    title: "Jazzify"
    description: "Make score align better with jazz conventions"

//=============================================================================

    MessageDialog
    {
        id: versionError
        visible: false
        title: qsTr("Unsupported MuseScore Version")
        text: qsTr("This plugin is for MuseScore 4.4 or later")
        onAccepted: {
            close();
        }
    }


//=============================================================================

    function showMessage(message)
    {
        infoDialog.text = message;
        infoDialog.open();
    }

    MessageDialog
    {
        id: infoDialog
        visible: false
        title: "Hello world"
        text: "someTextHere"
        onAccepted: {
            close();
        }
    }



    function arrayContains(arr, val)
    {
        for (var a in arr)
        {
            if (arr[a] === val) return true;
        }
        return false;
    }


    function initialiseScoreChanges()
    {
        curScore.startCmd();
    }

    function finaliseScoreChanges()
    {
        curScore.endCmd()
    }

    // Ensure all chords/notes that have a marcato also have a hidden staccato articulation.
    function ensureMarcatoHasHiddenStaccato()
    {
        initialiseScoreChanges();

        var cursor = curScore.newCursor();

        var countAdded = 0;
        var countHidden = 0;

        // possible staccato symbol names to try (strings first for compatibility)
        var staccCandidatesAbove = ["articStaccatAbove", "articStaccatoAbove", "articStaccat", "articStaccato"];
        var staccCandidatesBelow = ["articStaccatBelow", "articStaccatoBelow", "articStaccat", "articStaccato"];

        // determine number of staves (best-effort, fall back to 16)
        var maxStaves = 16;
        if (typeof curScore.nstaves === 'number') maxStaves = curScore.nstaves;
        else if (typeof curScore.nStaves === 'number') maxStaves = curScore.nStaves;
        else if (typeof curScore.staffCount === 'number') maxStaves = curScore.staffCount;
        else if (curScore.staves && typeof curScore.staves.length === 'number') maxStaves = curScore.staves.length;

        // voices typically 1..4 - iterate 0..3
        var maxVoices = 4;

        for (var staffIdx = 0; staffIdx < maxStaves; ++staffIdx)
        {
            cursor.staffIdx = staffIdx;
            for (var voice = 0; voice < maxVoices; ++voice)
            {
                cursor.voice = voice;
                cursor.rewind(Cursor.SCORE_START);

                while (cursor.segment)
                {
                    var el = cursor.element;
                    if (el && el.type == Element.CHORD)
                    {
                        // skip empty chords
                        var articulations = el.articulations || [];
                        var hasMarcatoAbove = false;
                        var hasMarcatoBelow = false;

                        for (var i = 0; i < articulations.length; ++i)
                        {
                            var a = articulations[i];
                            if (!a) continue;
                            var sym = a.symbol !== undefined ? a.symbol : (a.toString ? a.toString() : "");
                            if (sym == SymId.articMarcatoAbove || sym == "articMarcatoAbove")
                                hasMarcatoAbove = true;
                            if (sym == SymId.articMarcatoBelow || sym == "articMarcatoBelow")
                                hasMarcatoBelow = true;
                        }

                        if (hasMarcatoAbove || hasMarcatoBelow)
                        {
                            var wantAbove = hasMarcatoAbove;
                            var foundStacc = false;

                            // check for any existing staccato-like articulations
                            for (var i = 0; i < articulations.length; ++i)
                            {
                                var a = articulations[i];
                                if (!a) continue;
                                var sym = a.symbol !== undefined ? a.symbol : (a.toString ? a.toString() : "");
                                if (["articStaccatAbove","articStaccatoAbove","articStaccatBelow","articStaccatoBelow","articStaccat","articStaccato"].indexOf(sym) >= 0 ||
                                    sym == SymId.articStaccatAbove || sym == SymId.articStaccatBelow || sym == SymId.articStaccatoAbove || sym == SymId.articStaccatoBelow)
                                {
                                    // hide existing staccato
                                    try { a.hidden = true; } catch (e) { }
                                    try { a.visible = false; } catch (e) { }
                                    foundStacc = true;
                                    countHidden++;
                                    break;
                                }
                            }

                            if (!foundStacc)
                            {
                                // try a few candidate SymId numeric constants until one actually appears on the element after adding
                                var candidatesSym = [];
                                try {
                                    if (wantAbove) {
                                        candidatesSym = [SymId.articStaccatAbove, SymId.articStaccatoAbove, SymId.articStaccat, SymId.articStaccato];
                                    } else {
                                        candidatesSym = [SymId.articStaccatBelow, SymId.articStaccatoBelow, SymId.articStaccat, SymId.articStaccato];
                                    }
                                } catch (e) { candidatesSym = []; }

                                var addedOk = false;

                                for (var j = 0; j < candidatesSym.length; ++j)
                                {
                                    var candSym = candidatesSym[j];
                                    if (!candSym) { continue; }
                                    var s = newElement(Element.ARTICULATION);
                                    // set hidden/visible before adding (best-effort)
                                    try { s.hidden = true; } catch (e) { }
                                    try { s.visible = false; } catch (e) { }
                                    s.symbol = candSym;
                                    cursor.add(s);

                                    // refresh list and look for an articulation with matching symbol
                                    articulations = el.articulations || [];
                                    var foundAfterAdd = false;
                                    for (var k = 0; k < articulations.length; ++k)
                                    {
                                        var a2 = articulations[k];
                                        if (!a2) continue;
                                        var sym2 = a2.symbol !== undefined ? a2.symbol : (a2.toString ? a2.toString() : "");
                                        if (sym2 == candSym)
                                        {
                                            // hide the newly added/found staccato
                                            try { a2.hidden = true; } catch (e) { }
                                            try { a2.visible = false; } catch (e) { }
                                            countAdded++;
                                            addedOk = true;
                                            foundAfterAdd = true;
                                            break;
                                        }
                                    }

                                    if (addedOk) break;
                                }

                                if (!addedOk)
                                {
                                    console.log("Failed to add staccato articulation at tick " + cursor.tick + " staff " + staffIdx + " voice " + voice);
                                }
                            }
                        }
                    }
                    cursor.next();
                }
            }
        }

        finaliseScoreChanges();
        showMessage(qsTr("Added %1 hidden staccatos, hid %2 existing staccatos.").arg(countAdded).arg(countHidden));
    }


    onRun:
    {

        if ((mscoreMajorVersion <= 3) || ((mscoreMajorVersion == 4 && mscoreMinorVersion < 4 )))
        {
        versionError.open()
        return;
        }
        console.log("Running Jazzify plugin v0.2 on MuseScore " + mscoreMajorVersion + "." + mscoreMinorVersion);
        // Ensure marcato articulations have hidden staccatos
        ensureMarcatoHasHiddenStaccato();

    }

}