// Named types for JazzKit's OWN data shapes — the plain-data DTOs the pure libs
// pass to each other and hand back to the .qml. (musescore.d.ts is the companion
// file for the EXTERNAL MuseScore API; this one is ours, so it IS authoritative:
// every shape here has a constructor in JazzKit/lib/*.js that tsc checks against
// it, so a drifting field is a build error, not stale prose.)
//
// A `declare namespace` (ambient, global) so the libs reference `JK.Region` from
// JSDoc without an import — same pattern as `MS.`. Type-only: QML never loads a
// .d.ts, and sync.sh strips lib/*.d.ts from the deployed bundle.
//
// What lives here vs. in a lib's own `@typedef`: a shape used by MORE THAN ONE
// file (or by an interface below) needs one name both sides can say, so it goes
// here. A shape private to one lib — linebreaks' Box/Line, effects' SourceCR,
// harness' Report — stays a local @typedef next to the code that builds it.

declare namespace JK {
    /** A QML enum object (Element, Segment, Direction, NoteHeadGroup, …) as passed
     *  into a lib: member name → its numeric value, e.g. `Element.CHORD`. Indexable
     *  because effects.js looks members up by name (`Accidental[typeName]`). */
    interface QmlEnum {
        [member: string]: number;
    }

    // --- rhythm and regions (slashes.js ⇄ effects.js) ------------------------

    /** One rest segment in voice 1: its start tick and duration in ticks. */
    interface Rest {
        tick: number;
        durTicks: number;
    }

    /** A measure reduced to what region-finding needs. */
    interface MeasureRests {
        /** Tick of the measure's first segment. */
        mStart: number;
        numerator: number;
        denominator: number;
        /** Total ticks in the measure (timesig.ticks). */
        measureTicks: number;
        /** Voice-1 rest segments, in order. */
        rests: Rest[];
    }

    /** A half-open tick span [start, end) — a run of empty beats to fill. */
    interface Region {
        start: number;
        end: number;
    }

    /** A duration as the fraction-of-a-whole-note cursor.setDuration takes. */
    interface Fraction {
        z: number;
        n: number;
    }

    // --- accidentals (accidentals.js ⇄ effects.js) ---------------------------

    /** One note as planStaff sees it. */
    interface NoteData {
        pitch: number;
        /** Written tpc (the spelling shown on this staff). */
        tpc: number;
        /** Concert-pitch tpc. */
        tpc1: number;
        /** An accidental is currently engraved on it. */
        hasAccidental: boolean;
        /** Continuation of a tie (never needs one). */
        tiedBack?: boolean;
    }

    /** One measure of one staff: its key signature and its notes in tick/track
     *  order (grace notes before the chord they decorate, all voices merged). */
    interface MeasureData {
        keySig: number;
        notes: NoteData[];
    }

    /** What to do with one note. `index` is its position in the flattened note
     *  stream, so the caller can pair a decision back with the live API object. */
    interface AccidentalDecision {
        index: number;
        action: "add" | "remove";
        /** Accidental enum member name (adds only). */
        accidentalType?: string;
        /** True when the add is a reminder, not required. */
        courtesy?: boolean;
    }

    /** A note's octave-qualified letter class ("F4") and its spelling ("F#"). */
    interface NoteClass {
        noteClass: string;
        noteName: string;
    }

    // --- articulations (articulations.js ⇄ effects.js) -----------------------

    /** The decision Fix Marcato Staccatos acts on for one chord. */
    interface Classification {
        hasMarcato: boolean;
        /** Indices into the input names of existing staccatos (empty on a marcato
         *  chord = one must be added). */
        staccatoIndices: number[];
        /** Prefer the above (vs below) staccato variant. */
        addAbove: boolean;
    }

    // --- line breaks (linebreaks.js) -----------------------------------------

    /** A run of real measures that shows as one box on the page (a multirest is
     *  one box spanning several), as indices into the input measure list. */
    interface BoxGroup {
        firstIdx: number;
        lastIdx: number;
        musicBars: number;
    }

    // --- selection and targets (jazzkit.js ⇄ effects.js ⇄ .qml) --------------

    /** One staff a comp action writes into. */
    interface TargetSpec {
        staffIdx: number;
        isDrum: boolean;
    }

    /** What the target picker hands back: the ids to remember, and the rows to write. */
    interface SelectedTargets {
        ids: string[];
        targets: TargetSpec[];
    }

    /** The selection capture every range-based action starts with. The optional
     *  fields are present exactly when `ok` is true. */
    interface SelectionRange {
        ok: boolean;
        error?: string;
        selStart?: number;
        /** Exclusive. */
        selEnd?: number;
        /** Start of the measure containing selStart — the writers rewind there. */
        measureTick?: number;
        staffIdx?: number;
    }

    /** The Autofix macro's options, persisted in a score metatag. */
    interface AutofixSettings {
        marcato: boolean;
        courtesy: boolean;
        bracket: number;
    }

    // --- effect inputs and results (effects.js ⇄ .qml) -----------------------

    /** The source region a comp action copies from. */
    interface CompRegion {
        selStart: number;
        /** Exclusive. */
        selEnd: number;
        measureTick: number;
        srcStaffIdx: number;
    }

    /** compCuesNotes: needs `isDrum` per row, to route drum targets to the cue
     *  writer instead of the pitched one. */
    interface CompParams extends CompRegion {
        targets: TargetSpec[];
    }

    /** compSlashesNotes: `isDrum` is irrelevant (the slash writer picks a valid
     *  drum pitch itself), so a row may also be a bare staff index. */
    interface SlashParams extends CompRegion {
        targets: Array<TargetSpec | number>;
    }

    interface CompResult {
        targetsDone: number;
        error: string;
    }

    interface FillResult {
        regions: number;
        filled: number;
        /** A region could not be written (no usable pitch / bad cursor landing). */
        selectFailed: boolean;
    }

    interface StaccatoResult {
        added: number;
        hidden: number;
    }

    interface CourtesyResult {
        added: number;
        removed: number;
        /** Writes rolled back because they would have moved the pitch. */
        skipped: number;
    }

    interface LineBreakResult {
        removed: number;
        added: number;
    }

    // --- the sibling libs injected into an effect's ctx ----------------------
    // A QML-imported .js can't see its siblings, so effects.js receives them on
    // `ctx`. Typing them here is what makes a signature change in one lib break
    // the caller in the other, instead of passing silently through an `any`.

    interface JazzKitLib {
        countStaves(score: MS.Score): number;
    }

    interface SlashesLib {
        beatTicks(numerator: number, denominator: number, measureTicks: number): number;
        emptyRestRegions(measures: MeasureRests[], selStart: number, selEnd: number): Region[];
    }

    interface ArticulationsLib {
        chordNames(symId: MS.SymId, articulations: MS.Articulation[]): string[];
        classifyChord(names?: string[]): Classification;
        staccatoCandidates(symId: MS.SymId, wantAbove: boolean): MS.SymIdValue[];
    }

    interface AccidentalsLib {
        planStaff(measures: MeasureData[]): AccidentalDecision[];
    }
}
