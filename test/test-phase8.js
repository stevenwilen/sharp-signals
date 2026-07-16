// Unit tests for Phase 8: contract mapping, executable pricing, coherence, correlation, sizing.
//
// The failures these guard against are expensive and quiet: a method contract priced off the win
// probability, an order sized against a top-of-book quote the book cannot honour, two overlapping
// bets counted as diversification, or Kelly sizing to a probability the system has not earned.
const C = require("../lib/contracts");
const V = require("../lib/contract-value");
const P = require("../lib/portfolio");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? " -> " + extra : ""}`); } };

const A = "Alice Ace", B = "Bob Bruiser";
const BOUT = { boutId: "b1", a: { name: A, norm: "alice ace" }, b: { name: B, norm: "bob bruiser" } };
const TS = Date.parse("2026-07-18T20:00:00Z");
const mkt = (o = {}) => ({
  ticker: "KXUFCFIGHT-26JUL18ALIBOB-ALI", event_ticker: "KXUFCFIGHT-26JUL18ALIBOB",
  title: `Will ${A} win the Ace vs Bruiser professional MMA fight scheduled for Jul 18, 2026?`,
  yes_sub_title: A,
  rules_primary: `If ${A} wins the Ace vs Bruiser professional MMA fight originally scheduled for Jul 18, 2026, then the market resolves to Yes.`,
  rules_secondary: "If the fight is declared a tie or no contest, the market resolves to No.",
  status: "active", yes_bid_dollars: "0.4300", yes_ask_dollars: "0.4600",
  no_bid_dollars: "0.5400", no_ask_dollars: "0.5700",
  yes_bid_size_fp: "430.00", yes_ask_size_fp: "19902.05", last_price_dollars: "0.4600",
  open_interest_fp: "6584.70", volume_fp: "6590.70", ...o });
// ascending by price; best bid last (the real Kalshi shape)
const book = (noLevels, yesLevels) => ({ orderbook_fp: {
  no_dollars: noLevels || [["0.5200", "2038.00"], ["0.5300", "2035.00"], ["0.5400", "19902.05"]],
  yes_dollars: yesLevels || [["0.4100", "330.40"], ["0.4200", "225.00"], ["0.4300", "430.00"]] } });
const tree = (pA) => ({
  [A]: { win: pA, byKO: +(pA * 0.33).toFixed(4), bySubmission: +(pA * 0.17).toFixed(4), byDecision: +(pA * 0.5).toFixed(4),
    koByRound: { r1: +(pA * 0.33 * 0.45).toFixed(4), r2: +(pA * 0.33 * 0.32).toFixed(4), r3: +(pA * 0.33 * 0.23).toFixed(4) },
    submissionByRound: { r1: +(pA * 0.17 * 0.45).toFixed(4), r2: +(pA * 0.17 * 0.32).toFixed(4), r3: +(pA * 0.17 * 0.23).toFixed(4) } },
  [B]: { win: +(1 - pA).toFixed(4), byKO: +((1 - pA) * 0.33).toFixed(4), bySubmission: +((1 - pA) * 0.17).toFixed(4), byDecision: +((1 - pA) * 0.5).toFixed(4),
    koByRound: { r1: +((1 - pA) * 0.33 * 0.45).toFixed(4), r2: 0, r3: 0 }, submissionByRound: { r1: 0, r2: 0, r3: 0 } },
});
// A forecast that actually holds a view, priced against a contemporaneous wall-clock baseline.
// Both are required: a forecast with no adjustments has no opinion, and an opening-line prior
// cannot be traded against a current price. Tests that need those failure modes override them.
const ADJ = [{ adjustmentId: "a1", fighterFavored: A, mechanism: "striking", finalAppliedLogOdds: 0.14,
  evidenceTopics: ["power"], informationOriginCount: 3, originIds: ["o1", "o2", "o3"] }];
const fc = (o = {}) => ({ boutId: "b1", fight: `${A} vs ${B}`, status: "COMPLETE", evidenceCoverage: "WELL COVERED",
  outcomeTree: tree(0.6), systemRange: { forFighter: A, low: 0.55, high: 0.65 },
  appliedAdjustments: ADJ,
  marketBaseline: { probability: 0.58, clockBasis: "WALL_CLOCK", fallbackLevel: "A", staleCheckEnforceable: true },
  ...o });

console.log("8A: SETTLEMENT IS READ, NEVER INFERRED");
{
  const c = C.mapMarket(mkt(), BOUT, TS);
  ok("outright win maps to FIGHTER_WINS", c.outcomeType === C.OUTCOME.FIGHTER_WINS, c.outcomeType);
  ok("settlement rules stored VERBATIM", c.settlementRules === mkt().rules_primary);
  ok("secondary settlement rules stored too", /tie or no contest/.test(c.settlementRulesSecondary));
  ok("fighter taken from the RULES text, not the ticker", c.outcomeSubject === A);
  ok("contract binds to the right side of the bout", c.side === "a");
  ok("contract is hashed", typeof c.contractHash === "string" && c.contractHash.length === 16);
  ok("mappable with no flags", c.mappable === true, JSON.stringify(c.flags));
  // a market with no rules cannot be mapped from its ticker
  const noRules = C.mapMarket(mkt({ rules_primary: "" }), BOUT, TS);
  ok("no rules text -> UNMAPPABLE, never guessed from the ticker", noRules.outcomeType === C.OUTCOME.UNMAPPABLE);
  ok("no-rules flag says settlement is unknown", noRules.flags.some((f) => /settlement is unknown/.test(f)));
  ok("unmappable is not mappable", noRules.mappable === false);
}

console.log("\n8A: METHOD CONTRACTS MUST NOT BE SWALLOWED BY THE WIN PATTERN");
{
  // the ordering bug that would be invisible and catastrophic
  const ko = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight by KO or TKO, then the market resolves to Yes.` }), BOUT, TS);
  ok("'wins by KO' maps to KO, NOT to FIGHTER_WINS", ko.outcomeType === C.OUTCOME.FIGHTER_WINS_BY_KO, ko.outcomeType);
  const sub = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight by submission, then the market resolves to Yes.` }), BOUT, TS);
  ok("'wins by submission' maps to submission", sub.outcomeType === C.OUTCOME.FIGHTER_WINS_BY_SUBMISSION, sub.outcomeType);
  const dec = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight by decision, then the market resolves to Yes.` }), BOUT, TS);
  ok("'wins by decision' maps to decision", dec.outcomeType === C.OUTCOME.FIGHTER_WINS_BY_DECISION, dec.outcomeType);
  const rd = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight in round 2, then the market resolves to Yes.` }), BOUT, TS);
  ok("'wins in round 2' maps to round, and captures the round", rd.outcomeType === C.OUTCOME.FIGHTER_WINS_IN_ROUND && rd.round === 2);
  ok("method contracts are flagged UNVALIDATED METHOD MODEL", [ko, sub, dec, rd].every((x) => x.unvalidatedModel && x.modelStatus === "UNVALIDATED METHOD MODEL"));
  ok("outright winner is NOT flagged unvalidated", C.mapMarket(mkt(), BOUT, TS).unvalidatedModel === false);
  // name collisions must not create method contracts
  const koName = C.mapMarket(mkt({ yes_sub_title: "Seok Hyun Ko",
    rules_primary: "If Seok Hyun Ko wins the Lebosnoyani vs Ko professional MMA fight originally scheduled for Jul 18, 2026, then the market resolves to Yes." }), null, TS);
  ok("a fighter named 'Ko' does NOT become a KO contract", koName.outcomeType === C.OUTCOME.FIGHTER_WINS, koName.outcomeType);
}

console.log("\n8A: DISAGREEMENT IS FLAGGED, NEVER RESOLVED SILENTLY");
{
  const c = C.mapMarket(mkt({ yes_sub_title: "Someone Else" }), BOUT, TS);
  ok("rules/label fighter disagreement is flagged", c.flags.some((f) => /refusing to choose/.test(f)));
  ok("disagreement makes the contract unmappable", c.mappable === false);
  const off = C.mapMarket(mkt({ yes_sub_title: "Carl Stranger",
    rules_primary: "If Carl Stranger wins the Stranger vs Nobody professional MMA fight originally scheduled for Jul 18, 2026, then the market resolves to Yes." }), BOUT, TS);
  ok("a fighter in neither side of the bout is flagged", off.flags.some((f) => /matches neither fighter/.test(f)));
}

console.log("\n8B: EXECUTABLE PRICE WALKS THE BOOK");
{
  // buying YES consumes NO bids: best no bid 0.54 -> yes ask 0.46
  const ex = C.executableBuy(book(), "yes", 100);
  ok("cheapest YES fill = 1 - best NO bid", ex.topOfBookPrice === 0.46, String(ex.topOfBookPrice));
  ok("small order fills entirely at the top level", ex.fullyFilled && ex.avgExecutionPrice === 0.46);
  ok("no slippage on a small order", ex.slippage === 0);
  // an order larger than the top level must walk UP and cost more
  const big = C.executableBuy(book([["0.5200", "10.00"], ["0.5300", "10.00"], ["0.5400", "10.00"]]), "yes", 25);
  ok("a large order walks the ladder", big.avgExecutionPrice > 0.46, String(big.avgExecutionPrice));
  ok("walking the ladder produces measured slippage", big.slippage > 0, String(big.slippage));
  ok("fill respects available depth", big.filled === 25);
  const tooBig = C.executableBuy(book([["0.5400", "10.00"]]), "yes", 100);
  ok("an order beyond total depth is partially filled and says so", tooBig.filled === 10 && !tooBig.fullyFilled);
  ok("maxFillable reports the real ceiling", tooBig.maxFillable === 10);
  const empty = C.executableBuy({ orderbook_fp: { no_dollars: [], yes_dollars: [] } }, "yes", 10);
  ok("an empty book cannot fill and says why", !empty.ok && /empty order book/.test(empty.reason));
  // buying NO consumes YES bids
  const noSide = C.executableBuy(book(), "no", 100);
  ok("buying NO consumes YES bids: 1 - best yes bid", noSide.topOfBookPrice === 0.57, String(noSide.topOfBookPrice));
}

console.log("\n8B: FEES AND STALENESS");
{
  // fee is quadratic: maximal at 50c
  const at50 = C.tradingFee(100, 0.5), at10 = C.tradingFee(100, 0.1);
  ok("fee is highest near 50c", at50 > at10, `${at50} vs ${at10}`);
  ok("fee at 50c = ceil(0.07*100*0.25*100)/100 = 1.75", Math.abs(at50 - 1.75) < 1e-9, String(at50));
  ok("fee rounds UP (never understate cost)", C.tradingFee(1, 0.5) === 0.02, String(C.tradingFee(1, 0.5)));
  ok("fee refuses a non-finite price", C.tradingFee(100, NaN) === null);
  // The taker formula was verified on 2026-07-16 against three authenticated Kalshi tickets. It is
  // recorded as a SCOPED record, never a bare boolean: the old `verified` flag had one consumer —
  // the caveat on every order — so flipping it would have silenced that warning globally, including
  // for maker orders, other series and multi-fill ladders that nothing tested.
  ok("fee config exposes no bare `verified` boolean", C.FEES.verified === undefined);
  ok("verification is a scoped record", C.FEES.verifiedScope.verified === true && !!C.FEES.verifiedScope.asOf);
  ok("scope is TAKER-only", C.FEES.verifiedScope.takerFormulaOnly === true);
  ok("scope names what it does NOT establish", C.FEES.verifiedScope.doesNotEstablish.length >= 8);
  ok("maker fees are explicitly listed as not established", C.FEES.verifiedScope.doesNotEstablish.some((x) => /MAKER/.test(x)));
  ok("makerRate is REMOVED, not left at an untested 0.0", C.FEES.makerRate === undefined && C.FEES.makerSupported === false);

  const c = C.mapMarket(mkt(), BOUT, TS);
  const fresh = C.priceOrder(c, book(), 100, { nowTs: TS + 60000 });
  ok("a fresh snapshot prices", fresh.ok === true, JSON.stringify(fresh.reasons));
  ok("all-in price exceeds the raw execution price (fees included)", fresh.allInPricePerContract > fresh.avgExecutionPrice);
  // THE SAFETY RAIL. This assertion is the only guarantee that the fee caveat reaches a caller.
  // It is kept and STRENGTHENED rather than deleted: the caveat is now raised per-order against the
  // verified envelope, so it still fires exactly where the evidence runs out. The test fixture
  // prices at 0.46 on 100 contracts — outside the verified band (0.59-0.89, 111-165 contracts) — so
  // it MUST warn.
  ok("an order OUTSIDE the verified envelope still warns", fresh.reasons.some((r) => /EXTRAPOLATED beyond the verified envelope/.test(r)),
    JSON.stringify(fresh.reasons));
  ok("the warning names why it is outside", /price 0.46 is outside|size 100 is outside/.test(fresh.reasons.join(" ")));
  ok("the order records envelope status", fresh.feeSchedule.withinVerifiedEnvelope === false && fresh.feeSchedule.envelopeExceptions.length > 0);
  ok("the order carries the scope's asOf date", fresh.feeSchedule.verifiedScope.asOf === "2026-07-16");
  // an order INSIDE the envelope must NOT carry the extrapolation caveat
  const inEnv = C.priceOrder(
    C.mapMarket(mkt({ ticker: "KXUFCFIGHT-26JUL18ALIBOB-ALI", yes_ask_dollars: "0.6900", no_bid_dollars: "0.3100" }), BOUT, TS),
    book([["0.3100", "50000.00"]]), 141.84, { nowTs: TS });
  ok("an order INSIDE the verified envelope does not warn", inEnv.ok && !inEnv.reasons.some((r) => /EXTRAPOLATED/.test(r)),
    JSON.stringify(inEnv.reasons));
  ok("...and is marked within the envelope", inEnv.feeSchedule.withinVerifiedEnvelope === true);
  // maker fails closed rather than being charged the taker rate
  const maker = C.priceOrder(c, book(), 100, { nowTs: TS, treatment: "maker" });
  ok("a maker order FAILS CLOSED rather than being priced at the taker rate", maker.ok === false);
  ok("...and says the maker fee is unverified AND unimplemented", maker.reasons.some((r) => /unverified AND unimplemented/.test(r)));
  // multi-fill is flagged as an untested billing path
  const multi = C.priceOrder(c, book([["0.5200", "10.00"], ["0.5300", "10.00"], ["0.5400", "10.00"]]), 25, { nowTs: TS });
  ok("a multi-level fill warns that the billing path is untested", multi.reasons.some((r) => /multi-level fill/.test(r)));

  // EXACT ARITHMETIC — the two bugs that lived in tradingFee, in opposite directions
  ok("no overstatement: 100 @ 0.50 is 1.75, not 1.76", C.tradingFee(100, 0.5) === 1.75, String(C.tradingFee(100, 0.5)));
  ok("no understatement at a 4dp average price: 636.97 @ 0.0508 is 2.16, not 2.15",
    C.tradingFee(636.97, 0.0508) === 2.16, String(C.tradingFee(636.97, 0.0508)));
  ok("price is validated BEFORE the size shortcut: tradingFee(-5, 99) is null, not 0", C.tradingFee(-5, 99) === null);
  ok("tradingFee(0, 5) is null (invalid price), not 0", C.tradingFee(0, 5) === null);
  ok("tradingFee(0, 0.5) is 0 (no contracts at a valid price)", C.tradingFee(0, 0.5) === 0);
  ok("inputs finer than the modelled precision are REFUSED, not truncated", C.tradingFee(100, 0.123456789) === null);
  // exhaustive: the code equals exact integer truth across the whole-cent domain
  {
    let bad = 0;
    for (let k = 1; k < 100; k += 1) for (let m = 1; m <= 400; m += 1) {
      const N = 70000n * BigInt(m * 100) * BigInt(k * 100) * BigInt(10000 - k * 100), D = 10n ** 14n;
      if (C.tradingFee(m, k / 100) !== Number((N + D - 1n) / D) / 100) bad++;
    }
    ok("exhaustive: matches exact BigInt truth over 39,600 whole-cent cases", bad === 0, `${bad} mismatches`);
  }
  // the three authenticated tickets, asserted in the suite itself
  ok("authenticated ticket 1 (141.84 @ 0.69) reproduces 2.13", C.tradingFee(141.84, 0.69) === 2.13);
  ok("authenticated ticket 2 (164.76 @ 0.59) reproduces 2.79", C.tradingFee(164.76, 0.59) === 2.79);
  ok("authenticated ticket 3 (111.49 @ 0.89) reproduces 0.77", C.tradingFee(111.49, 0.89) === 0.77);
  ok("using the post-fee effective chance instead of the price would MISMATCH", C.tradingFee(141.84, 0.71) !== 2.13);
  const stale = C.priceOrder(c, book(), 100, { nowTs: TS + 60 * 60000 });
  ok("a stale snapshot is REFUSED, not priced", stale.ok === false && stale.reasons.some((r) => /stale/.test(r)));
  const closed = C.priceOrder(C.mapMarket(mkt({ status: "settled" }), BOUT, TS), book(), 100, { nowTs: TS });
  ok("a non-active market is not tradeable", closed.ok === false && closed.reasons.some((r) => /not tradeable/.test(r)));
}

console.log("\n8C: COHERENCE IS ENFORCED");
{
  ok("a well-formed tree is coherent", V.verifyTreeCoherence(fc()).ok);
  const bad1 = tree(0.6); bad1[A].byKO = 0.9;
  ok("KO exceeding win probability is caught", !V.verifyTreeCoherence(fc({ outcomeTree: bad1 })).ok);
  const bad2 = tree(0.6); bad2[A].byDecision = 0.9;
  ok("methods not summing to win is caught", V.verifyTreeCoherence(fc({ outcomeTree: bad2 })).errors.some((e) => /methods sum/.test(e)));
  const bad3 = tree(0.6); bad3[A].koByRound.r1 = 0.9;
  ok("a round KO exceeding total KO is caught", V.verifyTreeCoherence(fc({ outcomeTree: bad3 })).errors.some((e) => /koByRound/.test(e)));
  const bad4 = tree(0.6); bad4[B].win = 0.9;
  ok("win probabilities not summing to 1 is caught", V.verifyTreeCoherence(fc({ outcomeTree: bad4 })).errors.some((e) => /sum to/.test(e)));

  // overlapping contracts must read the SAME tree
  const win = C.mapMarket(mkt(), BOUT, TS);
  const ko = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight by KO or TKO, then the market resolves to Yes.` }), BOUT, TS);
  const pw = V.probabilityFor(win, fc()), pk = V.probabilityFor(ko, fc());
  ok("win contract reads the win cell", pw.probability === 0.6);
  ok("KO contract reads the KO cell of the SAME tree", Math.abs(pk.probability - 0.198) < 1e-9, String(pk.probability));
  ok("KO probability never exceeds win probability", pk.probability < pw.probability);
  ok("only the outright win is marked validated", pw.validated === true && pk.validated === false);
  const r1 = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight in round 1, then the market resolves to Yes.` }), BOUT, TS);
  const pr = V.probabilityFor(r1, fc());
  ok("round-1 probability <= overall KO+sub", pr.probability <= pk.probability + tree(0.6)[A].bySubmission + 1e-9);
  const r9 = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight in round 9, then the market resolves to Yes.` }), BOUT, TS);
  ok("an unmodelled round is UNPRICED, not invented", V.probabilityFor(r9, fc()).classification === "UNPRICED");
}

