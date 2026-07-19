// COMBO RECOMMENDATION ENGINE — a SEPARATE market with its OWN gates.
//
// Two individually-approved singles do NOT create an approved combo. A Kalshi combo (a multivariate
// market that pays YES only if EVERY leg settles YES) is a distinct market with its own probability,
// price, fee, correlation, freshness and bankroll gates. This engine reads the SEALED singles — it
// never recomputes or touches a forecast — and decides one of four outcomes:
//   COMBO_BUY · COMBO_PRICE_TOO_HIGH · NO_COMBO_BET · COMBO_UNAVAILABLE
//
// It is deliberately conservative and fails closed. It NEVER prices without a live quote, NEVER claims
// a fill is guaranteed, NEVER inflates a probability it cannot justify, and NEVER adds exposure on top
// of the singles beyond its own small, card-capped allocation. There is no order path here or anywhere.
require("./env");
const C = require("./contracts");

const CORRELATION = { INDEPENDENT: "independent", POSITIVE: "positively correlated", NEGATIVE: "negatively correlated", UNCERTAIN: "uncertain" };
const DECISION = { BUY: "COMBO_BUY", PRICE_TOO_HIGH: "COMBO_PRICE_TOO_HIGH", NO_BET: "NO_COMBO_BET", UNAVAILABLE: "COMBO_UNAVAILABLE" };

// Combo-specific policy. NOT the frozen singles config — combos get their OWN conservative numbers,
// never the $3/$4/$5 tiers. Chosen conservatively; not fitted.
const POLICY = {
  maxStakeDollars: 2,          // conservative default cap (spec: no more than $2 unless stricter)
  cardCapDollars: 10,          // must never push total card exposure over the existing $10 cap
  minEdgePoints: 0.06,         // required edge after fees + safety — LARGER than a single, because
                               // forecast errors compound across legs and the fill is uncertain
  feeCushion: 0.02,            // combos price OUTSIDE the verified fee envelope -> extra cushion
  uncertaintyHaircutPerExtraLeg: 0.05,   // 2 legs -> x0.95, 3 legs -> x0.90 (compounding error)
  negativeCorrelationFactor: 0.85,
  maxQuoteAgeSec: 90,          // an RFQ/combo quote older than this is stale -> revalidate/unavailable
  maxLegs: 3,
  minSmartPrice: 0.02,         // below this the max-buy leaves no real room after edge+fees -> a lottery
  minComboProb: 0.03,          // a conservative joint below this is not worth a combo, at any price
};

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const round = (x, n = 4) => +Number(x).toFixed(n);

// A leg (read from the SEALED singles): { ticker, boutId, eventDate, fighter, fight, conservativeProb
// (=sealed systemRange low for the recommended side), ask, maximumAcceptablePrice, forecastHash,
// classification, strongSupport, fightStarted, singleStakeDollars }.

// CORRELATION — classified STRUCTURALLY, never fitted. Same fighter across legs is CONCENTRATION, not a
// combo. Same event is treated as positively correlated (shared conditions) and priced conservatively
// at the independent product (no uplift claimed). Different events are independent. Anything we cannot
// place in time or relate is UNCERTAIN -> the caller fails closed.
function classifyCorrelation(legs) {
  const fighters = legs.map((l) => norm(l.fighter));
  const dupFighter = fighters.find((f, i) => f && fighters.indexOf(f) !== i);
  if (dupFighter) return { class: CORRELATION.UNCERTAIN, concentration: true, reason: `both legs depend on the same fighter (${dupFighter}) — hidden concentration, not a combo` };
  if (legs.some((l) => !l.eventDate)) return { class: CORRELATION.UNCERTAIN, reason: "a leg has no event date — cannot place it in time or relate it to the others" };
  const sameEvent = new Set(legs.map((l) => l.eventDate)).size === 1;
  if (sameEvent) return { class: CORRELATION.POSITIVE, reason: "legs share one event (shared conditions) — priced conservatively at the independent product, no uplift claimed" };
  return { class: CORRELATION.INDEPENDENT, reason: "legs are on different events — treated as independent, with an uncertainty haircut" };
}

