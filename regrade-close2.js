// Grade against the TRUE closing line: the last candlestick strictly BEFORE the fight starts.
//
// regrade-close.js used Kalshi's last_price_dollars, which on a settled market is the last
// TRADE — struck as the fight is being decided, when a winning favourite has already run to
// ~95c. That is a near-settlement price, not the closing line, and it made the baseline look
// like -35% (an artifact). The real closing line is the last candle before close_time.
//   node regrade-close2.js
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const grade = require("./lib/grade");
const k = require("./lib/kalshi");

const SERIES = { mma: "KXUFCFIGHT", boxing: "KXBOXING" };
const all = readJson(paths.predictions, [])
  .filter((p) => (p.result === 0 || p.result === 1) && p.marketTicker && p.fightTime);

// map ticker -> { domain, closeSec }
const mkt = {};
for (const p of all) if (!mkt[p.marketTicker]) mkt[p.marketTicker] = { domain: p.domain, closeSec: Math.floor(Date.parse(p.fightTime) / 1000) };

const closeLine = {};
async function fetchClose(ticker) {
  const { domain, closeSec } = mkt[ticker];
  try {
    const c = await k.candlesticks(SERIES[domain], ticker, {
      start_ts: closeSec - 7 * 86400, end_ts: closeSec, period_interval: 60,
    });
    const cs = (c && c.candlesticks) || [];
    // last candle strictly at/before the fight start = the closing line
    let chosen = null;
    for (const cd of cs) if (cd.end_period_ts <= closeSec) chosen = cd; // keep the LAST one
    if (!chosen) { closeLine[ticker] = null; return; }
    const yb = chosen.yes_bid && parseFloat(chosen.yes_bid.close_dollars);
    const ya = chosen.yes_ask && parseFloat(chosen.yes_ask.close_dollars);
    let px = (yb > 0 && ya > 0) ? (yb + ya) / 2 : (chosen.price && parseFloat(chosen.price.close_dollars));
    closeLine[ticker] = px > 0 && px < 1 ? px : null;
  } catch (_) { closeLine[ticker] = null; }
}

(async () => {
  const tickers = Object.keys(mkt);
  process.stdout.write(`fetching TRUE closing line for ${tickers.length} markets`);
  for (const t of tickers) { await fetchClose(t); process.stdout.write("."); }
  console.log("");

  // drift check first: call price vs true close, on the SAME side
  let n = 0, sc = 0, scl = 0;
  for (const p of all) { const c = closeLine[p.marketTicker]; if (c > 0) { n++; sc += p.priceAtCall; scl += c; } }
  console.log(`\ncall vs TRUE close: avg call ${(sc / n * 100).toFixed(1)}c, avg close ${(scl / n * 100).toFixed(1)}c, drift ${((scl - sc) / n * 100).toFixed(1)}c\n`);

  const atClose = all.filter((p) => closeLine[p.marketTicker] > 0)
    .map((p) => ({ ...p, priceAtCall: closeLine[p.marketTicker] }));

  const cfg = readJson(paths.config, {});
  const graded = grade.gradeAll(atClose, cfg);
  const ranked = Object.values(graded).sort((a, b) => (b.shrunkRoi || -9) - (a.shrunkRoi || -9));
  console.log("  TRUST   shrunk   defensible   n    source   (vs TRUE close)");
  for (const g of ranked) {
    if (!g.n || g.n < 10) continue;
    console.log(`  ${g.trusted ? " YES " : "  -  "}  ${String(g.shrunkRoi ?? "-").padStart(6)}  ` +
      `${String(g.roiLcb ?? "-").padStart(9)}   ${String(g.n).padStart(3)}   ${g.source}`);
  }
  const trusted = ranked.filter((g) => g.trusted);
  const defensible = ranked.filter((g) => g.trusted && g.roiLcb > 0);
  const roi = atClose.reduce((a, p) => a + (p.result / p.priceAtCall - 1), 0) / atClose.length;
  console.log(`\ntrusted vs close: ${trusted.length} | defensible vs close: ${defensible.length}`);
  console.log(`BASELINE (every pick, vs true close): ROI ${(roi * 100).toFixed(1)}%  (efficient market ~ -vig, i.e. slightly negative)`);
})();