console.log("\n8C/8D: METHOD CONTRACTS ARE BLOCKED");
{
  const ko = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight by KO or TKO, then the market resolves to Yes.` }), BOUT, TS);
  const v = V.valueContract(ko, fc(), book(), { contracts: 100, nowTs: TS });
  ok("a method contract is ANALYSIS ONLY", v.classification === "ANALYSIS ONLY", v.classification);
  ok("its probability source is labelled UNVALIDATED METHOD MODEL", v.probabilityModelStatus === "UNVALIDATED METHOD MODEL");
  ok("it is blocked from ranking, sizing, alerts and highest-leverage", v.blockedFrom.length === 4);
  ok("it is still MAPPED and displayed (probability present)", typeof v.systemCentralProbability === "number");
  ok("it receives no stake", P.sizePosition(v, 10000).sized === false);
  // even if something upstream mislabels it, the ranker independently blocks it
  const forced = P.rankContracts([{ ...v, classification: "ACTIONABLE EXPERIMENTAL", outcomeType: C.OUTCOME.FIGHTER_WINS_BY_KO }]);
  ok("the ranker independently demotes a non-outright ACTIONABLE contract", forced[0].classification === "ANALYSIS ONLY");
}

console.log("\n8D: VALUE, CONSERVATIVE BOUND, AND THE EDGE LABEL");
{
  const c = C.mapMarket(mkt(), BOUT, TS);
  const v = V.valueContract(c, fc(), book(), { contracts: 100, nowTs: TS });
  ok("central probability is the tree win cell", v.systemCentralProbability === 0.6);
  ok("conservative probability is the LOW end of the range", v.conservativeProbability === 0.55);
  ok("conservative < central (shaded against the position)", v.conservativeProbability < v.systemCentralProbability);
  ok("EV uses the all-in price, not the quote", Math.abs(v.expectedValueCentral - (0.6 - v.allInPrice)) < 1e-9);
  ok("conservative EV is lower than central EV", v.expectedValueConservative < v.expectedValueCentral);
  ok("break-even probability equals the all-in price", v.breakEvenProbability === v.allInPrice);
  ok("max acceptable price comes from the CONSERVATIVE bound", v.maximumAcceptablePrice === 0.55);
  ok("edge is labelled UNVERIFIED ESTIMATED EDGE", v.unverifiedEstimatedEdge.label === "UNVERIFIED ESTIMATED EDGE");
  ok("edge carries the no-demonstrated-skill caveat", /never demonstrated predictive skill/.test(v.unverifiedEstimatedEdge.caveat));
  ok("main uncertainty is described", typeof v.mainUncertainty === "string" && v.mainUncertainty.length > 0);
  ok("qualifies only when CONSERVATIVE EV survives costs", v.qualifies === (v.expectedValueConservative > 0));

  // conservative negative -> NO BET even when central is positive
  const thin = V.valueContract(c, fc({ systemRange: { forFighter: A, low: 0.46, high: 0.74 } }), book(), { contracts: 100, nowTs: TS });
  ok("central-positive but conservative-negative => NO BET", thin.classification === "NO BET", `${thin.classification} consEV=${thin.expectedValueConservative}`);
  ok("...and the reason names the conservative estimate", /conservative EV/.test(thin.reason || ""));
  // a HUMAN REVIEW forecast cannot be actionable
  const hr = V.valueContract(c, fc({ status: "HUMAN REVIEW REQUIRED" }), book(), { contracts: 100, nowTs: TS });
  ok("a HUMAN REVIEW forecast blocks actionability", hr.classification === "HUMAN REVIEW REQUIRED");
  // BASELINE UNAVAILABLE -> UNPRICED
  const nb = V.valueContract(c, fc({ status: "BASELINE UNAVAILABLE" }), book(), { contracts: 100, nowTs: TS });
  ok("BASELINE UNAVAILABLE => UNPRICED", nb.classification === "UNPRICED");
  // illiquid -> rejected/resized
  const illiquid = V.valueContract(c, fc(), book([["0.5400", "5.00"]]), { contracts: 100, nowTs: TS });
  ok("a book that cannot fill the size => NO BET", illiquid.classification === "NO BET", illiquid.classification);
  ok("...and the reason names the fill shortfall", /cannot fill/.test(illiquid.reason || ""));
}

console.log("\n8D: THE STALE-PRIOR GATE (the first shadow run's 7 fake edges)");
{
  const c = C.mapMarket(mkt(), BOUT, TS);
  const adj = [{ adjustmentId: "a1", fighterFavored: A, mechanism: "striking", finalAppliedLogOdds: 0.14, evidenceTopics: ["power"], informationOriginCount: 3, originIds: ["o1"] }];
  // an OPENING-line prior cannot value a contract trading at a CURRENT price
  const staleFc = fc({ appliedAdjustments: adj, marketBaseline: { probability: 0.6, clockBasis: "LOGICAL_OPEN", fallbackLevel: "B", staleCheckEnforceable: false } });
  const v = V.valueContract(c, staleFc, book(), { contracts: 100, nowTs: TS });
  ok("a LOGICAL_OPEN prior blocks an ACTIONABLE position", v.classification === "NO BET", v.classification);
  ok("the block is explicitly flagged", v.staleBaselineBlocked === true);
  ok("the reason names the open-vs-current mismatch", /market's move since the open, not an edge/.test(v.reason));
  ok("the detail records the offending tier and clock", v.staleBaselineDetail.baselineClock === "LOGICAL_OPEN" && v.staleBaselineDetail.baselineTier === "B");
  ok("a stale-blocked contract is never sized", P.sizePosition(v, 10000).sized === false);

  // a wall-clock prior contemporaneous with the price is allowed through
  const liveFc = fc({ appliedAdjustments: adj, marketBaseline: { probability: 0.6, clockBasis: "WALL_CLOCK", fallbackLevel: "A", staleCheckEnforceable: true } });
  const v2 = V.valueContract(c, liveFc, book(), { contracts: 100, nowTs: TS });
  ok("a WALL_CLOCK prior is not stale-blocked", !v2.staleBaselineBlocked);
  ok("...and can reach ACTIONABLE EXPERIMENTAL", v2.classification === "ACTIONABLE EXPERIMENTAL", v2.classification);

  // zero adjustments = no opinion, even with a live baseline
  const noView = fc({ appliedAdjustments: [], marketBaseline: { probability: 0.6, clockBasis: "WALL_CLOCK", fallbackLevel: "A" } });
  const v3 = V.valueContract(c, noView, book(), { contracts: 100, nowTs: TS });
  ok("zero adjustments => the system has no opinion => NO BET", v3.classification === "NO BET" && v3.noOpinion === true);
  ok("the reason says the gap is price movement, not a view", /price movement, not a disagreement/.test(v3.reason));
  const v4 = V.valueContract(c, fc({ appliedAdjustments: [{ fighterFavored: A, mechanism: "striking", finalAppliedLogOdds: 0 }], marketBaseline: { probability: 0.6, clockBasis: "WALL_CLOCK" } }), book(), { contracts: 100, nowTs: TS });
  ok("adjustments that all resolved to zero also count as no opinion", v4.noOpinion === true);
}

console.log("\n8E: TERMINAL STATES AND CORRELATION");
{
  const states = P.terminalStates(A, B);
  ok("terminal states enumerate both fighters x methods x rounds", states.length === 14, String(states.length));
  const win = C.mapMarket(mkt(), BOUT, TS);
  const ko = C.mapMarket(mkt({ rules_primary: `If ${A} wins the fight by KO or TKO, then the market resolves to Yes.` }), BOUT, TS);
  ok("the win contract pays in every state A wins", states.filter((s) => s.winner === A).every((s) => P.paysIn(win, s)));
  ok("the KO contract pays only in A's KO states", states.filter((s) => P.paysIn(ko, s)).every((s) => s.winner === A && s.method === "KO/TKO"));
  ok("KO states are a strict subset of win states", states.filter((s) => P.paysIn(ko, s)).length < states.filter((s) => P.paysIn(win, s)).length);

  const pos = (c, n, cost) => ({ boutId: "b1", contract: c, contracts: n, totalCost: cost, mechanisms: ["striking"] });
  const an = P.analysePortfolio([pos(win, 100, 46), pos(ko, 100, 20)], [fc()]);
  const b = an.perBout[0];
  ok("nesting is detected from terminal states", b.nestedPositions.length === 1, JSON.stringify(b.nestedPositions));
  ok("nesting is described as ONE bet at two sizes", /ONE bet at two sizes/.test(b.nestedPositions[0].note));
  ok("overlapping positions are NOT called diversification", /NOT diversified/.test(b.diversificationNote));
  ok("payoff is computed for every terminal state", b.payoffByTerminalState.length === 14);
  ok("max loss equals losing every position", Math.abs(b.maxLoss - -66) < 0.01, String(b.maxLoss));
  ok("shared mechanism concentration is reported", b.mechanismConcentration.length === 1 && b.mechanismConcentration[0].mechanism === "striking");
  ok("mechanism concentration warns they fail together", /fail together/.test(b.mechanismConcentration[0].note));
  ok("exposure per fight is totalled", b.totalExposure === 66);
  ok("concentration by fighter is reported", an.concentrationByFighter[A] === 66);
  ok("card-level exposure is totalled", an.cardTotalExposure === 66);
  ok("cross-fight independence is flagged as an ASSUMPTION", /ASSUMPTION/.test(an.note));

  // opposing positions can never both pay
  const winB = C.mapMarket(mkt({ ticker: "KXUFCFIGHT-26JUL18ALIBOB-BOB", yes_sub_title: B,
    rules_primary: `If ${B} wins the Ace vs Bruiser professional MMA fight originally scheduled for Jul 18, 2026, then the market resolves to Yes.` }), BOUT, TS);
  const an2 = P.analysePortfolio([pos(win, 100, 46), pos(winB, 100, 54)], [fc()]);
  ok("opposing positions are detected as mutually exclusive", an2.perBout[0].opposingPositions.length === 1);
}

console.log("\n8G: SIZING IS CONSERVATIVE AND AUDITABLE");
{
  const c = C.mapMarket(mkt(), BOUT, TS);
  const v = V.valueContract(c, fc(), book(), { contracts: 100, nowTs: TS });
  const s = P.sizePosition(v, 10000);
  ok("sizing runs only for ACTIONABLE EXPERIMENTAL", s.sized === true);
  ok("sizing is based on the CONSERVATIVE probability", s.conservativeProbability === v.conservativeProbability);
  ok("...and says so explicitly", /CONSERVATIVE/.test(s.basedOn));
  ok("quarter Kelly is applied", s.kellyMultiplier === 0.25);
  ok("fractional Kelly < full Kelly", s.fractionalKelly < s.fullKellyFraction);
  ok("the 0.5% per-position cap binds", s.appliedFraction <= 0.005 + 1e-9, String(s.appliedFraction));
  ok("stake never exceeds 0.5% of bankroll", s.proposedStake <= 10000 * 0.005 + 0.01, String(s.proposedStake));
  ok("a flat-stake comparison is produced for audit", s.flatStakeComparison.stake === 50);
  ok("caps are recorded on the sizing record", s.caps.maxFractionPerCard === 0.03);
  ok("caps are labelled as safety, not optimisation", /never widen them on a winning streak/.test(s.caps.rationale));
  ok("a NO BET position is never sized", P.sizePosition({ classification: "NO BET" }, 10000).sized === false);

  // card cap binds across many positions each inside the per-position cap
  const many = Array.from({ length: 10 }, (_, i) => ({ boutId: `b${i}`, allInPrice: 0.46, sizing: { sized: true, proposedStake: 50 } }));
  const capped = P.applyPortfolioCaps(many, 10000);
  const total = capped.positions.reduce((a, x) => a + x.sizing.proposedStake, 0);
  ok("10 x 0.5% positions are scaled to the 3% card cap", Math.abs(total - 300) < 0.5, String(total));
  ok("scaling is recorded on each position", capped.positions.every((p) => /per-card cap/.test(p.sizing.scaledBy || "")));
  // per-fight cap
  const sameFight = [0, 1, 2].map(() => ({ boutId: "b1", allInPrice: 0.46, sizing: { sized: true, proposedStake: 50 } }));
  const fcap = P.applyPortfolioCaps(sameFight, 10000);
  const ft = fcap.positions.reduce((a, x) => a + x.sizing.proposedStake, 0);
  ok("3 positions on ONE fight are scaled to the 1% per-fight cap", Math.abs(ft - 100) < 0.5, String(ft));
}

console.log("\n8F: RANKING IS RISK-ADJUSTED, NOT PAYOUT-SIZED");
{
  const c = C.mapMarket(mkt(), BOUT, TS);
  const good = V.valueContract(c, fc(), book(), { contracts: 100, nowTs: TS });
  const nobet = V.valueContract(c, fc({ systemRange: { forFighter: A, low: 0.4, high: 0.8 } }), book(), { contracts: 100, nowTs: TS });
  const ranked = P.rankContracts([nobet, good], { contracts: 100 });
  ok("ACTIONABLE outranks NO BET", ranked[0].classification === "ACTIONABLE EXPERIMENTAL");
  ok("ranking reasons are recorded", ranked[0].rankingReasons.length >= 4);
  ok("the leverage score is risk-adjusted, not payout size", /conservative EV\/\$/.test(ranked[0].rankingReasons[0]));
  ok("non-actionable contracts get no leverage score", ranked[1].leverageScore === null);
  ok("all six statuses are defined", P.STATUSES.length === 6);
  // the top-ranked outcome may be NO BET
  const allBad = P.rankContracts([nobet], { contracts: 100 });
  ok("the highest-ranked contract MAY be NO BET", allBad[0].classification === "NO BET" && allBad[0].rank === 1);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
