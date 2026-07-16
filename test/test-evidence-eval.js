// Unit tests for the evidence evaluator.
// Every case below is one this module got WRONG at least once. The origins logic is its central
// claim — that a megaphone is not a consensus — and it inverted that claim twice while being built.
const E = require("../lib/evidence-eval");
const be = require("../lib/bout-evidence");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${x ? " -> " + x : ""}`); } };
const C = (o) => ({ claim: "x", about: "A", opponent: "B", direction: "favors_about", evidenceType: "striking",
  claimClass: "film_study", confidence: 0.7, quote: "q", channel: "S1", sources: ["S1"], mentionCount: 1,
  videoId: "v", segment: { startChar: 0, endChar: 9 }, boutId: "B1", cardEvidence: "current_matchup", ...o });

console.log("ORIGINS — a megaphone is not a consensus");
// 1. N analysts each watching tape = N origins
{
  const g = ["S1", "S2", "S3"].map((s) => C({ channel: s, sources: [s], claim: "his chin rises when he trades", claimClass: "film_study" }));
  const o = E.originAnalysis(g);
  ok("3 analysts, 3 independent film reads -> 3 origins", o.independentOrigins === 3, `got ${o.independentOrigins}`);
  ok("  ...typed as independent analysis", o.originType === "independent_analysis", o.originType);
}
// 2. N channels repeating ONE rumor = 1 origin, N amplifiers
{
  const g = ["S1", "S2", "S3", "S4"].map((s) => C({ channel: s, sources: [s], claimClass: "rumor",
    claim: "he has a staph infection", quote: "I'm hearing he has staph" }));
  const o = E.originAnalysis(g);
  ok("4 channels repeating one rumor -> 1 origin", o.independentOrigins === 1, `got ${o.independentOrigins}`);
  ok("  ...but 4 amplifiers recorded", o.amplifyingChannels === 4, `got ${o.amplifyingChannels}`);
  ok("  ...and it says so explicitly", /amplification, not confirmation/.test(o.note || ""), o.note);
}
// 3. N channels citing ONE public stat = 1 origin (they all read the same sheet)
{
  const g = ["S1", "S2", "S3"].map((s) => C({ channel: s, sources: [s], claimClass: "statistical",
    claim: "he has an 86% takedown defence rate" }));
  const o = E.originAnalysis(g);
  ok("3 channels citing one stat -> 1 origin", o.independentOrigins === 1, `got ${o.independentOrigins}`);
}
// 4. THE BUG: one secondhand claim must NOT collapse a group of independent observations.
{
  const g = [
    ...["S1", "S2", "S3", "S4"].map((s) => C({ channel: s, sources: [s], claimClass: "psychological",
      claim: "he is not as hungry as he used to be", quote: "he doesn't look hungry" })),
    C({ channel: "S5", sources: ["S5"], claimClass: "rumor", claim: "he is not as hungry", quote: "I'm hearing he's not motivated" }),
  ];
  const o = E.originAnalysis(g);
  ok("4 independent reads + 1 rumor -> 5 origins, NOT 1", o.independentOrigins === 5, `got ${o.independentOrigins}`);
  ok("  ...not typed as a pure external report", o.originType !== "external_report", o.originType);
}
// 5. THE REGEX BUG: "strikes per minute" is a statistic, not hearsay.
{
  const c = C({ claimClass: "statistical", claim: "he lands 6 significant strikes per minute",
    quote: "Yanez six significant strikes per minute to 2.8 for Garbrandt." });
  ok('"strikes per minute" is NOT secondhand', E.kindOf(c) === "verifiable_statistical_claim", E.kindOf(c));
}
// 6. a genuine attribution IS secondhand
{
  const c = C({ claimClass: "film_study", claim: "he was dropped in camp", quote: "I'm hearing he was dropped in camp" });
  ok('"I\'m hearing" IS secondhand', E.kindOf(c) === "secondhand_report", E.kindOf(c));
}

console.log("\nCLASSIFICATION");
{
  ok("a pick is not evidence", E.kindOf(C({ claimClass: "prediction", claim: "he wins in round 2" })) === "direct_pick_or_prediction");
  ok("firsthand is detected", E.kindOf(C({ claim: "his hips looked slow", quote: "I watched the tape and his hips looked slow" })) === "firsthand_statement");
  ok("unconfirmed injury -> rumor, not injury_health", E.kindOf(C({ claimClass: "rumor", claim: "torn acl", quote: "rumour is a torn acl" })) === "rumor");
}

console.log("\nTOPICS — unrelated claims must not pool just because they favour one fighter");
{
  ok("striking offense vs defense are different topics",
    E.topicOf(C({ claim: "his jab is elite", evidenceType: "striking" })) !== E.topicOf(C({ claim: "he is very hittable and gets hit a lot", evidenceType: "striking" })),
    `${E.topicOf(C({ claim: "his jab is elite", evidenceType: "striking" }))} vs ${E.topicOf(C({ claim: "he is very hittable and gets hit a lot", evidenceType: "striking" }))}`);
  ok("takedown defence is its own topic", E.topicOf(C({ claim: "his takedown defense is poor", evidenceType: "grappling" })) === "takedown_defense");
  ok("a layoff is not 'recent form'", E.topicOf(C({ claim: "he is coming off a five year layoff", evidenceType: "layoff" })) === "inactivity_layoff");
}

console.log("\nFRESHNESS — a recent video must not make an old observation current");
{
  ok("dated info is flagged stale", E.freshnessOf(C({ claim: "he was dropped back in 2019", quote: "back in 2019 he was dropped" })) === "stale_or_dated");
  ok("fight-week info is current", E.freshnessOf(C({ claim: "he looked drained at the weigh in", quote: "at the weigh in he looked drained" })) === "current_fight_week");
  ok("career tendency is long-term", E.freshnessOf(C({ claim: "he always fades late", quote: "he always fades" })) === "long_term_tendency");
}

console.log("\nCONTRADICTIONS — not every opposition is a contradiction");
{
  const a = C({ claimClass: "film_study", claim: "he is a superior boxer" });
  const b = C({ claimClass: "film_study", claim: "he lacks one punch power", direction: "against_about" });
  ok("'great boxer' + 'no KO power' can BOTH be true", E.contradictionType(a, b) === "compatible_claims", E.contradictionType(a, b));
  const p1 = C({ claim: "he wins early", quote: "he takes this in round one" });
  const p2 = C({ claim: "he fades late", quote: "if it goes long he fades", direction: "against_about" });
  ok("early vs late = different fight phases, both true", E.contradictionType(p1, p2) === "different_predicted_fight_phases", E.contradictionType(p1, p2));
  const f1 = C({ claimClass: "statistical", claim: "he is 37 years old" });
  const f2 = C({ claimClass: "statistical", claim: "he is 39 years old", direction: "against_about" });
  ok("two conflicting facts = factual disagreement", E.contradictionType(f1, f2) === "factual_disagreement", E.contradictionType(f1, f2));
}

console.log("\nENTITY RESOLUTION — never silently rewrite a name");
{
  const bout = { a: { name: "Cong Wang", norm: "cong wang", surname: "wang", aliases: [], ambiguous: false },
    b: { name: "Tracy Cortez", norm: "tracy cortez", surname: "cortez", aliases: [], ambiguous: false } };
  const r = E.resolveEntity("Kong Wang", bout);
  ok('"Kong Wang" resolves to Cong Wang', r.resolvedFighter === "Cong Wang", r.resolvedFighter);
  ok("  ...raw caption name is preserved", r.rawCaptionName === "Kong Wang");
  // "Kong Wang" keeps the surname intact, so it resolves by UNAMBIGUOUS SURNAME inside the bout —
  // high confidence and correct. The fuzzy path is for a garbled SURNAME, tested below.
  ok("  ...method is recorded", !!r.method, r.method);
  ok("  ...surname match inside a 2-fighter bout is high confidence", r.confidence === "high", r.confidence);
  const g = E.resolveEntity("Tracy Cortes", bout);   // surname itself garbled
  ok("garbled SURNAME uses fuzzy + is flagged for review", /fuzzy/.test(g.method || "") && g.confidence === "low" && g.needsHumanReview === true, g.method + "/" + g.confidence);
  const x = E.resolveEntity("Jon Jones", bout);
  ok("an unrelated fighter does NOT resolve", x.resolvedFighter === null, x.resolvedFighter);
}

console.log("\nBOUT SUMMARY — sparse must stay sparse");
{
  const bout = { boutId: "B1", a: { name: "A", norm: "a", surname: "a", aliases: [] }, b: { name: "B", norm: "b", surname: "b", aliases: [] } };
  const r = be.evaluateBout(bout, []);
  ok("no claims -> INSUFFICIENT EVIDENCE", r.coverage === "INSUFFICIENT EVIDENCE", r.coverage);
  ok("  ...and it lists what is missing", r.missingInformation.length > 0);
  const picks = [C({ claimClass: "prediction", claim: "he wins" }), C({ claimClass: "prediction", claim: "he wins by ko" })];
  const r2 = be.evaluateBout(bout, picks);
  ok("only picks, no reasoning -> INSUFFICIENT EVIDENCE", r2.coverage === "INSUFFICIENT EVIDENCE", r2.coverage);
  // one analyst covering many topics is NOT many origins
  const solo = ["cardio is shot", "his chin is gone", "his jab is elite", "he is hittable", "he wrestles well"]
    .map((t) => C({ claim: t, channel: "S1", sources: ["S1"] }));
  const r3 = be.evaluateBout(bout, solo);
  ok("1 analyst, 5 topics -> NOT 5 independent origins", r3.independentOrigins === 1, `got ${r3.independentOrigins}`);
  ok("  ...and the single-analyst limitation is stated", r3.limitations.some((l) => /single analyst/.test(l)), JSON.stringify(r3.limitations));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
