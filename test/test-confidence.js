// CONFIDENCE ENGINE — the re-pointed system produces a calibrated who-wins confidence, no bet.
// These pin the honest bits: name matching that neither drops nor mis-joins a fighter, a consensus
// that refuses to speak when nothing covers a fight, and a calibration that never dresses a thin,
// lopsided read up as near-certainty.
const C = require("../lib/confidence");
const CAL = require("../lib/confidence-calibration");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

// ---- surname fuzzy equality (the join every pick rides on) ----
ok(C.surnameEq("delvalle", "valle"), "1. 'del Valle' matches 'Delvalle' (surname spelling drift)");
ok(C.surnameEq("sousa", "sousa"), "2. exact surname matches");
ok(!C.surnameEq("kim", "lee"), "3. unrelated surnames do not match");
ok(C.surnameEq("silva", "dasilva"), "4. 'Da Silva' matches 'Silva' (substring)");

// ---- whichSide: pair matching binds BOTH fighters, so it can't mis-join ----
const bout = { boutId: "B1", fight: "Ty Cole Miller vs Billy Goff", a: "Ty Cole Miller", b: "Billy Goff" };
ok(C.whichSide({ pick: "Ty Miller", opponent: "Billy Ray Goff" }, bout) === "a", "5. pick binds to side A on a fuzzy pair (Ty Miller / Billy Ray Goff)");
ok(C.whichSide({ pick: "Billy Goff", opponent: "Ty Miller" }, bout) === "b", "6. reversed pair binds to side B");
ok(C.whichSide({ pick: "Jon Jones", opponent: "Stipe Miocic" }, bout) === null, "7. an unrelated fight does NOT match (no mis-join)");
// same surname on the card must not collide: {Miller, Goff} != {Miller, Oliveira}
ok(C.whichSide({ pick: "Juliana Miller", opponent: "Luana Oliveira" }, bout) === null, "8. a DIFFERENT Miller fight does not collide via surname");

// ---- calibration: honest shrinkage (invariants that hold for any fitted slope in (0,1]) ----
ok(CAL.toProbability(0.5, 20) === 0.5, "9. a 50/50 consensus is 50% regardless of coverage");
ok(CAL.toProbability(1.0, 20) > CAL.toProbability(1.0, 4), "10. the SAME unanimous read is more confident when better covered");
ok(CAL.toProbability(1.0, 100) <= 0.92, "11. a YouTube consensus never asserts near-certainty (capped at 0.92)");
ok(CAL.toProbability(0.8, 10) > CAL.toProbability(0.65, 10), "12. more agreement -> higher confidence (monotonic in share)");
ok(CAL.toProbability(0.9, 2) < CAL.toProbability(0.9, 20), "13. the SAME lopsided read is pulled DOWN when thinly covered");
// the conservative DEFAULT (unfitted) never over-promises: an unfitted thin lopsided read stays modest
ok(0.5 + 0.5 * CAL.DEFAULT.slope * (3 / (3 + CAL.DEFAULT.coverageK)) < 0.7, "13b. the conservative default keeps a thin read under 70%");

// ---- scoreBout: refuses to speak with no coverage; counts what it has ----
const empty = C.scoreBout(bout, []);
ok(empty.pick === null && empty.label === "NO-READ" && empty.coverage === 0, "14. no picks -> NO-READ, never a fabricated pick");
const picks = [
  { source: "Bookie Beatdown", side: "a", confidence: 0.9, directness: "explicit" },
  { source: "MMA EXPERTS", side: "a", confidence: 0.8, directness: "explicit" },
  { source: "Kunath", side: "b", confidence: 0.6, directness: "explicit" },
];
const scored = C.scoreBout(bout, picks);
ok(scored.coverage === 3, "15. coverage counts distinct channels that picked");
ok(scored.pick === "Ty Cole Miller", "16. the weighted majority side is the pick");
ok(scored.confidencePct >= 50 && scored.confidencePct <= 92, "17. confidence stays within the honest [50,92] band");

// ---- label tracks the calibrated % (word and number never disagree) ----
ok(C.label(78, 20) === "STRONG" && C.label(58, 20) === "SLIGHT" && C.label(90, 1) === "UNDER-COVERED",
  "18. label follows the calibrated % and flags thin coverage outright");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
