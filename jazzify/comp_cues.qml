import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import QtQuick.Controls as Ctrl

import MuseScore
import Muse.UiComponents

MuseScore {
    version: "0.1"
    title: "To Comp Cues"
    menuPath: "Plugins.To Comp Cues"
    description: "Copy the selected passage into the chosen instruments. Pitched instruments receive a cue-size copy of the notes; drum/percussion parts receive a rhythmic comping cue (voice 3 slash notation, voice 1 time slashes). Choices are remembered per instrument."
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
// on the score (same mechanism as comp_slashes.qml / line_breaks.qml — MS's bundled
// QML has no Settings module). Recalls whenever the score is open, saved into the
// file on save. Own tag so it is remembered independently of comp_slashes.

    property string settingsTag: "jazzifyCueNotes"

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
    // dragged-in leading beats afterwards (same trick as comp_slashes).
    property int measureTick: 0
    property int srcStaffIdx: -1

    // Instruments the checkboxes represent. Roles: label, instrumentId, staffIdx, isDrum, checked.
    ListModel { id: targetsModel }

//=============================================================================

    // Heuristic: is this part a chord/comping instrument we'd add a cue to?
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
            // Never target the staff we're copying from.
            if (srcStaffIdx >= partStart && srcStaffIdx < partEnd) continue;

            var id = p.instrumentId || "";
            var checked = saved ? (saved.indexOf(id) !== -1) : true;

            targetsModel.append({
                label: p.longName && p.longName.length ? p.longName : p.partName,
                instrumentId: id,
                staffIdx: partStart, // top staff of the part
                isDrum: p.hasDrumStaff ? true : false,
                checked: checked
            });
        }
    }

//=============================================================================

    // Cue-size the pasted content on staffIdx across [startTick, endTick). No action
    // code exists for "cue size" — it is the elements' `small` property (its API
    // docstring is literally "Whether this element is cue size"). We walk voice 1
    // (always populated after a paste) with a cursor and set small on each chord/rest
    // and every notehead. Wrapped in one startCmd/endCmd (a single logical edit — not
    // a nest of cmd()s, which is the crash case in api-gotchas).
    function makeCueSize(staffIdx, startTick, endTick)
    {
        var cursor = curScore.newCursor();
        cursor.staffIdx = staffIdx;
        cursor.voice = 0; // set track BEFORE rewind (rewindToTick uses the current track)
        cursor.rewindToTick(startTick);

        curScore.startCmd();
        while (cursor.element && cursor.tick < endTick)
        {
            var e = cursor.element;
            e.small = true;
            if (e.type === Element.CHORD && e.notes)
                for (var k = 0; k < e.notes.length; ++k) e.notes[k].small = true;
            if (!cursor.next()) break;
        }
        curScore.endCmd();
    }

//=============================================================================

    // Pitched target: paste a cue-size copy of the source notes into voice 1.
    function pitchedCue(t)
    {
        if (!selectStaffRange(measureTick, selEnd, t))
        {
            showMessage(qsTr("Could not select a target staff. Some instruments may be unchanged."));
            return false;
        }
        cmd("paste");

        // Clear the dragged-in leading beats (voice 1) back to rests.
        if (selStart > measureTick)
        {
            if (!selectStaffRange(measureTick, selStart, t))
            {
                showMessage(qsTr("Pasted, but could not clear the leading beats."));
                return false;
            }
            cmd("delete");
        }

        makeCueSize(t, selStart, selEnd);
        return true;
    }

    // Drum/percussion target: paste as a rhythmic comping cue — voice 3 slash
    // notation over the passage, voice 1 filled with time slashes (see api-gotchas
    // for why each cmd() runs standalone rather than under one startCmd).
    function drumComp(t)
    {
        // Paste converts the pitched notes to drum notes.
        if (!selectStaffRange(measureTick, selEnd, t))
        {
            showMessage(qsTr("Could not select the drum staff to paste into. Some instruments may be unchanged."));
            return false;
        }
        cmd("paste");

        // Move the pasted region to voice 3 (before the leading-beats cleanup — doing
        // the delete first left the re-selection incomplete, moving only part of it).
        if (!selectStaffRange(selStart, selEnd, t))
        {
            showMessage(qsTr("Pasted into the drum staff, but could not re-select it to move to voice 3."));
            return false;
        }
        cmd("voice-3");

        // Rhythmic slash notation on the voice 3 drum notes.
        if (!selectStaffRange(selStart, selEnd, t))
        {
            showMessage(qsTr("Moved to voice 3, but could not re-select the drum staff for slash notation."));
            return false;
        }
        cmd("slash-rhythm");

        // Clear the leading beats we dragged in (still voice 1) back to rests; the
        // comping now lives in voice 3, outside this range.
        if (selStart > measureTick)
        {
            if (!selectStaffRange(measureTick, selStart, t))
            {
                showMessage(qsTr("Applied the comping cue, but could not clear the leading beats."));
                return false;
            }
            cmd("delete");
        }

        // Fill voice 1 across the touched region with time slashes so it reads as
        // "keep time" under the voice-3 accents.
        if (!selectStaffRange(measureTick, selEnd, t))
        {
            showMessage(qsTr("Applied the comping cue, but could not fill voice 1 with slashes."));
            return false;
        }
        cmd("slash-fill");
        return true;
    }

//=============================================================================
// Stamp the captured passage into every chosen target. Runs only after the options
// window is closed, so the notation view is the active context again — otherwise the
// paste / voice / slash actions have no handler ("no one can handle").

    function stamp()
    {
        var targets = [];
        for (var i = 0; i < targetsModel.count; ++i)
        {
            var r = targetsModel.get(i);
            if (r.checked) targets.push({ staffIdx: r.staffIdx, isDrum: r.isDrum });
        }
        if (targets.length === 0) return; // nothing checked → no-op

        for (var j = 0; j < targets.length; ++j)
        {
            var t = targets[j].staffIdx;
            if (t === srcStaffIdx) continue; // guarded in buildTargets, belt-and-braces

            // Copy the source, extended left to the measure start so the paste can
            // anchor on the target's full-measure rest (which sits at the measure start).
            if (!selectStaffRange(measureTick, selEnd, srcStaffIdx))
            {
                showMessage(qsTr("Could not re-select the source notes. Some instruments may be unchanged."));
                return;
            }
            cmd("copy");

            var ok = targets[j].isDrum ? drumComp(t) : pitchedCue(t);
            if (!ok) return; // the branch already reported why
        }
    }

//=============================================================================

    Window
    {
        id: optionsDialog
        title: qsTr("To Comp Cues")
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
                text: qsTr("Add a cue to:")
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
                        // context; otherwise paste / voice / slash have no handler.
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
