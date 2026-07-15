// VALIDATION GATE for the BestFightOdds source. Before we spend a cent extracting historical
// picks, prove BFO's de-vigged probabilities agree with Kalshi's live market on fights BOTH cover
// (the current UFC card, from signals.json). If they agree and the overrounds are sane, BFO is
// trustworthy for the pre-Kalshi era. If they don't, we stop here.
const fs = require("fs");
const bfo = require("../lib/odds-history");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const signals = JSON.parse(fs.readFileSync("data/signals.json", "utf8"));
  // one row per fighter (a fighter is one side of one market)
  const seen = new Set(), fights = [];
  for (const s of signals) {
    if (s.fighter && !seen.has(s.fighter) && s.opponent) { seen.add(s.fighter); fights.push(s); }
  }
  const sample = fights.slice(0, 14);
  console.log(`cross-checking ${sample.length} fights (BFO de-vig vs Kalshi mid):\n`);
  console.log("fight".padEnd(40) + " | Kalshi | BFO  | overr | verdict");
  console.log("-".repeat(78));

  let agree = 0, checked = 0, failed = 0;
  for (const s of sample) {
    const kalshi = s.mid != null ? s.mid : s.cost;
    let r;
    try { r = await bfo.closingLine(s.fighter, s.opponent, s.fightDate); }
    catch (e) { console.log(`${(s.fighter + " vs " + s.opponent).padEnd(40)} | BFO ERROR: ${e.message}`); failed++; await sleep(700); continue; }
    if (!r.ok) { console.log(`${(s.fighter + " vs " + s.opponent).padEnd(40)} | BFO miss: ${r.reason}`); failed++; await sleep(700); continue; }
    const diff = Math.abs(r.prob - kalshi);
    const sane = r.overround >= 1.01 && r.overround <= 1.12;
    const ok = diff <= 0.06 && sane;
    checked++; if (ok) agree++;
    console.log(`${(s.fighter + " vs " + s.opponent).slice(0, 40).padEnd(40)} | ${(kalshi * 100).toFixed(0).padStart(5)}% | ${(r.prob * 100).toFixed(0).padStart(3)}% | ${r.overround.toFixed(3)} | ${ok ? "agree" : `DIFF ${(diff * 100).toFixed(0)}c${sane ? "" : " BADOVR"}`}`);
    await sleep(700); // be polite to BFO
  }

  console.log("-".repeat(78));
  console.log(`\n${agree}/${checked} agree within 6c with a sane overround. ${failed} could not be fetched/matched.`);
  const rate = checked ? agree / checked : 0;
  console.log(rate >= 0.7 && checked >= 6
    ? "\nVERDICT: PASS — BFO is calibrated to the market. Safe to grade the historical backfill against it."
    : "\nVERDICT: NEEDS REVIEW — agreement/coverage too low; do NOT spend on extraction yet.");
})();
