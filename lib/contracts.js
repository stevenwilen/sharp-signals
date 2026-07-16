// PHASE 8A/8B — Kalshi contract ingestion, canonical mapping, and EXECUTABLE pricing.
//
// Two rules govern this file.
//
// 1. SETTLEMENT IS READ, NEVER INFERRED. A ticker is a label; `rules_primary` is the contract. The
//    ticker KXUFCFIGHT-26JUL18LEBSEO-SEO looks like it could be anything; only the rules text says
//    what actually pays. Every mapping below is driven by the rules text and the exact wording is
//    stored verbatim on the record. A market whose wording does not map confidently is FLAGGED, not
//    guessed — a mis-mapped settlement is a silent, total loss.
//
// 2. PRICE MEANS EXECUTABLE PRICE. Not midpoint, not last trade. On Kalshi you buy YES by matching
//    resting NO bids, so yes_ask == 1 - best_no_bid (verified against live data). Depth is finite:
//    the ask is only the price of the FIRST contract. Sizing against the top-of-book quote while
//    ignoring the ladder is how a backtest earns money a real order never could.
require("./env");
const crypto = require("crypto");
const E = require("./evidence-eval");

const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

// ---- FEES ------------------------------------------------------------------------------------
// Kalshi's published general trading fee: fee = roundUp(0.07 * C * P * (1-P)) in dollars, charged
// on the taker. It is quadratic in price, so it is largest at 50c and near zero at the wings.
//
// !! PROVENANCE WARNING !! This formula is transcribed from Kalshi's published schedule, NOT read
// from the API — the market objects carry no fee field. Every EV number downstream depends on it.
// It is exposed as config so it can be corrected without touching pricing logic, and any position
// built on an unverified schedule is labelled as such rather than quietly trusted.
const FEES = {
  source: "Kalshi published general trading fee schedule (transcribed, NOT read from the API)",
  verified: false,
  formula: "fee = ceil(rate * contracts * price * (1 - price) * 100) / 100  [dollars]",
  rate: 0.07,
  makerRate: 0.0,
  note: "quadratic in price: maximal near $0.50, minimal at the wings",
};

// Round UP to the cent, always. Understating fees flatters every edge.
//
// The nudge before ceil() is not cosmetic. 0.07*100*0.5*0.5 evaluates to 1.7500000000000002, so a
// naive ceil(x*100) returns 176 and charges $1.76 where the schedule says $1.75. It errs in the safe
// direction, but it is still wrong, and a fee that is silently a cent off sits underneath every EV
// number in the system. Round away the representation noise first, THEN round up honestly.
function tradingFee(contracts, price, cfg = FEES) {
  if (!Number.isFinite(contracts) || !Number.isFinite(price)) return null;
  if (contracts <= 0) return 0;
  if (!(price > 0 && price < 1)) return null;
  const cents = cfg.rate * contracts * price * (1 - price) * 100;
  return Math.ceil(+cents.toFixed(6)) / 100;
}

// ---- CANONICAL OUTCOME TYPES -----------------------------------------------------------------
const OUTCOME = {
  FIGHTER_WINS: "FIGHTER_WINS",
  FIGHTER_WINS_BY_KO: "FIGHTER_WINS_BY_KO",
  FIGHTER_WINS_BY_SUBMISSION: "FIGHTER_WINS_BY_SUBMISSION",
  FIGHTER_WINS_BY_DECISION: "FIGHTER_WINS_BY_DECISION",
  FIGHTER_WINS_IN_ROUND: "FIGHTER_WINS_IN_ROUND",
  FIGHT_ENDS_BY_METHOD: "FIGHT_ENDS_BY_METHOD",
  FIGHT_REACHES_DECISION: "FIGHT_REACHES_DECISION",
  OTHER: "OTHER",
  UNMAPPABLE: "UNMAPPABLE",
};

