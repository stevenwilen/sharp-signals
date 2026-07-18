// PROSPECTIVE LEARNING LEDGER — append-only. After a card settles, this grades what the SEALED forecast
// actually committed to, before the fights, against what happened. It is the feedback loop the audit
// found was entirely missing.
//
// THE DISCIPLINE, because the easy version of this lies to you:
//   - APPEND-ONLY. A grade is written once, keyed by (forecastHash, boutId). It is never rewritten —
//     rewriting a past grade is how a system launders a bad forecast into a good track record.
//   - PROSPECTIVE ONLY. It grades forecasts that were SEALED before first bell (the sealHash proves it).
//     It never back-grades, and it never claims a specialty edge from historical data whose grading
//     target does not exist (the audit: corroborated/knownBeforeBet are null on 2,199/2,199 claims).
//   - "THE BET WON" IS NOT "THE HYPOTHESIS WAS RIGHT." A forecast can be right for the wrong reason.
//     So the grade records the log-loss contribution of the ADJUSTMENT vs the bare market prior — did
//     moving off the market improve the forecast, or make it worse — not merely whether the pick won.
//   - PROVISIONAL. Any reliability record it rolls up is marked PROVISIONAL and shrunk toward neutral,
//     and it may influence a future forecast only through the exploration lane's capped, versioned,
//     transparent fields — never silently.
require("./env");

const clamp01 = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
// Log loss of a probabilistic forecast against a binary outcome. Lower is better. This is the honest
// scoreboard: a confident wrong forecast is punished, a hedged one less so.
const logLoss = (p, outcome) => { const q = clamp01(p); return -(outcome * Math.log(q) + (1 - outcome) * Math.log(1 - q)); };

// Grade one sealed bout forecast against its settled outcome. Everything is expressed for the SAME
// fighter — marketBaseline.forFighter — so system, market, and outcome are directly comparable.
//   fc      : a forecast record from the sealed artifact (systemCentral, marketBaseline, appliedAdjustments)
//   outcome : { forFighterWon: 0|1|null }  (null = void/cancelled — not gradeable)
function gradeBout(fc, outcome) {
  if (outcome.forFighterWon == null) {
    return { boutId: fc.boutId, gradeable: false, reason: "void/cancelled or unknown — no outcome to grade against" };
  }
  const aWon = outcome.forFighterWon;
  const forFighter = fc.marketBaseline && fc.marketBaseline.forFighter;
  const pSystem = forFighter && fc.systemCentral ? fc.systemCentral[forFighter] : null;
  const pMarket = fc.marketBaseline ? fc.marketBaseline.probability : null;
  if (pSystem == null || pMarket == null) {
    return { boutId: fc.boutId, gradeable: false, reason: "forecast carries no market/system probability to grade (likely INSUFFICIENT EVIDENCE)" };
  }

  const llSystem = logLoss(pSystem, aWon);
  const llMarket = logLoss(pMarket, aWon);
  const adjustments = (fc.appliedAdjustments || []).filter((x) => (x.finalAppliedLogOdds || 0) !== 0);
  const moved = Math.abs(pSystem - pMarket) > 1e-4;

  return {
    boutId: fc.boutId, fight: fc.fight, gradeable: true,
    aWon,
    pSystem: +pSystem.toFixed(4), pMarket: +pMarket.toFixed(4),
    // Did moving off the market help? Positive = the adjustment IMPROVED the forecast (lower log loss).
    logLossSystem: +llSystem.toFixed(4), logLossMarket: +llMarket.toFixed(4),
    adjustmentImprovedLogLoss: moved ? +(llMarket - llSystem).toFixed(4) : 0,
    movedOffMarket: moved,
    // The mechanisms the forecast leaned on — so a per-mechanism reliability record can be rolled up
    // later. Recorded even when the forecast did not move (empty), so "no adjustment" is itself data.
    mechanisms: adjustments.map((a) => ({ mechanism: a.mechanism || a.topic || "?", direction: a.fighterFavored,
      logOdds: a.finalAppliedLogOdds, magnitude: a.rawMagnitudeClass, origins: a.origins != null ? a.origins : null })),
    wonButDidNotMove: moved ? null : (pSystem >= 0.5) === (aWon === 1),
  };
}

