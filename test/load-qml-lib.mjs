import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load a MuseScore QML JavaScript library into Node the same way QML does an
// `import "x.js" as X`: the file's top-level function/var declarations form a
// namespace. Our libs end with `var JazzKitExports = { ... }` naming what to
// expose; we eval the source in a fresh scope and return that object.
//
// `globals` injects any MuseScore-ish globals a lib references (pure libs need
// none). This is exactly the seam a real unit test uses to hand in fakes.
export function loadQmlLib(relPath, globals = {}) {
    const src = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
    const names = Object.keys(globals);
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, src + "\n;return JazzKitExports;");
    return factory(...names.map((n) => globals[n]));
}
