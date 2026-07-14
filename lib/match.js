// Match an extracted prediction (a picked competitor + domain) to its live
// Kalshi market, and return the current implied price of that side.
const k = require("./kalshi");

const SERIES = { mma: "KXUFCFIGHT", boxing: "KXBOXING" };

const norm = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "").trim();

const lastName = (s) => { const p = norm(s).split(" "); return p[p.length - 1] || ""; };

// cache of open markets per series
const cache = {};
async function marketsFor(domain) {
  const series = SERIES[domain];
  if (!series) return [];
  if (!cache[series]) cache[series] = await k.marketsAll({ series_ticker: series, status: "open" });
  return cache[series];
}

// prediction: { domain, pick } -> { ticker, price, matchTitle } | null
async function matchToMarket(pred) {
  const markets = await marketsFor(pred.domain);
  const pick = norm(pred.pick);
  const pickLast = lastName(pred.pick);
  let best = null;
  for (const m of markets) {
    const sub = norm(m.yes_sub_title || "");
    if (!sub) continue;
    let score = 0;
    if (sub === pick) score = 3;
    else if (sub.includes(pick) || pick.includes(sub)) score = 2;
    else if (pickLast && lastName(m.yes_sub_title) === pickLast) score = 1;
    if (score > (best ? best.score : 0)) best = { m, score };
  }
  if (!best) return null;
  const { mid } = await k.impliedYes(best.m.ticker);
  return {
    ticker: best.m.ticker,
    price: mid,
    matchTitle: best.m.title || best.m.event_ticker,
    confidenceOfMatch: best.score,
  };
}

module.exports = { matchToMarket, marketsFor, SERIES, norm };
