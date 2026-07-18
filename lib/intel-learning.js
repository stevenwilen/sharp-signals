// POST-FIGHT INTELLIGENCE GRADING (§17). After a bout settles, grade each intelligence record on
// whether the REPORT was useful — deliberately kept separate from whether the associated bet won. A bet
// can win for the wrong reason and a true, early, well-sourced report can be useful even when the fight
// went the other way. Concluding "the report was good because the bet won" is exactly the hindsight this
// grader refuses.
//
// It produces a PROSPECTIVE record and a PROVISIONAL, shrunk-toward-zero reliability estimate by source
// access and report type. It does NOT change any rule — the estimate is a measurement to be read, not an
// input that silently re-weights the forecast.
require("./env");
const IMK = require("./intel-market");

const clamp = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const logLoss = (p, o) => -(o * Math.log(clamp(p)) + (1 - o) * Math.log(1 - clamp(p)));
const ACCESS_RELEVANT = ["firsthand", "insider_report"];

// The timestamp the market first MOVED past the noise threshold (from the record's own snapshots).
function marketMoveTs(record) {
  const kb = record.kalshiBefore && record.kalshiBefore.ask;
  if (kb == null) return null;
  const first = (record.kalshiAfter || []).find((x) => Math.abs(x.ask - kb) >= IMK.MOVE_THRESH);
  return first ? first.ts : null;
}
// The timestamp the record first reached a given action (from its lifecycle timeline).
function actionTs(record, action) {
  const h = (record.actionHistory || []).find((e) => e.action === action);
  return h ? h.at : null;
}
const before = (a, b) => (a && b) ? (new Date(a) <= new Date(b)) : null;

// Grade one settled record. `outcome`:
//   { settled, aWon (did fighter A of the bout win), method?, mechanismObserved? (bool|null),
//     betResult? ("win"|"loss"|"void"|none), gradedAt }
function gradeRecord(record, outcome = {}) {
  const gradeable = !!outcome.settled;
  const accessRelevant = ACCESS_RELEVANT.includes(record.accessRelevance);
  // Truth comes from the lifecycle verdict, NEVER from the fight result.
  const reportTrue = record.truthStatus === "CONFIRMED" ? true : record.truthStatus === "DISPROVED" ? false : null;
  // Apparent corroboration that is really one origic megaphoned by many channels.
  const amplifiersOnly = (record.amplifierCount || 0) > (record.independentOrigins || 0) && (record.independentOrigins || 0) <= 1;

  // Did the (capped) forecast move help or hurt, by log loss vs the pre-move probability?
  let adjustmentImprovedLogLoss = null, movedTowardWinner = null;
  const fx = record.forecastImpact;
  if (gradeable && fx && fx.probabilityBeforeA != null && fx.probabilityAfterA != null) {
    const a = outcome.aWon ? 1 : 0;
    adjustmentImprovedLogLoss = +(logLoss(fx.probabilityBeforeA, a) - logLoss(fx.probabilityAfterA, a)).toFixed(4);
    if (fx.probabilityAfterA !== fx.probabilityBeforeA)
      movedTowardWinner = Math.sign(fx.probabilityAfterA - fx.probabilityBeforeA) === (outcome.aWon ? 1 : -1);
  }

  const moveTs = marketMoveTs(record);
  const confirmedTs = (record.actionHistory || []).find((e) => e.status === "CONFIRMED");
  const confirmedBeforeMarketMoved = confirmedTs ? before(confirmedTs.at, moveTs) : null;
  const originEarly = moveTs ? before(record.firstSeenAt, moveTs) : null;
  const betActionTs = actionTs(record, "SPECULATIVE_BET");
  const marketAbsorbedBeforeAction = (moveTs && betActionTs) ? before(moveTs, betActionTs) : null;

  const betWon = outcome.betResult === "win";
  // A win only counts "for the predicted reason" if the mechanism actually showed up.
  const betWonForPredictedReason = betWon ? (outcome.mechanismObserved === true) : null;

  // USEFULNESS — independent of the bet and, deliberately, of who won. A true, well-sourced or
  // forecast-improving report was useful intelligence even if the fight went the other way.
  const reportUseful = reportTrue === true && (accessRelevant || (adjustmentImprovedLogLoss != null && adjustmentImprovedLogLoss > 0));

  return {
    intelligenceId: record.intelligenceId, fighter: record.fighter, proposition: record.proposition,
    reportType: record.reportType, accessRelevance: record.accessRelevance,
    independentOrigins: record.independentOrigins, amplifierCount: record.amplifierCount,
    gradeable, reportTrue, accessRelevant, amplifiersOnly,
    originEarly, confirmedBeforeMarketMoved, marketAbsorbedBeforeAction,
    mechanismAppeared: outcome.mechanismObserved ?? null,
    adjustmentImprovedLogLoss, movedTowardWinner,
    betWon, betWonForPredictedReason, reportUseful,
    gradedAt: outcome.gradedAt || null,
  };
}

// Grade every record for a settled card. `outcomeByRecordId` maps intelligenceId → outcome.
function gradeCard(records, outcomeByRecordId = {}) {
  return records.map((r) => gradeRecord(r, outcomeByRecordId[r.intelligenceId] || { settled: false }));
}

// PROVISIONAL reliability, shrunk toward zero (a prior of `priorStrength` "no-signal" observations), by
// source access and by report type. This is a measurement — it is NOT wired into the forecast, so it can
// never silently change a rule (§17: no automatic unrestricted rule changes).
function reliability(grades, { priorStrength = 5 } = {}) {
  const bucket = () => ({ n: 0, sumImprovement: 0, trueCount: 0, usefulCount: 0 });
  const byAccess = {}, byReportType = {};
  for (const g of grades) {
    if (!g.gradeable) continue;
    for (const [map, key] of [[byAccess, g.accessRelevance], [byReportType, g.reportType]]) {
      const b = (map[key] = map[key] || bucket());
      b.n++;
      if (g.adjustmentImprovedLogLoss != null) b.sumImprovement += g.adjustmentImprovedLogLoss;
      if (g.reportTrue === true) b.trueCount++;
      if (g.reportUseful) b.usefulCount++;
    }
  }
  const shrink = (m) => Object.fromEntries(Object.entries(m).map(([k, b]) => [k, {
    n: b.n, provisionalReliability: +(b.sumImprovement / (b.n + priorStrength)).toFixed(4),
    trueRate: +(b.trueCount / b.n).toFixed(3), usefulRate: +(b.usefulCount / b.n).toFixed(3),
    note: "PROVISIONAL, shrunk toward zero — a measurement, not a forecast input",
  }]));
  return { byAccess: shrink(byAccess), byReportType: shrink(byReportType), priorStrength };
}

// Append-only: each record is graded once per settlement (keyed by intelligenceId + settlement id).
function appendToLedger(ledger, cardGrades, settlementId) {
  const out = { grades: { ...(ledger.grades || {}) }, updatedAt: (ledger.updatedAt || null) };
  for (const g of cardGrades) {
    const key = `${g.intelligenceId}|${settlementId}`;
    if (!(key in out.grades)) out.grades[key] = g;   // never overwrite a settled grade
  }
  return out;
}

module.exports = { gradeRecord, gradeCard, reliability, appendToLedger, marketMoveTs };
