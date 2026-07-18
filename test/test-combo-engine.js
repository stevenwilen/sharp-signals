// COMBO ENGINE — a separate market with its own gates. These pin the four-way decision, the
// conservative probability math (never uplift, always haircut), correlation classification (concentration
// and uncertain both fail closed), the maximum-price-below-fair rule, the separate capped combo stake
// that never breaches the $10 card cap, and — the load-bearing one — that no quote provider POSTs.
const CE = require("../lib/combo-engine");
const CQ = require("../lib/combo-quote");
const TM = require("../lib/telegram-messages");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

const leg = (o = {}) => ({ ticker: "T-" + (o.fighter || "A"), boutId: "B1", eventDate: "2026-08-01", fighter: "Fighter A", fight: "Fighter A vs Opp A", conservativeProb: 0.55, ask: 0.5, maximumAcceptablePrice: 0.6, classification: "strong experimental", forecastHash: "seal1", strongSupport: true, fightStarted: false, eligibleSingle: true, singleStakeDollars: 0, ...o });
const quote = (o = {}) => ({ available: true, yesAsk: 0.18, ts: new Date().toISOString(), ageSec: 0, marketOpen: true, ...o });

console.log("CORRELATION IS CLASSIFIED STRUCTURALLY — concentration and uncertain fail closed");
{
  const same = CE.classifyCorrelation([leg({ fighter: "Jon Jones" }), leg({ fighter: "Jon Jones", ticker: "T2" })]);
  ok("same fighter across legs → concentration", same.concentration === true && same.class === CE.CORRELATION.UNCERTAIN);
  const sameEvent = CE.classifyCorrelation([leg({ fighter: "A", eventDate: "2026-08-01" }), leg({ fighter: "B", eventDate: "2026-08-01" })]);
  ok("same event → positively correlated", sameEvent.class === CE.CORRELATION.POSITIVE);
  const diffEvent = CE.classifyCorrelation([leg({ fighter: "A", eventDate: "2026-08-01" }), leg({ fighter: "B", eventDate: "2026-08-15" })]);
  ok("different events → independent", diffEvent.class === CE.CORRELATION.INDEPENDENT);
  const noDate = CE.classifyCorrelation([leg({ fighter: "A", eventDate: null }), leg({ fighter: "B" })]);
  ok("missing event date → uncertain (fail closed)", noDate.class === CE.CORRELATION.UNCERTAIN);
}

console.log("\nJOINT PROBABILITY IS CONSERVATIVE — product, never uplift, with an uncertainty haircut");
{
  const p2 = CE.jointProbability([leg({ conservativeProb: 0.6 }), leg({ conservativeProb: 0.5, fighter: "B" })], { class: CE.CORRELATION.INDEPENDENT });
  ok("raw joint is the product (0.6 × 0.5 = 0.30)", p2.rawJoint === 0.30, p2.rawJoint);
  ok("2-leg haircut is ×0.95", p2.uncertaintyHaircut === 0.95);
  ok("final = product × haircut, below the product", p2.finalConservativeProb === 0.285 && p2.finalConservativeProb < p2.rawJoint);
  const p3 = CE.jointProbability([leg({ conservativeProb: 0.6 }), leg({ conservativeProb: 0.6, fighter: "B" }), leg({ conservativeProb: 0.6, fighter: "C" })], { class: CE.CORRELATION.INDEPENDENT });
  ok("3-leg haircut is stricter (×0.90)", p3.uncertaintyHaircut === 0.90);
  const pos = CE.jointProbability([leg({ conservativeProb: 0.6 }), leg({ conservativeProb: 0.5, fighter: "B" })], { class: CE.CORRELATION.POSITIVE });
  ok("positive correlation claims NO uplift (still the product)", pos.finalConservativeProb === p2.finalConservativeProb);
  const neg = CE.jointProbability([leg({ conservativeProb: 0.6 }), leg({ conservativeProb: 0.5, fighter: "B" })], { class: CE.CORRELATION.NEGATIVE });
  ok("negative correlation reduces the joint further", neg.finalConservativeProb < p2.finalConservativeProb);
}

