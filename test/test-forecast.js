// Phase 7 tests: leakage, coherence, restraint, determinism, and the "no bets" boundary.
const F = require("../lib/forecast");
const L = require("../lib/leakage-guard");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${x ? " -> " + x : ""}`); } };
const SEAL = Date.parse("2026-07-11T00:00:00Z");

console.log("LEAKAGE — deliberately feed the pipeline post-fight information");
// 1. a claim published AFTER the seal
{
  let threw = null;
  try { L.checkClaim({ claim: "he looked slow", quote: "q", publishedAt: "2026-07-12T00:00:00Z" }, SEAL); }
  catch (e) { threw = e; }
  ok("claim published after the seal is REJECTED", threw && threw.leakage, threw ? threw.message : "no throw");
}
// 2. a claim carrying the outcome — even when the value is falsy
{
  let threw = null;
  try { L.checkClaim({ claim: "x", quote: "q", publishedAt: "2026-07-01T00:00:00Z", result: 0 }, SEAL); }
  catch (e) { threw = e; }
  ok("claim carrying result:0 is REJECTED (a falsy outcome still proves knowledge)", threw && threw.leakage, threw ? threw.message : "no throw");
}
// 3. retrospective language
{
  let threw = null;
  try { L.checkClaim({ claim: "he won", quote: "he knocked him out in the second last night", publishedAt: "2026-07-01T00:00:00Z" }, SEAL); }
  catch (e) { threw = e; }
  ok("retrospective language is REJECTED", threw && threw.leakage, threw ? threw.message : "no throw");
}
// 4. an undateable claim cannot be proven admissible
{
  let threw = null;
  try { L.checkClaim({ claim: "x", quote: "q" }, SEAL); } catch (e) { threw = e; }
  ok("claim with no timestamp is REJECTED (cannot prove it predates the fight)", threw && threw.leakage);
}
// 5. a legitimate pre-fight claim passes
{
  let threw = null;
  try { L.checkClaim({ claim: "his cardio fades", quote: "he fades late", publishedAt: "2026-07-01T00:00:00Z" }, SEAL); }
  catch (e) { threw = e; }
  ok("a genuine pre-fight claim is ADMITTED", !threw, threw && threw.message);
}
// 6. a closing price quoted after the seal
{
  let threw = null;
  try { L.checkBaseline({ probability: 0.6, timestamp: "2026-07-12T00:00:00Z" }, SEAL); } catch (e) { threw = e; }
  ok("market baseline quoted after the seal is REJECTED", threw && threw.leakage);
}
// 7. the bulk filter reports what it refused rather than dropping silently
{
  const claims = [
    { claim: "ok", quote: "q", publishedAt: "2026-07-01T00:00:00Z" },
    { claim: "leak", quote: "q", publishedAt: "2026-07-20T00:00:00Z" },
    { claim: "leak2", quote: "q", publishedAt: "2026-07-01T00:00:00Z", winner: "A" },
  ];
  const r = L.admissibleClaims(claims, SEAL);
  ok("bulk filter admits 1 of 3", r.admitted.length === 1, `got ${r.admitted.length}`);
  ok("  ...and REPORTS the 2 it refused", r.rejected.length === 2 && r.rejected.every((x) => x.why));
}
// 8. a nested outcome field anywhere in a loaded object
{
  let threw = null;
  try { L.assertNoOutcomeFields({ card: { bouts: [{ a: "X", meta: { result: 1 } }] } }, "card file"); } catch (e) { threw = e; }
  ok("a nested result field is caught by the deep sweep", threw && threw.leakage);
}

console.log("\nCOHERENT OUTCOME TREE");
{
  const t = F.buildTree(0.55, "A", "B");
  const errs = F.verifyTree(t, "A", "B");
  ok("a built tree is internally coherent", errs.length === 0, errs.join("; "));
  ok("  win probabilities sum to 1", Math.abs(t.A.win + t.B.win - 1) < 0.005);
  ok("  A: KO+sub+dec = A.win", Math.abs(t.A.byKO + t.A.bySubmission + t.A.byDecision - t.A.win) < 0.005);
  ok("  round-1 KO <= total KO", t.A.koByRound.r1 <= t.A.byKO);
}
// the exact incoherence the brief calls out: 55% win but methods totalling 80%
{
  const bad = { A: { win: 0.55, byKO: 0.35, bySubmission: 0.20, byDecision: 0.25, koByRound: { r1: 0.35, r2: 0, r3: 0 }, submissionByRound: { r1: 0.2, r2: 0, r3: 0 } },
    B: { win: 0.45, byKO: 0.1, bySubmission: 0.1, byDecision: 0.25, koByRound: { r1: 0.1, r2: 0, r3: 0 }, submissionByRound: { r1: 0.1, r2: 0, r3: 0 } } };
  const errs = F.verifyTree(bad, "A", "B");
  ok("the brief's incoherent example (55% win, 80% methods) is REJECTED", errs.length > 0, "verifier passed it!");
}

console.log("\nRESTRAINT — narratives and unmapped topics move nothing");
{
  // REAL Phase 6 shape. The first fixtures used a flat independentOrigins field that does not exist,
  // so the tests validated the buggy code instead of the data and a 1-origin claim reached MAJOR.
  const ev = (o) => { const { origins = 9, ...rest } = o || {};
    return { topic: "cardio", origin: { independentOrigins: origins, originIds: Array.from({length: origins}, (_, i) => "analyst:s" + i) },
      strength: "strong", kinds: ["verified_hard_fact"], relevance: ["direct_current_matchup"], freshness: ["recent_fights"], ...rest }; };
  ok("a blocked narrative gets NONE", F.magnitudeClassFor(ev({ topic: "psychological" })).cls === "NONE");
  ok("  ...and says why", /blocked narrative/.test(F.magnitudeClassFor(ev({ topic: "psychological" })).reason));
  ok("an unsupported narrative gets NONE", F.magnitudeClassFor(ev({ topic: "unsupported_narrative" })).cls === "NONE");
  ok("a direct pick gets NONE", F.magnitudeClassFor(ev({ topic: "direct_prediction" })).cls === "NONE");
  ok("a topic with no mechanism gets NONE", F.magnitudeClassFor(ev({ topic: "other" })).cls === "NONE");
  ok("  ...because no mechanism connects it to this fight", /no fight mechanism/.test(F.magnitudeClassFor(ev({ topic: "other" })).reason));
  ok("1 origin is not enough for any adjustment", F.magnitudeClassFor(ev({ origins: 1 })).cls === "NONE", F.magnitudeClassFor(ev({ origins: 1 })).cls);
  ok("2 origins cannot reach MAJOR", F.magnitudeClassFor(ev({ origins: 2 })).cls !== "MAJOR", F.magnitudeClassFor(ev({ origins: 2 })).cls);
  ok("4 origins cannot reach MAJOR (needs 5)", F.magnitudeClassFor(ev({ origins: 4 })).cls !== "MAJOR", F.magnitudeClassFor(ev({ origins: 4 })).cls);
  ok("a MISSING origin count is refused, not assumed", F.magnitudeClassFor({ topic: "cardio", strength: "strong", kinds: ["verified_hard_fact"], relevance: ["direct_current_matchup"], freshness: ["recent_fights"] }).cls === "NONE");
  ok("stale evidence cannot reach MAJOR", F.magnitudeClassFor(ev({ freshness: ["stale_or_dated"] })).cls !== "MAJOR");
  ok("strong, fresh, 9-origin hard fact reaches MAJOR", F.magnitudeClassFor(ev()).cls === "MAJOR", F.magnitudeClassFor(ev()).cls);
}

console.log("\nMAGNITUDES ARE CONSERVATIVE AND CAPPED");
{
  const R = F.RULES;
  ok("MAJOR is <= 0.30 log-odds (~7 points at an even line)", R.magnitudeClasses.MAJOR <= 0.30, String(R.magnitudeClasses.MAJOR));
  ok("total per-fighter cap <= 0.5 log-odds", R.caps.totalLogOddsPerFighter <= 0.5);
  ok("a hard cap on movement from the market exists", R.caps.maxProbabilityPointsFromMarket <= 10);
  // what MAJOR actually does to a 50c line
  const moved = F.sig(F.logit(0.5) + R.magnitudeClasses.MAJOR) - 0.5;
  ok(`  a single MAJOR moves a 50c line by <= 8 points (${(moved * 100).toFixed(1)})`, moved <= 0.08);
}

console.log("\nMECHANISM CLUSTERING — correlated evidence must not stack");
{
  ok("cardio and pace are ONE mechanism", F.mechanismOf("cardio") === F.mechanismOf("pressure_pace"));
  ok("wrestling and takedown defence are ONE mechanism", F.mechanismOf("wrestling_offense") === F.mechanismOf("takedown_defense"));
  ok("cardio and grappling are DIFFERENT mechanisms", F.mechanismOf("cardio") !== F.mechanismOf("wrestling_offense"));
  ok("injury and layoff are different mechanisms", F.mechanismOf("injury_health") !== F.mechanismOf("inactivity_layoff"));
}

console.log("\nDETERMINISM");
{
  const t1 = JSON.stringify(F.buildTree(0.618, "A", "B"));
  const t2 = JSON.stringify(F.buildTree(0.618, "A", "B"));
  ok("same input -> byte-identical tree", t1 === t2);
}

console.log("\nNO BETS ANYWHERE");
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "forecast.js"), "utf8");
  ok("engine contains no kelly/stake maths", !/kelly|stakePct|betSize/i.test(src.replace(/\/\/.*$/gm, "")));
  ok("config declares no stake rules", !JSON.stringify(F.RULES).match(/"(stake|kelly|bankroll)"/i));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
