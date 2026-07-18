// INTELLIGENCE → FORECAST TRACEABILITY (§9). Material intelligence feeds the EXISTING creative
// exploration lane; this module records the link so every forecast move is traceable back to the
// intelligence that caused it, and capped the same way.
//
// It NEVER recomputes the forecast. It reads the sealed exploration block (already produced by
// run-forecast.js with the SAME origin counting and the SAME caps) and attaches the lineage to the
// record. It NEVER bypasses the mechanical invariants — a bet is still gated downstream by
// lib/message-invariants (uncertain intel loosened the EVIDENCE threshold to get a hypothesis into the
// exploration lane; it may not loosen the price/side checks).
require("./env");
const norm = require("./evidence-eval").norm;

// Link one record to the exploration hypothesis it corresponds to on a sealed bout forecast. Returns
// the §9 traceability object and the signed forecast move toward the fighter the report HELPS.
function linkForecast(record, forecast, opts = {}) {
  const noImpact = { forecastImpact: null, forecastImpactPoints: 0, helps: record.outcomeAffected && record.outcomeAffected.helps };
  const xp = forecast && forecast.exploration;
  if (!xp) return noImpact;
  const A = String(forecast.fight || "").split(" vs ")[0];
  const helps = record.outcomeAffected && record.outcomeAffected.helps;
  // creativeMovePoints is expressed for fighter A. Translate to the fighter this report helps.
  const aMove = (xp.creativeMovePoints || 0) / 100;
  const towardHelps = helps && norm(helps) === norm(A) ? aMove : -aMove;
  const hyp = (xp.hypotheses || []).find((h) => norm(h.fighter) === norm(record.fighter) && h.boutTopic === record.topic) || null;

  const forecastImpact = {
    lane: "exploration",
    intelIds: [record.intelligenceId],
    truthStatus: record.truthStatus,
    independentOrigins: record.independentOrigins,
    accessRelevance: record.accessRelevance,
    mechanism: hyp ? hyp.causalMechanism : record.mechanism,
    adjustmentLogOdds: hyp ? hyp.adjustmentLogOdds : null,
    magnitudeBucket: hyp ? hyp.magnitudeBucket : null,
    verificationStatus: hyp ? hyp.verificationStatus : null,
    contradicted: hyp ? hyp.fatallyContradicted : null,
    boutCap: xp.cap, capped: xp.capped,
    probabilityBeforeA: xp.coreCentralA,
    probabilityAfterA: xp.creativeCentralA,
    aMovePoints: xp.creativeMovePoints,
    helps, impactPointsTowardHelps: +(towardHelps * 100).toFixed(2),
    effectOnContracts: opts.effectOnContracts || null,
  };
  return { forecastImpact, forecastImpactPoints: +towardHelps.toFixed(4), helps };
}

// Attach the impact to the record and record which sealed forecast versions it influenced (§2/§9).
function attach(record, forecast, opts = {}) {
  const { forecastImpact, forecastImpactPoints, helps } = linkForecast(record, forecast, opts);
  const version = forecast && (opts.sealHash || forecast.sealHash || forecast.forecastId);
  const forecastVersions = version ? [...new Set([...(record.forecastVersions || []), version])] : (record.forecastVersions || []);
  return { record: { ...record, forecastImpact, forecastVersions }, forecastImpactPoints, helps };
}

module.exports = { linkForecast, attach };
