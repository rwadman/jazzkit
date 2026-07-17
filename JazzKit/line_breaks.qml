import QtQuick
import QtQuick.Layouts

import MuseScore
import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit
import "lib/linebreaks.js" as LineBreaks
import "lib/effects.js" as Effects

// Extension "form" action (see manifest.json). Options live in the form body;
// on Apply we clear existing breaks and attach new ones via direct API
// (newElement(LAYOUT_BREAK)) — no cmd() — the pattern proven safe from a form
// (see courtesy_accidentals). Choices are remembered per score as a metatag.
MuseScore {
    id: root
    width: 380
    height: contentColumn.implicitHeight + 32

    property string settingsTag: "jazzKitLineBreaks"

    // Bound to the controls (mutable so loadSettings can populate them).
    property bool optDouble: true
    property bool optRepeats: true
    property int valEveryN: 4     // 0 = skip
    property int valMinBars: 3
    property int valMaxBars: 6    // 0 = no limit

    property string message: ""   // non-empty => show result instead of options

    // ---- persistence (per-score metatag; shared JazzKit/lib/jazzkit.js) --------
    function loadSettings() {
        var s = JazzKit.loadJsonTag(curScore, settingsTag);
        if (!s) return;
        if (s.d !== undefined) optDouble = s.d;
        if (s.r !== undefined) optRepeats = s.r;
        if (s.e !== undefined) valEveryN = parseInt(s.e, 10) || 0;
        if (s.mn !== undefined) valMinBars = parseInt(s.mn, 10) || 1;
        if (s.mx !== undefined) valMaxBars = parseInt(s.mx, 10) || 0;
    }
    function saveSettings() {
        JazzKit.saveJsonTag(curScore, settingsTag, {
            d: optDouble, r: optRepeats,
            e: String(valEveryN), mn: String(valMinBars), mx: String(valMaxBars)
        });
    }

    // ---- score inspection (API-bound; delegates the algorithm to linebreaks.js) -
    function mStart(m) { return m.tick.ticks; }
    function mEnd(m)   { return m.tick.ticks + m.ticks.ticks; }

    function endsWithDoubleBarline(m) {
        var seg = m.firstSegment;
        while (seg) {
            if (seg.segmentType === Segment.EndBarLine) {
                var bl = seg.elementAt(0);
                if (bl && bl.type === Element.BAR_LINE && bl.barlineType === BarLineType.DOUBLE)
                    return true;
            }
            seg = seg.nextInMeasure;
        }
        return false;
    }

    function collectMeasures() {
        var sel = curScore.selection;
        var startTick = -1, endTick = -1;
        if (sel && sel.isRange) {
            var c = curScore.newCursor();
            c.rewind(Cursor.SELECTION_START); startTick = c.tick;
            c.rewind(Cursor.SELECTION_END);   endTick = c.tick;
            if (endTick === 0) endTick = curScore.lastSegment.tick + 1;
        }
        var arr = [];
        var m = curScore.firstMeasure;
        while (m) {
            if (startTick < 0 || (mStart(m) < endTick && mEnd(m) > startTick))
                arr.push(m);
            m = m.nextMeasure;
        }
        return arr;
    }

    function buildBoxes(measures) {
        var starts = {};
        var hasStarts = false;
        var mm = curScore.firstMeasureMM;
        while (mm) { starts[mm.tick.ticks] = true; hasStarts = true; mm = mm.nextMeasureMM; }

        var ticks = [];
        for (var i = 0; i < measures.length; ++i) ticks.push(measures[i].tick.ticks);

        var groups = LineBreaks.groupBoxes(ticks, hasStarts ? starts : null);
        var boxes = [];
        for (var g = 0; g < groups.length; ++g) {
            boxes.push({
                first: measures[groups[g].firstIdx],
                last: measures[groups[g].lastIdx],
                musicBars: groups[g].musicBars
            });
        }
        return boxes;
    }

    function computeBoxBreaks(boxes, opts) {
        var data = [];
        for (var i = 0; i < boxes.length; ++i) {
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

    // ---- apply -----------------------------------------------------------------
    function effectCtx() {
        return {
            curScore: curScore, newElement: newElement,
            Element: Element, LayoutBreak: LayoutBreak
        };
    }

    function apply() {
        if (!curScore) { root.message = qsTr("Open a score first."); return; }
        if (!JazzKit.isSupportedVersion(mscoreMajorVersion, mscoreMinorVersion)) {
            root.message = qsTr("This plugin is for MuseScore 4.4 or later"); return;
        }
        var measures = collectMeasures();
        if (measures.length === 0) { root.message = qsTr("No measures found to format."); return; }

        var opts = {
            atDouble:  optDouble,
            atRepeats: optRepeats,
            everyN:    valEveryN,
            minBars:   Math.max(1, valMinBars),
            maxBars:   valMaxBars
        };
        var boxes = buildBoxes(measures);
        var breakMeasures = computeBoxBreaks(boxes, opts);

        saveSettings();
        var res = Effects.applyLineBreaks(effectCtx(), measures, breakMeasures);
        root.message = qsTr("Formatted %1 measures: cleared %2 break(s), added %3 line break(s).")
                        .arg(measures.length).arg(res.removed).arg(res.added);
    }

    Component.onCompleted: Qt.callLater(loadSettings)

    ColumnLayout {
        id: contentColumn
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        // --- result view ---
        StyledTextLabel {
            Layout.fillWidth: true
            visible: root.message !== ""
            text: root.message
            wrapMode: Text.WordWrap
        }

        // --- options view ---
        CheckBox {
            visible: root.message === ""
            text: qsTr("Line break at double barlines")
            checked: root.optDouble
            onClicked: root.optDouble = !root.optDouble
        }
        CheckBox {
            visible: root.message === ""
            text: qsTr("Line break at repeats")
            checked: root.optRepeats
            onClicked: root.optRepeats = !root.optRepeats
        }

        RowLayout {
            visible: root.message === ""
            spacing: 8
            StyledTextLabel { text: qsTr("Line break every") }
            IncrementalPropertyControl {
                implicitWidth: 56
                currentValue: root.valEveryN
                minValue: 0
                maxValue: 99
                step: 1
                onValueEdited: function(newValue) { root.valEveryN = newValue }
            }
            StyledTextLabel { Layout.fillWidth: true; text: qsTr("bars (0 = skip)") }
        }
        RowLayout {
            visible: root.message === ""
            spacing: 8
            StyledTextLabel { text: qsTr("Minimum bars on a line") }
            IncrementalPropertyControl {
                implicitWidth: 56
                currentValue: root.valMinBars
                minValue: 1
                maxValue: 99
                step: 1
                onValueEdited: function(newValue) { root.valMinBars = newValue }
            }
        }
        RowLayout {
            visible: root.message === ""
            spacing: 8
            StyledTextLabel { text: qsTr("Maximum bars on a line") }
            IncrementalPropertyControl {
                implicitWidth: 56
                currentValue: root.valMaxBars
                minValue: 0
                maxValue: 99
                step: 1
                onValueEdited: function(newValue) { root.valMaxBars = newValue }
            }
            StyledTextLabel { Layout.fillWidth: true; text: qsTr("(0 = no limit)") }
        }

        Item { Layout.fillHeight: true }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Item { Layout.fillWidth: true }
            FlatButton {
                text: root.message === "" ? qsTr("Cancel") : qsTr("Close")
                onClicked: root.quit()
            }
            FlatButton {
                visible: root.message === ""
                text: qsTr("Apply")
                accentButton: true
                onClicked: root.apply()
            }
        }
    }
}
