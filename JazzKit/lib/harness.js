// @ts-check
// Tiny assertion + reporting helpers for test_harness.qml. Pure (no MuseScore API),
// so it IS Node-unit-tested (test/harness-lib.test.mjs). The harness .qml does the
// GUI-only part (select/effect/read-back); this just tallies and formats results.
//
//   import "lib/harness.js" as H
//   var r = H.newReport();
//   H.check(r, "pitch rose", n1 === n0 + 1, "got " + n1);
//   H.skip(r, "needs empty measure");
//   infoDialog.show(H.format(r));

/** @typedef {{label:string, status:"pass"|"fail"|"skip", detail:string}} Case */
/** @typedef {{cases:Case[], pass:number, fail:number, skip:number}} Report */

/** @returns {Report} */
function newReport() {
    return { cases: [], pass: 0, fail: 0, skip: 0 };
}

/**
 * Record a checked assertion.
 * @param {Report} r
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 * @returns {boolean} ok (so callers can gate follow-up steps)
 */
function check(r, label, ok, detail) {
    ok = !!ok;
    r.cases.push({ label: label, status: ok ? "pass" : "fail", detail: detail || "" });
    if (ok) { r.pass++; } else { r.fail++; }
    return ok;
}

/**
 * Record a case that couldn't run (e.g. the fixture lacks what it needs). Skips
 * don't fail the run, but they aren't successes — the summary calls them out.
 * @param {Report} r
 */
function skip(r, label, detail) {
    r.cases.push({ label: label, status: "skip", detail: detail || "" });
    r.skip++;
}

/** @param {Report} r @returns {string} one line per case + a summary header. */
function format(r) {
    var mark = { pass: "OK  ", fail: "FAIL", skip: "SKIP" };
    var head;
    if (r.fail > 0) { head = "HARNESS FAILED — " + r.fail + " failing."; }
    else if (r.pass === 0) { head = "HARNESS INCONCLUSIVE — nothing ran."; }
    else { head = "HARNESS PASSED — " + r.pass + " ok" + (r.skip ? ", " + r.skip + " skipped" : "") + "."; }

    var lines = [head, ""];
    for (var i = 0; i < r.cases.length; ++i) {
        var c = r.cases[i];
        lines.push(mark[c.status] + " " + c.label + (c.detail ? "  (" + c.detail + ")" : ""));
    }
    return lines.join("\n");
}

// Exposed for the Node test loader; QML reaches the functions by name directly.
var harnessLib = {
    newReport: newReport,
    check: check,
    skip: skip,
    format: format
};
