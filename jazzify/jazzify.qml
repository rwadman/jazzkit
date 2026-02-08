import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.1"
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
            (typeof(quit) === 'undefined' ? Qt.quit : quit)()
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

  // Helper: detect whether a chord contains a marcato articulation (no modifications)
    function detectMarcato(chord) {
        try {
            if (!chord || !chord.notes) return 0;
            for (var ni = 0; ni < chord.notes.length; ++ni) {
                var note = chord.notes[ni];
                if (!note || !note.articulations) continue;
                for (var ai = 0; ai < note.articulations.length; ++ai) {
                    var art = note.articulations[ai];
                    if (art && art.subtype === Articulation.MARCATO) {
                        return 1;
                    }
                }
            }
            return 0;
        } catch (e) {
            console.log("Error in detectMarcato: " + e);
            return 0;
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

    function _quit() {
        (typeof(quit) === 'undefined' ? Qt.quit : quit)()
    }

    onRun:
    {

        if ((mscoreMajorVersion <= 3) || ((mscoreMajorVersion == 4 && mscoreMinorVersion < 4 )))
        {
        versionError.open()
        _quit();
        return;
        }

        // showMessage("start jazzify");

        var score = curScore;
        if (!score) {
            showMessage("no score open");
            Qt.quit();
            return;
        }

        var cursor = score.newCursor();
        cursor.rewind(Cursor.SCORE_START);
        var added = 0;
        var chordCount = 0;

        var marcatoCount = 0;

        while (!cursor.eos) {
            var element = cursor.element;
            if (element && element.type === Element.CHORD) {
                chordCount++;
                var has = detectMarcato(element);
                if (has) {
                    marcatoCount++;
                    showMessage("Marcato found in chord #" + chordCount);
                }
            }
            cursor.next();
        }

        showMessage("Scan complete: found " + marcatoCount + " marcato-containing chord(s) out of " + chordCount + " chords");

        _quit();

    }

}