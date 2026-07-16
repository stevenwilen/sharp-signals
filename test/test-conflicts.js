// Unit tests for claim dedup + the conflict metric.
// The cases below are exactly the ones that were previously wrong or ambiguous, including the
// inverted FOR/AGAINST labels that made the old report lie about who thought what.
const { dedupe, conflictTopics } = require("../lib/claim-dedupe");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? " -> " + extra : ""}`); } };

const C = (o) => ({ claim: "x", about: "A", opponent: "B", direction: "favors_about",
  evidenceType: "cardio", claimClass: "film_study", confidence: 0.7, quote: "q",
  channel: "S1", videoId: "v1", url: "u", publishedAt: "2026-07-01T00:00:00Z",
  chunkId: "0", segment: { startChar: 0, endChar: 10, approxMinute: 0 }, ...o });

console.log("DEDUPE");
// 1. opposite claims about the same fighter must NOT merge
{
  const m = dedupe([
    C({ claim: "His cardio is elite", direction: "favors_about" }),
    C({ claim: "His cardio is shot", direction: "against_about" }),
  ]);
  ok("opposite claims about one fighter stay separate", m.length === 2, `got ${m.length}`);
}
// 2. claims about DIFFERENT fighters must never merge, however similar the wording
{
  const m = dedupe([
    C({ about: "A", claim: "His takedown defence is poor" }),
    C({ about: "B", claim: "His takedown defence is poor" }),
  ]);
  ok("same wording, different fighter -> separate", m.length === 2, `got ${m.length}`);
}
// 3. one source repeating itself = ONE opinion, said several times
{
  const m = dedupe([
    C({ claim: "He has an 86% takedown defence rate", channel: "S1", chunkId: "1" }),
    C({ claim: "His takedown defence rate is 86%", channel: "S1", chunkId: "4" }),
    C({ claim: "86% takedown defence rate for him", channel: "S1", chunkId: "9" }),
  ]);
  ok("one analyst repeating -> merged to 1 claim", m.length === 1, `got ${m.length}`);
  ok("  ...mentionCount = 3", m[0] && m[0].mentionCount === 3, `got ${m[0] && m[0].mentionCount}`);
  ok("  ...independentSources = 1 (NOT corroborated)", m[0] && m[0].independentSources === 1 && m[0].corroborated === false);
  ok("  ...every occurrence preserved", m[0] && m[0].occurrences.length === 3);
}
// 4. independent sources agreeing = corroboration
{
  const m = dedupe([
    C({ claim: "He has an 86% takedown defence rate", channel: "S1" }),
    C({ claim: "His takedown defence rate is 86%", channel: "S2" }),
  ]);
  ok("two analysts agreeing -> corroborated", m.length === 1 && m[0].corroborated === true);
  ok("  ...independentSources = 2", m[0] && m[0].independentSources === 2);
  ok("  ...mentionsPerSource kept per analyst", m[0] && m[0].mentionsPerSource.S1 === 1 && m[0].mentionsPerSource.S2 === 1);
}
// 5. repetition must never be mistaken for corroboration
{
  const m = dedupe([
    C({ claim: "His chin is gone", channel: "S1", chunkId: "1" }),
    C({ claim: "His chin is gone now", channel: "S1", chunkId: "2" }),
    C({ claim: "The chin is gone", channel: "S1", chunkId: "3" }),
    C({ claim: "His chin is gone", channel: "S2" }),
  ]);
  ok("4 mentions from 2 analysts -> mentionCount 4, independentSources 2",
    m.length === 1 && m[0].mentionCount === 4 && m[0].independentSources === 2,
    m[0] && `${m[0].mentionCount}/${m[0].independentSources}`);
}

console.log("\nCONFLICT TOPICS");
// 6. the O(n^2) explosion is gone: many opposing claims on one topic = ONE conflict topic
{
  const claims = [];
  for (let i = 0; i < 10; i++) claims.push(C({ claim: `good cardio point ${i}`, direction: "favors_about", channel: "S1" }));
  for (let i = 0; i < 8; i++) claims.push(C({ claim: `bad cardio point ${i}`, direction: "against_about", channel: "S2" }));
  const t = conflictTopics(claims);
  ok("10 for x 8 against on one topic -> 1 conflict TOPIC (not 80 pairs)", t.length === 1, `got ${t.length}`);
  ok("  ...positions counted correctly", t[0] && t[0].favorPosition.claims === 10 && t[0].againstPosition.claims === 8);
}
// 7. THE LABEL BUG: FOR/AGAINST must follow each claim's own direction, not list position.
{
  const t = conflictTopics([
    C({ claim: "AGAINST-CLAIM: his cardio fails", direction: "against_about", channel: "S1" }),
    C({ claim: "FOR-CLAIM: his cardio is elite", direction: "favors_about", channel: "S2" }),
  ]);
  ok("labels follow direction, not order", t.length === 1 &&
    t[0].favorPosition.examples[0].startsWith("FOR-CLAIM") &&
    t[0].againstPosition.examples[0].startsWith("AGAINST-CLAIM"),
    t[0] && `for=${t[0].favorPosition.examples[0]} against=${t[0].againstPosition.examples[0]}`);
  ok("  ...proposition names the reference side", t[0] && t[0].proposition.startsWith("A — cardio"));
}
// 8. agreement is not a conflict
{
  const t = conflictTopics([
    C({ claim: "cardio elite", direction: "favors_about", channel: "S1" }),
    C({ claim: "cardio great", direction: "favors_about", channel: "S2" }),
  ]);
  ok("two analysts agreeing -> 0 conflicts", t.length === 0, `got ${t.length}`);
}
// 9. neutral claims take no position
{
  const t = conflictTopics([
    C({ claim: "he is a wrestler", direction: "neutral", channel: "S1" }),
    C({ claim: "cardio elite", direction: "favors_about", channel: "S2" }),
  ]);
  ok("neutral claims are not a position -> 0 conflicts", t.length === 0, `got ${t.length}`);
}
// 10. one analyst contradicting himself is flagged, but is NOT a cross-source disagreement
{
  const t = conflictTopics([
    C({ claim: "cardio elite", direction: "favors_about", channel: "S1" }),
    C({ claim: "cardio shot", direction: "against_about", channel: "S1" }),
  ]);
  ok("self-contradiction detected", t.length === 1, `got ${t.length}`);
  ok("  ...but crossSource = false (one analyst, not two disagreeing)", t[0] && t[0].crossSource === false);
}
// 11. different topics about one fighter are not a conflict
{
  const t = conflictTopics([
    C({ claim: "cardio elite", direction: "favors_about", evidenceType: "cardio" }),
    C({ claim: "chin is weak", direction: "against_about", evidenceType: "durability" }),
  ]);
  ok("for on cardio + against on durability -> not a conflict", t.length === 0, `got ${t.length}`);
}
// 12. different bouts never merge into one topic
{
  const t = conflictTopics([
    C({ boutId: "B01", claim: "cardio elite", direction: "favors_about" }),
    C({ boutId: "B02", claim: "cardio shot", direction: "against_about" }),
  ]);
  ok("same fighter+topic in different bouts -> separate", t.length === 0, `got ${t.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
