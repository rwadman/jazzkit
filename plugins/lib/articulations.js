// @ts-check
// Pure articulation classification for Fix Marcato Staccatos.
//
// No MuseScore API here. The .qml resolves each articulation on a chord to a
// canonical SymId *name* string (see _canonicalName there) and hands the list to
// classifyChord; every decision below is a plain function testable in Node. The
// .qml keeps the effects (hiding articulations, adding a hidden staccato).
//
//   QML:  import "lib/articulations.js" as Articulations

/**
 * The decision the Fix Marcato Staccatos plugin acts on for one chord.
 * @typedef {Object} Classification
 * @property {boolean} marcatoAbove
 * @property {boolean} marcatoBelow
 * @property {boolean} hasMarcato
 * @property {number[]} staccatoIndices   Indices into the input names of existing staccatos.
 * @property {boolean} needsStaccato      Marcato present but no staccato yet.
 * @property {boolean} addAbove           Prefer the above (vs below) staccato variant.
 */

/**
 * Read the raw symbol off an articulation: its `.symbol` (a SymId value or a
 * name string, version-dependent) or, failing that, its string form.
 * @param {MS.Articulation|null|undefined} a
 * @returns {MS.SymIdValue}
 */
function articSymbol(a) {
    if (!a) return "";
    return a.symbol !== undefined ? a.symbol : (a.toString ? a.toString() : "");
}

/**
 * Resolve an articulation to a canonical SymId *name* string. `.symbol` may be a
 * name string already or a numeric SymId enum value; map the latter via the
 * injected SymId table. (SymId is a MuseScore global the .qml sees but a
 * stateless JS library does not — so the .qml passes it in.)
 * @param {MS.SymId} symId
 * @param {MS.Articulation|null|undefined} a
 * @returns {string}
 */
function canonicalName(symId, a) {
    if (!a) return "";
    var s = articSymbol(a);
    if (typeof s === "string") return s;
    if (s === symId.articMarcatoAbove) return "articMarcatoAbove";
    if (s === symId.articMarcatoBelow) return "articMarcatoBelow";
    if (s === symId.articStaccatAbove) return "articStaccatAbove";
    if (s === symId.articStaccatoAbove) return "articStaccatoAbove";
    if (s === symId.articStaccatBelow) return "articStaccatBelow";
    if (s === symId.articStaccatoBelow) return "articStaccatoBelow";
    return "" + s;
}

/**
 * Canonical names of every articulation on a chord, in order.
 * @param {MS.SymId} symId
 * @param {MS.Articulation[]} articulations
 * @returns {string[]}
 */
function chordNames(symId, articulations) {
    /** @type {string[]} */
    var names = [];
    for (var i = 0; i < articulations.length; i++) names.push(canonicalName(symId, articulations[i]));
    return names;
}

/**
 * Ordered SymId candidates to try when adding a hidden staccato: the placement-
 * specific variants first, then the generic ones. (SymId injected — see above.)
 * @param {MS.SymId} symId
 * @param {boolean} wantAbove
 * @returns {MS.SymIdValue[]}
 */
function staccatoCandidates(symId, wantAbove) {
    if (wantAbove) return [symId.articStaccatAbove, symId.articStaccatoAbove, symId.articStaccat, symId.articStaccato];
    return [symId.articStaccatBelow, symId.articStaccatoBelow, symId.articStaccat, symId.articStaccato];
}

var MARCATO_ABOVE = ["articMarcatoAbove"];
var MARCATO_BELOW = ["articMarcatoBelow"];
var STACCATO_NAMES = [
    "articStaccatAbove", "articStaccatoAbove",
    "articStaccatBelow", "articStaccatoBelow",
    "articStaccat", "articStaccato"
];

/**
 * @param {string[]} list
 * @param {string[]} names
 * @returns {boolean}
 */
function _hasAny(list, names) {
    for (var i = 0; i < names.length; i++)
        if (list.indexOf(names[i]) !== -1) return true;
    return false;
}

/**
 * Classify one chord from the canonical symbol-name strings present on it.
 * @param {string[]} [names]
 * @returns {Classification}
 */
function classifyChord(names) {
    names = names || [];
    var marcatoAbove = _hasAny(MARCATO_ABOVE, names);
    var marcatoBelow = _hasAny(MARCATO_BELOW, names);
    var hasMarcato = marcatoAbove || marcatoBelow;

    // Indices into `names` of existing staccatos — the .qml hides these in place.
    /** @type {number[]} */
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

// Exposed for the Node test loader; QML reaches the functions by name directly.
var articulationsLib = {
    MARCATO_ABOVE: MARCATO_ABOVE,
    MARCATO_BELOW: MARCATO_BELOW,
    STACCATO_NAMES: STACCATO_NAMES,
    articSymbol: articSymbol,
    canonicalName: canonicalName,
    chordNames: chordNames,
    staccatoCandidates: staccatoCandidates,
    classifyChord: classifyChord
};
