// POST-FIGHT GRADING — append-only. After a card settles, read the SEALED forecast, fetch the real
// outcomes from Kalshi, grade what the forecast committed to before the fights, and append the grades
// to data/learning-ledger.json. Never rewrites a past grade.
//
//   node run-grade-card.js data/forecast-<date>.json [--write]
//
// The seal hash is the leakage proof: a grade is only ever attached to a forecast that was sealed
// before first bell, so "the forecast improved on the market" can never be an artifact of hindsight.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const k = require("./lib/kalshi");
const E = require("./lib/evidence-eval");
const LN = require("./lib/learning");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

const LEDGER = path.join(__dirname, "data", "learning-ledger.json");

async function settlementsFor(forecast) {
  // Map each bout's forFighter to a Kalshi settled result. The forFighter's own market resolving YES
  // means forFighter won; NO means they lost; "" / void means not gradeable.
  const settled = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "settled" }).catch(() => []);
  const byNorm = new Map();
  for (const m of settled) {
    if (m.result === "yes" || m.result === "no") byNorm.set(E.norm(m.yes_sub_title || ""), m.result);
  }
  const out = {};
  for (const fc of forecast.forecasts || []) {
    const forFighter = fc.marketBaseline && fc.marketBaseline.forFighter;
    if (!forFighter) { out[fc.boutId] = { forFighterWon: null }; continue; }
    const res = byNorm.get(E.norm(forFighter));
    out[fc.boutId] = { forFighterWon: res === "yes" ? 1 : res === "no" ? 0 : null };
  }
  return out;
}

async function main() {
  const fcPath = process.argv[2];
  if (!fcPath || !fs.existsSync(fcPath)) fail("usage: node run-grade-card.js data/forecast-<date>.json [--write]");
  const write = process.argv.includes("--write");
  const forecast = JSON.parse(fs.readFileSync(fcPath, "utf8"));
  if (!forecast.sealHash) fail("this forecast has no sealHash — only a SEALED forecast can be graded");

  say(`[grade] card ${forecast.card && forecast.card.eventId} | forecast ${forecast.sealHash}`);
  const settlements = await settlementsFor(forecast);
  const settledCount = Object.values(settlements).filter((s) => s.forFighterWon != null).length;
  say(`[grade] ${settledCount}/${(forecast.forecasts || []).length} bouts have a settled Kalshi result`);
  if (!settledCount) { say("[grade] nothing has settled yet — nothing to grade. (This is normal before/at the card.)"); return 0; }

  const cardGrade = LN.gradeCard(forecast, settlements);
  const s = cardGrade.summary;
  say(`[grade] gradeable ${s.gradeable} | moved off market ${s.movedOffMarket} | adjustments improved log loss ${s.adjustmentsImprovedLogLoss}, worsened ${s.adjustmentsWorsenedLogLoss}`);
  say(`[grade] mean log loss: system ${s.meanLogLossSystem} vs market ${s.meanLogLossMarket}` +
      (s.meanLogLossSystem != null ? ` -> the forecast ${s.meanLogLossSystem < s.meanLogLossMarket ? "BEAT" : s.meanLogLossSystem > s.meanLogLossMarket ? "LOST TO" : "tied"} the market` : ""));

  if (!write) { say(`\n  (dry run — re-run with --write to append to data/learning-ledger.json)`); return 0; }

  const existing = (() => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return { version: 1, grades: [] }; } })();
  const { ledger, added, skipped } = LN.appendToLedger(existing, cardGrade);
  const tmp = LEDGER + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, LEDGER);
  say(`\n  appended ${added} grade(s) to data/learning-ledger.json (${skipped} already present, not overwritten)`);

  // Roll up the provisional per-mechanism reliability (descriptive; never a live signal on its own).
  const rel = LN.mechanismReliability(ledger);
  if (rel.length) { say(`  provisional mechanism reliability (shrunk toward neutral):`); for (const r of rel.slice(0, 8)) say(`     ${r.mechanism}: n=${r.n}, improvement ${r.provisionalMeanImprovement} [${r.status}]`); }
  fs.writeFileSync(path.join(__dirname, "data", "mechanism-reliability.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), status: "PROVISIONAL", mechanisms: rel }, null, 2));
  return 0;
}

main().then((c) => { if (!LINES) process.stdout.write("FATAL: no output\n"); process.exit(c || 0); })
  .catch((e) => { say(`\nFATAL: ${e.message}`); process.exit(1); });
