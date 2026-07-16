// Unit tests for the ranked scenario layer.
//
// The property under test is FALSIFIABILITY. v1 passed its own evaluation 12/12 because every set
// was forced to cover both fighters, so no result could contradict it. These tests assert the
// structures that make v2 capable of being wrong: shares that must reconcile with the sealed tree,
// paths that are labelled unsupported when nothing supports them, and a falsifier on every path.
const R = require("../lib/scenarios-ranked");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? " -> " + extra : ""}`); } };

const A = "Alice Ace", B = "Bob Bruiser";
// a tree shaped exactly like the engine's: win split into ko/sub/dec by the fixed priors
const tree = (pA) => ({
  [A]: { win: pA, byKO: +(pA * 0.33).toFixed(4), bySubmission: +(pA * 0.17).toFixed(4), byDecision: +(pA * 0.5).toFixed(4) },
  [B]: { win: +(1 - pA).toFixed(4), byKO: +((1 - pA) * 0.33).toFixed(4), bySubmission: +((1 - pA) * 0.17).toFixed(4), byDecision: +((1 - pA) * 0.5).toFixed(4) },
});
const adj = (o) => ({ adjustmentId: "x1", fighterFavored: A, mechanism: "striking", finalAppliedLogOdds: 0.14,
  evidenceTopics: ["power"], informationOriginCount: 3, originIds: ["o1", "o2", "o3"], capOrReductionReason: null, ...o });
const fc = (o = {}) => ({ fight: `${A} vs ${B}`, boutId: "b1", outcomeTree: tree(0.6), appliedAdjustments: [adj()], ...o });
const be = { boutId: "b1", coverage: "WELL COVERED", topics: [], contradictions: [] };

console.log("SHARES COME FROM THE TREE, NOT FROM A MODEL");
{
  const { scenarios, coherence } = R.rankedScenariosFor(be, fc(), A, B);
  ok("six cells: two fighters x three methods", scenarios.length === 6, String(scenarios.length));
  ok("shares sum to exactly 1", coherence.sharesSumTo === 1, String(coherence.sharesSumTo));
  ok("coherence verified against the sealed tree", coherence.ok, JSON.stringify(coherence.errors));
  const t = tree(0.6);
  ok("A's shares sum to A's tree win prob", Math.abs(coherence.perFighterShares[A] - t[A].win) < 0.005);
  ok("B's shares sum to B's tree win prob", Math.abs(coherence.perFighterShares[B] - t[B].win) < 0.005);
  // every share must BE a tree cell — not a nearby number
  const cells = [t[A].byKO, t[A].bySubmission, t[A].byDecision, t[B].byKO, t[B].bySubmission, t[B].byDecision];
  ok("every share is literally a tree cell", scenarios.every((s) => cells.some((c) => Math.abs(c - s.share) < 1e-9)));
}

console.log("\nINCOHERENCE IS CAUGHT, NOT ASSUMED");
{
  // a tampered tree whose cells do not sum to its own win prob must be reported
  const bad = tree(0.6);
  bad[A].byDecision = 0.9;              // now A's cells sum well past A's win prob
  const { coherence } = R.rankedScenariosFor(be, fc({ outcomeTree: bad }), A, B);
  ok("a tree whose cells contradict its win prob is flagged", !coherence.ok);
  ok("the error names the mismatch", coherence.errors.some((e) => /sum to/.test(e)), JSON.stringify(coherence.errors));
  const { scenarios, coherence: c2 } = R.rankedScenariosFor(be, fc({ outcomeTree: null }), A, B);
  ok("no tree -> no scenarios, and a reason", scenarios.length === 0 && /without inventing/.test(c2.reason));
}

console.log("\nRANKING IS DETERMINISTIC AND SHARE-ORDERED");
{
  const { scenarios } = R.rankedScenariosFor(be, fc(), A, B);
  const ranks = scenarios.map((s) => s.rank);
  ok("ranks are 1..6 with no gaps", JSON.stringify(ranks) === "[1,2,3,4,5,6]", JSON.stringify(ranks));
  const shares = scenarios.map((s) => s.share);
  ok("shares are non-increasing with rank", shares.every((v, i) => i === 0 || shares[i - 1] >= v), JSON.stringify(shares));
  // same input twice -> byte-identical output
  const a = R.rankedScenariosFor(be, fc(), A, B), b = R.rankedScenariosFor(be, fc(), A, B);
  ok("identical inputs produce an identical hash", a.hash === b.hash);
  ok("the favourite's paths outrank the underdog's same-method paths", (() => {
    const aDec = scenarios.find((s) => s.winner === A && s.expectedMethod === "Decision");
    const bDec = scenarios.find((s) => s.winner === B && s.expectedMethod === "Decision");
    return aDec.share > bDec.share;
  })());
}

console.log("\nUNSUPPORTED PATHS ARE LABELLED, NOT DRESSED UP");
{
  // only ONE mechanism, favouring A's striking -> A/KO is supported; everything else is not
  const { scenarios } = R.rankedScenariosFor(be, fc(), A, B);
  const aKO = scenarios.find((s) => s.winner === A && s.expectedMethod === "KO/TKO");
  ok("the mechanism's own cell is marked supported", aKO.supported === true);
  ok("its decisive mechanism is named", aKO.decisiveMechanisms.includes("striking"));
  const bSub = scenarios.find((s) => s.winner === B && s.expectedMethod === "Submission");
  ok("a cell nothing argues for is marked UNSUPPORTED", bSub.supported === false);
  ok("an unsupported path says so in plain words", bSub.whyRankedHere.some((w) => /no mechanism in the evidence/.test(w)));
  ok("an unsupported path claims no mechanisms", bSub.decisiveMechanisms.length === 0);
  // the v1 failure mode: both fighters handed equally broad generic paths
  const supported = scenarios.filter((s) => s.supported);
  ok("support is NOT handed to both fighters equally by default", new Set(supported.map((s) => s.winner)).size === 1,
    JSON.stringify(supported.map((s) => `${s.winner}/${s.expectedMethod}`)));
}

console.log("\nROLES");
{
  const { scenarios } = R.rankedScenariosFor(be, fc(), A, B);
  const p = scenarios.find((s) => s.role === "PRIMARY");
  const u = scenarios.find((s) => s.role === "UPSET_OR_ALTERNATIVE");
  ok("exactly one PRIMARY", scenarios.filter((s) => s.role === "PRIMARY").length === 1);
  ok("exactly one SECONDARY", scenarios.filter((s) => s.role === "SECONDARY").length === 1);
  ok("exactly one UPSET_OR_ALTERNATIVE", scenarios.filter((s) => s.role === "UPSET_OR_ALTERNATIVE").length === 1);
  ok("PRIMARY is a supported path", p.supported === true, `${p.winner}/${p.expectedMethod} supported=${p.supported}`);
  ok("UPSET names the other fighter", u.winner !== p.winner, `${u.winner} vs primary ${p.winner}`);
  ok("remaining paths are DOWNWEIGHTED", scenarios.filter((s) => s.role === "DOWNWEIGHTED").length === 3);
  ok("PRIMARY explains why it outranks the rest", p.whyRankedHere.length >= 2);
  ok("a DOWNWEIGHTED path states its distance from PRIMARY",
    scenarios.filter((s) => s.role === "DOWNWEIGHTED").every((s) => s.whyRankedHere.some((w) => /ranks below PRIMARY/.test(w))));
  // PRIMARY must be the highest-share SUPPORTED path, not merely the biggest cell
  const supported = scenarios.filter((s) => s.supported).sort((x, y) => y.share - x.share);
  ok("PRIMARY is the highest-share supported path", p.scenarioId === supported[0].scenarioId);
}

console.log("\nEVERY PATH IS FALSIFIABLE");
{
  const { scenarios } = R.rankedScenariosFor(be, fc(), A, B);
  ok("every path names what would falsify it", scenarios.every((s) => s.falsifiedBy.length > 0));
  ok("falsifiers are observable developments, not results",
    scenarios.every((s) => s.falsifiedBy.every((f) => !/wins the fight|loses the fight/i.test(f))));
  const dec = scenarios.find((s) => s.expectedMethod === "Decision");
  ok("a Decision path is falsified by a finish", dec.falsifiedBy.some((f) => /inside the distance/.test(f)));
  const ko = scenarios.find((s) => s.expectedMethod === "KO/TKO" && s.supported);
  ok("a KO path is falsified by reaching the final bell", ko.falsifiedBy.some((f) => /final bell/.test(f)));
  ok("a mechanism adds its own falsifier", ko.falsifiedBy.length >= 2, JSON.stringify(ko.falsifiedBy));
  ok("every path carries a required condition", scenarios.every((s) => s.requiredConditions.length > 0));
  ok("every path carries evidence limitations", scenarios.every((s) => s.evidenceLimitations.length > 0));
  ok("every path states a round range", scenarios.every((s) => !!s.expectedRoundRange));
}

console.log("\nMECHANISMS CLUSTER, NEVER STACK");
{
  // three mechanisms all arguing for A's KO must MERGE into one path, not become three paths
  const many = fc({ appliedAdjustments: [
    adj({ adjustmentId: "a1", mechanism: "striking" }),
    adj({ adjustmentId: "a2", mechanism: "durability" }),
    adj({ adjustmentId: "a3", mechanism: "activity" }),
  ] });
  const { scenarios, coherence } = R.rankedScenariosFor(be, many, A, B);
  ok("three KO-implying mechanisms produce ONE path, not three", scenarios.length === 6, String(scenarios.length));
  const aKO = scenarios.find((s) => s.winner === A && s.expectedMethod === "KO/TKO");
  ok("all three are named on that single path", aKO.decisiveMechanisms.length === 3, JSON.stringify(aKO.decisiveMechanisms));
  ok("merging does not inflate the share beyond the tree cell", Math.abs(aKO.share - tree(0.6)[A].byKO) < 1e-9);
  ok("shares still sum to 1 after merging", coherence.sharesSumTo === 1);
}

console.log("\nCONTRADICTING EVIDENCE IS SURFACED");
{
  const both = fc({ appliedAdjustments: [
    adj({ adjustmentId: "a1", mechanism: "striking", fighterFavored: A }),
    adj({ adjustmentId: "a2", mechanism: "striking", fighterFavored: B }),
  ] });
  const { scenarios } = R.rankedScenariosFor(be, both, A, B);
  const aKO = scenarios.find((s) => s.winner === A && s.expectedMethod === "KO/TKO");
  ok("a mechanism arguing the other way is listed as contradicting", aKO.contradictingEvidence.length === 1);
  ok("the contradiction names who it favours", aKO.contradictingEvidence[0].favours === B);
  ok("both fighters' striking paths are supported when evidence genuinely splits",
    scenarios.filter((s) => s.expectedMethod === "KO/TKO" && s.supported).length === 2);
}

console.log("\nNO OUTCOME MAY REACH THIS MODULE");
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "scenarios-ranked.js"), "utf8");
  ok("module never imports a results source", !/require\(["'].*(results|predictions|grade)["']\)/.test(src));
  ok("module never reads a winner field", !/\.winner\s*===\s*actual|actualWinner|\bresult\b\s*===/.test(src));
  const { scenarios } = R.rankedScenariosFor(be, fc(), A, B);
  ok("no scenario carries an outcome field", scenarios.every((s) => !("actual" in s) && !("result" in s) && !("correct" in s)));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