console.log("\nMAX BUY PRICE IS STRICTLY BELOW FAIR; COMBO FEES ARE FLAGGED EXTRAPOLATED");
{
  const pr = CE.pricing(0.4655, 0.35);
  ok("fair price = final conservative prob", pr.fairPrice === 0.4655);
  ok("max buy price is strictly below fair (minEdge + fee cushion)", pr.maxBuyPrice < pr.fairPrice && pr.maxBuyPrice === 0.3855);
  ok("edge at quote = fair − quote − per-contract fee", Math.abs(pr.edgeAtQuote - (0.4655 - 0.35 - CE.perContractFee(0.35))) < 1e-9);
  ok("combo fee is flagged EXTRAPOLATED beyond the verified envelope", pr.feeExtrapolated === true);
}

console.log("\nSTAKING — separate capped allocation, never over the $10 card cap");
{
  const s = CE.staking([leg({ singleStakeDollars: 4 }), leg({ fighter: "B" })], 0.18, { existingCardExposureDollars: 8 });
  ok("combo stake ≤ $2 default cap", s.stakeDollars <= 2);
  ok("...and never pushes total card exposure over $10", s.totalCardExposureAfterDollars <= 10 && s.stakeDollars === 2);
  const capped = CE.staking([leg(), leg({ fighter: "B" })], 0.18, { existingCardExposureDollars: 9 });
  ok("only $1 of room left → stake $1", capped.stakeDollars === 1);
  const none = CE.staking([leg(), leg({ fighter: "B" })], 0.18, { existingCardExposureDollars: 10 });
  ok("card cap already reached → $0", none.stakeDollars === 0);
  ok("a repeated leg (also a single) records its worst-case loss", s.repeatedLegs.length === 1 && s.repeatedLegs[0].maxLossIfLegFails === 6);
}

console.log("\nTHE FOUR DECISIONS");
{
  const A = leg({ fighter: "A", eventDate: "2026-08-01", conservativeProb: 0.7 });
  const B = leg({ fighter: "B", ticker: "T-B", eventDate: "2026-08-15", conservativeProb: 0.7 });
  ok("< 2 legs → NO_COMBO_BET", CE.evaluateCombo([A], quote()).decision === CE.DECISION.NO_BET);
  ok("same fighter (concentration) → NO_COMBO_BET", CE.evaluateCombo([A, leg({ fighter: "A", ticker: "T-A2", eventDate: "2026-08-15" })], quote()).decision === CE.DECISION.NO_BET);
  ok("no live quote → COMBO_UNAVAILABLE", CE.evaluateCombo([A, B], { available: false, reason: "none" }).decision === CE.DECISION.UNAVAILABLE);
  ok("stale quote → COMBO_UNAVAILABLE", CE.evaluateCombo([A, B], quote({ ageSec: 999 })).decision === CE.DECISION.UNAVAILABLE);
  ok("closed market → COMBO_UNAVAILABLE", CE.evaluateCombo([A, B], quote({ marketOpen: false })).decision === CE.DECISION.UNAVAILABLE);
  // fair = 0.7*0.7*0.95 = 0.4655; max = 0.3855
  ok("quote above max but structurally sound → COMBO_PRICE_TOO_HIGH", CE.evaluateCombo([A, B], quote({ yesAsk: 0.45 })).decision === CE.DECISION.PRICE_TOO_HIGH);
  const buy = CE.evaluateCombo([A, B], quote({ yesAsk: 0.35 }), { existingCardExposureDollars: 0 });
  ok("quote at/below max with a real edge → COMBO_BUY", buy.decision === CE.DECISION.BUY, buy.reason);
  ok("...a BUY carries a positive edge and a capped stake", buy.pricing.edgeAtQuote > 0 && buy.staking.stakeDollars <= 2);
  const weak = CE.evaluateCombo([leg({ fighter: "A", conservativeProb: 0.25, eventDate: "2026-08-01" }), leg({ fighter: "B", ticker: "T-B", conservativeProb: 0.25, eventDate: "2026-08-15" })], quote({ yesAsk: 0.03 }));
  ok("negligible joint value → NO_COMBO_BET (not price-too-high)", weak.decision === CE.DECISION.NO_BET);
  ok("3 legs without strong support on all → NO_COMBO_BET",
    CE.evaluateCombo([A, B, leg({ fighter: "C", ticker: "T-C", eventDate: "2026-08-20", strongSupport: false })], quote({ yesAsk: 0.1 })).decision === CE.DECISION.NO_BET);
  ok("card cap exhausted → NO_COMBO_BET", CE.evaluateCombo([A, B], quote({ yesAsk: 0.35 }), { existingCardExposureDollars: 10 }).decision === CE.DECISION.NO_BET);
  const started = CE.evaluateCombo([A, leg({ fighter: "B", ticker: "T-B", eventDate: "2026-08-15", fightStarted: true })], quote());
  ok("a started leg → NO_COMBO_BET (no combos after a leg begins)", started.decision === CE.DECISION.NO_BET);
}

