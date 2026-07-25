// @ts-check
// Pure articulation classification for Fix Marcato Staccatos.
//
// No MuseScore API here: effects.js resolves each articulation to a canonical
// SymId *name* string (canonicalName/chordNames, below) and classifyChord decides
// from those names alone; effects.js keeps the mutations.

/**
 * The decision the Fix Marcato Staccatos plugin acts on for one chord.
 * @typedef {Object} Classification
 * @property {boolean} hasMarcato
 * @property {number[]} staccatoIndices   Indices into the input names of existing staccatos
 *                                        (empty on a marcato chord = one must be added).
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

    // Indices into `names` of existing staccatos — effects.js hides these in place.
    /** @type {number[]} */
    var staccatoIndices = [];
    for (var i = 0; i < names.length; i++)
        if (STACCATO_NAMES.indexOf(names[i]) !== -1) staccatoIndices.push(i);

    return {
        hasMarcato: marcatoAbove || marcatoBelow,
        staccatoIndices: staccatoIndices,
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

// Export trailer — MANDATORY, see api-gotchas "macros actions".
if (typeof exports !== "undefined") { exports = articulationsLib; }
