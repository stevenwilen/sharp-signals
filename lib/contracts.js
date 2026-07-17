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
// Kalshi's TAKER trading fee: fee = ceil_to_cent(0.07 * C * P * (1-P)). Quadratic in price, so it is
// largest near 50c and near zero at the wings.
//
// PROVENANCE. The market objects carry no fee field, so this cannot be read from the API. It was
// transcribed from Kalshi's published schedule and then CONFIRMED on 2026-07-16 against seven
// authenticated UFC Quick Order tickets (unsubmitted), which reproduce it exactly. Every EV number
// downstream depends on it, so the scope of that confirmation is recorded in `verifiedScope` and
// enforced per-order by withinVerifiedEnvelope() — an order outside the tested band is priced by
// EXTRAPOLATION and says so, rather than inheriting credibility it did not earn.
const FEES = {
  source: "Kalshi published taker fee schedule, CONFIRMED against seven authenticated UFC Quick Order tickets (2026-07-16): $100 x3 at prices 0.59/0.69/0.89, plus $2/$5/$50/$500 at 0.59 which vary size at a fixed price across a 251x span",
  formula: "fee = ceil_to_cent(rate * contracts * price * (1 - price))  [dollars]",
  rate: 0.07,
  note: "quadratic in price: maximal near $0.50, minimal at the wings",

  // NOT a bare boolean, deliberately. `verified: true` has exactly one consumer — the caveat pushed
  // onto every order — so a single flag would silence that warning GLOBALLY: for maker orders, other
  // series, one-contract orders and multi-fill ladders, none of which the evidence touches. The
  // scope below is machine-readable so `withinVerifiedEnvelope()` can keep warning outside the band
  // that was actually tested, instead of trusting a reader to remember the footnote.
  verifiedScope: {
    verified: true,
    asOf: "2026-07-16",
    takerFormulaOnly: true,
    series: "KXUFCFIGHT",
    side: "yes",
    priceRange: [0.59, 0.89],
    // The size band is bounded by tickets that hold price fixed at 0.59 and vary size ALONE — the $2
    // ticket sets the floor (3.28 contracts), the $500 ticket the ceiling. Five points now span 251x
    // at one price and are exactly linear pre-ceil, so scaling in contracts is measured across the
    // whole band rather than extrapolated into its ends.
    //
    // NOTE THE UNIT. This floor is in CONTRACTS, not dollars. A fixed dollar stake buys FEWER
    // contracts at a higher price, so a $2 order is inside at 59c (3.28 contracts) and OUTSIDE at
    // 89c (2.22 contracts). The envelope check enforces that per order; it is not a dollar rule.
    sizeRange: [3.28, 823.81],
    notionalRange: ["$2", "$500"],
    fills: "single-price fills only",
    rateConstrainedTo: [0.06995195, 0.07000213],
    establishes:
      "taker rate 0.07 and ceil-to-cent rounding, for single-price YES fills on KXUFCFIGHT as of 2026-07-16. " +
      "Seven authenticated Quick Order tickets reproduce exactly (diff 0.00). The admissible rate interval under " +
      "ceil is (0.06995195, 0.07000213] — 50ppm wide, containing 0.07 as its only two-decimal value. ceil is " +
      "discriminated: floor fits 0/7, round-half-up fits 4/7 — it reproduces the four tickets whose exact " +
      "cents happen to land above the .5 boundary, so ceil remains the ONLY mode fitting all seven, but the " +
      "$2 and $5 tickets both fit round-half-up and therefore WEAKEN that discriminator rather than " +
      "strengthening it. LINEARITY IN CONTRACTS IS MEASURED over a 251x " +
      "span at a fixed price, not assumed: at 0.59, 3.28 -> 8.23 -> 82.37 -> 164.76 -> 823.81 contracts " +
      "(251.16x end to end) produce exact pre-ceil fees 0.055540 -> 0.139359 -> 1.394771 -> 2.789881 -> " +
      "13.949575 (251.16x), refuting every rival exponent k*gross^x for x in 0.8-1.5. The ceil premium is " +
      "observed across the whole band rather than inferred at its ends: it adds 8.03% of the fee at 3.28 " +
      "contracts, 0.46% at 8.23, 0.375% at 82.37 and 0.003% at 823.81 — the small-order regime is measured, " +
      "not extrapolated. The $2 and $5 tickets do NOT tighten the rate (their own intervals are 12603ppm and " +
      "5023ppm wide, since a 6-cent fee has coarse resolution); their value is size coverage only.",
    doesNotEstablish: [
      "MAKER fees. No maker example exists. `makerRate` has been REMOVED rather than left at an untested 0.0 — see below.",
      "Settlement/exercise fees — a separate Kalshi line item the order ticket never displays.",
      "Linearity in `contracts` at prices OTHER than 0.59. Size was varied at one price only, so the separable form k*C*P*(1-P) is measured on its two axes independently — linear in C at P=0.59, quadratic in P at C~111-165 — and the cross-term is inferred from separability rather than observed. A non-separable rival (an exponent on C that itself varies with P) is not excluded, though nothing suggests one.",
      "The P=0.50 peak — the very figure that motivates this gate. Tested p(1-p) is 0.2419/0.2139/0.0979; the 0.2500 maximum is never observed. The '1.75c at 50c' number is interpolated from the fitted model, not measured.",
      "Prices outside 0.59-0.89. Below 0.59 is covered only by the formula's own p<->1-p symmetry, which cannot validate itself.",
      "The NO side. Symmetry makes NO@0.31 identical to YES@0.69 only if Kalshi bills side-agnostically, which no YES-only example tests.",
      "Sizes below 3.28 contracts, where the ceil premium keeps growing as size shrinks — it is already 8.03% of the fee at the 3.28 floor. NOTE THE UNIT: the floor is in CONTRACTS, so a fixed dollar stake falls out of the envelope as price rises. A $2 entertainment order is inside at 0.59 (3.28 contracts) but OUTSIDE at 0.70/0.80/0.89 (2.78/2.46/2.22 contracts). $3 and $5 orders are inside across the whole 0.59-0.89 band.",
      "Multi-fill ladders — the actual production path. priceOrder applies ONE ceil to the blended average price; every ticket is a single-price fill. Direction is not uniformly conservative.",
      "Any series other than KXUFCFIGHT (other series carry different published rates), or any date other than 2026-07-16.",
    ],
    examples: "data/fee-examples.json — seven unsubmitted Kalshi UFC Quick Order tickets ($2, $5, $50, $100 x3, $500)",
    verificationRecord: "data/fee-verification.json",
  },

  // makerRate is DELIBERATELY ABSENT. It previously sat here as 0.0 and was dead config: tradingFee
  // never read it, so tradingFee(100,0.50,{makerRate:0.0}) === tradingFee(100,0.50,{makerRate:0.99}).
  // A maker order priced through this code was silently charged the FULL TAKER rate, and stamping
  // `verified` onto an object containing it would have certified a number that was both untested and
  // non-functional. Maker orders now fail closed in priceOrder rather than quietly mispricing.
  makerSupported: false,
  makerNote: "maker fees are unverified AND unimplemented; a maker order is refused, not guessed",
};

