// Stamp a passing harness run into harness/acceptance.json, fingerprinted with the
// current e2e source. Called automatically by scripts/e2e.sh after a green report,
// or by hand:  node scripts/e2e-accept.mjs <report-file>
// Refuses to stamp anything that isn't a clean pass, or a report that predates the
// code it would vouch for.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fingerprint, TRACKED } from "./e2e-fingerprint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const reportPath = process.argv[2];
if (!reportPath) { console.error("usage: e2e-accept.mjs <report-file>"); process.exit(2); }

const report = readFileSync(reportPath, "utf8").trim();
const summary = report.split("\n")[0];
if (!/^HARNESS PASSED/.test(summary) || /\bFAIL\b/.test(report)) {
    console.error("Refusing to record acceptance: report is not a clean pass.\n" + summary);
    process.exit(1);
}

// A leftover jazzkit-harness-report.txt from an earlier session would otherwise be
// stamped against TODAY's fingerprint — an acceptance record for a run that never
// happened. e2e.sh deletes stale reports before launching; this is the backstop for
// a hand-run (and it caught a real one once). The report must be at least as new as
// every file it vouches for.
const reportTime = statSync(reportPath).mtimeMs;
for (const rel of TRACKED) {
    const srcTime = statSync(join(ROOT, rel)).mtimeMs;
    if (srcTime > reportTime) {
        console.error(
            "Refusing to record acceptance: the report is older than the code it would\n" +
            "vouch for (" + rel + " changed after the run). Re-run scripts/e2e.sh."
        );
        process.exit(1);
    }
}

const record = {
    fingerprint: fingerprint(),
    recorded: new Date().toISOString().slice(0, 10),
    summary,
    report,
};
writeFileSync(join(ROOT, "harness/acceptance.json"), JSON.stringify(record, null, 2) + "\n");
console.log("Recorded acceptance (" + summary + ") → harness/acceptance.json");
console.log("Commit it so CI can verify the harness was run for this code.");
