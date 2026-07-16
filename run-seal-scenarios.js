// SEAL THE RANKED SCENARIOS — before any outcome is loaded.
//
//   node run-seal-scenarios.js <forecast.json> <evidence-eval.json> [--out=path]
//
// The ranking must be fixed BEFORE results are known or the evaluation is theatre. This script
// cannot load an outcome: it requires no results file and imports none. It writes a hashed artifact
// that the evaluator reads back and verifies.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const R = require("./lib/scenarios-ranked");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

function main() {
  const fPath = process.argv[2], ePath = process.argv[3];
  const outArg = (process.argv.find((a) => a.startsWith("--out=")) || "").split("=")[1];
  if (!fPath || !ePath) fail("usage: node run-seal-scenarios.js <forecast.json> <evidence-eval.json>");
  for (const p of [fPath, ePath]) if (!fs.existsSync(p)) fail(`not found: ${p}`);

  const fc = JSON.parse(fs.readFileSync(fPath, "utf8"));
  const ev = JSON.parse(fs.readFileSync(ePath, "utf8"));
  say(`[stage 1] ${fc.card.eventId}: ${fc.forecasts.length} sealed forecasts, rules v${fc.rulesVersion}`);

  say(`[stage 2] ranking paths from the SEALED outcome tree (no new numbers) ...`);
  const out = {};
  let incoherent = 0, noTree = 0, roles = { PRIMARY: 0, SECONDARY: 0, UPSET_OR_ALTERNATIVE: 0, DOWNWEIGHTED: 0 };
  for (const f of fc.forecasts) {
    const [A, B] = f.fight.split(" vs ");
    const be = ev.bouts.find((b) => b.boutId === f.boutId);
    const r = R.rankedScenariosFor(be, f, A, B);
    if (!r.scenarios.length) { noTree++; out[f.boutId] = { scenarios: [], coherence: r.coherence, note: "no forecast tree — nothing to rank" }; continue; }
    if (!r.coherence.ok) { incoherent++; say(`    INCOHERENT ${f.fight}: ${r.coherence.errors.join("; ")}`); }
    for (const s of r.scenarios) roles[s.role]++;
    out[f.boutId] = r;
  }
  // A scenario set that contradicts the sealed tree is worse than none: it reads as the model's
  // belief while disagreeing with it. Refuse rather than seal it.
  if (incoherent) fail(`${incoherent} bout(s) produced shares incoherent with the sealed outcome tree`);
  say(`[stage 2] ranked ${fc.forecasts.length - noTree} bouts (${noTree} had no tree: BASELINE UNAVAILABLE)`);
  say(`[stage 2] roles: ${Object.entries(roles).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  say(`[stage 2] coherence: every ranked set reconciles with its sealed tree`);

  // leakage sweep: no scenario may contain retrospective language
  const RETRO = require("./lib/leakage-guard").RETRO;
  const leaky = Object.values(out).flatMap((x) => x.scenarios || []).filter((s) => RETRO.test(JSON.stringify(s)));
  if (leaky.length) fail(`${leaky.length} scenario(s) contain retrospective language`);
  say(`[stage 3] leakage sweep: 0 scenarios contain retrospective language`);

  const outPath = outArg || fPath.replace(/forecast-/, "scenarios-ranked-");
  const payload = {
    card: fc.card, sealedForecastAt: fc.sealedAt, scenariosSealedAt: new Date().toISOString(),
    module: "scenarios-ranked@1.0.0", rulesVersion: fc.rulesVersion,
    references: { numericalForecastHash: fc.sealHash, numericalForecastFile: path.basename(fPath) },
    scenarios: out,
    immutable: true,
    outcomesLoaded: false,
  };
  payload.scenarioSetHash = R.sha(payload);
  writeJson(outPath, payload);
  if (!fs.existsSync(outPath)) fail(`not written: ${outPath}`);
  say(`\n[stage 4] SEALED: ${outPath}`);
  say(`           scenarioSetHash = ${payload.scenarioSetHash}`);
  say(`           (no outcomes were loaded by this script)`);
  return 0;
}
try { const c = main(); if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); }
catch (e) { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); }
