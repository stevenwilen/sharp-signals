// PRE-RENDER INVARIANTS + COMPACT MESSAGE SNAPSHOTS.
//
// This suite exists because a contradictory BUY shipped to Telegram: Dricus Du Plessis, "BUY", current
// ask 67.0¢, MAXIMUM acceptable price 61.7¢ (67 > 61.7 — buy above the system's own ceiling), with a
// probability range of 27.3–38.3% that belonged to the OTHER fighter (Usman). Two independent defects
// in one message: a price gate that did not gate, and a range rendered for the wrong side.
//
// The regression at the centre of this file is the EXACT 67.0¢ / 61.7¢ example. It proves the pipeline
// cannot turn those numbers into a BUY — not with the wrong-side range (fails closed), and not even with
// the CORRECT range (priced out → "PRICE TOO HIGH", never "BUY"). The rest pins the compact formats and
// the properties message-13 required: one footer, no repeated disclaimers, no internal taxonomy, length
// caps, and three unmistakably distinct placement labels.
const MI = require("../lib/message-invariants");
const TM = require("../lib/telegram-messages");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

// A faithful reproduction of run-entertainment-alerts.js buildActionMessage's DISPATCH: a betting
// instruction (buyInstruction) is reachable ONLY after both the FAIL_CLOSED and PRICE_TOO_HIGH
// early-returns. If this helper ever renders a "Buy:" line for a non-BUY verdict, so would production.
function render(fields, opts = {}) {
  const r = MI.evaluateRecommendation(fields);
  const recommendedFirst = opts.recommendedFirst || `${fields.recommendedSide} vs Opponent`;
  if (r.verdict === "FAIL_CLOSED") return { verdict: r.verdict, text: null, violations: r.violations };
  if (r.verdict === "PRICE_TOO_HIGH") {
    return { verdict: r.verdict, text: TM.priceTooHigh({ recommendedFirst, ask: fields.ask, maximumAcceptablePrice: fields.maximumAcceptablePrice }) };
  }
  return {
    verdict: r.verdict,
    text: TM.buyInstruction({
      classification: opts.classification || "CREATIVE SPECULATIVE", stake: opts.stake || 3, bankroll: 100,
      recommendedFirst, buyLine: `${fields.recommendedSide} YES`,
      ask: fields.ask, maximumAcceptablePrice: fields.maximumAcceptablePrice,
      whyOne: opts.whyOne || "one sentence", riskOne: opts.riskOne || "one sentence",
      centralProb: fields.centralProb, rangeLow: fields.rangeLow, rangeHigh: fields.rangeHigh,
    }),
  };
}
const hasBuyLine = (t) => typeof t === "string" && /^\s*Buy:/m.test(t);

// ---------------------------------------------------------------------------------------------------
// THE EXACT DU PLESSIS REGRESSION — 67.0¢ ask, 61.7¢ maximum. It must never become a BUY.
// ---------------------------------------------------------------------------------------------------
console.log("REGRESSION: the exact 67.0¢ / 61.7¢ Du Plessis alert cannot produce a BUY");

// (A) AS SHIPPED: the range shown (27.3–38.3%) is Usman's, not Du Plessis's. The central 67.2% sits
//     outside it, so the range is provably for the wrong fighter → FAIL_CLOSED, no instruction at all.
const asShipped = {
  recommendedSide: "Du Plessis", fighterA: "Kamaru Usman", fighterB: "Dricus Du Plessis",
  centralProb: 0.672, rangeLow: 0.273, rangeHigh: 0.383,   // <-- Usman's range on a Du Plessis buy: the bug
  ask: 0.67, allInPrice: 0.63, maximumAcceptablePrice: 0.617,
  centralEV: 0.042, conservativeEV: 0.01,
};
{
  const r = MI.evaluateRecommendation(asShipped);
  ok("as-shipped (wrong-side range) verdict is NOT BUY", r.verdict !== "BUY", r.verdict);
  ok("...it FAILS CLOSED", r.verdict === "FAIL_CLOSED", r.verdict);
  ok("...and names the wrong-side range as the reason", r.violations.some((v) => /opposite fighter|outside its own range/i.test(v)), r.violations.join(" | "));
  const out = render(asShipped);
  ok("...render produces NO text (silence, not a betting instruction)", out.text === null);
  ok("...and therefore no 'Buy:' line anywhere", !hasBuyLine(out.text));
}

