// POST-FIGHT INTELLIGENCE GRADING (§17). Grade the REPORT's usefulness independently of whether the
// bet won — a bet can win for the wrong reason, and a true early well-sourced report is useful even when
// the fight went the other way. The reliability estimate is provisional and shrunk; it changes no rule.
const IL = require("../lib/intel-learning");
const I = require("../lib/intelligence");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

const rec = (o = {}) => ({
  intelligenceId: "intel_" + (o.id || "x"), fighter: "Kevin Holland", proposition: "cond:knee",
  reportType: I.REPORT_TYPE.CURRENT_CONDITION, accessRelevance: I.ACCESS.FIRSTHAND,
  truthStatus: I.TRUTH_STATUS.CONFIRMED, independentOrigins: 1, amplifierCount: 1,
  firstSeenAt: "2026-07-17T12:00:00Z", kalshiBefore: { ask: 0.54, ts: "2026-07-17T12:00:00Z" }, kalshiAfter: [],
  actionHistory: [{ at: "2026-07-17T12:00:00Z", status: "PLAUSIBLE", action: "WATCH", note: "" }],
  forecastImpact: null, ...o,
});

console.log("TRUTH COMES FROM THE VERDICT, NEVER FROM THE FIGHT RESULT");
{
  ok("CONFIRMED → reportTrue true", IL.gradeRecord(rec({ truthStatus: I.TRUTH_STATUS.CONFIRMED }), { settled: true, aWon: true }).reportTrue === true);
  ok("DISPROVED → reportTrue false", IL.gradeRecord(rec({ truthStatus: I.TRUTH_STATUS.DISPROVED }), { settled: true, aWon: true }).reportTrue === false);
  ok("UNCERTAIN → reportTrue unknown (null)", IL.gradeRecord(rec({ truthStatus: I.TRUTH_STATUS.UNCERTAIN }), { settled: true, aWon: true }).reportTrue === null);
}

console.log("\nA WINNING BET DOES NOT MAKE THE REPORT 'GOOD'");
{
  // The bet won, but the report itself was never verified — usefulness must not be inferred from the win.
  const g = IL.gradeRecord(rec({ truthStatus: I.TRUTH_STATUS.UNCERTAIN, accessRelevance: I.ACCESS.ANALYST_ONLY }), { settled: true, aWon: true, betResult: "win", mechanismObserved: null });
  ok("betWon is recorded", g.betWon === true);
  ok("...but reportUseful is NOT concluded from the win", g.reportUseful === false);
  ok("...and 'won for the predicted reason' needs the mechanism, which was not observed", g.betWonForPredictedReason === false);
}

console.log("\nFORECAST ADJUSTMENT: HELPED OR HURT (log loss vs the pre-move probability)");
{
  const helped = IL.gradeRecord(rec({ forecastImpact: { probabilityBeforeA: 0.50, probabilityAfterA: 0.55 } }), { settled: true, aWon: true });
  ok("moving toward the eventual winner improves log loss", helped.adjustmentImprovedLogLoss > 0 && helped.movedTowardWinner === true, helped.adjustmentImprovedLogLoss);
  const hurt = IL.gradeRecord(rec({ forecastImpact: { probabilityBeforeA: 0.50, probabilityAfterA: 0.55 } }), { settled: true, aWon: false });
  ok("moving away from the winner hurts", hurt.adjustmentImprovedLogLoss < 0 && hurt.movedTowardWinner === false);
}

console.log("\nAMPLIFIERS-ONLY, ACCESS, AND USEFUL-EVEN-IF-RESULT-DIFFERED");
{
  const amp = IL.gradeRecord(rec({ independentOrigins: 1, amplifierCount: 10 }), { settled: true, aWon: true });
  ok("10 channels / 1 origin flagged as amplifiers-only", amp.amplifiersOnly === true);
  const two = IL.gradeRecord(rec({ independentOrigins: 2, amplifierCount: 5 }), { settled: true, aWon: true });
  ok("2 genuine origins → NOT amplifiers-only", two.amplifiersOnly === false);
  // A true, access-relevant report is useful even though the injured fighter's side LOST the bout view.
  const useful = IL.gradeRecord(rec({ truthStatus: I.TRUTH_STATUS.CONFIRMED, accessRelevance: I.ACCESS.FIRSTHAND }), { settled: true, aWon: false, betResult: "loss" });
  ok("a true, well-sourced report is useful even when the fight went the other way", useful.reportUseful === true);
}

