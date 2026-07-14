// Is our priceAtCall systematically BELOW the closing line? If pundits call early and we grade
// against that soft price, every favorite that wins looks like edge that is really just the
// line moving after the call. That would explain "everyone beats the market by 18%".
//   node diag-linebias.js
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const k = require("./lib/kalshi");

const all = readJson(paths.predictions, [])
  .filter((p) => (p.result === 0 || p.result === 1) && p.priceAtCall > 0 && p.priceAtCall < 1 && p.marketTicker);

// closing price = last settled price of the YES side (settlement is 1/0, so use last_price)
const closeCache = {};
async function closingPrice(domain, ticker) {
  if (closeCache[ticker] !== undefined) return closeCache[ticker];
  try {
    const m = await k.market(ticker);
    const mk = (m && m.market) || m || {};
    let px = parseFloat(mk.last_price_dollars);
    if (!(px > 0 && px < 1)) px = parseFloat(mk.previous_price_dollars);
    closeCache[ticker] = px > 0 && px < 1 ? px : null;
  } catch (_) { closeCache[ticker] = null; }
  return closeCache[ticker];
}

(async () => {
  const sample = all.slice(0, 250);
  let n = 0, sumCall = 0, sumClose = 0, callBelow = 0;
  const diffs = [];
  for (const p of sample) {
    const close = await closingPrice(p.domain, p.marketTicker);
    if (close == null) continue;
    n++;
    sumCall += p.priceAtCall;
    sumClose += close;
    diffs.push(close - p.priceAtCall);
    if (p.priceAtCall < close - 0.02) callBelow++;
  }
  diffs.sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  console.log(`compared ${n} picks: price-at-call vs closing price of the SAME side\n`);
  console.log(`  avg price-at-call : ${(sumCall / n * 100).toFixed(1)}c`);
  console.log(`  avg closing price : ${(sumClose / n * 100).toFixed(1)}c`);
  console.log(`  avg drift (close - call): ${((sumClose - sumCall) / n * 100).toFixed(1)}c`);
  console.log(`  median drift            : ${(med * 100).toFixed(1)}c`);
  console.log(`  picks where call was >2c BELOW close: ${callBelow}/${n} (${Math.round(100 * callBelow / n)}%)`);
  console.log(`\nREAD: if the call price sits well BELOW the close, we are grading against a soft`);
  console.log(`early line. The fix is to grade against the CLOSE (or the historical closing odds`);
  console.log(`from BestFightOdds). A small/zero drift means the call price is fair and the edge`);
  console.log(`is more likely real.`);
})();
