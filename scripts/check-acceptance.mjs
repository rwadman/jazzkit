// CI gate: the GUI e2e harness can't run headless, so verify a passing run was
// RECORDED for the current code. Fails if harness/acceptance.json is missing, isn't
// a clean pass, or was stamped against different e2e source (someone changed the
// tested code without re-running scripts/e2e.sh). Node-only; run via `npm run e2e:check`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fingerprint, TRACKED } from "./e2e-fingerprint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) { console.error("E2E ACCEPTANCE CHECK FAILED\n" + msg); process.exit(1); }

let rec;
try {
    rec = JSON.parse(readFileSync(join(ROOT, "harness/acceptance.json"), "utf8"));
} catch {
    fail("harness/acceptance.json is missing or unreadable.\n"
        + "Run scripts/e2e.sh (GUI), then commit the acceptance stamp it writes.");
}

if (!/^HARNESS PASSED/.test(rec.summary || "") || /\bFAIL\b/.test(rec.report || ""))
    fail("Recorded acceptance is not a clean pass: " + (rec.summary || "(none)"));

const current = fingerprint();
if (rec.fingerprint !== current)
    fail("e2e-tested code changed since the last recorded harness run.\n"
        + "  recorded: " + rec.fingerprint + "\n"
        + "  current:  " + current + "\n"
        + "Re-run scripts/e2e.sh (GUI); it re-stamps harness/acceptance.json — commit that.\n"
        + "Fingerprinted surface:\n" + TRACKED.map(f => "  - " + f).join("\n"));

console.log("e2e acceptance OK — " + rec.summary + " (recorded " + rec.recorded + ")");
