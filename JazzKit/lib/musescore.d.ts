// Ambient type model of the slice of the MuseScore 4 plugin API that JazzKit's
// pure libs consume. NOT authoritative — MuseScore ships no TypeScript types, so
// this encodes *our verified understanding*; grep the MuseScore source
// (scripts/fetch-mscore-src.sh) before trusting a shape you haven't exercised.
// See .claude/skills/musescore-plugin-dev/reference/api-gotchas.md.
//
// It's a `declare namespace` (ambient, global) so the libs reference `MS.Score`
// etc. from JSDoc without an import. QML never sees this file; it only shapes the
// `npm run typecheck` pass. The libs still take these objects as *parameters*
// (the proven DI pattern) — a QML-imported stateless .js can't see MuseScore
// globals at runtime, so we never reference them as free globals here.

declare namespace MS {
    /** A part/instrument. Absolute staff index = Math.floor(startTrack / 4). */
    interface Part {
        instrumentId?: string;
        /** First track of the part; /4 gives the top staff index. */
        startTrack: number;
        /** One past the last track (exclusive); /4 gives the staff past the part. */
        endTrack: number;
        longName?: string;
        partName?: string;
        hasDrumStaff?: boolean;
    }

    /** curScore.selection. selectRange's endTick/endStaff are exclusive. */
    interface Selection {
        selectRange(startTick: number, endTick: number, startStaff: number, endStaff: number): void;
        isRange?: boolean;
        startStaff?: number;
    }

    /** A part's private score, carrying its own metatags. */
    interface Excerpt {
        partScore?: Score | null;
    }

    /** curScore (and, recursively, each excerpt's partScore). */
    interface Score {
        selection: Selection;
        parts: Part[];
        excerpts?: Excerpt[];
        metaTag(tag: string): string;
        setMetaTag(tag: string, value: string): void;
        // Staff count — MuseScore versions spell it several ways (see countStaves).
        nstaves?: number;
        nStaves?: number;
        staffCount?: number;
        staves?: { length: number };
        newCursor(): Cursor;
        firstMeasure: Measure | null;
        lastSegment: Segment;
        /** Wrap a single logical edit; never nest cmd()s inside (see api-gotchas). */
        startCmd(): void;
        endCmd(): void;
    }

    /** A note-input / read cursor (curScore.newCursor()). Only the members the
     *  effect layer touches are modelled. Set staffIdx/voice BEFORE a rewind. */
    interface Cursor {
        /** rewind(mode): 0 SCORE_START, 1 SELECTION_START, 2 SELECTION_END. */
        rewind(mode: number): void;
        rewindToTick(tick: number): void;
        staffIdx: number;
        voice: number;
        tick: number;
        element: Element | null;
        segment: Segment | null;
        measure: Measure | null;
        next(): boolean;
        /** Attach an element (e.g. a hidden articulation) at the cursor. */
        add(element: any): void;
    }

    interface Measure {
        firstSegment: Segment | null;
        nextMeasure: Measure | null;
        /** Nominal time signature of the measure. */
        timesigNominal: { numerator: number; denominator: number; ticks: number };
    }

    interface Segment {
        tick: number;
        /** Segment.ChordRest etc. — compared against the QML Segment enum. */
        segmentType: number;
        nextInMeasure: Segment | null;
        elementAt(track: number): Element | null;
    }

    /** A score element (chord, rest, …) as reached via a segment/cursor. */
    interface Element {
        /** Element.CHORD / Element.REST etc. — compared against the QML Element enum. */
        type: number;
        duration: { ticks: number };
        /** Cue size ("Whether this element is cue size"). */
        small?: boolean;
        /** Notes of a chord (Element.CHORD). */
        notes?: Note[];
        /** Articulations attached to a chord. */
        articulations?: Articulation[];
    }

    /** A note within a chord. */
    interface Note {
        small?: boolean;
    }

    /** A SymId enum value — a number in current MuseScore, sometimes a name string. */
    type SymIdValue = number | string;

    /** The SymId enum table (only the names JazzKit references). */
    interface SymId {
        articMarcatoAbove: SymIdValue;
        articMarcatoBelow: SymIdValue;
        articStaccatAbove: SymIdValue;
        articStaccatoAbove: SymIdValue;
        articStaccatBelow: SymIdValue;
        articStaccatoBelow: SymIdValue;
        articStaccat: SymIdValue;
        articStaccato: SymIdValue;
    }

    /** A note articulation. `.symbol` is a SymId value or, on some versions, its name. */
    interface Articulation {
        symbol?: SymIdValue;
        hidden?: boolean;
        visible?: boolean;
        toString(): string;
    }
}
