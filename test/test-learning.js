// PROSPECTIVE LEARNING LEDGER — the feedback loop the audit found missing. These tests pin the
// disciplines that stop it from lying: append-only, log-loss-not-win-rate, seal-gated, shrunk.
const LN = require("../lib/learning");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const bout = (id, forFighter, pMarket, pSystem, adj = []) => ({
  boutId: id, fight: `${forFighter} vs X`, marketBaseline: { forFighter, probability: pMarket },
  systemCentral: { [forFighter]: pSystem, X: +(1 - pSystem).toFixed(4) }, appliedAdjustments: adj,
});
const sealed = (forecasts) => ({ sealHash: "seal-1", sealedAt: "2026-07-18T20:00:00Z", card: { eventId: "UFC-T" }, rulesVersion: "7.0.0", forecasts });

console.log("A GRADE REQUIRES A SEALED FORECAST");
{
  let threw = false;
  try { LN.gradeCard({ forecasts: [] }, {}); } catch { threw = true; }
  ok("grading an unsealed forecast throws", threw);
}

console.log("\nLOG LOSS, NOT WIN RATE — A RIGHT PICK FOR THE WRONG REASON DOES NOT SCORE THE ADJUSTMENT");
{
  // Moved market 0.50 -> 0.65 on A, and A won: the adjustment improved the forecast (lower log loss).
  const g1 = LN.gradeBout(bout("B", "A", 0.5, 0.65, [{ mechanism: "injury", finalAppliedLogOdds: 0.28, rawMagnitudeClass: "MODERATE", origins: 3 }]), { forFighterWon: 1 });
  ok("moving toward the winner improves log loss", g1.adjustmentImprovedLogLoss > 0);

  // Moved market 0.50 -> 0.65 on A, and A LOST: the adjustment made it worse.
  const g2 = LN.gradeBout(bout("B", "A", 0.5, 0.65, [{ mechanism: "injury", finalAppliedLogOdds: 0.28 }]), { forFighterWon: 0 });
  ok("moving toward the loser worsens log loss", g2.adjustmentImprovedLogLoss < 0);

  // A forecast that did NOT move: no adjustment credit either way, even if the favourite won.
  const g3 = LN.gradeBout(bout("B", "A", 0.6, 0.6, []), { forFighterWon: 1 });
  ok("a forecast that did not move earns no adjustment credit", g3.adjustmentImprovedLogLoss === 0 && g3.movedOffMarket === false);
}

console.log("\nVOID / UNSETTLED BOUTS ARE NOT GRADED");
{
  ok("a void bout is not gradeable", LN.gradeBout(bout("B", "A", 0.5, 0.6), { forFighterWon: null }).gradeable === false);
  const g = LN.gradeCard(sealed([bout("B1", "A", 0.5, 0.6)]), { B1: { forFighterWon: null } });
  ok("a card with only void bouts grades nothing", g.summary.gradeable === 0);
  const g2 = LN.gradeCard(sealed([bout("B1", "A", 0.5, 0.6)]), {});   // no settlement supplied
  ok("a bout with no settlement is skipped, not assumed", g2.bouts[0].gradeable === false);
}

console.log("\nTHE LEDGER IS APPEND-ONLY");
{
  const g = LN.gradeCard(sealed([bout("B1", "A", 0.5, 0.65), bout("B2", "C", 0.6, 0.6)]), { B1: { forFighterWon: 1 }, B2: { forFighterWon: 0 } });
  const r1 = LN.appendToLedger({ version: 1, grades: [] }, g);
  ok("first append writes both grades", r1.added === 2 && r1.skipped === 0);
  const r2 = LN.appendToLedger(r1.ledger, g);
  ok("re-appending the same (sealHash, boutId) writes nothing", r2.added === 0 && r2.skipped === 2);
  ok("...and the ledger still has exactly 2 grades", r2.ledger.grades.length === 2);

  // A DIFFERENT seal (a re-forecast) is a distinct grade, not an overwrite.
  const g2 = { ...g, forecastSealHash: "seal-2" };
  const r3 = LN.appendToLedger(r2.ledger, g2);
  ok("a different seal appends new grades", r3.added === 2 && r3.ledger.grades.length === 4);
}

console.log("\nPROVISIONAL RELIABILITY IS SHRUNK TOWARD NEUTRAL AND LABELLED");
{
  // One lucky 1-for-1 must not read as a strong edge.
  const g = LN.gradeCard(sealed([bout("B1", "A", 0.5, 0.65, [{ mechanism: "injury", finalAppliedLogOdds: 0.28 }])]), { B1: { forFighterWon: 1 } });
  const { ledger } = LN.appendToLedger({ version: 1, grades: [] }, g);
  const rel = LN.mechanismReliability(ledger, { priorStrength: 5 });
  const injury = rel.find((r) => r.mechanism === "injury");
  ok("the mechanism is tracked", !!injury && injury.n === 1);
  ok("...shrunk far below the raw improvement (n=1, prior=5)", Math.abs(injury.provisionalMeanImprovement) < 0.1);
  ok("...and marked PROVISIONAL", injury.status === "PROVISIONAL");
  ok("...with a note that it is not a standalone live signal", /exploration lane|capped/.test(injury.note));
}

console.log("\nEVERY GRADE CARRIES ITS SEAL LINEAGE (the leakage proof)");
{
  const g = LN.gradeCard(sealed([bout("B1", "A", 0.5, 0.65)]), { B1: { forFighterWon: 1 } });
  ok("the card grade records the seal hash", g.forecastSealHash === "seal-1");
  ok("...the rules version", g.rulesVersion === "7.0.0");
  ok("...and that it was sealed before first bell", g.sealedBeforeFirstBell === true);
  const { ledger } = LN.appendToLedger({ version: 1, grades: [] }, g);
  ok("each ledger row carries the seal hash", ledger.grades.every((r) => r.forecastSealHash === "seal-1"));
  ok("...and a gradedAt timestamp", ledger.grades.every((r) => Number.isFinite(Date.parse(r.gradedAt))));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