// (B) CORRECTED SIDE, STILL PRICED OUT: give it Du Plessis's OWN range (61.7–72.7%). Every consistency
//     invariant now holds — but the ask (67¢) is still above the maximum (61.7¢). PRICE TOO HIGH, not BUY.
const correctedButPricedOut = {
  recommendedSide: "Du Plessis", fighterA: "Kamaru Usman", fighterB: "Dricus Du Plessis",
  centralProb: 0.672, rangeLow: 0.617, rangeHigh: 0.727,   // <-- Du Plessis's own range
  ask: 0.67, allInPrice: 0.63, maximumAcceptablePrice: 0.617,
  centralEV: 0.042, conservativeEV: 0.01,
};
{
  const r = MI.evaluateRecommendation(correctedButPricedOut);
  ok("corrected-side verdict is NOT BUY (ask 67¢ > max 61.7¢)", r.verdict !== "BUY", r.verdict);
  ok("...it is PRICE_TOO_HIGH", r.verdict === "PRICE_TOO_HIGH", r.verdict);
  const out = render(correctedButPricedOut, { recommendedFirst: "Dricus Du Plessis vs Kamaru Usman" });
  ok("...render is a PRICE TOO HIGH notice", /PRICE TOO HIGH/.test(out.text));
  ok("...with NO 'Buy:' line", !hasBuyLine(out.text));
  ok("...telling the human to wait for the maximum", /Wait for 62¢ or lower/.test(out.text), out.text);
}

// (C) A GENUINELY VALID BUY — same shape, but the ask (59¢) is at or below the maximum (61¢).
const validBuy = {
  recommendedSide: "Du Plessis", fighterA: "Kamaru Usman", fighterB: "Dricus Du Plessis",
  centralProb: 0.64, rangeLow: 0.58, rangeHigh: 0.69,
  ask: 0.59, allInPrice: 0.60, maximumAcceptablePrice: 0.61,
  centralEV: 0.04, conservativeEV: 0.01,
};
{
  const r = MI.evaluateRecommendation(validBuy);
  ok("a valid, in-price, correct-side recommendation IS a BUY", r.verdict === "BUY", r.verdict);
  const out = render(validBuy, { recommendedFirst: "Dricus Du Plessis vs Kamaru Usman", whyOne: "Size and weight-cut dynamics may favor Du Plessis.", riskOne: "Based on one uncorroborated origin." });
  ok("...render is a buy instruction with a 'Buy:' line", hasBuyLine(out.text));
}

// ---------------------------------------------------------------------------------------------------
// EVERY OTHER WAY THE FIELDS CAN CONTRADICT → FAIL_CLOSED, never a BUY.
// ---------------------------------------------------------------------------------------------------
console.log("\nCONTRADICTORY FIELDS FAIL CLOSED (a refusal is the safe output)");
const base = () => JSON.parse(JSON.stringify(validBuy));
const failsClosed = (name, mutate, reasonRe) => {
  const f = base(); mutate(f);
  const r = MI.evaluateRecommendation(f);
  ok(`${name} -> not BUY`, r.verdict !== "BUY", r.verdict);
  ok(`${name} -> FAIL_CLOSED`, r.verdict === "FAIL_CLOSED", r.verdict);
  if (reasonRe) ok(`${name} -> names the reason`, r.violations.some((v) => reasonRe.test(v)), r.violations.join(" | "));
  ok(`${name} -> render emits no 'Buy:' line`, !hasBuyLine(render(f).text));
};
failsClosed("a missing central probability", (f) => { f.centralProb = null; }, /missing or not a number/);
failsClosed("a missing ask", (f) => { f.ask = undefined; }, /missing or not a number/);
failsClosed("an inverted range", (f) => { f.rangeLow = 0.69; f.rangeHigh = 0.58; }, /inverted/);
failsClosed("central below the fee-adjusted break-even", (f) => { f.centralProb = 0.59; f.allInPrice = 0.60; f.centralEV = -0.01; }, /break-even/);
failsClosed("a central EV inconsistent with prob minus price", (f) => { f.centralEV = 0.30; }, /inconsistent/);
failsClosed("a conservative EV above the central EV", (f) => { f.conservativeEV = 0.20; }, /swapped|exceeds central/);
failsClosed("a maximum price above the central probability", (f) => { f.maximumAcceptablePrice = 0.80; }, /exceeds the central probability/);
failsClosed("no recommended side named", (f) => { f.recommendedSide = ""; }, /no recommended side/);

