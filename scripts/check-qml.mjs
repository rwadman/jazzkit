#!/usr/bin/env node
// Fast static sanity check for MuseScore plugin .qml files. There is no qmllint
// for MuseScore's QML dialect, and a syntax error only shows up as a silent
// no-op (or a terse line in MuseScore's log) at runtime - so catch the cheap
// mistakes here before syncing: unbalanced braces/parens, and missing required
// top-level MuseScore{} keys.
//
// Usage:  node scripts/check-qml.mjs plugins/*.qml
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node check-qml.mjs <file.qml> [more.qml ...]");
  process.exit(2);
}

// Count a character outside of // line comments and "double-quoted" strings.
function counts(src) {
  let brace = 0, paren = 0, inStr = false, inCmt = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inCmt) { if (c === "\n") inCmt = false; continue; }
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === "/" && n === "/") { inCmt = true; i++; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") brace++; else if (c === "}") brace--;
    else if (c === "(") paren++; else if (c === ")") paren--;
  }
  return { brace, paren };
}

let bad = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const { brace, paren } = counts(src);
  const problems = [];
  if (brace !== 0) problems.push(`unbalanced braces (${brace > 0 ? "+" : ""}${brace})`);
  if (paren !== 0) problems.push(`unbalanced parens (${paren > 0 ? "+" : ""}${paren})`);

  // Files under lib/ are reusable QML components, not plugins - they have no
  // MuseScore{} root, menuPath, or onRun. Only the brace/paren check applies.
  const isComponent = /(^|\/)lib\//.test(f);
  if (!isComponent) {
    if (!/\bMuseScore\s*\{/.test(src)) problems.push("no MuseScore{} root element");
    // menuPath is what nests the plugin under a submenu; warn if a titled plugin lacks it.
    if (/\btitle\s*:/.test(src) && !/\bmenuPath\s*:/.test(src))
      problems.push("has title: but no menuPath: (won't nest in a submenu)");
    if (!/\bonRun\s*:/.test(src)) problems.push("no onRun: handler");
  }

  if (problems.length) {
    bad++;
    console.log(`FAIL ${f}`);
    for (const p of problems) console.log(`   - ${p}`);
  } else {
    console.log(`ok   ${f}`);
  }
}
process.exit(bad ? 1 : 0);