console.log("\nTIMING: origin early, confirmed before the market moved, absorbed before we acted");
{
  const r = rec({
    truthStatus: I.TRUTH_STATUS.CONFIRMED, firstSeenAt: "2026-07-17T12:00:00Z",
    kalshiBefore: { ask: 0.54, ts: "2026-07-17T12:00:00Z" },
    kalshiAfter: [{ ask: 0.72, ts: "2026-07-17T15:00:00Z" }],   // moved +18 pts at 15:00
    actionHistory: [
      { at: "2026-07-17T12:00:00Z", status: "PLAUSIBLE", action: "WATCH", note: "" },
      { at: "2026-07-17T13:00:00Z", status: "CONFIRMED", action: "REPORT_CONFIRMED", note: "" },
      { at: "2026-07-17T16:00:00Z", status: "PLAUSIBLE", action: "SPECULATIVE_BET", note: "" },
    ],
  });
  const g = IL.gradeRecord(r, { settled: true, aWon: true });
  ok("the origin existed before the market moved", g.originEarly === true);
  ok("confirmed (13:00) before the market moved (15:00)", g.confirmedBeforeMarketMoved === true);
  ok("market absorbed it (15:00) before we acted (16:00) — we were late", g.marketAbsorbedBeforeAction === true);
}

console.log("\nRELIABILITY IS PROVISIONAL, SHRUNK, AND GROUPED — AND CHANGES NO RULE");
{
  const grades = [
    IL.gradeRecord(rec({ id: "a", accessRelevance: I.ACCESS.FIRSTHAND, forecastImpact: { probabilityBeforeA: 0.5, probabilityAfterA: 0.55 } }), { settled: true, aWon: true }),
    IL.gradeRecord(rec({ id: "b", accessRelevance: I.ACCESS.ANALYST_ONLY, forecastImpact: { probabilityBeforeA: 0.5, probabilityAfterA: 0.55 } }), { settled: true, aWon: false }),
  ];
  const rel = IL.reliability(grades, { priorStrength: 5 });
  ok("grouped by source access", "firsthand" in rel.byAccess && "analyst_only" in rel.byAccess);
  ok("grouped by report type", I.REPORT_TYPE.CURRENT_CONDITION in rel.byReportType);
  ok("shrunk toward zero (denominator includes the prior)", Math.abs(rel.byAccess.firsthand.provisionalReliability) < Math.abs(grades[0].adjustmentImprovedLogLoss));
  ok("each bucket says it is provisional, not a forecast input", /PROVISIONAL/.test(rel.byAccess.firsthand.note));

  // No rule mutation: this module must not require or write the frozen rule config.
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "intel-learning.js"), "utf8");
  ok("intel-learning touches no rule config (no forecast-rules / exploration-rules require)", !/forecast-rules|exploration-rules|writeFileSync.*rules/.test(src));
}

console.log("\nAPPEND-ONLY LEDGER — GRADED ONCE PER SETTLEMENT");
{
  let ledger = { grades: {} };
  const grades = [IL.gradeRecord(rec({ id: "a" }), { settled: true, aWon: true })];
  ledger = IL.appendToLedger(ledger, grades, "UFC-2026-07-18");
  ok("a grade is written", Object.keys(ledger.grades).length === 1);
  // regrading the same record for the same settlement must not overwrite.
  const tampered = [IL.gradeRecord(rec({ id: "a", truthStatus: I.TRUTH_STATUS.DISPROVED }), { settled: true, aWon: false })];
  ledger = IL.appendToLedger(ledger, tampered, "UFC-2026-07-18");
  ok("the same (record, settlement) is never overwritten", Object.keys(ledger.grades).length === 1 && ledger.grades["intel_a|UFC-2026-07-18"].reportTrue === true);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
