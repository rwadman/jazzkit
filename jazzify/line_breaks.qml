import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import QtQuick.Controls

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.1"
    title: "Format Line Breaks"
    menuPath: "Plugins.Jazzify.Format Line Breaks"
    description: "Clear existing breaks in the selection (or whole score) and re-apply line breaks at double barlines, repeats and every N bars"

//=============================================================================
// Messaging

    function showMessage(message)
    {
        infoDialog.text = message;
        infoDialog.open();
    }

    MessageDialog
    {
        id: infoDialog
        visible: false
        title: "Jazzify"
        text: ""
        onAccepted: { close(); }
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
// Break computation

    // Returns a boolean[] the same length as measures: isBreak[i] === true means a
    // line break is placed ON measure i (the system ends after measure i).
    //
    // Structural breaks (double barlines / repeats) are placed first. They divide
    // the measures into sections; within each section the "every N" breaks are
    // applied, then the break before an over-short trailing line is dropped.
    function computeBreaks(measures, opts)
    {
        var n = measures.length;
        var structural = [];
        var isBreak = [];
        for (var i = 0; i < n; ++i) { structural.push(false); isBreak.push(false); }

        // 1. Structural breaks.
        for (var i = 0; i < n; ++i)
        {
            var m = measures[i];
            if (opts.atDouble && endsWithDoubleBarline(m)) structural[i] = true;
            if (opts.atRepeats && m.repeatEnd)             structural[i] = true;
            // "before start-repeat" -> break on the previous measure
            if (opts.atRepeats && m.repeatStart && i > 0)  structural[i - 1] = true;
        }
        // Never break on the very last measure of the range (nothing follows).
        if (n > 0) structural[n - 1] = false;
        for (var i = 0; i < n; ++i) if (structural[i]) isBreak[i] = true;

        // 2. "Every N" breaks, per section between structural breaks.
        if (opts.everyN >= 1)
        {
            var sectionStart = 0;
            for (var i = 0; i < n; ++i)
            {
                if (structural[i] || i === n - 1)
                {
                    applyEveryN(isBreak, sectionStart, i, opts.everyN, opts.minBars);
                    sectionStart = i + 1;
                }
            }
        }
        return isBreak;
    }

    // Subdivide the section of measures [a..b] (inclusive) with a break every n
    // measures. If the trailing line would be shorter than minBars, drop the last
    // internal break so that short tail merges into the previous line.
    function applyEveryN(isBreak, a, b, n, minBars)
    {
        var internal = [];
        for (var j = a + n - 1; j < b; j += n) internal.push(j);
        if (internal.length === 0) return;

        var last = internal[internal.length - 1];
        var lastLineLen = b - last;               // measures in (last+1 .. b)
        if (lastLineLen < minBars) internal.pop();

        for (var k = 0; k < internal.length; ++k) isBreak[internal[k]] = true;
    }

//=============================================================================
// Apply

    function applyLineBreaks(opts)
    {
        var measures = collectMeasures();
        if (measures.length === 0)
        {
            showMessage(qsTr("No measures found to format."));
            return;
        }

        var isBreak = computeBreaks(measures, opts);

        curScore.startCmd();

        // 1. Clear every existing layout break (line, page, section) in range.
        var removed = 0;
        for (var i = 0; i < measures.length; ++i)
        {
            var els = measures[i].elements;
            var toRemove = [];
            for (var j = 0; j < els.length; ++j)
            {
                var e = els[j];
                if (e && e.type === Element.LAYOUT_BREAK) toRemove.push(e);
            }
            for (var k = 0; k < toRemove.length; ++k) { measures[i].remove(toRemove[k]); ++removed; }
        }

        // 2. Add the new line breaks.
        var added = 0;
        for (var i = 0; i < measures.length; ++i)
        {
            if (!isBreak[i]) continue;
            var lb = newElement(Element.LAYOUT_BREAK);
            lb.layoutBreakType = LayoutBreak.LINE;
            measures[i].add(lb);
            ++added;
        }

        curScore.endCmd();

        showMessage(qsTr("Formatted %1 measures: cleared %2 break(s), added %3 line break(s).")
                    .arg(measures.length).arg(removed).arg(added));
    }

//=============================================================================
// Options dialog

    Window
    {
        id: optionsDialog
        title: qsTr("Format Line Breaks")
        width: 360
        height: 260
        modality: Qt.ApplicationModal
        flags: Qt.Dialog
        color: "#f0f0f0"

        ColumnLayout
        {
            anchors.fill: parent
            anchors.margins: 16
            spacing: 10

            CheckBox
            {
                id: cbDouble
                checked: true
                text: qsTr("Line break at double barlines")
            }

            CheckBox
            {
                id: cbRepeats
                checked: true
                text: qsTr("Line break at repeats")
            }

            RowLayout
            {
                spacing: 8
                Label { text: qsTr("Line break every"); color: "#202020" }
                TextField
                {
                    id: tfEveryN
                    text: "4"
                    Layout.preferredWidth: 48
                    horizontalAlignment: TextInput.AlignHCenter
                    inputMethodHints: Qt.ImhDigitsOnly
                }
                Label { text: qsTr("bars (empty = skip)"); color: "#202020" }
            }

            RowLayout
            {
                spacing: 8
                Label { text: qsTr("Minimum bars on a line"); color: "#202020" }
                TextField
                {
                    id: tfMinBars
                    text: "3"
                    Layout.preferredWidth: 48
                    horizontalAlignment: TextInput.AlignHCenter
                    inputMethodHints: Qt.ImhDigitsOnly
                }
            }

            Item { Layout.fillHeight: true }

            RowLayout
            {
                Layout.alignment: Qt.AlignRight
                spacing: 8
                Button
                {
                    text: qsTr("Cancel")
                    onClicked: optionsDialog.close()
                }
                Button
                {
                    text: qsTr("Apply")
                    onClicked:
                    {
                        var everyN = parseInt(tfEveryN.text, 10);
                        if (isNaN(everyN) || everyN < 1) everyN = 0;   // empty / invalid -> skip
                        var minBars = parseInt(tfMinBars.text, 10);
                        if (isNaN(minBars) || minBars < 1) minBars = 1;

                        optionsDialog.close();
                        applyLineBreaks({
                            atDouble:  cbDouble.checked,
                            atRepeats: cbRepeats.checked,
                            everyN:    everyN,
                            minBars:   minBars
                        });
                    }
                }
            }
        }
    }

//=============================================================================

    onRun:
    {
        if ((mscoreMajorVersion <= 3) || (mscoreMajorVersion == 4 && mscoreMinorVersion < 4))
        {
            showMessage(qsTr("This plugin is for MuseScore 4.4 or later"));
            return;
        }
        if (!curScore)
        {
            showMessage(qsTr("Open a score first."));
            return;
        }
        optionsDialog.show();
    }
}
