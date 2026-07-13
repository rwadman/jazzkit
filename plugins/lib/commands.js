// @ts-check
// MuseScore action codes JazzKit dispatches via cmd(). These are the strings the
// ActionsDispatcher registers — NOT the menu labels (see api-gotchas.md, "cmd()":
// codes ≠ labels). Centralised so every code has one documented home; find and
// verify them against the source with:
//   grep -rn 'registerAction' src/notationscene/internal/notationactioncontroller.cpp
//
// Caveat: this does NOT make the codes safe — a wrong code silently no-ops at
// runtime (no error), and QML cmd() call sites aren't type-checked. It documents
// and de-duplicates the codes; it can't verify them without running MuseScore.
//
//   QML:  import "lib/commands.js" as Cmd   →   cmd(Cmd.PASTE)

var COPY = "copy";                  // Edit ▸ Copy
var PASTE = "paste";                // Edit ▸ Paste
var DELETE = "delete";              // remove the selection (leaves rests)
var VOICE_3 = "voice-3";            // move the selection to voice 3
var SLASH_RHYTHM = "slash-rhythm";  // Toggle rhythmic slash notation
var SLASH_FILL = "slash-fill";      // Fill with slashes

// Exposed for the Node test loader; QML reaches the constants by name directly.
var commandsLib = {
    COPY: COPY,
    PASTE: PASTE,
    DELETE: DELETE,
    VOICE_3: VOICE_3,
    SLASH_RHYTHM: SLASH_RHYTHM,
    SLASH_FILL: SLASH_FILL
};