// Grade a whole sealed card. Returns an APPEND-ONLY record set. `settlements` maps boutId ->
// { winnerNorm, aWon }. Every record carries the seal lineage so it can never be confused with a
// forecast produced after the fact.
function gradeCard(forecast, settlements) {
  if (!forecast || !forecast.sealHash) throw new Error("gradeCard requires a SEALED forecast (no sealHash) — refusing to grade an unsealed or post-hoc forecast");
  const sealedAt = Date.parse(forecast.sealedAt || "");
  const graded = [];
  for (const fc of forecast.forecasts || []) {
    const s = settlements[fc.boutId];
    if (!s) { graded.push({ boutId: fc.boutId, gradeable: false, reason: "no settlement recorded for this bout" }); continue; }
    graded.push(gradeBout(fc, s));
  }
  const usable = graded.filter((g) => g.gradeable);
  const improved = usable.filter((g) => g.movedOffMarket && g.adjustmentImprovedLogLoss > 0).length;
  const worsened = usable.filter((g) => g.movedOffMarket && g.adjustmentImprovedLogLoss < 0).length;

  return {
    card: forecast.card && forecast.card.eventId ? forecast.card.eventId : (forecast.card || null),
    forecastSealHash: forecast.sealHash,
    rulesVersion: forecast.rulesVersion || (forecast.versions && forecast.versions.rules) || null,
    sealedAt: forecast.sealedAt || null,
    sealedBeforeFirstBell: Number.isFinite(sealedAt),   // the seal timestamp is the leakage proof
    bouts: graded,
    summary: {
      gradeable: usable.length,
      movedOffMarket: usable.filter((g) => g.movedOffMarket).length,
      adjustmentsImprovedLogLoss: improved,
      adjustmentsWorsenedLogLoss: worsened,
      meanLogLossSystem: usable.length ? +(usable.reduce((s, g) => s + g.logLossSystem, 0) / usable.length).toFixed(4) : null,
      meanLogLossMarket: usable.length ? +(usable.reduce((s, g) => s + g.logLossMarket, 0) / usable.length).toFixed(4) : null,
    },
  };
}

// Merge a card grade into the append-only ledger. A (forecastSealHash, boutId) grade is written ONCE;
// a second attempt is ignored, never overwritten. Returns { ledger, added, skipped }.
function appendToLedger(ledger, cardGrade) {
  const l = ledger && Array.isArray(ledger.grades) ? ledger : { version: 1, grades: [] };
  const seen = new Set(l.grades.map((g) => `${g.forecastSealHash}|${g.boutId}`));
  let added = 0, skipped = 0;
  for (const b of cardGrade.bouts) {
    const key = `${cardGrade.forecastSealHash}|${b.boutId}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    l.grades.push({
      forecastSealHash: cardGrade.forecastSealHash, card: cardGrade.card,
      rulesVersion: cardGrade.rulesVersion, boutId: b.boutId,
      gradedAt: new Date().toISOString(), ...b,
    });
    added++;
  }
  return { ledger: l, added, skipped };
}

// Roll up PROVISIONAL per-mechanism reliability from the ledger. Shrunk toward neutral (0) by a prior,
// and labelled provisional — this is descriptive, and may influence a forecast only through the
// exploration lane's capped fields. n is tiny by construction early on; the shrinkage keeps a lucky
// 1-for-1 from reading as a real edge.
function mechanismReliability(ledger, { priorStrength = 5 } = {}) {
  const byMech = new Map();
  for (const g of (ledger.grades || [])) {
    for (const m of (g.mechanisms || [])) {
      const k = m.mechanism;
      if (!byMech.has(k)) byMech.set(k, { mechanism: k, n: 0, sumImprovement: 0 });
      const rec = byMech.get(k);
      rec.n++;
      rec.sumImprovement += (g.adjustmentImprovedLogLoss || 0);
    }
  }
  return [...byMech.values()].map((r) => ({
    mechanism: r.mechanism, n: r.n,
    // Shrunk mean improvement in log loss: (sum) / (n + prior). Toward 0 (neutral) when n is small.
    provisionalMeanImprovement: +(r.sumImprovement / (r.n + priorStrength)).toFixed(4),
    status: "PROVISIONAL",
    note: "Descriptive only. May influence a forecast solely via the exploration lane's capped, versioned fields.",
  })).sort((a, b) => b.n - a.n);
}

module.exports = { gradeBout, gradeCard, appendToLedger, mechanismReliability, logLoss };