// JOINT PROBABILITY — conservative. raw = product of the SEALED conservative leg probabilities; a
// correlation factor that never adds uplift; an uncertainty haircut that grows with leg count.
function jointProbability(legs, correlation) {
  const raw = legs.reduce((p, l) => p * l.conservativeProb, 1);
  const correlationFactor = correlation.class === CORRELATION.NEGATIVE ? POLICY.negativeCorrelationFactor : 1.0;
  const uncertaintyHaircut = round(1 - POLICY.uncertaintyHaircutPerExtraLeg * (legs.length - 1), 4);
  const final = round(raw * correlationFactor * uncertaintyHaircut, 4);
  return {
    rawJoint: round(raw), correlationClass: correlation.class, correlationFactor,
    uncertaintyHaircut, finalConservativeProb: final,
  };
}

// Per-contract taker fee as a fraction of the $1 payout, at a given price. Combos are OUTSIDE the
// verified envelope (different market, low price band), so this is EXTRAPOLATED and flagged.
function perContractFee(price) { return round(C.FEES.rate * price * (1 - price), 4); }

// Fair price, the maximum smart entry price (STRICTLY below fair value), and the edge at a quote.
function pricing(finalProb, quote) {
  const fairPrice = round(finalProb);
  const maxBuyPrice = round(Math.max(0.01, fairPrice - POLICY.minEdgePoints - POLICY.feeCushion));
  const edgeAtQuote = quote == null ? null : round(fairPrice - quote - perContractFee(quote));
  // A combo is a multivariate market, not a single KXUFCFIGHT YES fill, so its fee is ALWAYS outside
  // the verified envelope (2026-07-16, price 0.59-0.89, single-price taker). Flagged, with feeCushion.
  return { fairPrice, maxBuyPrice, edgeAtQuote, quoteFee: quote == null ? null : perContractFee(quote),
    feeExtrapolated: true, feeNote: "combo fee is EXTRAPOLATED beyond the verified single-leg envelope — an extra safety cushion is applied" };
}

// COMBO STAKE within a SEPARATE allocation. Never a single tier; capped; never pushes total card
// exposure over $10; repeated-leg exposure and worst-case single-leg loss are made explicit.
function staking(legs, quote, exposure = {}) {
  const cap = Math.min(POLICY.maxStakeDollars, exposure.comboStakeOverride || POLICY.maxStakeDollars);
  const existingCardExposure = round(exposure.existingCardExposureDollars || 0, 2);
  const remainingCardAllowance = round(POLICY.cardCapDollars - existingCardExposure, 2);
  const stakeDollars = round(Math.max(0, Math.min(cap, remainingCardAllowance)), 2);
  const contracts = quote && stakeDollars > 0 ? Math.floor(stakeDollars / quote) : 0;
  // A leg that is ALSO an active single is exposed twice — record the worst case if that fighter loses.
  const repeatedLegs = legs.filter((l) => (l.singleStakeDollars || 0) > 0)
    .map((l) => ({ fighter: l.fighter, singleStakeDollars: l.singleStakeDollars, maxLossIfLegFails: round((l.singleStakeDollars || 0) + stakeDollars, 2) }));
  return {
    stakeDollars, contracts,
    existingCardExposureDollars: existingCardExposure,
    remainingCardAllowanceDollars: remainingCardAllowance,
    totalCardExposureAfterDollars: round(existingCardExposure + stakeDollars, 2),
    repeatedLegs,
    maxComboLossDollars: stakeDollars,
    maxPayoutDollars: contracts,   // each YES contract pays $1
  };
}

