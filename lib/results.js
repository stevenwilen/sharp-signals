// Resolve an extracted pick against Kalshi's settled markets:
//   - did the picked competitor WIN? (settled market result)
//   - what was the LINE when they called it? (candlestick price at pick timestamp)
// Produces the { priceAtCall, result } that the grading engine needs.
const k = require("./kalshi");
const names = require("./names");
const cards = require("./cards");
const oddsHistory = require("./odds-history"); // BFO closing line — the historical (pre-Kalshi) line
const ufcResults = require("./ufc-results");   // Wikipedia W/L — the historical result
const { norm } = names;

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

// Find the settled market for a pick: name match + fight shortly AFTER the pick.
//
// This used to match on SURNAME ALONE, which is the same mistake lib/match.js was making on the
// live path. It graded a pick for "Daniel Santos" against the JUNIOR DOS SANTOS market —
// different fight, different human, and the price recorded against that pick belongs to someone
// else entirely. Nothing flagged it; the row looks completely normal in predictions.json.
//
// Now: a surname alone is never enough. Either the full name is present, or the extractor's
// `opponent` must confirm the other side of the same fight.
function findMarket(markets, pred) {
  const t = Date.parse(pred.timestamp) || 0;

  // sibling lookup: the two per-fighter markets of one fight share an event_ticker
  const byEvent = {};
  for (const m of markets) if (m.event_ticker) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);

  let best = null;
  for (const m of markets) {
    const sub = m.yes_sub_title || "";
    if (!sub) continue;

    let name = names.nameScore(pred.pick, sub);
    if (!name) continue;

    const sibs = byEvent[m.event_ticker] || [];
    const sibling = sibs.find((s) => s.ticker !== m.ticker);

    // Does the pick text name this fighter's OPPONENT at least as strongly? ("Usman over Du
    // Plessis" names both.) Then this side is not established.
    const rival = sibling ? names.nameScore(pred.pick, sibling.yes_sub_title) : 0;
    const oppConfirms = sibling && pred.opponent
      ? names.nameScore(pred.opponent, sibling.yes_sub_title) >= 2 : false;

    // A bare surname (score 1) is only usable if the opponent corroborates the fight.
    if (name < 2 && !oppConfirms) continue;
    if (rival >= name && !oppConfirms) continue;

    if (oppConfirms) name += 2;
    const fightT = Date.parse(m.close_time) || 0;
    const dtDays = (fightT - t) / 86400000;
    // HINDSIGHT GUARD. This used to be `dtDays < -1`, which admitted any "pick" made up to 24
    // HOURS AFTER the fight had already finished and settled — i.e. a post-fight reaction or a
    // "told you so" tweet, graded as a prediction. There were 8 such rows in the data and ALL
    // EIGHT "won" (of course they did). They were not a rounding error: they were 57% of Sean
    // O'Malley's entire measured edge (ROI +46% -> +20% once removed).
    // A prediction must PRECEDE the thing it predicts. No tolerance.
    if (dtDays <= 0 || dtDays > 28) continue;
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
    // NO FALLBACK TO THE LAST CANDLE. It used to do `chosen = cs[cs.length - 1]` when no candle
    // sat at or after the pick — which happens precisely when the "pick" came AFTER the fight.
    // It then handed back the near-settlement price, so a hindsight call got a tradeable-looking
    // line and a guaranteed win. If there is no candle at or after the call, there is no line,
    // and no line means NOT GRADEABLE. Silence beats a flattering number.
    if (!chosen) return null;

    // Price at the ASK, not the mid. You cannot buy at the mid — you lift the offer. Grading a
    // track record at the mid overstates every source's ROI by roughly half the spread, which on
    // thin UFC undercard books is ~5 points: larger than the entire 3-point trust threshold.
    // Sources were being trusted on an edge they never could have captured.
    const ya = chosen.yes_ask && parseFloat(chosen.yes_ask.close_dollars);
    if (ya > 0 && ya < 1) return +ya.toFixed(4);
    const yb = chosen.yes_bid && parseFloat(chosen.yes_bid.close_dollars);
    const px = chosen.price && parseFloat(chosen.price.close_dollars);
    // No ask quoted: fall back to the trade price, then the bid. Both understate the true cost,
    // so they flatter the source — acceptable only because the alternative is dropping the pick.
    if (px > 0 && px < 1) return +px.toFixed(4);
    return yb > 0 && yb < 1 ? +yb.toFixed(4) : null;
  } catch (_) { return null; }
}

