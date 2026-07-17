#!/usr/bin/env node
// Fast static sanity check for MuseScore plugin .qml files. There is no qmllint
// for MuseScore's QML dialect, and a syntax error only shows up as a silent
// no-op (or a terse line in MuseScore's log) at runtime - so catch the cheap
// mistakes here before syncing: unbalanced braces/parens, and missing required
// top-level MuseScore{} keys.
//
// Usage:  node scripts/check-qml.mjs JazzKit/*.qml
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  // MuseScore{} root. Only the brace/paren check applies.
  //
  // The JazzKit actions are extension "form" .qml (referenced by manifest.json):
  // a MuseScore{} root, but NO onRun (a form is loaded as a view — work runs from
  // Component.onCompleted / handlers) and NO menuPath (the manifest supplies the
  // menu entry). So we only require the MuseScore{} root here; menu wiring is
  // validated against manifest.json below.
  const isComponent = /(^|\/)lib\//.test(f);
  if (!isComponent) {
    if (!/\bMuseScore\s*\{/.test(src)) problems.push("no MuseScore{} root element");
  }

  if (problems.length) {
    bad++;
    console.log(`FAIL ${f}`);
    for (const p of problems) console.log(`   - ${p}`);
  } else {
    console.log(`ok   ${f}`);
  }
}

// Validate the extension manifest(s): the bundle's single manifest.json declares
// the menu actions and which .qml each maps to. A typo in a path silently drops
// the action, so verify JSON validity, required keys, and that every action file
// exists next to the manifest.
const manifests = new Set(
  files.map((f) => resolve(dirname(f), "manifest.json")).filter((m) => existsSync(m))
);
for (const m of manifests) {
  const rel = m.replace(resolve(".") + "/", "");
  const problems = [];
  let obj;
  try {
    obj = JSON.parse(readFileSync(m, "utf8"));
  } catch (e) {
    problems.push(`invalid JSON: ${e.message}`);
  }
  // A legacy plugin PACKAGE manifest (name/version/category, no uri/actions —
  // e.g. the dev harness) is not an extension bundle; skip the extension checks.
  if (obj && obj.actions === undefined && obj.uri === undefined) {
    console.log(`ok   ${rel} (legacy package manifest)`);
    continue;
  }
  if (obj) {
    if (!obj.uri) problems.push("missing `uri`");
    if (!obj.type) problems.push("missing `type`");
    if (obj.apiversion !== 1)
      problems.push("apiversion is not 1 (bare curScore/cmd/Settings need apiversion 1)");
    if (!Array.isArray(obj.actions) || obj.actions.length === 0) {
      problems.push("missing/empty `actions`");
    } else {
      for (const a of obj.actions) {
        if (!a.path) { problems.push(`action ${a.code || "?"}: missing \`path\``); continue; }
        if (!existsSync(resolve(dirname(m), a.path)))
          problems.push(`action ${a.code || a.path}: file not found (${a.path})`);
      }
    }
  }
  if (problems.length) {
    bad++;
    console.log(`FAIL ${rel}`);
    for (const p of problems) console.log(`   - ${p}`);
  } else {
    console.log(`ok   ${rel}`);
  }
}

process.exit(bad ? 1 : 0);