// THE DECISION for one candidate combo. `quote` is a live combo quote object from the read-only quote
// provider: { available, yesAsk, ts, ageSec, marketOpen, ticker } — or { available:false, reason }.
function evaluateCombo(legs, quote, exposure = {}, opts = {}) {
  const now = opts.now || Date.now();
  const audit = { legs: legs.map((l) => ({ ticker: l.ticker, fighter: l.fighter, fight: l.fight, eventDate: l.eventDate, conservativeProb: l.conservativeProb, forecastHash: l.forecastHash, singleStakeDollars: l.singleStakeDollars || 0 })), evaluatedAt: new Date(now).toISOString() };

  if (!Array.isArray(legs) || legs.length < 2)
    return { decision: DECISION.NO_BET, reason: "fewer than 2 eligible BUY legs — nothing to combine", audit };
  if (legs.length > POLICY.maxLegs)
    return { decision: DECISION.NO_BET, reason: `more than ${POLICY.maxLegs} legs — no large lottery-style combos`, audit };

  // A leg that started, is no longer an individual BUY, or was withdrawn is ineligible.
  const bad = legs.find((l) => l.fightStarted || l.eligibleSingle === false);
  if (bad) return { decision: DECISION.NO_BET, reason: `leg ${bad.ticker} is no longer eligible (started/withdrawn/not a BUY)`, audit };

  // 3 legs require STRONG individual support on every leg.
  if (legs.length === 3 && !legs.every((l) => l.strongSupport))
    return { decision: DECISION.NO_BET, reason: "3-leg combo requires strong individual support on every leg", audit };

  const correlation = classifyCorrelation(legs);
  audit.correlation = correlation;
  if (correlation.concentration)
    return { decision: DECISION.NO_BET, reason: correlation.reason, audit };
  if (correlation.class === CORRELATION.UNCERTAIN)
    return { decision: DECISION.NO_BET, reason: `correlation cannot be modeled safely: ${correlation.reason}`, audit };

  const prob = jointProbability(legs, correlation);
  audit.probability = prob;

  // READ-ONLY ESTIMATE (no quote needed). The combo's fair value and the maximum smart entry price are
  // pure functions of the legs' SEALED conservative probabilities — the live quote only decides whether
  // the market currently offers it at/under that price. Surfacing this lets the dashboard show a combo
  // target the human can price on Kalshi themselves, exactly like a single, with NO write/RFQ. It is
  // advisory only: it never becomes a BUY decision (that still requires a real, readable quote below).
  const estPricing = pricing(prob.finalConservativeProb, null);
  audit.estimate = {
    combinedProb: prob.finalConservativeProb,
    fairPrice: estPricing.fairPrice,
    maxBuyPrice: estPricing.maxBuyPrice,
    structurallyAcceptable: estPricing.maxBuyPrice >= POLICY.minSmartPrice && prob.finalConservativeProb >= POLICY.minComboProb,
  };

  // No live quote -> we cannot claim it is purchasable. This is the RFQ/read-only reality: a combo the
  // exchange does not currently offer as a readable market is UNAVAILABLE, never a silent "no bet". The
  // read-only ESTIMATE above still rides along in the audit so the dashboard can show a manual target.
  if (!quote || quote.available === false)
    return { decision: DECISION.UNAVAILABLE, reason: (quote && quote.reason) || "no live combo quote available", estimate: audit.estimate, audit: { ...audit, quote: quote || null } };
  if (quote.marketOpen === false)
    return { decision: DECISION.UNAVAILABLE, reason: "the combo market is not open", audit: { ...audit, quote } };
  if (quote.ageSec != null && quote.ageSec > POLICY.maxQuoteAgeSec)
    return { decision: DECISION.UNAVAILABLE, reason: `combo quote is stale (${quote.ageSec}s > ${POLICY.maxQuoteAgeSec}s) — revalidate before acting`, audit: { ...audit, quote } };
  if (!(quote.yesAsk > 0 && quote.yesAsk < 1))
    return { decision: DECISION.UNAVAILABLE, reason: "combo quote has no usable YES ask", audit: { ...audit, quote } };

  const price = pricing(prob.finalConservativeProb, quote.yesAsk);
  const stake = staking(legs, quote.yesAsk, exposure);
  audit.pricing = { ...price, liveQuote: quote.yesAsk, quoteTs: quote.ts };
  audit.staking = stake;

  // STRUCTURAL VALUE (independent of the current quote): is there ANY price at which this combo carries
  // a real edge after fees + safety, and is the joint probability non-negligible? If not, there is no
  // combo worth making at any price -> NO_BET. This is what separates "no value" from "price too high".
  const structurallyAcceptable = price.maxBuyPrice >= POLICY.minSmartPrice && prob.finalConservativeProb >= POLICY.minComboProb;
  if (!structurallyAcceptable)
    return { decision: DECISION.NO_BET, reason: `joint value insufficient — a conservative ${(prob.finalConservativeProb * 100).toFixed(1)}% joint leaves no safe edge after fees; retaining the singles is better`, audit };

  // Bankroll / card cap: if the combo cannot be funded without breaching the $10 card cap, no bet.
  if (stake.stakeDollars <= 0)
    return { decision: DECISION.NO_BET, reason: `no room under the $10 card cap (existing exposure $${stake.existingCardExposureDollars})`, audit };

  // Price gate: structurally acceptable, so a quote above the maximum smart entry price is PRICE_TOO_HIGH
  // (worth revisiting if it drops), and at/below with a positive edge is a BUY.
  if (quote.yesAsk > price.maxBuyPrice + 1e-9)
    return { decision: DECISION.PRICE_TOO_HIGH, reason: `combo is structurally sound but the live quote ${(quote.yesAsk * 100).toFixed(0)}c is above the maximum ${(price.maxBuyPrice * 100).toFixed(0)}c`, requiredImprovement: round(quote.yesAsk - price.maxBuyPrice), audit };
  if (!(price.edgeAtQuote > 0))
    return { decision: DECISION.NO_BET, reason: "no positive edge at the quote after fees", audit };

  return {
    decision: DECISION.BUY,
    reason: `${(price.edgeAtQuote * 100).toFixed(1)}pts edge after fees at ${(quote.yesAsk * 100).toFixed(0)}c; ${correlation.class}; capped $${stake.stakeDollars} within the $10 card`,
    correlation, probability: prob, pricing: price, staking: stake, quote, audit,
  };
}

