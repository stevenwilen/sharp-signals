// "Is this a real fight, or filler on the undercard?"
//
// WHY THIS EXISTS. Boxing sources looked useless: 31 graded picks, +2.3% ROI vs the line,
// 77% of their picks were favourites at an average of 73c. That is the exact signature of
// "right a lot, earning nothing" — the thing this whole project was built to detect.
//
// But it turned out to be a composition problem, not a talent problem. Filter to the fights
// that actually matter and boxing's ROI goes 2.3% -> ~19%. On small cards the matchmaking is
// protective (promoters are building a record), the favourite is a heavy favourite, everyone
// picks him, and there is nothing to disagree about. On a main event there is a real fight and
// an informed voice has somewhere to be right.
//
// HOW WE MEASURE "BIG". Traded volume on the fight. Two false starts, both instructive:
//
//   - `liquidity_dollars` is 0 on EVERY open market. Like yes_bid/yes_ask, Kalshi only
//     populates it once settled. That is why config's `minMarketLiquidityUsd: 500` sat there
//     for weeks doing nothing: it could never have worked.
//
//   - "Is it the biggest fight on its card?" sounds right and fails badly. Many boxing cards
//     on Kalshi list only ONE fight, so that fight is 100% of its own card and passes no matter
//     how small it is. It also happily admitted TheGrefg, IlloJuan and Fernanfloo — La Velada,
//     the Spanish influencer boxing event, which Kalshi files under KXBOXING and which no
//     boxing analyst on our roster has ever covered.
//
// Plain volume separates cleanly, so plain volume it is. There is a cliff, not a gradient:
// Mayweather 303k, Pacquiao 257k, Canelo 40k, Mbilli 28k ... then 5k and below.
//
// SEPARATE FLOORS FOR OPEN AND SETTLED, because volume accrues right up to the bell. A settled
// fight has its final number; an upcoming one is still filling. Using one floor for both would
// filter by how SOON a fight is rather than how big.
const k = require("./kalshi");

const SERIES = { mma: "KXUFCFIGHT", boxing: "KXBOXING" };
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

const cache = {};

// ticker -> traded volume, for one domain/status.
async function volumes(domain, status = "open") {
  const key = `${domain}:${status}`;
  if (cache[key]) return cache[key];
  const series = SERIES[domain];
  if (!series) return {};
  const markets = await k.marketsAll({ series_ticker: series, status });

  // Both sides of a fight are one fight: take the busier side, and give both that number.
  const eventVol = {}, eventOf = {};
  for (const m of markets) {
    eventOf[m.ticker] = m.event_ticker;
    eventVol[m.event_ticker] = Math.max(eventVol[m.event_ticker] || 0, num(m.volume_fp));
  }
  const out = {};
  for (const t of Object.keys(eventOf)) out[t] = eventVol[eventOf[t]] || 0;
  cache[key] = out;
  return out;
}

// Config: { markets: { boxing: { minVolumeOpen: 20000, minVolumeSettled: 100000 } } }
// A domain with no floors (MMA) keeps everything. MMA's numbers went 24.6% -> 10.0% -> 14.2%
// across thresholds: non-monotonic, i.e. noise. There is no effect there, and picking the
// best-looking cut would be curve-fitting.
function floorFor(domain, cfg, status) {
  const m = (cfg && cfg.markets && cfg.markets[domain]) || {};
  return (status === "settled" ? m.minVolumeSettled : m.minVolumeOpen) || 0;
}

// Is this a real fight, or filler?
async function isWorthIt(domain, ticker, cfg, status = "open") {
  const floor = floorFor(domain, cfg, status);
  if (!floor) return true;
  const v = await volumes(domain, status);
  return (v[ticker] || 0) >= floor;
}

module.exports = { volumes, isWorthIt, floorFor };
