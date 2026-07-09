import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import QtQuick.Controls as Ctrl

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
// Settings persistence
//
// The plugin QML is reinstantiated on every run, so the dialog choices are stored
// on the score as a metatag. That recalls them whenever the score is open (this
// session or later) and saves them into the file when the score is saved.

    property string settingsTag: "jazzifyLineBreaks"

    function loadSettings()
    {
        if (!curScore) return;
        var raw = curScore.metaTag(settingsTag);
        if (!raw) return;
        try {
            var s = JSON.parse(raw);
            if (s.d !== undefined) cbDouble.checked = s.d;
            if (s.r !== undefined) cbRepeats.checked = s.r;
            if (s.e !== undefined) tfEveryN.text = s.e;
            if (s.mn !== undefined) tfMinBars.text = s.mn;
            if (s.mx !== undefined) tfMaxBars.text = s.mx;
        } catch (e) { }
    }

    function saveSettings()
    {
        if (!curScore) return;
        var val = JSON.stringify({
            d:  cbDouble.checked,
            r:  cbRepeats.checked,
            e:  tfEveryN.text,
            mn: tfMinBars.text,
            mx: tfMaxBars.text
        });
        curScore.setMetaTag(settingsTag, val);

        // Share with the parts. Reading a metatag already falls back to the master
        // score, so writing from the main score reaches every part; this loop also
        // overwrites any value a part had set on its own. The API has no upward link
        // from a part to the master, so a change made while viewing a part cannot be
        // propagated and stays local to that part.
        var ex = curScore.excerpts;
        if (ex)
        {
            for (var i = 0; i < ex.length; ++i)
            {
                var ps = ex[i].partScore;
                if (ps) ps.setMetaTag(settingsTag, val);
            }
        }
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
        var starts = {};
        var hasStarts = false;
        var mm = curScore.firstMeasureMM;
        while (mm) { starts[mm.tick.ticks] = true; hasStarts = true; mm = mm.nextMeasureMM; }

        var boxes = [];
        var cur = null;
        for (var i = 0; i < measures.length; ++i)
        {
            var m = measures[i];
            if (cur === null || !hasStarts || starts[m.tick.ticks])
            {
                cur = { first: m, last: m, musicBars: 1 };
                boxes.push(cur);
            }
            else
            {
                cur.last = m;
                cur.musicBars += 1;
            }
        }
        return boxes;
    }

//=============================================================================
// Break computation (per box)

    // Decide which boxes get a line break after them. Returns an array of real
    // measures to attach a LINE break to (each box's last real measure).
    //
    // Structural breaks (double barlines / repeats) come first and split the boxes
    // into sections. Within a section, "every N" breaks fall on the everyN-bar grid
    // (bars N, 2N, 3N ... from the section start), placed at the box boundary that
    // lands on the grid line - so a 6-bar rest with N=4 keeps counting to bar 8
    // rather than breaking at 6. Finally the minimum-bars rule removes/moves breaks
    // around any line with too few boxes.
    function computeBoxBreaks(boxes, opts)
    {
        var n = boxes.length;
        if (n === 0) return [];

        // tag[i]: 0 = no break, 1 = structural break, 2 = "every N" break (removable)
        var tag = [];
        var structural = [];
        for (var i = 0; i < n; ++i) { tag.push(0); structural.push(false); }

        // 1. Structural breaks.
        for (var i = 0; i < n; ++i)
        {
            var b = boxes[i];
            if (opts.atDouble && endsWithDoubleBarline(b.last)) structural[i] = true;
            if (opts.atRepeats && b.last.repeatEnd)             structural[i] = true;
            // "before start-repeat" -> break on the previous box
            if (opts.atRepeats && b.first.repeatStart && i > 0) structural[i - 1] = true;
        }
        structural[n - 1] = false;   // never break on the last box (nothing follows)
        for (var i = 0; i < n; ++i) if (structural[i]) tag[i] = 1;

        // 2. "Every N" breaks on the everyN-bar grid. acc is the cumulative music-bar
        // count from the section start; a break falls where acc lands on a grid line
        // (a multiple of everyN). acc is not reset after a break - only at a section
        // boundary - so the grid stays aligned across multibar rests.
        if (opts.everyN >= 1)
        {
            var acc = 0;
            for (var i = 0; i < n; ++i)
            {
                acc += boxes[i].musicBars;
                if (i === n - 1) break;               // no break after the last box
                if (structural[i]) { acc = 0; continue; }   // section boundary: restart the grid
                if (acc % opts.everyN === 0) tag[i] = 2;
            }
        }

        // 3. Minimum bars per line: merge any too-short line into the previous one
        // by dropping the ("every N") break before it. Boxes count as 1 bar here.
        minMerge(tag, n, opts.minBars, opts.maxBars);

        var res = [];
        for (var i = 0; i < n; ++i) if (tag[i] > 0) res.push(boxes[i].last);
        return res;
    }

    // Partition the boxes into lines by the current breaks. Each line records its
    // box range [s..e] and box count (both the minimum and maximum rules count
    // visible boxes, a multirest being one box).
    function computeLines(tag, n)
    {
        var lines = [];
        var s = 0;
        for (var i = 0; i < n; ++i)
        {
            if (tag[i] > 0 || i === n - 1)
            {
                lines.push({ s: s, e: i, boxCount: i - s + 1 });
                s = i + 1;
            }
        }
        return lines;
    }

    // Fix lines shorter than minBars boxes by merging them into a neighbour, until
    // stable. A short line normally merges into the PREVIOUS line (drop the break
    // before it). But that break is only removable if it is an "every N" break
    // (tag 2) - if it is structural (tag 1: a double barline / repeat) or there is
    // no line before, the short line merges into the NEXT line instead (drop the
    // break after it). Structural breaks are never removed. A merge is skipped when
    // it would make the merged line exceed maxBars visible boxes (0 = no limit).
    function minMerge(tag, n, minBars, maxBars)
    {
        if (minBars <= 1) return;
        var guard = 0;
        while (guard++ < 10000)
        {
            var lines = computeLines(tag, n);
            var acted = false;
            for (var li = 0; li < lines.length; ++li)
            {
                var L = lines[li];
                if (L.boxCount >= minBars) continue;

                var prev = (li > 0) ? lines[li - 1] : null;
                var next = (li < lines.length - 1) ? lines[li + 1] : null;

                var beforeRemovable = (L.s > 0 && tag[L.s - 1] === 2);
                var afterRemovable  = (L.e < n - 1 && tag[L.e] === 2);
                var canBefore = beforeRemovable && prev && (maxBars <= 0 || prev.boxCount + L.boxCount <= maxBars);
                var canAfter  = afterRemovable  && next && (maxBars <= 0 || L.boxCount + next.boxCount <= maxBars);

                var dropIdx = -1;
                if (beforeRemovable)          // prefer merging into the previous line
                    dropIdx = canBefore ? (L.s - 1) : (canAfter ? L.e : -1);
                else if (canAfter)            // structural / no break before -> merge into next
                    dropIdx = L.e;

                if (dropIdx >= 0) { tag[dropIdx] = 0; acted = true; break; }
            }
            if (!acted) break;
        }
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

        var boxes = buildBoxes(measures);
        var breakMeasures = computeBoxBreaks(boxes, opts);

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
        for (var i = 0; i < breakMeasures.length; ++i)
        {
            var lb = newElement(Element.LAYOUT_BREAK);
            lb.layoutBreakType = LayoutBreak.LINE;
            breakMeasures[i].add(lb);
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
        loadSettings();          // recall the last choices stored on this score
        optionsDialog.show();
    }
}
