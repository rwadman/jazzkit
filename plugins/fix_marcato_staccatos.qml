import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.2"
    title: "Fix Marcato Staccatos"
    menuPath: "Plugins.Fix Marcato Staccatos"
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

    function _getMaxStaves()
    {
        if (typeof curScore.nstaves === 'number') return curScore.nstaves;
        if (typeof curScore.nStaves === 'number') return curScore.nStaves;
        if (typeof curScore.staffCount === 'number') return curScore.staffCount;
        if (curScore.staves && typeof curScore.staves.length === 'number') return curScore.staves.length;
        return 16;
    }

    function _articSymbol(a)
    {
        if (!a) return "";
        return a.symbol !== undefined ? a.symbol : (a.toString ? a.toString() : "");
    }

    function _hasMarcato(articulations)
    {
        var above = false, below = false;
        for (var i = 0; i < articulations.length; ++i)
        {
            var s = _articSymbol(articulations[i]);
            if (s == SymId.articMarcatoAbove || s == "articMarcatoAbove") above = true;
            if (s == SymId.articMarcatoBelow || s == "articMarcatoBelow") below = true;
            if (above && below) break;
        }
        return {above: above, below: below};
    }

    function _findAndHideExistingStaccatos(articulations)
    {
        var found = false;
        var staccNames = ["articStaccatAbove","articStaccatoAbove","articStaccatBelow","articStaccatoBelow","articStaccat","articStaccato"];
        for (var i = 0; i < articulations.length; ++i)
        {
            var a = articulations[i];
            if (!a) continue;
            var s = _articSymbol(a);
            if (staccNames.indexOf(s) >= 0 || s == SymId.articStaccatAbove || s == SymId.articStaccatBelow || s == SymId.articStaccatoAbove || s == SymId.articStaccatoBelow)
            {
                try { a.hidden = true; } catch (e) { }
                try { a.visible = false; } catch (e) { }
                found = true;
            }
        }
        return found;
    }

    function _tryAddHiddenStaccato(el, cursor, wantAbove)
    {
        // numeric SymIds we try (order: prefer above/below specific)
        var candidates = [];
        try {
            if (wantAbove) candidates = [SymId.articStaccatAbove, SymId.articStaccatoAbove, SymId.articStaccat, SymId.articStaccato];
            else candidates = [SymId.articStaccatBelow, SymId.articStaccatoBelow, SymId.articStaccat, SymId.articStaccato];
        } catch (e) { candidates = []; }

        var articulations = el.articulations || [];

        for (var j = 0; j < candidates.length; ++j)
        {
            var cand = candidates[j];
            if (!cand) continue;
            var s = newElement(Element.ARTICULATION);
            try { s.hidden = true; } catch (e) { }
            try { s.visible = false; } catch (e) { }
            s.symbol = cand;
            cursor.add(s);

            // check if added
            articulations = el.articulations || [];
            for (var k = 0; k < articulations.length; ++k)
            {
                var a2 = articulations[k];
                if (!a2) continue;
                var sym2 = _articSymbol(a2);
                if (sym2 == cand)
                {
                    try { a2.hidden = true; } catch (e) { }
                    try { a2.visible = false; } catch (e) { }
                    return true;
                }
            }
        }
        return false;
    }

    // Process a chord with marcato: hide existing staccatos or try to add a hidden staccato.
    function _processMarcatoStaccato(el, cursor, staffIdx, voice)
    {
        var result = {added: 0, hidden: 0};
        if (!el || el.type != Element.CHORD) return result;

        var articulations = el.articulations || [];
        var marc = _hasMarcato(articulations);
        if (!(marc.above || marc.below)) return result;

        if (_findAndHideExistingStaccatos(articulations))
        {
            result.hidden = 1;
            console.log("Hid existing staccato at tick " + cursor.tick + " staff " + staffIdx + " voice " + voice);
            return result;
        }

        var wantAbove = marc.above;
        var ok = _tryAddHiddenStaccato(el, cursor, wantAbove);
        if (ok)
        {
            result.added = 1;
            console.log("Added hidden staccato at tick " + cursor.tick + " staff " + staffIdx + " voice " + voice);
        }
        else
        {
            console.log("Failed add at tick " + cursor.tick + " staff " + staffIdx + " voice " + voice);
        }
        return result;
    }

    // Process a voice on a given staff: iterate segments and process chords using provided chordProcessor.
    // chordProcessor signature: (el, cursor, staffIdx, voice) => {added, hidden}
    function _processVoice(cursor, staffIdx, voice, chordProcessor)
    {
        if (typeof chordProcessor !== 'function') chordProcessor = _processMarcatoStaccato;
        var counts = {added: 0, hidden: 0};
        cursor.staffIdx = staffIdx;
        cursor.voice = voice;
        cursor.rewind(Cursor.SCORE_START);

        while (cursor.segment)
        {
            var el = cursor.element;
            if (el && el.type == Element.CHORD)
            {
                var res = chordProcessor(el, cursor, staffIdx, voice);
                if (res) { counts.added += res.added || 0; counts.hidden += res.hidden || 0; }
            }
            cursor.next();
        }
        return counts;
    }

    // Bind a chordProcessor into a voiceProcessor via partial application.
    function _processAllChordsFn(chordProcessor)
    {
        return function(cursor, staffIdx, voice)
        {
            return _processVoice(cursor, staffIdx, voice, chordProcessor);
        };
    }

    // Process an entire staff: iterate voices and aggregate counts.
    // Accepts a voiceProcessor callback which receives (cursor, staffIdx, voice) and returns {added, hidden}.
    // Use _processAllChordsFn(chordProcessor) to create a voiceProcessor that forwards to a chordProcessor.
    // If no callback is provided, defaults to _processVoice.
    function _processStaff(cursor, staffIdx, voiceProcessor)
    {
        if (typeof voiceProcessor !== 'function') voiceProcessor = _processVoice;
        var agg = {added: 0, hidden: 0};
        var maxVoices = 4;
        for (var voice = 0; voice < maxVoices; ++voice)
        {
            var res = voiceProcessor(cursor, staffIdx, voice);
            if (res) { agg.added += res.added || 0; agg.hidden += res.hidden || 0; }
        }
        return agg;
    }

    function ensureMarcatoHasHiddenStaccato()
    {
        initialiseScoreChanges();

        var cursor = curScore.newCursor();
        var total = {added: 0, hidden: 0};

        var maxStaves = _getMaxStaves();
        for (var staffIdx = 0; staffIdx < maxStaves; ++staffIdx)
        {
            // pass the default voice processor (bound to the marcato/chord processor) so callers can override if needed
            var res = _processStaff(cursor, staffIdx, _processAllChordsFn(_processMarcatoStaccato));
            total.added += res.added;
            total.hidden += res.hidden;
        }

        finaliseScoreChanges();
        showMessage(qsTr("Added %1 hidden staccatos, hid %2 existing staccatos.").arg(total.added).arg(total.hidden));
    }


    onRun:
    {

        if ((mscoreMajorVersion <= 3) || ((mscoreMajorVersion == 4 && mscoreMinorVersion < 4 )))
        {
        versionError.open()
        return;
        }
        console.log("Running JazzKit plugin v0.2 on MuseScore " + mscoreMajorVersion + "." + mscoreMinorVersion);
        // Ensure marcato articulations have hidden staccatos
        ensureMarcatoHasHiddenStaccato();

    }

}