// reproduce() surfaces the seven load-bearing fields for a fail-closed report.
console.log("\nreproduce() RECORDS THE SEVEN FIELDS THAT DISAGREED");
{
  const rp = MI.reproduce(asShipped);
  for (const k of ["recommendedSide", "systemCentralProbability", "probabilityRange", "currentAsk", "maximumAcceptablePrice", "centralEV", "conservativeEV"])
    ok(`reproduce() carries ${k}`, k in rp);
  ok("probabilityRange is the [low, high] pair", JSON.stringify(rp.probabilityRange) === JSON.stringify([0.273, 0.383]));
}

// ---------------------------------------------------------------------------------------------------
// COMPACT FORMAT SNAPSHOTS. Shape, one footer, no repeated disclaimers, no internal taxonomy, caps.
// ---------------------------------------------------------------------------------------------------
// Substrings that must NEVER appear in a phone message: internal slugs, tickers, and the repeated
// legal/methodological boilerplate the operator asked to be removed from every alert.
const TAXONOMY = /injury_health|weight_cut|credible_single_origin|favors_about|against_about|KXUFCFIGHT|\bboutId\b|\ballInPrice\b|logOdds/i;
const REPEATED_DISCLAIMERS = /trading path|cannot place|no write|not demonstrated|contaminated|not Kelly|prospective edge|Alerts (remain|are) disarmed|confirm command/i;
const oneCharBullet = (t) => t.split("\n").some((l) => /^[•\-]\s\S$/.test(l.trim()));
const footerCount = (t) => (t.match(/For entertainment use/g) || []).length;

console.log("\nCOMPACT CREATIVE BUY");
{
  const t = render(validBuy, {
    recommendedFirst: "Dricus Du Plessis vs Kamaru Usman",
    whyOne: "Size and weight-cut dynamics may favor Du Plessis.",
    riskOne: "Based on one uncorroborated origin.",
  }).text;
  ok("headlines the tier and the whole-dollar stake", /^🧪 CREATIVE SPECULATIVE — \$3$/m.test(t));
  ok("names the recommended fighter first", t.indexOf("Dricus Du Plessis vs Kamaru Usman") >= 0);
  ok("has a single 'Buy:' line", (t.match(/^Buy: /gm) || []).length === 1);
  ok("shows Current, Maximum and Stake", /Current: 59¢/.test(t) && /Maximum: 61¢/.test(t) && /Stake: \$3 of \$100/.test(t));
  ok("Why is ONE line (not a bulleted list)", /^Why: Size and weight-cut/m.test(t) && !/^• /m.test(t));
  ok("Main risk is one line", /^Main risk: Based on one/m.test(t));
  ok("System estimate carries a RANGE, not a single scalar", /System estimate: 64% \(range 58%–69%\)/.test(t));
  ok("places the price condition", /Place only if the displayed average price is 61¢ or less\./.test(t));
  ok("exactly ONE footer", footerCount(t) === 1, `count=${footerCount(t)}`);
  ok("no repeated legal/methodology boilerplate", !REPEATED_DISCLAIMERS.test(t), (t.match(REPEATED_DISCLAIMERS) || [])[0]);
  ok("no internal taxonomy or ticker leaks", !TAXONOMY.test(t), (t.match(TAXONOMY) || [])[0]);
  ok("no one-character bullet", !oneCharBullet(t));
  ok("under the 1000-char BUY cap", t.length < 1000, `len=${t.length}`);
}

console.log("\nPRICE TOO HIGH");
{
  const t = render(correctedButPricedOut, { recommendedFirst: "Dricus Du Plessis vs Kamaru Usman" }).text;
  ok("headlines DO NOT BUY", /^⏸️ PRICE TOO HIGH — DO NOT BUY$/m.test(t));
  ok("carries NO 'Buy:' instruction", !hasBuyLine(t));
  ok("shows the current and maximum prices", /Current: 67¢/.test(t) && /Maximum: 62¢/.test(t));
  ok("tells the human to wait", /Wait for 62¢ or lower/.test(t));
  ok("under the 400-char price-update cap", t.length < 400, `len=${t.length}`);
}

