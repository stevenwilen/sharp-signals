// PHASE 7 COMPLETION — scenarios + CAP LIMITED labels + a sealed, hash-linked artifact.
//
//   node run-phase7-seal.js <forecast.json> <evidence-eval.json> [--out=path]
//
// NO OUTCOMES ARE LOADED HERE. This runs before results are opened; it must never require a results
// file. Scenarios explain the already-sealed numbers and cannot change them — the numeric forecast
// is read, never recomputed.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const S = require("./lib/scenarios");
const F = require("./lib/forecast");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);

async function main() {
  const fPath = process.argv[2], ePath = process.argv[3];
  const outArg = (process.argv.find((a) => a.startsWith("--out=")) || "").split("=")[1];
  say(`[stage 1] loading sealed artifacts (no outcomes) ...`);
  if (!fPath || !ePath) fail("usage: node run-phase7-seal.js <forecast.json> <evidence-eval.json>");
  for (const p of [fPath, ePath]) if (!fs.existsSync(p)) fail(`not found: ${p}`);
  const fc = JSON.parse(fs.readFileSync(fPath, "utf8"));
  const ev = JSON.parse(fs.readFileSync(ePath, "utf8"));
  if (!fc.forecasts || !ev.bouts) fail("inputs are not a forecast + evidence-eval pair");
  say(`[stage 1] ${fc.card.eventId}: ${fc.forecasts.length} sealed forecasts, rules v${fc.rulesVersion}`);

  say(`[stage 2] labelling CAP LIMITED forecasts + recording cap detail ...`);
  const capped = [];
  for (const f of fc.forecasts) {
    if (!f.capNote) { f.capLimited = false; continue; }
    f.capLimited = true;
    const A = f.fight.split(" vs ")[0];
    const applied = f.appliedAdjustments || [];
    // uncapped: what the evidence asked for before any ceiling
    const uncappedNet = applied.reduce((a, x) => a + (x.fighterFavored === A ? +x.finalAppliedLogOdds : -x.finalAppliedLogOdds), 0);
    const pMkt = f.marketBaseline.probability;
    const pUncapped = F.sig(F.logit(F.clamp(pMkt)) + uncappedNet);
    // what happens if the single strongest mechanism is removed
    const strongest = applied.slice().sort((a, b) => b.finalAppliedLogOdds - a.finalAppliedLogOdds)[0];
    const netMinus = applied.filter((x) => x !== strongest)
      .reduce((a, x) => a + (x.fighterFavored === A ? +x.finalAppliedLogOdds : -x.finalAppliedLogOdds), 0);
    const pMinus = F.sig(F.logit(F.clamp(pMkt)) + Math.max(-F.RULES.caps.totalLogOddsPerFighter, Math.min(F.RULES.caps.totalLogOddsPerFighter, netMinus)));
    const mechs = [...new Set(applied.map((x) => x.mechanism))];
    f.capDetail = {
      uncappedLogOdds: +uncappedNet.toFixed(4),
      uncappedProbability: +pUncapped.toFixed(4),
      appliedCaps: f.capNote,
      finalProbability: f.systemCentral[A],
      mechanismsResponsible: mechs,
      causedBySingleMechanism: applied.filter((x) => x.finalAppliedLogOdds >= F.RULES.magnitudeClasses.MAJOR).length === 1 && mechs.length === 1,
      probabilityWithoutStrongestMechanism: +pMinus.toFixed(4),
      strongestMechanism: strongest ? strongest.mechanism : null,
    };
    capped.push(f);
  }
  say(`[stage 2] CAP LIMITED: ${capped.length}/${fc.forecasts.length}`);
  for (const f of capped) {
    say(`    ${f.fight}: uncapped ${(f.capDetail.uncappedProbability * 100).toFixed(1)}% -> final ` +
      `${(f.capDetail.finalProbability * 100).toFixed(1)}% | ${f.capDetail.mechanismsResponsible.length} mechanism(s) ` +
      `(${f.capDetail.causedBySingleMechanism ? "single" : "several"}) | without strongest: ${(f.capDetail.probabilityWithoutStrongestMechanism * 100).toFixed(1)}%`);
  }

  say(`\n[stage 3] building scenarios from PRE-FIGHT evidence only ...`);
  const scenarios = {};
  let generic = 0, total = 0;
  for (const f of fc.forecasts) {
    const be = ev.bouts.find((b) => b.boutId === f.boutId);
    const [A, B] = f.fight.split(" vs ");
    const sc = S.scenariosFor(be, f, A, B);
    scenarios[f.boutId] = sc;
    total += sc.length;
    if (sc.some((x) => x.generic)) generic++;
  }
  say(`[stage 3] ${total} scenarios across ${fc.forecasts.length} bouts (${generic} bouts got the clearly-labelled generic set)`);
  // leakage sweep over the scenario text itself
  const RETRO = require("./lib/leakage-guard").RETRO;
  const leaky = Object.values(scenarios).flat().filter((s) => RETRO.test(JSON.stringify(s)));
  if (leaky.length) fail(`${leaky.length} scenario(s) contain retrospective language — a path written with knowledge of the result`);
  say(`[stage 3] leakage sweep: 0 scenarios contain retrospective language`);

  say(`\n[stage 4] sealing the completed Phase 7 artifact ...`);
  const out = outArg || fPath.replace(/forecast-/, "phase7-");
  const payload = {
    card: fc.card, phase: 7, completedAt: new Date().toISOString(),
    sealedForecastAt: fc.sealedAt,
    references: {
      numericalForecastHash: fc.sealHash,
      numericalForecastFile: path.basename(fPath),
      scenarioHash: sha(scenarios),
      evidenceHash: sha(ev.bouts),
      marketSnapshotHash: sha(fc.forecasts.map((f) => f.marketBaseline)),
      engineVersion: "phase7-engine-1.0.0",
      ruleConfigVersion: fc.rulesVersion,
    },
    capLimited: capped.map((f) => ({ boutId: f.boutId, fight: f.fight, ...f.capDetail })),
    forecasts: fc.forecasts, scenarios,
    immutable: true,
  };
  payload.completedHash = sha(payload);
  if (fs.existsSync(out)) {
    const prior = JSON.parse(fs.readFileSync(out, "utf8"));
    if (prior.completedHash && prior.completedHash !== payload.completedHash) {
      const v = out.replace(/\.json$/, `.v${Date.now()}.json`);
      fs.renameSync(out, v);
      payload.supersedes = { file: path.basename(v), hash: prior.completedHash };
      say(`[stage 4] prior artifact preserved as ${path.basename(v)} — this is a NEW version, nothing overwritten`);
    }
  }
  writeJson(out, payload);
  if (!fs.existsSync(out)) fail(`not written: ${out}`);
  say(`[stage 4] sealed: ${out}`);
  say(`           completedHash   = ${payload.completedHash}`);
  say(`           numericalForecast = ${payload.references.numericalForecastHash}`);
  say(`           scenarios         = ${payload.references.scenarioHash}`);
  say(`           evidence          = ${payload.references.evidenceHash}`);
  say(`           marketSnapshot    = ${payload.references.marketSnapshotHash}`);
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
