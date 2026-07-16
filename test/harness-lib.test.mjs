import { test, eq, ok } from "./harness.mjs";
import { loadQmlLib } from "./load-qml-lib.mjs";

const H = loadQmlLib("../JazzKit/lib/harness.js", "harnessLib");

test("newReport: empty tallies", () => {
    eq(H.newReport(), { cases: [], pass: 0, fail: 0, skip: 0 });
});

test("check: records pass/fail and returns the boolean", () => {
    const r = H.newReport();
    eq(H.check(r, "a", true, "d"), true);
    eq(H.check(r, "b", false), false);
    eq(H.check(r, "c", 0), false); // coerced
    eq(r.pass, 1);
    eq(r.fail, 2);
    eq(r.cases[0], { label: "a", status: "pass", detail: "d" });
    eq(r.cases[1], { label: "b", status: "fail", detail: "" });
});

test("skip: counts separately, never fails the run", () => {
    const r = H.newReport();
    H.skip(r, "x", "no fixture");
    eq(r.skip, 1);
    eq(r.pass, 0);
    eq(r.fail, 0);
    eq(r.cases[0], { label: "x", status: "skip", detail: "no fixture" });
});

test("format: any failure ⇒ FAILED header", () => {
    const r = H.newReport();
    H.check(r, "ok one", true);
    H.check(r, "bad one", false, "boom");
    const s = H.format(r);
    ok(s.startsWith("HARNESS FAILED — 1 failing."));
    ok(s.includes("OK   ok one"));
    ok(s.includes("FAIL bad one  (boom)"));
});

test("format: all pass (with skips) ⇒ PASSED header noting skips", () => {
    const r = H.newReport();
    H.check(r, "a", true);
    H.skip(r, "b");
    ok(H.format(r).startsWith("HARNESS PASSED — 1 ok, 1 skipped."));
});

test("format: nothing ran ⇒ INCONCLUSIVE", () => {
    ok(H.format(H.newReport()).startsWith("HARNESS INCONCLUSIVE"));
});