// Resolve one prediction -> { ...pred, marketTicker, priceAtCall, result, priceSource } or null.
// Kalshi is tried first and OWNS the pick if it has the market; only when Kalshi has no market at
// all (a fight that predates Kalshi) do we fall back to the historical BFO+Wikipedia path. A pick
// is therefore graded ENTIRELY by one source or the other, never a mix — which is what keeps the
// two corpora cleanly separable by priceSource.
async function resolvePick(pred, cfg = {}) {
  const markets = await settledFor(pred.domain);
  const hit = findMarket(markets, pred);
  if (hit) {
    // Skip filler. A pick on a four-round undercard bout that nobody traded tells us nothing about
    // whether a source can beat a real market — see lib/cards.js.
    if (!(await cards.isWorthIt(pred.domain, hit.m.ticker, cfg, "settled"))) return null;
    const result = wonFromMarket(hit.m);
    if (result == null) return null;
    const priceAtCall = await lineAtCall(pred.domain, hit.m, pred.timestamp, hit.fightT);
    return { ...pred, marketTicker: hit.m.ticker, fightTime: hit.m.close_time, priceAtCall, result, priceSource: "kalshi" };
  }
  return resolveHistorical(pred);
}

// Historical fallback for fights with no Kalshi market: line from BestFightOdds, result from
// Wikipedia. UFC/MMA only. Tagged priceSource:"bfo" so it can be filtered/deleted without touching
// the Kalshi numbers. Fails safe: if either source can't confidently place the fight, return null
// (the pick is dropped, never graded on a guess).
//
// MEMOIZED — but keyed on the FULL pick timestamp, and that detail is load-bearing.
//
// The old key ended in `String(pred.timestamp).slice(0, 4)` — the YEAR. The reasoning was that the
// line and the result are properties of the FIGHT, not of who called it. That is true of the fight
// and FALSE of the hindsight guard, which depends entirely on WHEN each person predicted. So every
// pick of the same fight in the same year inherited the FIRST caller's resolution and skipped the
// guard: one pundit calling it in January legitimised another "calling" it in November, after the
// fight was over. It put 1,145 post-fight rows (9.1% of the corpus) in as predictions, and they
// fabricated a +52% high-conviction-underdog edge — the same hindsight bug that once doubled
// O'Malley's ROI, reintroduced by an optimisation.
//
// Speed now comes from where it always should have: the disk caches (data/wiki, data/bfo) and the
// per-fighter record memo in lib/ufc-results.js — both genuinely pick-independent. This memo now
// only collapses truly identical picks, which is the only thing it was ever safe to collapse.
// Negative results are cached too (as null). Cleared at the start of each resolveAll run.
let histMemo = new Map();
async function resolveHistorical(pred) {
  if (pred.domain !== "mma" || !pred.opponent) return null;
  const key = `${names.canonical(pred.pick)}|${names.canonical(pred.opponent)}|${pred.timestamp || ""}`;
  if (histMemo.has(key)) {
    const m = histMemo.get(key);
    return m ? { ...pred, ...m } : null;
  }
  let fight = null;
  // Wikipedia: the pick's next fight vs this opponent AFTER the prediction -> result + fight date.
  const win = await ufcResults.outcome(pred.pick, pred.opponent, pred.timestamp).catch(() => null);
  if (win && win.ok) {
    // BFO: the de-vigged closing line for that same fight (matched by the Wikipedia date).
    const line = await oddsHistory.closingLine(pred.pick, pred.opponent, win.date).catch(() => null);
    if (line && line.ok) {
      fight = { marketTicker: null, fightTime: win.date, priceAtCall: line.prob, result: win.result, priceSource: "bfo", oddsOverround: line.overround };
    }
  }
  histMemo.set(key, fight);
  return fight ? { ...pred, ...fight } : null;
}

// Resolve many; returns { resolved, matched, unmatched, noLine, bySource }.
async function resolveAll(preds, cfg = {}) {
  const resolved = [];
  let matched = 0, noLine = 0;
  const bySource = { kalshi: 0, bfo: 0 };
  histMemo = new Map(); // fresh per run
  for (const p of preds) {
    const r = await resolvePick(p, cfg).catch(() => null);
    if (!r) continue;
    matched++;
    if (r.priceAtCall == null) { noLine++; continue; }
    if (r.priceSource) bySource[r.priceSource] = (bySource[r.priceSource] || 0) + 1;
    resolved.push(r);
  }
  return { resolved, matched, unmatched: preds.length - matched, noLine, bySource };
}

module.exports = { resolvePick, resolveHistorical, resolveAll, settledFor, wonFromMarket };