console.log("\nTHE QUOTE PROVIDER IS READ-ONLY — no combo ticker means COMBO_UNAVAILABLE, never a POST");
{
  (async () => {
    const q = await CQ.getComboQuote([leg(), leg({ fighter: "B" })]);   // default provider, no comboTicker
    ok("no live combo quote without a listed market", q.available === false && q.requiresWritePath === true);
    ok("...the reason names the write-path limitation honestly", /read-only|write call|RFQ|lookup/i.test(q.reason));
    // the kalshi client itself refuses any write, so a provider CANNOT POST
    const k = require("../lib/kalshi");
    let threw = false; try { k.request("POST", "/rfqs", { body: {} }); } catch { threw = true; }
    ok("kalshi.request('POST', ...) is refused synchronously — no RFQ/lookup path exists", threw === true);
    const ARM = require("../lib/arming");
    ok("assertNoTradingPath still holds with the combo engine present", (() => { try { ARM.assertNoTradingPath(); return true; } catch { return false; } })());

    console.log("\nMESSAGE FORMATS");
    const cb = TM.comboBuy({ legs: ["A YES (A vs X)", "B YES (B vs Y)"], quote: 0.35, fairPrice: 0.4655, maxBuyPrice: 0.3855, stake: 2, contracts: 5, maxPayout: 5, estProfit: 3.1, correlation: "independent", whyOne: "real edge after fees", existingSingles: ["A — $4 recommended"], totalCardExposure: 6, cardCap: 10 });
    ok("COMBO BUY has legs, live quote, MAX BUY PRICE, stake, correlation", /🎯 COMBO BUY/.test(cb) && /Live quote: 35¢/.test(cb) && /MAX BUY PRICE: 39¢/.test(cb) && /Correlation assessment: independent/.test(cb));
    ok("COMBO BUY is a MANUAL RECOMMENDATION — NOT CONFIRMED", /MANUAL RECOMMENDATION — NOT CONFIRMED/.test(cb) && /Total card exposure after combo: \$6 \/ \$10/.test(cb));
    ok("COMBO PRICE TOO HIGH names the required improvement", /COMBO PRICE TOO HIGH/.test(TM.comboPriceTooHigh({ legs: ["A", "B"], quote: 0.45, maxBuyPrice: 0.3855, requiredImprovement: 0.0645 })) );
    ok("NO COMBO BET keeps the singles valid", /singles remain|individual recommendations remain valid/i.test(TM.noComboBet({ reason: "x" })));
    ok("COMBO UNAVAILABLE explains why + keeps singles", /COMBO UNAVAILABLE/.test(TM.comboUnavailable({ legs: ["A", "B"], reason: "no readable market" })) && /Keep the existing single positions/.test(TM.comboUnavailable({ reason: "x" })));

    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  })();
}
