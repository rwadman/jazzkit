import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/articulations.js" as Articulations
import "lib"

MuseScore {
    version: "0.2"
    title: "Fix Marcato Staccatos"
    menuPath: "Plugins.Fix Marcato Staccatos"
    description: "Make score align better with jazz conventions"

//=============================================================================

    InfoDialog { id: infoDialog }



    // Symbol resolution (the version-dependent SymId/name matching) and the
    // staccato candidate order now live in the typed, unit-tested articulations.js.
    // SymId is a MuseScore global this .qml sees but a stateless JS library can't,
    // so we pass it in.
    function _tryAddHiddenStaccato(el, cursor, wantAbove)
    {
        var candidates = [];
        try { candidates = Articulations.staccatoCandidates(SymId, wantAbove); } catch (e) { candidates = []; }

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
                if (Articulations.articSymbol(a2) == cand)
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
        var c = Articulations.classifyChord(Articulations.chordNames(SymId, articulations));
        if (!c.hasMarcato) return result;

        if (c.staccatoIndices.length > 0)
        {
            for (var k = 0; k < c.staccatoIndices.length; ++k)
            {
                var a = articulations[c.staccatoIndices[k]];
                if (!a) continue;
                try { a.hidden = true; } catch (e) { }
                try { a.visible = false; } catch (e) { }
            }
            result.hidden = 1;
            console.log("Hid existing staccato at tick " + cursor.tick + " staff " + staffIdx + " voice " + voice);
            return result;
        }

        var ok = _tryAddHiddenStaccato(el, cursor, c.addAbove);
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
        curScore.startCmd();

        var cursor = curScore.newCursor();
        var total = {added: 0, hidden: 0};

        var maxStaves = JazzKit.countStaves(curScore);
        for (var staffIdx = 0; staffIdx < maxStaves; ++staffIdx)
        {
            // pass the default voice processor (bound to the marcato/chord processor) so callers can override if needed
            var res = _processStaff(cursor, staffIdx, _processAllChordsFn(_processMarcatoStaccato));
            total.added += res.added;
            total.hidden += res.hidden;
        }

        curScore.endCmd();
        infoDialog.show(qsTr("Added %1 hidden staccatos, hid %2 existing staccatos.").arg(total.added).arg(total.hidden));
    }


    onRun:
    {

        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion))
        {
        infoDialog.show(qsTr("This plugin is for MuseScore 4.4 or later"));
        return;
        }
        console.log("Running JazzKit plugin v0.2 on MuseScore " + mscoreMajorVersion + "." + mscoreMinorVersion);
        // Ensure marcato articulations have hidden staccatos
        ensureMarcatoHasHiddenStaccato();

    }

}