import QtQuick
import QtQuick.Layouts

import Muse.UiComponents

import "lib/jazzkit.js" as JazzKit

// Shared body of the two comp actions (comp_cues.qml, comp_slashes.qml): pick the
// target instruments AND apply, in one gesture. The two differ only in their
// settingsTag, their two strings and the effect they call, so all of that comes in
// as properties.
//
// This is the dialog CONTENT, not the root: the manifest maps an action to a file
// whose root must be MuseScore{}, so each action file keeps its own root and fills
// it with this component. It sits NEXT TO the action files (not in lib/) so it needs
// no import at all — QML resolves a type from the containing file's own directory —
// and check-qml.mjs exempts PascalCase files from the MuseScore{}-root rule.
//
// The root here is the ColumnLayout ITSELF, anchored to the action's MuseScore{}
// root, so the instantiated item tree is exactly the one the shipping forms had
// (MuseScore → ColumnLayout → controls). An extra wrapper Item in between is not
// worth the risk: dialog sizing in this host is fragile and unverifiable outside
// the GUI (see contentHeight below).
//
// The MuseScore globals (curScore, Element, Cursor, …) are NOT read here — they are
// context properties of the plugin's own QML context and it is unverified whether
// they reach a nested component. The action file passes them in as `ctx`, which
// doubles as the effect layer's EffectCtx.
ColumnLayout {
    id: form

    anchors.fill: parent
    anchors.margins: 16
    spacing: 12

    // ---- parameters (set by the action file) ----------------------------------
    property string settingsTag: ""       // per-score metatag holding the last picks
    property string prompt: ""            // label above the instrument list
    property string resultTemplate: ""    // success message, one %1 = targets done
    property var effect: null             // Effects.<fn>(ctx, args) -> {error?, targetsDone}
    property var ctx: ({})                // plugin globals; see the action's effectCtx

    signal closeRequested()

    // ---- state ----------------------------------------------------------------
    property string message: ""           // non-empty => show message instead of picker
    property var selection: null          // from JazzKit.captureSingleStaffRange

    // Height the host window needs. DO NOT try to derive this from the laid-out
    // column — this arithmetic is the original, GUI-verified sizing, and two
    // attempts to replace it have already failed in the GUI:
    //   * `height: contentColumn.implicitHeight + 32` (what the static forms use):
    //     a Repeater-driven ColumnLayout has not laid out when the host measures;
    //   * `forceLayout()` first, then read implicitHeight: still short — the buttons
    //     landed below the bottom edge.
    // The host samples this ONCE, at show (WindowView::showView() →
    // updateSize(rootObject->implicitHeight()), windowview.cpp) and never resizes
    // afterwards, so there is no second chance and no self-correction.
    // The action file ASSIGNS its root implicitHeight from this (see setSize there);
    // a binding is not equivalent — the working version always assigned.
    readonly property int rowHeight: 40
    readonly property int chromeHeight: 130
    property real contentHeight: 180

    ListModel { id: targetsModel }

    function updateSize() {
        form.contentHeight = (form.message !== "" || targetsModel.count === 0)
            ? 180
            : chromeHeight + targetsModel.count * rowHeight;
    }

    // Validate + capture the selection, build the instrument list, size the window.
    // Called from the action file's Component.onCompleted (i.e. after the root has
    // its width, and before the host measures it).
    function start() {
        var guard = JazzKit.guardScore(ctx.curScore, ctx.mscoreMajorVersion, ctx.mscoreMinorVersion);
        if (guard !== "") { form.message = guard; updateSize(); return; }

        var sel = JazzKit.captureSingleStaffRange(ctx.curScore, ctx.Cursor);
        if (!sel.ok) { form.message = sel.error; updateSize(); return; }
        form.selection = sel;

        var saved = JazzKit.loadJsonTag(ctx.curScore, settingsTag);
        var rows = JazzKit.computeTargets(ctx.curScore.parts, sel.staffIdx,
                                          (saved && saved.ids !== undefined) ? saved.ids : null);
        targetsModel.clear();
        for (var i = 0; i < rows.length; ++i) targetsModel.append(rows[i]);
        if (targetsModel.count === 0)
            form.message = qsTr("No comping instruments (piano, bass, drums, …) other than the selected staff were found.");
        updateSize();
    }

    function apply() {
        var rows = [];
        for (var i = 0; i < targetsModel.count; ++i) rows.push(targetsModel.get(i));
        var picked = JazzKit.selectedTargets(rows);
        if (picked.targets.length === 0) {
            form.message = qsTr("Check at least one instrument."); updateSize(); return;
        }
        JazzKit.saveJsonTag(ctx.curScore, settingsTag, { ids: picked.ids });

        var res = effect(ctx, {
            selStart: selection.selStart, selEnd: selection.selEnd,
            measureTick: selection.measureTick, srcStaffIdx: selection.staffIdx,
            targets: picked.targets
        });
        form.message = res.error ? res.error : resultTemplate.arg(res.targetsDone);
        updateSize();
    }

    // --- result view ---
    StyledTextLabel {
        Layout.fillWidth: true
        visible: form.message !== ""
        text: form.message
        wrapMode: Text.WordWrap
    }

    // --- picker view ---
    ColumnLayout {
        Layout.fillWidth: true
        visible: form.message === ""
        spacing: 12

        StyledTextLabel {
            Layout.fillWidth: true
            text: form.prompt
        }

        Repeater {
            model: targetsModel
            delegate: CheckBox {
                required property var model
                required property int index
                Layout.fillWidth: true
                text: model.label
                checked: model.checked
                onClicked: targetsModel.setProperty(index, "checked", !model.checked)
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        Item { Layout.fillWidth: true }
        FlatButton {
            text: form.message === "" ? qsTr("Cancel") : qsTr("Close")
            onClicked: form.closeRequested()
        }
        FlatButton {
            visible: form.message === ""
            text: qsTr("Apply")
            accentButton: true
            onClicked: form.apply()
        }
    }
}
