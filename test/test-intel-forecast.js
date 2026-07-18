// FIGHT INTELLIGENCE — forecast traceability (§9) and market-reaction tracking (§8). Material
// intelligence feeds the EXISTING exploration lane (never a second forecast), every move is traceable
// and capped, the market before/after is recorded, and a price that already moved past the ceiling
// yields MARKET_ALREADY_MOVED — never a bet. The mechanical invariants are never bypassed.
const IF = require("../lib/intel-forecast");
const IMK = require("../lib/intel-market");
const IM = require("../lib/intel-messages");
const I = require("../lib/intelligence");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

const rec = (o = {}) => ({
  intelligenceId: "intel_abc", fighter: "Kevin Holland", fight: "Jacobe Smith vs Kevin Holland",
  topic: "injury_health", truthStatus: I.TRUTH_STATUS.PLAUSIBLE, accessRelevance: I.ACCESS.FIRSTHAND,
  independentOrigins: 1, mechanism: "injury_health → hurts Kevin Holland",
  outcomeAffected: { fighter: "Kevin Holland", direction: "against_about", helps: "Jacobe Smith" },
  forecastVersions: [], kalshiAfter: [], sportsbookAfter: [], ...o,
});

// A sealed bout forecast carrying an exploration block (fighter A = Jacobe Smith).
const forecast = (o = {}) => ({
  boutId: "UFC-TEST-B4", fight: "Jacobe Smith vs Kevin Holland", forecastId: "fc_1", sealHash: "seal_deadbeef",
  systemCentral: { "Jacobe Smith": 0.52, "Kevin Holland": 0.48 },
  exploration: {
    lane: "exploration", marketPriorA: 0.50, coreCentralA: 0.52, creativeCentralA: 0.55, creativeMovePoints: 3.0,
    capped: false, cap: 0.20, activeHypotheses: 1,
    hypotheses: [{ fighter: "Kevin Holland", boutTopic: "injury_health", adjustmentLogOdds: 0.07, magnitudeBucket: "credible_single_origin",
      causalMechanism: "injury_health → hurts Kevin Holland", verificationStatus: "unverified_single_origin", fatallyContradicted: false, directionTowardSubject: false }],
  }, ...o,
});

console.log("FORECAST TRACEABILITY (§9): intel → exploration lane, capped, prob before/after");
{
  const { forecastImpact, forecastImpactPoints, helps } = IF.linkForecast(rec(), forecast());
  ok("links to the exploration lane (not a second forecast)", forecastImpact.lane === "exploration");
  ok("carries the intelligence id(s) that caused it", JSON.stringify(forecastImpact.intelIds) === JSON.stringify(["intel_abc"]));
  ok("records truth status, origins and access relevance", forecastImpact.truthStatus === "PLAUSIBLE" && forecastImpact.independentOrigins === 1 && forecastImpact.accessRelevance === I.ACCESS.FIRSTHAND);
  ok("records the causal mechanism", /injury_health → hurts Kevin Holland/.test(forecastImpact.mechanism));
  ok("records probability before and after", forecastImpact.probabilityBeforeA === 0.52 && forecastImpact.probabilityAfterA === 0.55);
  ok("records the adjustment and its cap", forecastImpact.adjustmentLogOdds === 0.07 && forecastImpact.boutCap === 0.20);
  // The report HURTS Holland → HELPS Smith (fighter A). A's move is +3.0 pts, so toward-helps is +3.0.
  ok("impact is signed toward the fighter the report helps", forecastImpact.impactPointsTowardHelps === 3.0 && helps === "Jacobe Smith", forecastImpact.impactPointsTowardHelps);
  ok("forecastImpactPoints is a fraction the classifier can threshold", Math.abs(forecastImpactPoints - 0.03) < 1e-9, forecastImpactPoints);
}

console.log("\nA report that HELPS the SUBJECT (favors_about) flips the sign correctly");
{
  // Holland's OWN advantage report (favors Holland, fighter B). A's creative move is DOWN.
  const f = forecast();
  f.exploration.creativeCentralA = 0.49; f.exploration.creativeMovePoints = -3.0;
  const r = rec({ outcomeAffected: { fighter: "Kevin Holland", direction: "favors_about", helps: "Kevin Holland" } });
  const { forecastImpact, forecastImpactPoints } = IF.linkForecast(r, f);
  ok("helps Holland (B): A's -3.0 move reads as +3.0 toward Holland", forecastImpact.impactPointsTowardHelps === 3.0, forecastImpact.impactPointsTowardHelps);
  ok("...and forecastImpactPoints is +0.03 toward the helped side", Math.abs(forecastImpactPoints - 0.03) < 1e-9, forecastImpactPoints);
}

