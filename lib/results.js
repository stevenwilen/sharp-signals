// Resolve an extracted pick against Kalshi's settled markets:
//   - did the picked competitor WIN? (settled market result)
//   - what was the LINE when they called it? (candlestick price at pick timestamp)
// Produces the { priceAtCall, result } that the grading engine needs.
const k = require("./kalshi");
const { norm } = require("./match");

const SERIES = { mma: "KXUFCFIGHT", boxing: "KXBOXING" };
const cache = {};
async function settledFor(domain) {
  const s = SERIES[domain];
  if (!s) return [];
  if (!cache[s]) cache[s] = await k.marketsAll({ series_ticker: s, status: "settled" });
  return cache[s];
}

// Did the YES side (the picked competitor) win?  1 = win, 0 = loss, null = void/unknown.
function wonFromMarket(m) {
  if (m.result === "yes") return 1;
  if (m.result === "no") return 0;
  const sv = parseFloat(m.settlement_value_dollars);
  if (!isNaN(sv)) return sv >= 0.5 ? 1 : 0;
  const lp = parseFloat(m.last_price_dollars);
  if (!isNaN(lp)) return lp >= 0.9 ? 1 : lp <= 0.1 ? 0 : null;
  return null;
}

const lastTok = (s) => { const p = norm(s).split(" "); return p[p.length - 1] || ""; };

// Find the settled market for a pick: name match + fight shortly AFTER the pick.
function findMarket(markets, pred) {
  const pick = norm(pred.pick), pl = lastTok(pred.pick);
  const t = Date.parse(pred.timestamp) || 0;
  let best = null;
  for (const m of markets) {
    const sub = norm(m.yes_sub_title || "");
    if (!sub) continue;
    let name = 0;
    if (sub === pick) name = 3;
    else if (sub.includes(pick) || pick.includes(sub)) name = 2;
    else if (pl && lastTok(m.yes_sub_title) === pl) name = 1;
    if (!name) continue;
    const fightT = Date.parse(m.close_time) || 0;
    const dtDays = (fightT - t) / 86400000;
    if (dtDays < -1 || dtDays > 28) continue; // fight must follow the pick, within 4 weeks
    const score = name * 100 - Math.abs(dtDays);
    if (!best || score > best.score) best = { m, score, fightT };
  }
  return best;
}

// Line (implied prob of the picked YES side) at the pick's timestamp, from candlesticks.
async function lineAtCall(domain, market, pickTs, fightT) {
  const series = SERIES[domain];
  const pickSec = Math.floor((Date.parse(pickTs) || 0) / 1000);
  try {
    const c = await k.candlesticks(series, market.ticker, {
      start_ts: pickSec - 3 * 86400, end_ts: Math.floor(fightT / 1000), period_interval: 60,
    });
    const cs = (c && c.candlesticks) || [];
    let chosen = null;
    for (const cd of cs) { if (cd.end_period_ts >= pickSec) { chosen = cd; break; } }
    if (!chosen && cs.length) chosen = cs[cs.length - 1];
    if (!chosen) return null;
    const yb = chosen.yes_bid && parseFloat(chosen.yes_bid.close_dollars);
    const ya = chosen.yes_ask && parseFloat(chosen.yes_ask.close_dollars);
    if (yb > 0 && ya > 0) return +(((yb + ya) / 2)).toFixed(4);
    const px = chosen.price && parseFloat(chosen.price.close_dollars);
    return px > 0 && px < 1 ? +px.toFixed(4) : null;
  } catch (_) { return null; }
}

// Resolve one prediction -> { ...pred, marketTicker, priceAtCall, result } or null.
async function resolvePick(pred) {
  const markets = await settledFor(pred.domain);
  const hit = findMarket(markets, pred);
  if (!hit) return null;
  const result = wonFromMarket(hit.m);
  if (result == null) return null;
  const priceAtCall = await lineAtCall(pred.domain, hit.m, pred.timestamp, hit.fightT);
  return { ...pred, marketTicker: hit.m.ticker, fightTime: hit.m.close_time, priceAtCall, result };
}

// Resolve many; returns { resolved, matched, unmatched, noLine }.
async function resolveAll(preds) {
  const resolved = [];
  let matched = 0, noLine = 0;
  for (const p of preds) {
    const r = await resolvePick(p).catch(() => null);
    if (!r) continue;
    matched++;
    if (r.priceAtCall == null) { noLine++; continue; }
    resolved.push(r);
  }
  return { resolved, matched, unmatched: preds.length - matched, noLine };
}

module.exports = { resolvePick, resolveAll, settledFor, wonFromMarket };
