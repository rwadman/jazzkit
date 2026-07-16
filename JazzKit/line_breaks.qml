import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import QtQuick.Controls as Ctrl

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/linebreaks.js" as LineBreaks
import "lib/effects.js" as Effects
import "lib"

MuseScore {
    version: "0.1"
    title: "Format Line Breaks"
    menuPath: "Plugins.Format Line Breaks"
    description: "Clear existing breaks in the selection (or whole score) and re-apply line breaks at double barlines, repeats and every N bars"

//=============================================================================
// Messaging

    InfoDialog { id: infoDialog }

//=============================================================================
// Settings persistence
//
// The plugin QML is reinstantiated on every run, so the dialog choices are stored
// on the score as a metatag. That recalls them whenever the score is open (this
// session or later) and saves them into the file when the score is saved.

    property string settingsTag: "jazzKitLineBreaks"

    // JSON + excerpt mirroring live in the shared JazzKit/lib/jazzkit.js.
    function loadSettings()
    {
        var s = JazzKit.loadJsonTag(curScore, settingsTag);
        if (!s) return;
        if (s.d !== undefined) cbDouble.checked = s.d;
        if (s.r !== undefined) cbRepeats.checked = s.r;
        if (s.e !== undefined) tfEveryN.text = s.e;
        if (s.mn !== undefined) tfMinBars.text = s.mn;
        if (s.mx !== undefined) tfMaxBars.text = s.mx;
    }

    function saveSettings()
    {
        JazzKit.saveJsonTag(curScore, settingsTag, {
            d:  cbDouble.checked,
            r:  cbRepeats.checked,
            e:  tfEveryN.text,
            mn: tfMinBars.text,
            mx: tfMaxBars.text
        });
    }

//=============================================================================
// Score inspection helpers

    // Integer (MIDI-tick) start / end of a measure. measure.tick / measure.ticks
    // are Fraction wrappers; .ticks converts to an integer tick count.
    function mStart(m) { return m.tick.ticks; }
    function mEnd(m)   { return m.tick.ticks + m.ticks.ticks; }

    // Does this measure end with a double barline? The end barline lives in the
    // measure's EndBarLine segment as a BAR_LINE element at track 0.
    function endsWithDoubleBarline(m)
    {
        var seg = m.firstSegment;
        while (seg)
        {
            if (seg.segmentType === Segment.EndBarLine)
            {
                var bl = seg.elementAt(0);
                if (bl && bl.type === Element.BAR_LINE && bl.barlineType === BarLineType.DOUBLE)
                    return true;
            }
            seg = seg.nextInMeasure;
        }
        return false;
    }

    // The measures to operate on: the selected range, or every measure when
    // nothing is selected. A measure is in range if it overlaps [startTick,endTick).
    function collectMeasures()
    {
        var sel = curScore.selection;
        var startTick = -1, endTick = -1;
        if (sel && sel.isRange)
        {
            var c = curScore.newCursor();
            c.rewind(Cursor.SELECTION_START); startTick = c.tick;
            c.rewind(Cursor.SELECTION_END);   endTick = c.tick;
            // rewind(SELECTION_END) wraps to 0 at the end of the score
            if (endTick === 0) endTick = curScore.lastSegment.tick + 1;
        }

        var arr = [];
        var m = curScore.firstMeasure;
        while (m)
        {
            if (startTick < 0 || (mStart(m) < endTick && mEnd(m) > startTick))
                arr.push(m);
            m = m.nextMeasure;
        }
        return arr;
    }

//=============================================================================
// Boxes (visual measures)

    // Group the in-range real measures into "boxes" - what shows as one measure on
    // the page. A multimeasure rest is one box spanning several real measures.
    //
    // nextMeasureMM walks the visual boxes and every box exposes its start tick, so
    // a real measure starts a new box iff its start tick is one of those box starts
    // (interior measures of a multirest are not). Each box carries:
    //   first / last  - its first / last real measure (breaks attach to `last`)
    //   musicBars     - real measures it spans (for the "every N bars" count)
    //   (each box counts as 1 for the "minimum bars per line" count)
    function buildBoxes(measures)
    {
        // Read the visual-box start ticks off the MM (multimeasure-rest) walk, and
        // the real measures' ticks; the grouping itself (which measures merge into
        // one box) is the pure, unit-tested groupBoxes.
        var starts = {};
        var hasStarts = false;
        var mm = curScore.firstMeasureMM;
        while (mm) { starts[mm.tick.ticks] = true; hasStarts = true; mm = mm.nextMeasureMM; }

        var ticks = [];
        for (var i = 0; i < measures.length; ++i) ticks.push(measures[i].tick.ticks);

        var groups = LineBreaks.groupBoxes(ticks, hasStarts ? starts : null);
        var boxes = [];
        for (var g = 0; g < groups.length; ++g)
        {
            boxes.push({
                first: measures[groups[g].firstIdx],
                last: measures[groups[g].lastIdx],
                musicBars: groups[g].musicBars
            });
        }
        return boxes;
    }

//=============================================================================
// Break computation (per box)

    // Decide which boxes get a line break after them. Returns real measures to
    // attach a LINE break to (each box's last real measure). Reads the structural
    // facts off each box here (the only API-bound part), then delegates the
    // placement algorithm to the pure, unit-tested linebreaks.js.
    function computeBoxBreaks(boxes, opts)
    {
        var data = [];
        for (var i = 0; i < boxes.length; ++i)
        {
            var b = boxes[i];
            data.push({
                musicBars:   b.musicBars,
                endsDouble:  endsWithDoubleBarline(b.last),
                repeatEnd:   !!b.last.repeatEnd,
                repeatStart: !!b.first.repeatStart
            });
        }

        var idxs = LineBreaks.computeBreaks(data, opts);
        var res = [];
        for (var j = 0; j < idxs.length; ++j) res.push(boxes[idxs[j]].last);
        return res;
    }

//=============================================================================
// Apply

    // Bundle the MuseScore globals the effect layer needs (a QML-imported JS lib
    // can't see them). The placement algorithm is the pure, unit-tested
    // LineBreaks.computeBreaks (via computeBoxBreaks); Effects.applyLineBreaks only
    // clears the existing breaks and attaches the new ones.
    function effectCtx()
    {
        return {
            curScore: curScore, newElement: newElement,
            Element: Element, LayoutBreak: LayoutBreak
        };
    }

    function applyLineBreaks(opts)
    {
        var measures = collectMeasures();
        if (measures.length === 0)
        {
            infoDialog.show(qsTr("No measures found to format."));
            return;
        }

        var boxes = buildBoxes(measures);
        var breakMeasures = computeBoxBreaks(boxes, opts);

        var res = Effects.applyLineBreaks(effectCtx(), measures, breakMeasures);

        infoDialog.show(qsTr("Formatted %1 measures: cleared %2 break(s), added %3 line break(s).")
                    .arg(measures.length).arg(res.removed).arg(res.added));
    }

//=============================================================================
// Options dialog

    Window
    {
        id: optionsDialog
        title: qsTr("Format Line Breaks")
        width: 360
        height: 300
        modality: Qt.ApplicationModal
        flags: Qt.Dialog
        color: "#f0f0f0"

        ColumnLayout
        {
            anchors.fill: parent
            anchors.margins: 16
            spacing: 10

            Ctrl.CheckBox
            {
                id: cbDouble
                checked: true
                text: qsTr("Line break at double barlines")
                // Force dark label text; the default contentItem inherits a light
                // theme colour that is invisible on this dialog's background.
                contentItem: Text {
                    text: cbDouble.text
                    color: "#202020"
                    verticalAlignment: Text.AlignVCenter
                    leftPadding: cbDouble.indicator.width + cbDouble.spacing
                }
            }

            Ctrl.CheckBox
            {
                id: cbRepeats
                checked: true
                text: qsTr("Line break at repeats")
                contentItem: Text {
                    text: cbRepeats.text
                    color: "#202020"
                    verticalAlignment: Text.AlignVCenter
                    leftPadding: cbRepeats.indicator.width + cbRepeats.spacing
                }
            }

            RowLayout
            {
                spacing: 8
                Ctrl.Label { text: qsTr("Line break every"); color: "#202020" }
                Ctrl.TextField
                {
                    id: tfEveryN
                    text: "4"
                    Layout.preferredWidth: 48
                    horizontalAlignment: TextInput.AlignHCenter
                    inputMethodHints: Qt.ImhDigitsOnly
                }
                Ctrl.Label { text: qsTr("bars (empty = skip)"); color: "#202020" }
            }

            RowLayout
            {
                spacing: 8
                Ctrl.Label { text: qsTr("Minimum bars on a line"); color: "#202020" }
                Ctrl.TextField
                {
                    id: tfMinBars
                    text: "3"
                    Layout.preferredWidth: 48
                    horizontalAlignment: TextInput.AlignHCenter
                    inputMethodHints: Qt.ImhDigitsOnly
                }
            }

            RowLayout
            {
                spacing: 8
                Ctrl.Label { text: qsTr("Maximum bars on a line"); color: "#202020" }
                Ctrl.TextField
                {
                    id: tfMaxBars
                    text: "6"
                    Layout.preferredWidth: 48
                    horizontalAlignment: TextInput.AlignHCenter
                    inputMethodHints: Qt.ImhDigitsOnly
                }
                Ctrl.Label { text: qsTr("(empty = no limit)"); color: "#202020" }
            }

            Item { Layout.fillHeight: true }

            RowLayout
            {
                Layout.alignment: Qt.AlignRight
                spacing: 8
                Ctrl.Button
                {
                    text: qsTr("Cancel")
                    onClicked: optionsDialog.close()
                }
                Ctrl.Button
                {
                    text: qsTr("Apply")
                    onClicked:
                    {
                        var everyN = parseInt(tfEveryN.text, 10);
                        if (isNaN(everyN) || everyN < 1) everyN = 0;   // empty / invalid -> skip
                        var minBars = parseInt(tfMinBars.text, 10);
                        if (isNaN(minBars) || minBars < 1) minBars = 1;
                        var maxBars = parseInt(tfMaxBars.text, 10);
                        if (isNaN(maxBars) || maxBars < 1) maxBars = 0;   // empty / invalid -> no limit

                        saveSettings();
                        optionsDialog.close();
                        applyLineBreaks({
                            atDouble:  cbDouble.checked,
                            atRepeats: cbRepeats.checked,
                            everyN:    everyN,
                            minBars:   minBars,
                            maxBars:   maxBars
                        });
                    }
                }
            }
        }
    }

//=============================================================================

    onRun:
    {
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion))
        {
            infoDialog.show(qsTr("This plugin is for MuseScore 4.4 or later"));
            return;
        }
        if (!curScore)
        {
            infoDialog.show(qsTr("Open a score first."));
            return;
        }
        loadSettings();          // recall the last choices stored on this score
        optionsDialog.show();
    }
}
