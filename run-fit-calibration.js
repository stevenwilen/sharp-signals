// FIT CALIBRATION — teach the confidence engine what its consensus SHARE is really worth, and produce
// the honest scoreboard that replaces the old P&L chart.
//
// For every past, settled card it rebuilds the same rank-weighted consensus, looks up who actually won
// (Kalshi settlement, read-only), and pairs (share, coverage) with the outcome. It fits the shrink slope
// so "74%" comes to mean "won ~74% of the time", and writes:
//   - data/confidence-calibration.json   the fitted params the engine uses (or the conservative default)
//   - data/confidence-history.json       every graded read + a bucketed hit-rate table (the scoreboard)
//
//   node run-fit-calibration.js
//
// Best-effort and read-only: a Kalshi hiccup leaves the conservative default in place, never a bet path.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const C = require("./lib/confidence");
const CAL = require("./lib/confidence-calibration");
const R = require("./lib/results");
const N = require("./lib/names");

const DATA = path.join(__dirname, "data");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const tickerDate = (d) => { const [y, m, day] = d.split("-"); return `${y.slice(2)}${MONTHS[+m - 1]}${day}`; };

// Which past cards do we have a forecast for? (canonical files only, not the .v<ts> seals.)
function settledCards() {
  return fs.readdirSync(DATA)
    .map((f) => (f.match(/^forecast-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1])
    .filter(Boolean).sort();
}

(async () => {
  let settled = [];
  try { settled = await R.settledFor("mma"); }
  catch (e) { console.error(`kalshi settled fetch failed (${e.message}) — keeping current calibration`); process.exit(0); }
  if (!settled.length) { console.error("no settled markets returned — keeping current calibration"); process.exit(0); }

  const cards = settledCards();
  const samples = [];   // { card, fight, pick, confidencePct, share, coverage, label, won }
  for (const card of cards) {
    const td = tickerDate(card);
    const cardMkts = settled.filter((m) => String(m.ticker || "").includes(`-${td}`));
    if (!cardMkts.length) continue;   // not settled yet (e.g. the upcoming card)
    const conf = C.buildCard(card);
    for (const f of conf.fights) {
      if (!f.pick) continue;
      // the settled market whose YES side IS the picked fighter -> did the pick win?
      const mkt = cardMkts.find((m) => N.surname(m.yes_sub_title) && C.surnameEq(N.surname(m.yes_sub_title), N.surname(f.pick)));
      const won = mkt ? R.wonFromMarket(mkt) : null;
      if (won !== 0 && won !== 1) continue;   // void / unmatched -> not a calibration point
      samples.push({ card, fight: f.fight, pick: f.pick, confidencePct: f.confidencePct,
        share: f.share, coverage: f.coverage, label: f.label, won });
    }
  }

  const fitted = CAL.fit(samples.map((s) => ({ share: s.share, coverage: s.coverage, won: s.won })));
  CAL.save(fitted);
  // Recompute each read's % with the JUST-FITTED calibration so the scoreboard is self-consistent
  // (buildCard above used whatever calibration was loaded before this fit).
  for (const s of samples) s.confidencePct = Math.round(100 * CAL.toProbability(s.share, s.coverage));

  // Scoreboard: overall + by confidence bucket (was the high-confidence pick actually right?).
  const buckets = [[50, 56], [56, 62], [62, 70], [70, 86]].map(([lo, hi]) => {
    const inB = samples.filter((s) => s.confidencePct >= lo && s.confidencePct < hi);
    const won = inB.filter((s) => s.won === 1).length;
    return { range: `${lo}-${hi - 1}%`, n: inB.length, won, hitRate: inB.length ? +(won / inB.length).toFixed(3) : null };
  });
  const total = samples.length, wins = samples.filter((s) => s.won === 1).length;
  const brier = total ? +(samples.reduce((a, s) => a + ((s.confidencePct / 100) - s.won) ** 2, 0) / total).toFixed(4) : null;

  const scoreboard = {
    generatedAt: new Date().toISOString(),
    calibration: fitted,
    graded: total, correct: wins, accuracy: total ? +(wins / total).toFixed(3) : null,
    brier,
    byConfidence: buckets,
    reads: samples.sort((a, b) => (b.confidencePct - a.confidencePct)),
  };
  fs.writeFileSync(path.join(DATA, "confidence-history.json"), JSON.stringify(scoreboard, null, 2));

  console.log(`calibration: ${fitted.method} slope=${fitted.slope} — ${fitted.reliability}`);
  console.log(`scoreboard: ${total} graded reads · ${wins} correct (${total ? Math.round(100 * wins / total) : 0}%) · Brier ${brier}`);
  for (const b of buckets) console.log(`  ${b.range.padStart(7)}: ${String(b.n).padStart(3)} reads · ${b.hitRate == null ? "—" : Math.round(100 * b.hitRate) + "% won"}`);
  process.exit(0);
})().catch((e) => { console.error("fit-calibration error:", e.message); process.exit(1); });