// Method/round outcomes rest on v7.0.0's FIXED method priors, which are not validated: they make
// Decision the primary path by construction and returned 1/5 correct methods in the first blind
// evaluation. Contracts of these types are mapped and displayed, and go no further.
const UNVALIDATED_TYPES = new Set([
  OUTCOME.FIGHTER_WINS_BY_KO, OUTCOME.FIGHTER_WINS_BY_SUBMISSION, OUTCOME.FIGHTER_WINS_BY_DECISION,
  OUTCOME.FIGHTER_WINS_IN_ROUND, OUTCOME.FIGHT_ENDS_BY_METHOD, OUTCOME.FIGHT_REACHES_DECISION,
]);

// Rules-text patterns, most specific first. Order matters: "wins by KO" also contains "wins", so a
// loose win-pattern checked first would silently swallow every method contract and price it off the
// win probability. That single ordering bug would be invisible and catastrophic.
// Every pattern captures the FIGHTER from the rules text. A method pattern that matched the outcome
// but not the subject would fall back to yes_sub_title — a label, not the contract — and get
// flagged for a disagreement that does not exist.
const RULE_PATTERNS = [
  { type: OUTCOME.FIGHTER_WINS_IN_ROUND, re: /if\s+(.+?)\s+wins?\b[^.]*?\bin\s+round\s+(\d)/i,
    grab: (m) => ({ ruleFighter: m[1].trim(), round: Number(m[2]) }) },
  { type: OUTCOME.FIGHTER_WINS_BY_KO, re: /if\s+(.+?)\s+wins?\b[^.]*?\bby\s+(?:ko|tko|knockout|technical knockout)/i,
    grab: (m) => ({ ruleFighter: m[1].trim() }) },
  { type: OUTCOME.FIGHTER_WINS_BY_SUBMISSION, re: /if\s+(.+?)\s+wins?\b[^.]*?\bby\s+submission/i,
    grab: (m) => ({ ruleFighter: m[1].trim() }) },
  { type: OUTCOME.FIGHTER_WINS_BY_DECISION, re: /if\s+(.+?)\s+wins?\b[^.]*?\bby\s+decision/i,
    grab: (m) => ({ ruleFighter: m[1].trim() }) },
  { type: OUTCOME.FIGHT_REACHES_DECISION, re: /\b(?:goes?|reach(?:es)?)\s+(?:the\s+)?(?:distance|decision)|does\s+not\s+end\s+(?:early|inside)/i },
  { type: OUTCOME.FIGHT_ENDS_BY_METHOD, re: /\bfight\s+ends?\s+by\b/i },
  // The outright winner contract. Deliberately last, and deliberately anchored on the observed
  // Kalshi wording rather than a bare /wins/ that would match anything.
  { type: OUTCOME.FIGHTER_WINS, re: /if\s+(.+?)\s+wins\s+the\s+.*?fight.*?then\s+the\s+market\s+resolves\s+to\s+yes/i, grab: (m) => ({ ruleFighter: m[1].trim() }) },
];

