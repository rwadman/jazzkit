// Fingerprint of the exact source the GUI e2e harness (harness/test_harness.qml)
// exercises: the effect layer + pure libs it drives, the harness itself, and the
// fixture it runs against. CI can't run the harness (no headless MuseScore), so it
// compares this fingerprint against the one recorded in harness/acceptance.json —
// if the tested code changed without a fresh recorded run, CI fails. Node-only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The surface whose behaviour the harness verifies. Keep in sync with what the
// harness actually drives (Effects.* + the pure libs), plus the test and fixture.
// NOT the shipping .qml plugins — the harness tests the effect layer, not the glue.
export const TRACKED = [
    "harness/test_harness.qml",
    "harness/fixtures/blank.mscz",
    "JazzKit/lib/effects.js",
    "JazzKit/lib/articulations.js",
    "JazzKit/lib/linebreaks.js",
    "JazzKit/lib/slashes.js",
    "JazzKit/lib/jazzkit.js",
];

export function fingerprint() {
    const h = createHash("sha256");
    for (const rel of TRACKED) {
        h.update(rel + "\0");
        h.update(readFileSync(join(ROOT, rel)));
        h.update("\0");
    }
    return "sha256:" + h.digest("hex");
}

// `node scripts/e2e-fingerprint.mjs` prints the current fingerprint.
if (import.meta.url === `file://${process.argv[1]}`) console.log(fingerprint());
