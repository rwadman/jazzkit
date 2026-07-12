import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import QtQuick.Controls as Ctrl

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.1"
    title: "Rhythm to Comp Slashes"
    menuPath: "Plugins.Jazzify.Rhythm to Comp Slashes"
    description: "Copy the selected rhythm into voice 1 of the chosen comping instruments (piano, bass, drums, …) as rhythmic slash notation. Beats without a note become rests. Choices are remembered per instrument."
    requiresScore: true

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
// Persisted choices: the instrumentIds enabled on the last run, stored as a metatag
// on the score (same mechanism as line_breaks.qml — MS's bundled QML has no Settings
// module). Recalls whenever the score is open and is saved into the file on save.

    property string settingsTag: "jazzifyCompSlashes"

    function loadEnabledIds()
    {
        if (!curScore) return null; // null → first run, default all checked
        var raw = curScore.metaTag(settingsTag);
        if (!raw) return null;
        try {
            var s = JSON.parse(raw);
            if (s.ids !== undefined) return s.ids;
        } catch (e) { }
        return null;
    }

    function saveEnabledIds(ids)
    {
        if (!curScore) return;
        var val = JSON.stringify({ ids: ids });
        curScore.setMetaTag(settingsTag, val);

        // Share with the parts. Reading a metatag falls back to the master score, so
        // writing from the main score reaches every part; this loop also overwrites any
        // value a part set on its own (see line_breaks.qml for the full rationale).
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
// Captured selection (read once at launch — the dialog must not depend on the
// score selection surviving user interaction with the checkboxes).

    property int selStart: 0
    property int selEnd: 0
    // Tick of the barline the selection starts in. Pasting a range anchors on the
    // first chordrest of the target range; an empty target measure holds only a
    // full-measure rest at the measure start, so a mid-measure paste finds no anchor
    // and silently does nothing. We paste from the measure start and clear the
    // dragged-in leading beats afterwards (same trick as drum_comp_cue).
    property int measureTick: 0
    property int srcStaffIdx: -1

    // Instruments the checkboxes represent. Roles: label, instrumentId, staffIdx, checked.
    ListModel { id: targetsModel }

//=============================================================================

    // Heuristic: is this part a chord/comping instrument we'd stamp a rhythm onto?
    function isCompInstrument(part)
    {
        if (part.hasDrumStaff) return true;
        var id = (part.instrumentId || "").toLowerCase();
        var kws = ["piano", "keyboard", "organ", "synth", "harpsichord", "celesta",
                   "clavinet", "accordion", "rhodes", "wurl", "guitar", "bass",
                   "vibraphone", "vibes", "marimba", "banjo", "ukulele", "mandolin", "harp", "comp", "komp"];
        for (var i = 0; i < kws.length; ++i)
            if (id.indexOf(kws[i]) !== -1) return true;
        return false;
    }

    // Select a single-staff range and confirm the selection actually landed on the
    // intended staff. The dispatched cmd()s act on curScore.selection, so a failed
    // selection must abort rather than run against the wrong staff.
    function selectStaffRange(startTick, endTick, staffIdx)
    {
        curScore.selection.selectRange(startTick, endTick, staffIdx, staffIdx + 1);
        var s = curScore.selection;
        return s && s.isRange && s.startStaff === staffIdx;
    }

//=============================================================================

    function buildTargets()
    {
        targetsModel.clear();

        var saved = loadEnabledIds(); // null on first ever run → default all checked
        var parts = curScore.parts;
        for (var i = 0; i < parts.length; ++i)
        {
            var p = parts[i];
            if (!isCompInstrument(p)) continue;

            var partStart = Math.floor(p.startTrack / 4);
            var partEnd = Math.floor(p.endTrack / 4); // exclusive
            // Never target the staff we're copying the rhythm from.
            if (srcStaffIdx >= partStart && srcStaffIdx < partEnd) continue;

            var id = p.instrumentId || "";
            var checked = saved ? (saved.indexOf(id) !== -1) : true;

            targetsModel.append({
                label: p.longName && p.longName.length ? p.longName : p.partName,
                instrumentId: id,
                staffIdx: partStart, // top staff of the part
                checked: checked
            });
        }
    }

//=============================================================================
// Stamp the captured rhythm into voice 1 of every chosen target. Runs only after
// the options window is closed, so the notation view is the active context again —
// otherwise the paste / slash-rhythm actions have no handler ("no one can handle").

    function stamp()
    {
        var targets = [];
        for (var i = 0; i < targetsModel.count; ++i)
        {
            var r = targetsModel.get(i);
            if (r.checked) targets.push(r.staffIdx);
        }
        if (targets.length === 0) return; // nothing checked → no-op

        // Per target: copy the source rhythm, paste into voice 1, slashify the real
        // region, then clear the dragged-in leading beats back to rests. Each cmd()
        // is standalone (no outer startCmd) so the score lays out between steps —
        // wrapping them together crashes MS (see api-gotchas).
        for (var j = 0; j < targets.length; ++j)
        {
            var t = targets[j];
            if (t === srcStaffIdx) continue; // guarded in buildTargets, belt-and-braces

            if (!selectStaffRange(measureTick, selEnd, srcStaffIdx))
            {
                showMessage(qsTr("Could not re-select the source notes. Some instruments may be unchanged."));
                return;
            }
            cmd("copy");

            if (!selectStaffRange(measureTick, selEnd, t))
            {
                showMessage(qsTr("Could not select a target staff. Some instruments may be unchanged."));
                return;
            }
            cmd("paste");

            if (!selectStaffRange(selStart, selEnd, t))
            {
                showMessage(qsTr("Pasted, but could not apply slash notation. Some instruments may be unchanged."));
                return;
            }
            cmd("slash-rhythm");

            if (selStart > measureTick)
            {
                if (!selectStaffRange(measureTick, selStart, t))
                {
                    showMessage(qsTr("Applied the rhythm, but could not clear the leading beats."));
                    return;
                }
                cmd("delete");
            }
        }
    }

//=============================================================================

    Window
    {
        id: optionsDialog
        title: qsTr("Rhythm to Comp Slashes")
        width: 340
        height: Math.min(120 + targetsModel.count * 34, 520)
        modality: Qt.ApplicationModal
        flags: Qt.Dialog
        color: "#f0f0f0"

        ColumnLayout
        {
            anchors.fill: parent
            anchors.margins: 16
            spacing: 10

            Ctrl.Label
            {
                text: qsTr("Add comp slashes to voice 1 of:")
                color: "#202020"
            }

            Repeater
            {
                model: targetsModel
                delegate: Ctrl.CheckBox
                {
                    required property var model
                    required property int index

                    Layout.fillWidth: true
                    checked: model.checked
                    text: model.label
                    onClicked: targetsModel.setProperty(index, "checked", checked)
                    // Force dark label text; the default contentItem inherits a light
                    // theme colour that is invisible on this dialog's background.
                    contentItem: Text {
                        text: model.label
                        color: "#202020"
                        verticalAlignment: Text.AlignVCenter
                        leftPadding: parent.indicator.width + parent.spacing
                    }
                }
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
                        var ids = [];
                        for (var i = 0; i < targetsModel.count; ++i)
                        {
                            var r = targetsModel.get(i);
                            if (r.checked) ids.push(r.instrumentId);
                        }
                        if (ids.length === 0)
                        {
                            showMessage(qsTr("Check at least one instrument."));
                            return;
                        }
                        saveEnabledIds(ids);
                        // Close BEFORE stamping so the notation view regains the active
                        // context; otherwise paste / slash-rhythm have no handler.
                        optionsDialog.close();
                        stamp();
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

        var sel = curScore.selection;
        if (!sel || !sel.isRange || sel.elements.length === 0)
        {
            showMessage(qsTr("Please select a range of notes first."));
            return;
        }
        if (sel.endStaff - sel.startStaff !== 1)
        {
            showMessage(qsTr("Please select notes in a single staff only."));
            return;
        }

        srcStaffIdx = sel.startStaff;

        var cursor = curScore.newCursor();
        cursor.rewind(Cursor.SELECTION_START);
        selStart = cursor.tick;
        measureTick = cursor.measure.firstSegment.tick;
        cursor.rewind(Cursor.SELECTION_END);
        selEnd = cursor.tick;
        // rewind(SELECTION_END) wraps to tick 0 at the end of the score.
        if (selEnd === 0) selEnd = curScore.lastSegment.tick + 1;

        buildTargets();

        if (targetsModel.count === 0)
        {
            showMessage(qsTr("No comping instruments (piano, bass, drums, …) other than the selected staff were found."));
            return;
        }

        optionsDialog.show();
    }
}