// Map ONE Kalshi market into a canonical contract.
function mapMarket(mkt, bout, snapshotTs) {
  const rules = String(mkt.rules_primary || "");
  const rules2 = String(mkt.rules_secondary || "");
  const flags = [];
  if (!rules) flags.push("market has no rules_primary — settlement is unknown and cannot be inferred from the ticker");

  let type = OUTCOME.UNMAPPABLE, extra = {};
  for (const p of RULE_PATTERNS) {
    const m = rules.match(p.re);
    if (m) { type = p.type; extra = p.grab ? p.grab(m) : {}; break; }
  }
  if (type === OUTCOME.UNMAPPABLE && rules) flags.push("rules wording did not match any known outcome pattern");

  // Which fighter does YES represent? Prefer the rules text (the contract), fall back to
  // yes_sub_title (a label). If they disagree, that is a flag, never a silent choice.
  const subject = (mkt.yes_sub_title || "").trim();
  let fighter = null;
  if (extra.ruleFighter) {
    fighter = extra.ruleFighter;
    if (subject && E.norm(subject) !== E.norm(extra.ruleFighter))
      flags.push(`rules name "${extra.ruleFighter}" but yes_sub_title says "${subject}" — refusing to choose between them`);
  } else if (subject) {
    fighter = subject;
    if (type !== OUTCOME.UNMAPPABLE) flags.push("fighter taken from yes_sub_title because the rules text did not name one");
  }

  // Tie the contract to a bout in our card, by name. A contract we cannot attach to a bout cannot
  // be priced from the tree.
  let side = null;
  if (bout && fighter) {
    if (E.norm(fighter) === bout.a.norm) side = "a";
    else if (E.norm(fighter) === bout.b.norm) side = "b";
    else flags.push(`contract fighter "${fighter}" matches neither fighter in the mapped bout`);
  }

  const px = readPrices(mkt);
  const rec = {
    ticker: mkt.ticker,
    eventTicker: mkt.event_ticker,
    boutId: bout ? bout.boutId : null,
    bout: bout ? `${bout.a.name} vs ${bout.b.name}` : null,
    contractWording: mkt.title || null,
    settlementRules: rules,             // VERBATIM. never paraphrased, never regenerated.
    settlementRulesSecondary: rules2,
    outcomeType: type,
    outcomeSubject: fighter,
    side,
    ...extra,
    marketStatus: mkt.status || null,
    canCloseEarly: mkt.can_close_early ?? null,
    expirationTime: mkt.expiration_time || null,
    ...px,
    snapshotTimestamp: new Date(snapshotTs).toISOString(),
    unvalidatedModel: UNVALIDATED_TYPES.has(type),
    modelStatus: UNVALIDATED_TYPES.has(type) ? "UNVALIDATED METHOD MODEL" : null,
    flags,
    mappable: type !== OUTCOME.UNMAPPABLE && flags.length === 0,
  };
  rec.contractHash = sha({ ...rec, contractHash: undefined });
  return rec;
}

// Kalshi prices arrive as decimal STRINGS ("0.4600"). Number("") is 0 and Number(null) is 0 — a
// silent zero here becomes a free contract and an infinite edge. Everything non-finite stays null.
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function readPrices(mkt) {
  return {
    yesBid: num(mkt.yes_bid_dollars), yesAsk: num(mkt.yes_ask_dollars),
    noBid: num(mkt.no_bid_dollars), noAsk: num(mkt.no_ask_dollars),
    yesBidSize: num(mkt.yes_bid_size_fp), yesAskSize: num(mkt.yes_ask_size_fp),
    lastTrade: num(mkt.last_price_dollars),
    openInterest: num(mkt.open_interest_fp), volume: num(mkt.volume_fp),
  };
}

// ---- EXECUTABLE PRICE ------------------------------------------------------------------------
// Walk the ladder. On Kalshi the book holds resting BIDS on both sides; buying YES consumes resting
// NO bids, where a NO bid at price q is a YES ask at (1 - q). Verified against live data:
// yes_ask == 1 - best_no_bid.
//
// Both arrays are ascending by price, so the BEST bid is the LAST element — and the best NO bid is
// the CHEAPEST yes ask. Walking from the wrong end would fill at the worst price in the book and
// report it as the best.
function executableBuy(orderbook, side, contracts) {
  const o = (orderbook && (orderbook.orderbook_fp || orderbook.orderbook)) || orderbook || {};
  // to buy YES consume NO bids; to buy NO consume YES bids
  const raw = side === "yes" ? (o.no_dollars || o.no || []) : (o.yes_dollars || o.yes || []);
  const levels = raw.map((r) => ({ counterPrice: Number(r[0]), size: Number(r[1]) }))
    .filter((r) => Number.isFinite(r.counterPrice) && Number.isFinite(r.size) && r.size > 0)
    .map((r) => ({ price: +(1 - r.counterPrice).toFixed(4), size: r.size }))
    .sort((x, y) => x.price - y.price);           // cheapest fill first

  const depthTotal = levels.reduce((s, l) => s + l.size, 0);
  if (!levels.length) return { ok: false, reason: "empty order book on the side required to fill this trade", depthTotal: 0 };

  let need = contracts, cost = 0, filled = 0;
  const fills = [];
  for (const l of levels) {
    if (need <= 0) break;
    const take = Math.min(need, l.size);
    cost += take * l.price; filled += take; need -= take;
    fills.push({ price: l.price, contracts: +take.toFixed(2) });
  }
  const topPrice = levels[0].price;
  const avg = filled > 0 ? cost / filled : null;
  return {
    ok: filled > 0,
    requested: contracts,
    filled: +filled.toFixed(2),
    fullyFilled: filled >= contracts - 1e-9,
    topOfBookPrice: topPrice,
    avgExecutionPrice: avg === null ? null : +avg.toFixed(4),
    // Slippage is measured, not assumed: the gap between the quote you saw and the price you'd pay.
    slippage: avg === null ? null : +(avg - topPrice).toFixed(4),
    grossCost: +cost.toFixed(2),
    depthTotal: +depthTotal.toFixed(2),
    fills,
    maxFillable: +depthTotal.toFixed(2),
  };
}