// Is this order inside the band the seven tickets actually verified?
//
// FAILS CLOSED ON EVERY DIMENSION, INCLUDING ABSENT ONES. The first version guarded each check with
// a truthiness test — `if (contract && contract.ticker && ...)` — so a missing field SKIPPED its
// check and the order came back inside:true with an empty reason list. An order with no ticker
// passed the series gate as "verified". For a gate whose declared default is "not proven", missing
// data must be a refusal, not a pass.
//
// It also now sees TREATMENT and FILL COUNT. Previously its arity was 4 and it could not observe
// either, so two of the four authorised dimensions — taker-only and single-price-fills — were
// declared in the scope, read by nothing, and enforced only elsewhere. The file header calls this
// function the enforcement mechanism; it now actually is one.
function withinVerifiedEnvelope(order, cfg = FEES) {
  const s = cfg.verifiedScope;
  if (!s || !s.verified) return { inside: false, reasons: ["no verified scope on this fee config"] };
  const { ticker, side, contracts, price, treatment, fillCount } = order || {};
  const out = [];

  // series: exact SEGMENT match. startsWith() let KXUFCFIGHTNIGHT-x squat the KXUFCFIGHT prefix and
  // pass as verified.
  if (!ticker) out.push("no ticker supplied — the series cannot be confirmed");
  else if (String(ticker).split("-")[0] !== s.series)
    out.push(`series ${String(ticker).split("-")[0]} is not ${s.series} — other Kalshi series carry different published rates`);

  if (!side) out.push("no side supplied — only the YES side is verified");
  else if (String(side).toLowerCase() !== s.side) out.push(`${String(side).toUpperCase()} side untested (only ${s.side.toUpperCase()} tickets were verified)`);

  // treatment: ALLOWLIST. A deny-list on the literal "maker" refused exactly one spelling and priced
  // "Maker", "MAKER", "limit", "post_only" and "passive" at the full taker rate.
  if (!treatment) out.push("no treatment supplied — only taker fills are verified");
  else if (String(treatment).toLowerCase() !== "taker") out.push(`treatment "${treatment}" is not a verified taker fill — no fee model exists for it`);

  if (!Number.isFinite(price)) out.push("no price supplied");
  else if (price < s.priceRange[0] || price > s.priceRange[1])
    out.push(`price ${price} is outside the verified band ${s.priceRange[0]}-${s.priceRange[1]}`);

  if (!Number.isFinite(contracts)) out.push("no size supplied");
  else if (contracts < s.sizeRange[0] || contracts > s.sizeRange[1])
    out.push(`size ${contracts} is outside the verified band ${s.sizeRange[0]}-${s.sizeRange[1]} contracts ($2-$500 tickets)`);

  if (!Number.isFinite(fillCount)) out.push("fill count unknown — only single-price fills are verified");
  else if (fillCount > 1) out.push(`${fillCount}-level fill: the fee is one ceil on a blended average price, and every verified ticket was a single-price fill`);

  return { inside: out.length === 0, reasons: out };
}

