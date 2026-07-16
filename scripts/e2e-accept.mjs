// Stamp a passing harness run into harness/acceptance.json, fingerprinted with the
// current e2e source. Called automatically by scripts/e2e.sh after a green report,
// or by hand:  node scripts/e2e-accept.mjs <report-file>
// Refuses to stamp anything that isn't a clean pass.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fingerprint } from "./e2e-fingerprint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const reportPath = process.argv[2];
if (!reportPath) { console.error("usage: e2e-accept.mjs <report-file>"); process.exit(2); }

const report = readFileSync(reportPath, "utf8").trim();
const summary = report.split("\n")[0];
if (!/^HARNESS PASSED/.test(summary) || /\bFAIL\b/.test(report)) {
    console.error("Refusing to record acceptance: report is not a clean pass.\n" + summary);
    process.exit(1);
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
