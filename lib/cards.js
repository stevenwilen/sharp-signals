// "Is this a real fight, or filler on the undercard?" — tell the fights that matter from the ones
// nobody disagrees about (protective matchmaking, a heavy favourite everyone picks) by TRADED VOLUME
// on the fight. On a real main event an informed voice has somewhere to be right; on filler it does not.
//
// HOW WE MEASURE "BIG". Traded volume, NOT liquidity: `liquidity_dollars` is 0 on EVERY open market
// (Kalshi only populates it once settled — which is why config's `minMarketLiquidityUsd` sat unused).
// Volume separates on a cliff, not a gradient, so a plain volume floor is enough.
//
// SEPARATE FLOORS FOR OPEN AND SETTLED, because volume accrues right up to the bell. A settled fight
// has its final number; an upcoming one is still filling. One floor for both would filter by how SOON
// a fight is rather than how big.
const k = require("./kalshi");

const SERIES = { mma: "KXUFCFIGHT" };
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

// Volume floors are optional per domain: { markets: { mma: { minVolumeOpen: N, minVolumeSettled: N } } }.
// A domain with no floors keeps everything. MMA's numbers went 24.6% -> 10.0% -> 14.2% across
// thresholds — non-monotonic, i.e. noise — so no MMA floor is set and this passes everything today;
// picking the best-looking cut would be curve-fitting.
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