// Round UP to the cent, always — and now actually true, which it was not before.
//
// TWO BUGS LIVED HERE, in opposite directions.
//
// 1. OVERSTATEMENT. Naive ceil: 0.07*100*0.5*0.5 evaluates to 1.7500000000000002, so ceil(x*100)
//    returned 176 and charged $1.76 where the schedule says $1.75.
//
// 2. UNDERSTATEMENT — worse, because it flatters every edge. The fix for (1) was `toFixed(6)` before
//    ceil, justified by a proof that the exact value has at most 6 decimals. That proof only holds
//    for WHOLE-CENT prices. The real call site (priceOrder -> executableBuy) passes
//    `avgExecutionPrice` rounded to FOUR decimals, where the exact value is a multiple of 1e-10 and
//    toFixed(6) can snap a genuine overshoot down across an integer. Concrete: 636.97 contracts at
//    0.0508 is exactly 215.0000001744 cents, so the fee is $2.16; the old code reported $2.15.
//
// Both are gone because the arithmetic is now EXACT rather than nudged. Everything is scaled to
// integers and evaluated in BigInt, so there is no representation error to round away:
//
//     cents = rate * C * P * (1-P) * 100,  with rate = R/1e6, C = m/1e2, P = k/1e4
//           = R * m * k * (1e4 - k) / 1e14        <- exact, integer numerator
//
// A value outside that domain (more precision than the scaling assumes) is REFUSED rather than
// silently truncated: a fee quietly computed on rounded-off inputs is exactly the class of error
// this function has already produced twice.
const FEE_SCALE = { rate: 1e6, contracts: 1e2, price: 1e4 };
function tradingFee(contracts, price, cfg = FEES) {
  if (!Number.isFinite(contracts) || !Number.isFinite(price)) return null;
  // Price is validated BEFORE the size shortcut. The old order returned 0 for tradingFee(-5, 99) —
  // a nonsense price waved through because contracts <= 0 was checked first.
  if (!(price > 0 && price < 1)) return null;
  if (contracts <= 0) return 0;
  const R = Math.round(cfg.rate * FEE_SCALE.rate);
  const m = Math.round(contracts * FEE_SCALE.contracts);
  const k = Math.round(price * FEE_SCALE.price);
  // round-trip guard: if scaling lost precision, the inputs are outside the modelled domain
  if (Math.abs(R / FEE_SCALE.rate - cfg.rate) > 1e-12) return null;
  if (Math.abs(m / FEE_SCALE.contracts - contracts) > 1e-9) return null;
  if (Math.abs(k / FEE_SCALE.price - price) > 1e-9) return null;
  if (k <= 0 || k >= FEE_SCALE.price) return null;
  const N = BigInt(R) * BigInt(m) * BigInt(k) * BigInt(FEE_SCALE.price - k);
  const D = 10n ** 14n;
  if (N <= 0n) return 0;
  const feeCents = (N + D - 1n) / D;          // exact ceil for positive N
  return Number(feeCents) / 100;
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

  // Non-taker treatments fail closed, by ALLOWLIST. The first version denied the literal string
  // "maker", which refused exactly one spelling: "Maker", "MAKER", " maker", "limit", "post_only"
  // and "passive" all sailed through and were charged the full taker rate with no warning — the
  // precise failure the makerRate removal was supposed to end. Anything that is not exactly a taker
  // fill has no fee model here and is refused rather than guessed.
  const treatment = String(opts.treatment || "taker").toLowerCase();
  if (treatment !== "taker") {
    out.ok = false;
    out.reasons.push(`treatment "${opts.treatment}" is not a verified taker fill — no fee model exists for it (maker fees are unverified AND unimplemented), refusing to price it at the taker rate`);
    return out;
  }
  out.fees = tradingFee(ex.filled, ex.avgExecutionPrice, cfg);
  const env = withinVerifiedEnvelope({
    ticker: contract.ticker, side, contracts: ex.filled, price: ex.avgExecutionPrice,
    treatment, fillCount: ex.fills ? ex.fills.length : null,
  }, cfg);
  out.feeSchedule = {
    rate: cfg.rate, source: cfg.source,
    verifiedScope: cfg.verifiedScope ? { asOf: cfg.verifiedScope.asOf, establishes: cfg.verifiedScope.establishes } : null,
    withinVerifiedEnvelope: env.inside,
    envelopeExceptions: env.reasons,
  };
  if (out.fees === null) { out.ok = false; out.reasons.push("fee could not be computed"); return out; }
  out.totalCost = +(ex.grossCost + out.fees).toFixed(2);
  out.allInPricePerContract = +((ex.grossCost + out.fees) / ex.filled).toFixed(4);

  if (!ex.fullyFilled) out.reasons.push(`book supports only ${ex.filled} of ${contracts} contracts — size must be reduced or the position rejected`);
  // The caveat is raised per ORDER against the tested envelope, not silenced globally by one flag.
  // The seven tickets verified single-price YES fills on KXUFCFIGHT at 0.59-0.89 and 3.28-823.81
  // contracts; an order outside that band is priced by an EXTRAPOLATION and says so.
  // ONE channel, no contradiction. Previously a multi-level fill pushed an "untested billing path"
  // reason while feeSchedule.withinVerifiedEnvelope simultaneously reported TRUE with an empty
  // exception list — the boolean said verified while the prose said untested, which is exactly the
  // over-generalisation a scoped record exists to prevent. Multi-fill is now one of the envelope's
  // own dimensions, so the flag and the warning cannot disagree.
  if (!env.inside)
    out.reasons.push(`fee is EXTRAPOLATED beyond the verified envelope (${env.reasons.join("; ")}) — EV depends on it`);
  out.ok = true;
  return out;
}

module.exports = {
  mapMarket, readPrices, executableBuy, priceOrder, tradingFee, withinVerifiedEnvelope,
  OUTCOME, UNVALIDATED_TYPES, RULE_PATTERNS, FEES, sha, num,
};
