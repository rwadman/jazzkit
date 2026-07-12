// Zero-dep test harness (Node 16 has no built-in `node --test`). Same spirit as
// scripts/check-qml.mjs: tiny, no packages, exits non-zero on failure.
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
