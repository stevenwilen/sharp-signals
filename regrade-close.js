// Re-grade the corpus against the CLOSING line instead of the price at the call.
//
// diag-linebias showed picks are made a median 22c below the close: we were grading against a
// soft early price, so "beating the line" mostly meant calling before the crowd, not predicting
// better than the market. The close is the sharpest price the market makes; beating IT is the
// real test of skill. It is also closer to what the user can actually bet, since our 4h-scan
// pipeline relays a pick only after the line has already moved.
//   node regrade-close.js
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const grade = require("./lib/grade");
const k = require("./lib/kalshi");

const all = readJson(paths.predictions, [])
  .filter((p) => (p.result === 0 || p.result === 1) && p.marketTicker);

const cache = {};
async function closeOf(ticker) {
  if (cache[ticker] !== undefined) return cache[ticker];
  try {
    const m = await k.market(ticker);
    const mk = (m && m.market) || m || {};
    let px = parseFloat(mk.last_price_dollars);
    if (!(px > 0 && px < 1)) px = parseFloat(mk.previous_price_dollars);
    cache[ticker] = px > 0 && px < 1 ? px : null;
  } catch (_) { cache[ticker] = null; }
  return cache[ticker];
}

(async () => {
  const tickers = [...new Set(all.map((p) => p.marketTicker))];
  process.stdout.write(`fetching closing prices for ${tickers.length} markets`);
  for (const t of tickers) { await closeOf(t); process.stdout.write("."); }
  console.log("");

  // rebuild each pick with priceAtCall REPLACED by the closing price of the picked side
  const atClose = [];
  for (const p of all) {
    const c = cache[p.marketTicker];
    if (!(c > 0 && c < 1)) continue;
    atClose.push({ ...p, priceAtCall: c }); // grade.js keys off priceAtCall
  }
  console.log(`graded at close: ${atClose.length} picks\n`);

  const cfg = readJson(paths.config, {});
  const graded = grade.gradeAll(atClose, cfg);
  const ranked = Object.values(graded).sort((a, b) => (b.shrunkRoi || -9) - (a.shrunkRoi || -9));

  console.log("  TRUST   shrunk   defensible   n    source   (graded vs the CLOSE)");
  for (const g of ranked) {
    if (!g.n || g.n < 5) continue;
    console.log(`  ${g.trusted ? " YES " : "  -  "}  ${String(g.shrunkRoi ?? "-").padStart(6)}  ` +
      `${String(g.roiLcb ?? "-").padStart(9)}   ${String(g.n).padStart(3)}   ${g.source}`);
  }
  const trusted = ranked.filter((g) => g.trusted);
  const defensible = ranked.filter((g) => g.trusted && g.roiLcb > 0);
  console.log(`\ntrusted vs close: ${trusted.length} | with a defensible edge vs close: ${defensible.length}`);

  // market-wide baseline at the close: should be ~0 in an efficient market
  const roi = atClose.reduce((a, p) => a + (p.result / p.priceAtCall - 1), 0) / atClose.length;
  console.log(`\nBASELINE (every pick, graded at close): ROI ${(roi * 100).toFixed(1)}%`);
  console.log(`  (at the SOFT call price this was +18%. If it is near 0 here, that 18% was`);
  console.log(`   line-timing, not skill. Whoever stays positive vs the close has the real edge.)`);
})();
