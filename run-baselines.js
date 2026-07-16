// MARKET BASELINE COLLECTION — run the waterfall across full cards and report real coverage.
//
//   node run-baselines.js [--cards=26JUL11,26JUL18] [--out=data/baselines.json]
//
// Card rosters come from KALSHI, deliberately: BFO is the price source, so reconstructing the roster
// from BFO pages would define the card as "fights BFO knows about" and score 100% by construction.
// An independent roster is the only way this measurement means anything.
//
// No outcomes are loaded. No closing line reaches a baseline.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const k = require("./lib/kalshi");
const O = require("./lib/odds-history");
const MB = require("./lib/market-baseline");
const tc = require("./lib/target-card");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function tickerToDate(t) {
  const m = String(t).match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(2000 + Number(m[1]), MONTHS[m[2]], Number(m[3])));
}

async function main() {
  const only = (process.argv.find((a) => a.startsWith("--cards=")) || "").split("=")[1];
  const out = (process.argv.find((a) => a.startsWith("--out=")) || "").split("=")[1] || "data/baselines.json";

  say(`[stage 1] pulling independent card rosters from Kalshi ...`);
  const markets = [].concat(
    await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "settled" }).catch(() => []),
    await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" }).catch(() => []),
  );
  if (!markets.length) fail("no Kalshi markets returned — cannot build an independent roster");

  const cards = {};
  for (const m of markets) {
    const mt = String(m.ticker).match(/KXUFCFIGHT-(\d{2}[A-Z]{3}\d{2})/);
    if (!mt) continue;
    const d = mt[1];
    (cards[d] = cards[d] || {})[m.event_ticker] = (cards[d][m.event_ticker] || []).concat(m);
  }
  let dates = Object.keys(cards).sort();
  if (only) dates = dates.filter((d) => only.split(",").includes(d));
  say(`[stage 1] ${dates.length} card(s): ${dates.join(", ")}`);

  const report = [];
  const allBaselines = {};
  for (const d of dates) {
    const dt = tickerToDate(d);
    if (!dt) { say(`  skip ${d}: unparsable ticker date`); continue; }
    const iso = dt.toISOString().slice(0, 10);
    // two-sided events only: a one-sided market is not a bout we can de-vig
    const pairs = Object.values(cards[d]).filter((a) => a.length === 2)
      .map((a) => ({ a: a[0].yes_sub_title, b: a[1].yes_sub_title, date: iso }));
    const oneSided = Object.values(cards[d]).filter((a) => a.length !== 2).length;
    if (!pairs.length) { say(`  skip ${d}: no two-sided markets`); continue; }

    const card = tc.buildCard(`UFC-${iso}`, iso, pairs);
    // The forecast instant for a historical replay. Tier B is LOGICAL_OPEN so staleness does not
    // apply to it; tiers A and C are wall-clock and are measured against this boundary.
    const forecastTs = Date.parse(`${iso}T00:00:00Z`);
    const fightMs = Date.parse(`${iso}T22:00:00Z`);

    say(`\n[stage 2] ${d} (${iso}) — ${card.bouts.length} bouts${oneSided ? `, ${oneSided} one-sided market(s) excluded` : ""}`);
    const tiers = { A: 0, B: 0, C: 0, D: 0 };
    const baselines = [];
    for (const b of card.bouts) {
      let hit = null;
      try {
        hit = await O.lookup(b.a.name, b.b.name, fightMs);
        if (!hit) {
          const v = await O.lookup(b.b.name, b.a.name, fightMs);
          if (v) hit = { me: v.opp, opp: v.me, ft: v.ft };
        }
      } catch (e) { /* recorded as a missing-source reason by the waterfall */ }

      // Tier A needs a live per-book snapshot taken before the seal; none exists for a past card.
      // Tier C needs a Kalshi quote timestamped before the seal; settled markets carry post-fight
      // prices, which the waterfall's own timestamp check refuses. Both are left genuinely empty
      // rather than faked, and the record shows exactly that.
      const rec = MB.buildBaseline(b, { liveSnapshot: null, bfoHit: hit, kalshi: null }, forecastTs);
      tiers[rec.fallbackLevel]++;
      baselines.push(rec);
      if (rec.fallbackLevel === "D") say(`    D  ${b.a.name} vs ${b.b.name} -> ${(rec.missingSourceReasons || []).filter((x) => /^B:/.test(x)).join("; ") || "no reason recorded"}`);
    }
    const priced = tiers.A + tiers.B + tiers.C;
    const pct = (priced / card.bouts.length) * 100;
    say(`    tiers: A=${tiers.A} B=${tiers.B} C=${tiers.C} D=${tiers.D}  ->  ${priced}/${card.bouts.length} priced = ${pct.toFixed(1)}%`);
    report.push({ card: d, date: iso, bouts: card.bouts.length, ...tiers, priced, pct: +pct.toFixed(1) });
    allBaselines[d] = baselines;
  }

  if (!report.length) fail("no cards produced baselines — refusing to report success");

  say(`\n${"=".repeat(78)}\nCOVERAGE\n${"=".repeat(78)}`);
  say("  card      date         bouts   A    B    C    D   priced");
  let tb = 0, tp = 0;
  for (const r of report) {
    say(`  ${r.card.padEnd(9)} ${r.date}   ${String(r.bouts).padStart(3)}  ${String(r.A).padStart(3)}  ${String(r.B).padStart(3)}  ${String(r.C).padStart(3)}  ${String(r.D).padStart(3)}   ${r.pct.toFixed(1)}%`);
    tb += r.bouts; tp += r.priced;
  }
  const overall = (tp / tb) * 100;
  say(`  ${"".padEnd(9)} ${"OVERALL".padEnd(12)} ${String(tb).padStart(3)}                      ${overall.toFixed(1)}%`);
  say(`\n  PASS TARGET >= 90%:  ${overall >= 90 ? "MET" : "NOT MET"} (${overall.toFixed(1)}%)`);
  const worst = report.filter((r) => r.pct < 90);
  if (worst.length) say(`  cards below 90%: ${worst.map((r) => `${r.card} (${r.pct}%)`).join(", ")}`);

  writeJson(out, { generatedAt: new Date().toISOString(), module: "market-baseline@1.0.0",
    rosterSource: "kalshi KXUFCFIGHT (independent of the price source)", report, baselines: allBaselines });
  if (!fs.existsSync(out)) fail(`not written: ${out}`);
  say(`\n  written: ${out}`);
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