console.log("\nattach() records which sealed forecast versions a report influenced");
{
  const { record } = IF.attach(rec(), forecast());
  ok("forecastImpact attached to the record", !!record.forecastImpact);
  ok("forecastVersions records the seal hash", record.forecastVersions.includes("seal_deadbeef"));
  const again = IF.attach(record, forecast()).record;
  ok("influencing the same seal twice does not duplicate the version", again.forecastVersions.filter((v) => v === "seal_deadbeef").length === 1);
}

console.log("\nNO exploration block → no forecast impact (nothing invented)");
{
  const { forecastImpact, forecastImpactPoints } = IF.linkForecast(rec(), forecast({ exploration: null }));
  ok("no exploration → null impact, zero points", forecastImpact === null && forecastImpactPoints === 0);
}

console.log("\nMARKET-REACTION TRACKING (§8): before, after, movement, who moved first");
{
  let r = rec();
  r = IMK.recordBefore(r, { kalshiAsk: 0.54, sportsbook: 0.53, ts: "2026-07-17T12:00:00Z" });
  ok("captures the BEFORE picture once", r.kalshiBefore.ask === 0.54 && r.sportsbookBefore.consensus === 0.53);
  // capturing again must not overwrite the original before.
  const r2 = IMK.recordBefore(r, { kalshiAsk: 0.99, sportsbook: 0.99, ts: "later" });
  ok("BEFORE is immutable once set", r2.kalshiBefore.ask === 0.54);

  r = IMK.recordAfter(r, { kalshiAsk: 0.60, sportsbook: 0.55, ts: "2026-07-17T13:00:00Z" });
  r = IMK.recordAfter(r, { kalshiAsk: 0.72, sportsbook: 0.70, ts: "2026-07-17T14:00:00Z" });
  const mv = IMK.movement(r, { reportSign: 1 });
  ok("kalshi move is +18 points", mv.kalshiMovePoints === 18.0, mv.kalshiMovePoints);
  ok("the report was absorbed by the market (moved in its direction)", mv.absorbed === true);
  ok("Kalshi moved first (it crossed the threshold at 13:00, book at 14:00)", mv.movedFirst === "kalshi", mv.movedFirst);
}

console.log("\nPRICE ALREADY GONE → MARKET_ALREADY_MOVED, never a bet (§8)");
{
  let r = rec({ actionStatus: null });
  r = IMK.recordBefore(r, { kalshiAsk: 0.54, sportsbook: 0.53, ts: "t0" });
  r = IMK.recordAfter(r, { kalshiAsk: 0.72, sportsbook: 0.70, ts: "t1" });
  const mc = IMK.marketContext(r, { maximumAcceptablePrice: 0.57, subject: "Smith" });
  ok("current ask 72¢ is beyond the 57¢ maximum", mc.marketMovedBeyondMax === true);
  ok("no value remains after fees", mc.valueRemainsAfterFees === false);
  // Feed that into the action classifier alongside a would-be qualifying bet.
  const decided = I.classifyAction(rec({ actionStatus: null }), { betQualifies: true, priceFavorable: true, marketMovedBeyondMax: mc.marketMovedBeyondMax });
  ok("classifier returns MARKET_ALREADY_MOVED, not a bet", decided.action === I.ACTION_STATUS.MARKET_ALREADY_MOVED, decided.action);
}

console.log("\nNO INVARIANT BYPASS (§10): a strong forecast move still cannot buy above the ceiling");
{
  // Even with a material forecast impact, the bet is gated by message-invariants: ask 67¢ > max 57¢.
  const bet = { recommendedSide: "Jacobe Smith", fighterA: "Jacobe Smith", fighterB: "Kevin Holland", buyLine: "Smith YES",
    stake: 3, ask: 0.67, allInPrice: 0.55, maximumAcceptablePrice: 0.57, centralProb: 0.60, rangeLow: 0.55, rangeHigh: 0.66, centralEV: 0.05, conservativeEV: 0.01 };
  const m = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }), { bet, forecastImpactPoints: 0.05, helps: "Smith" });
  ok("a favorable forecast does NOT buy above the max — PRICE_TOO_HIGH", m.verdict === "PRICE_TOO_HIGH", m.verdict);
  ok("...and no 'Buy:' line is emitted", !/^Buy:/m.test(m.text || ""));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
