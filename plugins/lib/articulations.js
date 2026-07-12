// Pure articulation classification for Fix Marcato Staccatos.
//
// No MuseScore API here. The .qml resolves each articulation on a chord to a
// canonical SymId *name* string (see _canonicalName there) and hands the list to
// classifyChord; every decision below is a plain function testable in Node. The
// .qml keeps the effects (hiding articulations, adding a hidden staccato).
//
//   QML:  import "lib/articulations.js" as Articulations

var MARCATO_ABOVE = ["articMarcatoAbove"];
var MARCATO_BELOW = ["articMarcatoBelow"];
var STACCATO_NAMES = [
    "articStaccatAbove", "articStaccatoAbove",
    "articStaccatBelow", "articStaccatoBelow",
    "articStaccat", "articStaccato"
];

function _hasAny(list, names) {
    for (var i = 0; i < names.length; i++)
        if (list.indexOf(names[i]) !== -1) return true;
    return false;
}

// names: canonical articulation symbol-name strings present on one chord.
// Returns the decision the plugin acts on.
function classifyChord(names) {
    names = names || [];
    var marcatoAbove = _hasAny(MARCATO_ABOVE, names);
    var marcatoBelow = _hasAny(MARCATO_BELOW, names);
    var hasMarcato = marcatoAbove || marcatoBelow;

    // Indices into `names` of existing staccatos — the .qml hides these in place.
    var staccatoIndices = [];
    for (var i = 0; i < names.length; i++)
        if (STACCATO_NAMES.indexOf(names[i]) !== -1) staccatoIndices.push(i);

    return {
        marcatoAbove: marcatoAbove,
        marcatoBelow: marcatoBelow,
        hasMarcato: hasMarcato,
        staccatoIndices: staccatoIndices,
        // A marcato chord with no staccato yet needs a hidden one added.
        needsStaccato: hasMarcato && staccatoIndices.length === 0,
        // Prefer the above/below variant matching the marcato placement.
        addAbove: marcatoAbove
    };
}

var JazzKitExports = {
    MARCATO_ABOVE: MARCATO_ABOVE,
    MARCATO_BELOW: MARCATO_BELOW,
    STACCATO_NAMES: STACCATO_NAMES,
    classifyChord: classifyChord
};
