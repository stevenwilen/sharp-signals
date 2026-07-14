// Match an extracted prediction to its Kalshi market, and price the side that was picked.
//
// THIS FILE IS WHERE MONEY GETS LOST. The extractor works hard to get DIRECTION right
// (see DIRECTION_RULE) and the old matcher threw that away at the last step. It scored the
// pick against every open market and took the argmax, where a bare surname match was enough
// to fire a bet. Verified against the live board, that produced:
//
//   "Usman over Du Plessis"  -> the DU PLESSIS market  (right fight, WRONG SIDE)
//   "Usman by KO"            -> Seok Hyun Ko           (different fighter, DIFFERENT FIGHT)
//
// Kalshi lists each fight as an EVENT with two per-fighter markets (…DUUSM-USM = "Kamaru
// Usman", …DUUSM-DU = "Dricus Du Plessis"). So the job is not "find a market" — it is
// "find the FIGHT, then decide WHICH OF THE TWO SIDES the source was backing", and refuse
// when that cannot be established beyond doubt. A missing signal costs nothing. A backwards
// one costs 5% of bankroll.
const k = require("./kalshi");

// Name handling lives in ONE place (lib/names.js) so the live signal path and the grading path
// cannot drift apart. They had drifted: match.js was fixed to reject surname-only matches while
// results.js was still making them, which is how a "Daniel Santos" pick ended up graded against
// Junior dos Santos's price. Same bug, two files, one fixed.
const names = require("./names");
const cards = require("./cards");
const { norm, nameScore } = names;

const SERIES = { mma: "KXUFCFIGHT", boxing: "KXBOXING" };

// Kalshi encodes the card date in the event ticker: KXUFCFIGHT-26JUL18DUUSM -> 2026-07-18.
// This is the only reliable fight date available; `close_time` on open markets is a
// placeholder set weeks out, which is exactly why "is this fight over?" could not be
// answered and the system was willing to bet on a fight that had already been decided.
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function cardDate(eventTicker) {
  const m = String(eventTicker || "").match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const mo = MONTHS[m[2]];
  if (mo == null) return null;
  return new Date(Date.UTC(2000 + Number(m[1]), mo, Number(m[3])));
}

const cache = {};
async function marketsFor(domain) {
  const series = SERIES[domain];
  if (!series) return [];
  if (!cache[series]) cache[series] = await k.marketsAll({ series_ticker: series, status: "open" });
  return cache[series];
}

// Returns { ticker, price, yesAsk, yesBid, matchTitle, eventTicker, fightDate, matchScore }
// or null with a `reason` explaining the refusal. Refusing is the default, not the exception.
async function matchToMarket(pred, { now = new Date(), cfg = {} } = {}) {
  const markets = await marketsFor(pred.domain);
  if (!markets.length) return null;

  // Group the two per-fighter markets back into the fight they belong to.
  const events = {};
  for (const m of markets) {
    if (!m.yes_sub_title) continue;
    (events[m.event_ticker] = events[m.event_ticker] || []).push(m);
  }

  const cands = [];
  for (const [eventTicker, sides] of Object.entries(events)) {
    for (const m of sides) {
      const sibling = sides.find((s) => s.ticker !== m.ticker);
      const pickS = nameScore(pred.pick, m.yes_sub_title);
      if (!pickS) continue;

      // Does the pick text ALSO name this fighter's opponent? "Usman over Du Plessis" names
      // both, which is precisely how the old matcher ended up buying Du Plessis. If the
      // opposing side scores at least as well, this side is not established.
      const rivalS = sibling ? nameScore(pred.pick, sibling.yes_sub_title) : 0;

      // The extractor already told us who the OPPONENT is. Use it: if the opponent matches
      // the other side of THIS fight, that is strong confirmation we have the right fight
      // and the right side. This is what separates "Usman by KO" (the Du Plessis fight)
      // from Seok Hyun Ko, who merely shares a surname fragment.
      const oppConfirms = sibling && pred.opponent
        ? nameScore(pred.opponent, sibling.yes_sub_title) >= 2 : false;

      cands.push({ m, eventTicker, sibling, pickS, rivalS, oppConfirms,
        score: pickS + (oppConfirms ? 2 : 0) - rivalS });
    }
  }
  if (!cands.length) return null;

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const runnerUp = cands[1];

  // --- REFUSALS. Each of these was a live way to lose money. ---------------------------

  // A bare surname, with nothing else corroborating it, is not an identification. This alone
  // kills both of the verified failures above.
  if (best.pickS < 2 && !best.oppConfirms) {
    return { ok: false, reason: `only a surname matched "${pred.pick}" — not enough to name a side` };
  }

  // The pick names BOTH fighters and nothing breaks the tie. Refuse rather than guess which
  // one they were backing.
  if (best.rivalS >= best.pickS && !best.oppConfirms) {
    return { ok: false, reason: `"${pred.pick}" names both fighters and the direction is unclear` };
  }

  // Two different candidates are equally plausible (e.g. a surname shared across two cards).
  if (runnerUp && runnerUp.score === best.score) {
    return { ok: false, reason: `"${pred.pick}" matches ${best.m.yes_sub_title} and ${runnerUp.m.yes_sub_title} equally` };
  }

  // --- TIME. The fight must be in the FUTURE, and must postdate the call. ---------------
  const fightDate = cardDate(best.eventTicker);
  if (!fightDate) return { ok: false, reason: `cannot read a fight date from ${best.eventTicker}` };

  // The pick must have been made BEFORE the fight. (results.js enforces this for grading;
  // the live path never did, so a "told you so" post could become a bet.)
  if (pred.timestamp && Date.parse(pred.timestamp) > fightDate.getTime() + 36 * 3600e3) {
    return { ok: false, reason: `pick postdates the fight — hindsight, not a prediction` };
  }

  // Filler fights are not worth betting. On a small boxing card the matchmaking is protective,
  // the favourite is a heavy favourite, and there is nothing to disagree about — sources are
  // right constantly and earn nothing. See lib/cards.js. (Boxing only; MMA is unfiltered.)
  if (!(await cards.isWorthIt(pred.domain, best.m.ticker, cfg, "open"))) {
    return { ok: false, reason: `${best.m.yes_sub_title} is filler on the undercard, not a real fight` };
  }

  // Do not bet on fight day. Kalshi leaves markets OPEN while the fight is happening and
  // until an operator settles them, so a fighter who is being knocked out right now shows a
  // collapsing price — which this system would read as a huge edge and shout about at maximum
  // stake. Alerting only while the card is still in the future removes that entirely. You get
  // the signal on Thursday/Friday for a Saturday card, which is when you would bet anyway.
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (fightDate.getTime() <= startOfToday) {
    return { ok: false, reason: `fight is today or already past — too late to bet safely` };
  }

  const { yesBid, yesAsk, mid } = await k.impliedYes(best.m.ticker);
  return {
    ok: true,
    ticker: best.m.ticker,
    eventTicker: best.eventTicker,
    fighter: best.m.yes_sub_title,   // the side we are buying — assert against pred.pick
    opponent: best.sibling ? best.sibling.yes_sub_title : null,
    yesBid, yesAsk, price: mid,
    matchTitle: best.m.title || best.eventTicker,
    fightDate: fightDate.toISOString().slice(0, 10),
    matchScore: best.score,
  };
}

module.exports = { matchToMarket, marketsFor, nameScore, cardDate, SERIES, norm };
