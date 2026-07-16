// FIGHT SCENARIOS — the paths the sealed numbers already imply.
//
// SCENARIOS EXPLAIN THE FORECAST. THEY NEVER CHANGE IT. The probability was sealed before this file
// ran, and nothing here feeds back into it. That ordering is deliberate: a narrative built alongside
// a number will always find a way to justify it.
//
// Built from PRE-FIGHT evidence only. No result, no post-fight statistic, no retrospective phrasing,
// and — most importantly — no path invented because it is what happened. A scenario set that
// mysteriously contains the actual finish is not insight, it is leakage.
require("./env");
const F = require("./forecast");
const E = require("./evidence-eval");

// Which mechanisms tend to produce which method. Fixed, and not fitted to any outcome.
const MECH_METHOD = {
  striking: { method: "KO/TKO", rounds: "1-3", condition: "lands cleanly before the opponent establishes their own game" },
  grappling: { method: "decision or submission", rounds: "1-3", condition: "gets the fight to the mat and keeps it there" },
  cardio: { method: "late TKO or decision", rounds: "2-3", condition: "the fight reaches deep water" },
  durability: { method: "KO/TKO", rounds: "1-3", condition: "the opponent is made to absorb real damage" },
  condition: { method: "any", rounds: "1-3", condition: "the reported condition is real and matters on the night" },
  activity: { method: "any", rounds: "1-3", condition: "ring rust shows early, or does not" },
  style: { method: "decision", rounds: "1-3", condition: "the stylistic edge holds for the full fight" },
  physical: { method: "decision", rounds: "1-3", condition: "the physical edge is usable at range" },
};

// A generic, clearly-labelled pair for fights we know nothing about. Better an honest stub than a
// fabricated path with invented detail.
function genericScenarios(A, B, why) {
  return [
    { scenarioId: "GEN-A", winner: A, method: "any", roundRange: "1-3",
      requiredConditions: ["no specific mechanism identified"], supportingMechanismIds: [], contradictoryMechanismIds: [],
      mainFailureMode: "unknown — there is no evidence to describe a path",
      evidenceLimitations: [why], generic: true },
    { scenarioId: "GEN-B", winner: B, method: "any", roundRange: "1-3",
      requiredConditions: ["no specific mechanism identified"], supportingMechanismIds: [], contradictoryMechanismIds: [],
      mainFailureMode: "unknown — there is no evidence to describe a path",
      evidenceLimitations: [why], generic: true },
  ];
}

// Build 3-6 distinct scenarios where evidence permits. Distinct means a DIFFERENT mechanism or a
// different fighter — not the same path reworded.
function scenariosFor(boutEval, forecast, A, B) {
  if (!boutEval || boutEval.coverage === "INSUFFICIENT EVIDENCE")
    return genericScenarios(A, B, "insufficient evidence — no mechanism-level path can be described");
  const applied = (forecast.appliedAdjustments || []);
  if (!applied.length)
    return genericScenarios(A, B, "evidence exists but no mechanism cleared the magnitude rules, so no path is supported");

  // group the sealed adjustments by (fighter, mechanism) — these ARE the paths the number came from
  const paths = [];
  for (const adj of applied.sort((a, b) => b.finalAppliedLogOdds - a.finalAppliedLogOdds)) {
    const mm = MECH_METHOD[adj.mechanism] || { method: "any", rounds: "1-3", condition: "the mechanism is decisive" };
    const loser = adj.fighterFavored === A ? B : A;
    // contradiction on this mechanism is the path's own failure mode — stated, not buried
    const opposing = applied.find((x) => x.mechanism === adj.mechanism && x.fighterFavored !== adj.fighterFavored);
    paths.push({
      scenarioId: `${adj.mechanism.toUpperCase()}-${adj.fighterFavored === A ? "A" : "B"}`,
      winner: adj.fighterFavored,
      method: mm.method, roundRange: mm.rounds,
      requiredConditions: [mm.condition, `${adj.fighterFavored}'s ${adj.mechanism} advantage is real and not already in the price`],
      supportingMechanismIds: [adj.adjustmentId],
      supportingTopics: adj.evidenceTopics,
      informationOrigins: adj.informationOriginCount,
      contradictoryMechanismIds: opposing ? [opposing.adjustmentId] : [],
      mainFailureMode: opposing
        ? `${loser} wins the same exchange: ${opposing.evidenceTopics.join("/")} cuts the other way`
        : `${loser} denies the mechanism entirely (${mm.condition} never happens)`,
      evidenceLimitations: [
        `${adj.informationOriginCount} independent origin(s)`,
        ...(adj.capOrReductionReason ? [adj.capOrReductionReason] : []),
        ...(adj.freshness.includes("unknown_timeframe") ? ["some supporting evidence has no determinable timeframe"] : []),
      ],
      generic: false,
    });
  }

  // de-duplicate: one path per (winner, mechanism). Different phrasings of one path are one path.
  const seen = new Set();
  const distinct = paths.filter((p) => { const k = `${p.winner}|${p.scenarioId}`; if (seen.has(k)) return false; seen.add(k); return true; });

  // ensure BOTH fighters have at least one path — a scenario set that only describes how the
  // favourite wins is not a fight analysis, it is a pick with extra words.
  const have = new Set(distinct.map((p) => p.winner));
  for (const f of [A, B]) {
    if (have.has(f)) continue;
    distinct.push({
      scenarioId: `RESIDUAL-${f === A ? "A" : "B"}`, winner: f, method: "any", roundRange: "1-3",
      requiredConditions: [`the mechanisms favouring ${f === A ? B : A} do not materialise`],
      supportingMechanismIds: [], contradictoryMechanismIds: applied.map((a) => a.adjustmentId),
      mainFailureMode: "no positive evidence describes this path; it is the residual the market already prices",
      evidenceLimitations: ["no mechanism-level support was found for this fighter"], generic: false, residual: true,
    });
  }
  return distinct.slice(0, 6);
}

module.exports = { scenariosFor, genericScenarios, MECH_METHOD };