// Build all eligible combos from the active BUY legs (2-leg always; 3-leg only when every leg has
// strong support), avoiding overlapping combos that concentrate on one fighter/event. Prefer the
// shortest settlement window, then the largest edge. Returns candidates, not decisions.
function eligibleCombos(legs) {
  const buys = legs.filter((l) => l.eligibleSingle !== false && !l.fightStarted && l.conservativeProb > 0);
  const out = [];
  for (let i = 0; i < buys.length; i++) for (let j = i + 1; j < buys.length; j++) {
    if (norm(buys[i].fighter) === norm(buys[j].fighter)) continue;   // never combine a fighter with themselves
    out.push([buys[i], buys[j]]);
  }
  const strong = buys.filter((l) => l.strongSupport);
  for (let i = 0; i < strong.length; i++) for (let j = i + 1; j < strong.length; j++) for (let m = j + 1; m < strong.length; m++) {
    const set = [strong[i], strong[j], strong[m]];
    if (new Set(set.map((l) => norm(l.fighter))).size < 3) continue;
    out.push(set);
  }
  // shortest settlement window first (prefer combos that resolve soon), then more legs, then... caller ranks by edge
  out.sort((a, b) => {
    const wa = Math.min(...a.map((l) => Date.parse(l.eventDate) || Infinity));
    const wb = Math.min(...b.map((l) => Date.parse(l.eventDate) || Infinity));
    return wa - wb || a.length - b.length;
  });
  return out;
}

module.exports = { CORRELATION, DECISION, POLICY, classifyCorrelation, jointProbability, perContractFee, pricing, staking, evaluateCombo, eligibleCombos };
