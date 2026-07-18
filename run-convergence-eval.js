// CONVERGENCE EVALUATOR — read-only. Reads the birth samples in data/listing-watch.json and reports
// who moves toward whom. Writes data/convergence-eval.json. It NEVER touches a forecast, a decision, or
// an alert, and it REFUSES a verdict below the minimum sample.
//
//   node run-convergence-eval.js [--min-events=20] [--write]
require("./lib/env");
const fs = require("fs");
const path = require("path");
const C = require("./lib/convergence");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

function main() {
  const src = path.join(__dirname, "data", "listing-watch.json");
  if (!fs.existsSync(src)) fail("data/listing-watch.json not found — nothing to evaluate");
  const state = JSON.parse(fs.readFileSync(src, "utf8"));
  const minEvents = Number(arg("min-events") || 20);
  const write = process.argv.includes("--write");

  const v = C.evaluate(state, { minEvents });
  say(`[convergence] ${v.genuineBirthEvents} genuine birth event(s), ${v.usableEvents} usable (min ${v.minEventsForVerdict})`);
  say(`[convergence] ${v.ready ? "VERDICT READY" : "NOT READY"}`);
  say(`[convergence] ${v.finding}`);
  for (const e of v.events) {
    if (!e.usable) { say(`   - ${e.key}: (unusable) ${e.reason}`); continue; }
    say(`   - ${e.key}: birth ask ${(e.birthAsk * 100).toFixed(0)}c, gap ${(e.birthGap * 100).toFixed(1)}%, ` +
        `${e.samples} samples, moved-farther=${e.whoMovedFarther}, converged=${e.convergedBy}` +
        `${e.edgeSurvivedCost == null ? "" : `, edge-after-cost=${e.edgeSurvivedCost ? "YES" : "no"}`}`);
  }

  if (!write) { say(`\n  (read-only report. Re-run with --write to save data/convergence-eval.json)`); return 0; }
  const out = path.join(__dirname, "data", "convergence-eval.json");
  const tmp = out + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...v, ranAt: new Date().toISOString(), note: "READ-ONLY research. Not connected to any live decision." }, null, 2));
  fs.renameSync(tmp, out);
  say(`\n  wrote data/convergence-eval.json`);
  return 0;
}

const c = main();
if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); }
process.exit(c || 0);