console.log("\nCOMPACT HUMAN REVIEW (unverified news — no price, no instruction)");
{
  const t = TM.humanReview({ fight: "Kevin Holland vs Anthony Smith", claim: "Holland reportedly off the card with a knee injury", origins: 1, forecastMoved: false, dashboard: "https://x/y" });
  ok("headlines UNVERIFIED FIGHT UPDATE", /^🔎 UNVERIFIED FIGHT UPDATE$/m.test(t));
  ok("states the single origin count", /Sources: 1 independent origin$/m.test(t));
  ok("states forecast impact is None (1 origin moves nothing)", /Forecast impact: None/.test(t));
  ok("says 'Verify before acting.' exactly once", (t.match(/Verify before acting\./g) || []).length === 1);
  ok("carries NO betting language (price/stake/contract)", !/¢|\bbuy\b|\bstake\b|\bcontract\b|maximum price/i.test(t));
  ok("no internal topic slug leaks", !TAXONOMY.test(t), (t.match(TAXONOMY) || [])[0]);
  ok("no repeated disclaimer block", !REPEATED_DISCLAIMERS.test(t));
  ok("under the 700-char HUMAN REVIEW cap", t.length < 700, `len=${t.length}`);
  ok("building one WITH betting language throws (structural, not stylistic)", (() => { try { TM.humanReview({ fight: "A vs B", claim: "buy this at 40¢ now", origins: 1, forecastMoved: false }); return false; } catch { return true; } })());
}

console.log("\nBET WITHDRAWN");
{
  const t = TM.positionWithdrawn({ recommendedFirst: "Dricus Du Plessis vs Kamaru Usman", reason: "the bout was rescheduled" });
  ok("headlines BET WITHDRAWN", /^❌ BET WITHDRAWN$/m.test(t));
  ok("names the recommended fight", /Dricus Du Plessis vs Kamaru Usman/.test(t));
  ok("gives a reason", /Reason: the bout was rescheduled/.test(t));
  ok("says do not place the previous recommendation", /Do not place the previous recommendation\./.test(t));
  ok("under the 400-char cap", t.length < 400, `len=${t.length}`);
}

console.log("\nTHREE DISTINCT PLACEMENT LABELS (paper vs recommended vs confirmed)");
{
  const P = TM.PLACEMENT_LABELS;
  ok("PAPER ONLY says do not place", /PAPER ONLY/.test(P.PAPER_ONLY) && /Do not place/.test(P.PAPER_ONLY));
  ok("MANUAL RECOMMENDATION says not yet confirmed", /MANUAL RECOMMENDATION/.test(P.MANUAL_RECOMMENDATION) && /not yet confirmed/.test(P.MANUAL_RECOMMENDATION));
  ok("PLACEMENT CONFIRMED says included in P&L", /PLACEMENT CONFIRMED/.test(P.PLACEMENT_CONFIRMED) && /actual bankroll P&L/.test(P.PLACEMENT_CONFIRMED));
  ok("the three labels are all different", new Set([P.PAPER_ONLY, P.MANUAL_RECOMMENDATION, P.PLACEMENT_CONFIRMED]).size === 3);
}

// ---------------------------------------------------------------------------------------------------
// THE RUNNER WIRES THE VERDICT IN THE SAFE ORDER: fail-closed and price-too-high both return BEFORE
// any buyInstruction call. A source-scan so a future refactor can't reorder them.
// ---------------------------------------------------------------------------------------------------
console.log("\nrun-entertainment-alerts.js DISPATCHES IN THE SAFE ORDER");
{
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "run-entertainment-alerts.js"), "utf8").replace(/\r/g, "");
  const iFail = src.indexOf('=== "FAIL_CLOSED"');
  const iPrice = src.indexOf('=== "PRICE_TOO_HIGH"');
  const iBuy = src.indexOf("TM.buyInstruction");
  ok("it evaluates through message-invariants", /MI\.evaluateRecommendation\(/.test(src));
  ok("FAIL_CLOSED is handled before any buy instruction", iFail >= 0 && iBuy >= 0 && iFail < iBuy);
  ok("PRICE_TOO_HIGH is handled before any buy instruction", iPrice >= 0 && iBuy >= 0 && iPrice < iBuy);
  ok("the range is flipped to the recommended side (not left on fighter A)", /1 - f\.systemRange\.high|1 - f\.systemRange\.low/.test(src));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
