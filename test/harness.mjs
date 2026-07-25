// Zero-dep test harness: no packages, no runner config, exits non-zero on failure.
// Kept in preference to `node --test` for the same reason as scripts/check-qml.mjs —
// the whole repo stays runnable with nothing but a Node binary, and the output format
// is ours. See package.json "engines" for the supported Node range.
import assert from "node:assert/strict";

const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export const eq = assert.deepStrictEqual;
export const ok = assert.ok;

export async function run() {
    let pass = 0, fail = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ok    ${name}`);
            pass++;
        } catch (e) {
            console.log(`  FAIL  ${name}\n        ${e.message}`);
            fail++;
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
}
