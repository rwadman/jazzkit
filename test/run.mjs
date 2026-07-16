// Run all JazzKit unit tests: `node test/run.mjs` (or `npm test`).
import "./articulations.test.mjs";
import "./comp.test.mjs";
import "./jazzkit.test.mjs";
import "./linebreaks.test.mjs";
import "./slashes.test.mjs";
import { run } from "./harness.mjs";

run();