// The full executable picture for a proposed size, fees included, with an explicit verdict on
// whether the book can actually support it.
function priceOrder(contract, orderbook, contracts, opts = {}) {
  const cfg = opts.fees || FEES;
  const maxAgeMs = opts.maxSnapshotAgeMs ?? 15 * 60 * 1000;
  const nowTs = opts.nowTs;
  const side = opts.side || "yes";
  const out = { ticker: contract.ticker, side, requestedContracts: contracts, reasons: [] };

  if (!Number.isFinite(contracts) || contracts <= 0) { out.ok = false; out.reasons.push("non-positive size"); return out; }
  if (contract.marketStatus !== "active") { out.ok = false; out.reasons.push(`market status is "${contract.marketStatus}" — not tradeable`); return out; }

  // A stale snapshot is a price that may no longer exist. Age is always reported; if a clock is
  // supplied it is enforced.
  if (Number.isFinite(nowTs)) {
    const age = nowTs - Date.parse(contract.snapshotTimestamp);
    out.snapshotAgeMs = age;
    out.snapshotAgeMinutes = +(age / 60000).toFixed(2);
    if (age > maxAgeMs) { out.ok = false; out.reasons.push(`snapshot is ${(age / 60000).toFixed(1)} min old — stale, refusing to price against it`); return out; }
  } else out.snapshotAgeMs = null;

  const ex = executableBuy(orderbook, side, contracts);
  if (!ex.ok) { out.ok = false; out.reasons.push(ex.reason || "could not fill any size"); out.maxFillable = ex.depthTotal; return out; }
  Object.assign(out, ex);

  // Spread from the quoted book — a wide spread is a real cost signal even before slippage.
  const bid = side === "yes" ? contract.yesBid : contract.noBid;
  const ask = side === "yes" ? contract.yesAsk : contract.noAsk;
  out.quotedBid = bid; out.quotedAsk = ask;
  out.spread = (bid !== null && ask !== null) ? +(ask - bid).toFixed(4) : null;

  out.fees = tradingFee(ex.filled, ex.avgExecutionPrice, cfg);
  out.feeSchedule = { rate: cfg.rate, verified: cfg.verified, source: cfg.source };
  if (out.fees === null) { out.ok = false; out.reasons.push("fee could not be computed"); return out; }
  out.totalCost = +(ex.grossCost + out.fees).toFixed(2);
  out.allInPricePerContract = +((ex.grossCost + out.fees) / ex.filled).toFixed(4);

  if (!ex.fullyFilled) out.reasons.push(`book supports only ${ex.filled} of ${contracts} contracts — size must be reduced or the position rejected`);
  if (!cfg.verified) out.reasons.push("fee schedule is TRANSCRIBED, not verified against the API — EV depends on it");
  out.ok = true;
  return out;
}

module.exports = {
  mapMarket, readPrices, executableBuy, priceOrder, tradingFee,
  OUTCOME, UNVALIDATED_TYPES, RULE_PATTERNS, FEES, sha, num,
};
