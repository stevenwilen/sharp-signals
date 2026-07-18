// ORIGIN COUNTING — the cardinal rule, tested against the five shapes it has to tell apart.
//
// "Ten channels repeating one injury rumour is ONE origin with ten amplifiers, not ten confirmations."
// The magnitude rules key entirely on this number: 2 -> MINOR, 3 -> MODERATE, 5 -> MAJOR, 1 -> exactly
// zero. If the count is wrong, every gate above it is decoration.
//
// It was wrong. lib/evidence-eval.js kindOf() mapped claimClass "injury_health" to
// "current_condition_report", which matched none of the collapse branches and fell to the default —
// minting `analyst:<channel>`, one origin PER CHANNEL. Five channels each saying "Holland has a staph
// infection", phrased plainly so no secondhand cue fired, returned FIVE origins. Five is MAJOR. One
// reporter's story could move the forecast by the largest amount the engine can emit, and anyone
// checking the printed origin count would have read "5".
//
// Two subtler failures sat beside it:
//   - every unnamed rumour keyed to the literal string `report:unnamed`, so a staph rumour and a visa
//     rumour collapsed into ONE origin — under-counting, the mirror of the same blindness;
//   - identity keyed on `norm(claim).slice(0, 28)`, i.e. verbatim text, so REWORDING one story minted
//     fresh origins. Amplification rewords. That is what amplification IS.
const E = require("../lib/evidence-eval");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const claim = (o) => ({ about: "Kevin Holland", direction: "against_about", ...o });
const injury = (text, ch) => claim({ claim: text, quote: text, channel: ch, claimClass: "injury_health" });
const film = (text, ch) => claim({ claim: text, quote: text, channel: ch, claimClass: "film_study" });
const stat = (text, ch) => claim({ claim: text, quote: text, channel: ch, claimClass: "statistical" });

console.log("FIXTURE 1 — ONE RUMOUR REPEATED BY MANY CHANNELS");
{
  // Worded DIFFERENTLY by each channel, which is what real amplification looks like. A fixture that
  // repeats one string verbatim would pass against a broken implementation.
  const g = [
    injury("Kevin Holland has a staph infection.", "MMA EXPERTS"),
    injury("A staph infection is affecting Holland.", "Greedo Plays MMA"),
    injury("Holland is dealing with staph, infection confirmed.", "Fight Nerds"),
    injury("Word is Holland picked up a staph infection in camp.", "Combat Daily"),
    injury("Holland reportedly has staph.", "The Breakdown"),
  ];
  const r = E.originAnalysis(g);
  ok("five channels repeating one rumour = ONE origin", r.independentOrigins === 1, String(r.independentOrigins));
  ok("...with five amplifiers", r.amplifyingChannels === 5);
  ok("...composed of exactly one REPORTED origin", r.composition.reported === 1 && r.composition.analytical === 0);
  ok("...and zero analyst origins (the bug minted one per channel)", r.composition.analytical === 0);
  ok("...all five channels are recorded as amplifiers of that one origin",
    Object.values(r.amplifiersByOrigin)[0].length === 5);
  ok("...and it says so in words", /amplification, not confirmation/.test(r.note || ""));
  ok("ONE origin cannot reach MINOR (which needs 2)", r.independentOrigins < 2);
}

console.log("\nFIXTURE 2 — SEVERAL GENUINELY INDEPENDENT REPORTS");
{
  const g = [
    injury("Holland has a staph infection.", "A"),
    injury("Holland has visa problems and may not travel.", "B"),
    injury("Holland broke his hand sparring.", "C"),
  ];
  const r = E.originAnalysis(g);
  ok("three different unnamed reports = THREE origins", r.independentOrigins === 3, String(r.independentOrigins));
  ok("...they do not collapse to report:unnamed", !r.originIds.includes("report:unnamed"));
  ok("...each is a distinct id", new Set(r.originIds).size === 3);

  // Named attribution is the identity: ten outlets "per Helwani" are ONE origin.
  const helwani = Array.from({ length: 10 }, (_, i) => claim({
    claim: "Usman is dealing with a knee issue.", quote: "per Ariel Helwani, Usman is dealing with a knee issue",
    channel: `Outlet ${i}`, claimClass: "rumor" }));
  const h = E.originAnalysis(helwani);
  ok("ten outlets citing one named reporter = ONE origin", h.independentOrigins === 1, String(h.independentOrigins));
  ok("...with ten amplifiers", h.amplifyingChannels === 10);
  ok("...and the reporter is named in the record", h.citedOrigins.some((x) => /helwani/i.test(x)));

  // Two DIFFERENT named reporters are two origins.
  const two = E.originAnalysis([
    claim({ claim: "Usman is hurt.", quote: "per Ariel Helwani, Usman is hurt", channel: "A", claimClass: "rumor" }),
    claim({ claim: "Usman is hurt.", quote: "according to ESPN, Usman is hurt", channel: "B", claimClass: "rumor" }),
  ]);
  ok("two different named reporters = TWO origins", two.independentOrigins === 2, String(two.independentOrigins));
}

console.log("\nFIXTURE 3 — ANALYSTS INDEPENDENTLY OBSERVING THE SAME FOOTAGE");
{
  // The case the collapse must NOT swallow. Each analyst watched the tape and reached this themselves,
  // so each is a genuine independent judgement. An earlier version of this module cascaded the whole
  // group to "one rumour with N megaphones" and that was the same error pointing the other way.
  const g = [
    film("His chin rises when he throws the right hand.", "A"),
    film("He lifts his chin on the right cross.", "B"),
    film("Watch the chin — it comes up every time he commits.", "C"),
  ];
  const r = E.originAnalysis(g);
  ok("three analysts reading the same tape = THREE origins", r.independentOrigins === 3, String(r.independentOrigins));
  ok("...composed of analytical origins", r.composition.analytical === 3 && r.composition.reported === 0);
  ok("...and reported as independent observations", r.independentObservations === 3);
  ok("three independent analytical origins CAN reach MODERATE", r.independentOrigins >= 3);
}

console.log("\nFIXTURE 4 — ONE CHANNEL REPEATING ITSELF");
{
  const g = [
    film("His chin rises on the right hand.", "Greedo Plays MMA"),
    film("Again, that chin comes up on the right.", "Greedo Plays MMA"),
    film("The chin rise on the right hand is the read.", "Greedo Plays MMA"),
  ];
  const r = E.originAnalysis(g);
  ok("one analyst saying it three times = ONE origin", r.independentOrigins === 1, String(r.independentOrigins));
  ok("...and one amplifying channel", r.amplifyingChannels === 1);

  const j = E.originAnalysis([
    injury("Holland has staph.", "MMA EXPERTS"),
    injury("Holland's staph infection is bad.", "MMA EXPERTS"),
  ]);
  ok("one channel repeating one rumour = ONE origin", j.independentOrigins === 1, String(j.independentOrigins));
}

console.log("\nFIXTURE 5 — MIXED FIRSTHAND AND SECONDHAND REPORTING");
{
  const g = [
    claim({ claim: "I cornered him last camp and his knee was bad.", quote: "i cornered him last camp and his knee was bad",
      channel: "Coach Pod", claimClass: "injury_health" }),
    injury("Reportedly Holland has a staph infection.", "A"),
    injury("Word is Holland has staph.", "B"),
  ];
  const r = E.originAnalysis(g);
  ok("a firsthand account and a repeated rumour = TWO origins", r.independentOrigins === 2, String(r.independentOrigins));
  ok("...one firsthand", r.composition.firsthand === 1);
  ok("...one reported", r.composition.reported === 1);
  // The firsthand speaker is identified by PERSON, not by a `firsthand:` namespace. Namespacing ids by
  // kind means one channel that both witnesses something and reads tape mints two ids and counts as
  // two people — measured on the real card, that took a bout from 2 origins to 5. The role lives in
  // the composition; the identity is the person.
  ok("...and the firsthand source is identified as a person", r.originIds.some((i) => i.startsWith("analyst:coach")));
  ok("...with its role recorded in the composition, not in the id", r.composition.firsthand === 1);
  ok("the two rumour channels did NOT become two origins",
    r.originIds.filter((i) => i.startsWith("report:")).length === 1);
}

console.log("\nTHE COMPOSITION IS SEPARATED, NOT COLLAPSED INTO ONE NUMBER");
{
  const r = E.originAnalysis([
    injury("Holland has staph.", "A"),
    injury("Holland has staph, we're told.", "B"),
    film("His chin rises.", "C"),
    stat("He lands 4.2 significant strikes per minute.", "D"),
    stat("He is landing 4.2 sig strikes a minute.", "E"),
  ]);
  ok("origins separate into reported / analytical / recorded",
    r.composition.reported === 1 && r.composition.analytical === 1 && r.composition.recorded === 1,
    JSON.stringify(r.composition));
  ok("the two stat channels are ONE record origin, not two", r.composition.recorded === 1);
  ok("total origins is the sum of the composition",
    r.independentOrigins === Object.values(r.composition).reduce((a, b) => a + b, 0));
  ok("every origin carries its amplifier list", Object.keys(r.amplifiersByOrigin).length === r.independentOrigins);
  ok("maxAmplifiersOnOneOrigin is reported", Number.isFinite(r.maxAmplifiersOnOneOrigin));
}

console.log("\nPARAPHRASE CANNOT MANUFACTURE AN ORIGIN, AND DIFFERENT STORIES CANNOT MERGE");
{
  // The two directions of the identity function, tested against each other.
  const same = E.originAnalysis([
    injury("Holland has a staph infection.", "A"),
    injury("A staph infection is affecting Holland.", "B"),
    injury("Holland is dealing with staph, infection confirmed.", "C"),
  ]);
  ok("three paraphrases of one story = ONE origin", same.independentOrigins === 1, String(same.independentOrigins));

  const diff = E.originAnalysis([
    injury("Holland has a staph infection.", "A"),
    injury("Holland missed weight badly at the last fight.", "B"),
  ]);
  ok("two unrelated stories stay TWO origins", diff.independentOrigins === 2, String(diff.independentOrigins));

  // Order-independence: an origin id that depends on array order is not an identity.
  const g = [injury("Holland has a staph infection.", "A"), injury("A staph infection is affecting Holland.", "B")];
  const fwd = E.originAnalysis(g).originIds.slice().sort();
  const rev = E.originAnalysis(g.slice().reverse()).originIds.slice().sort();
  ok("origin ids are independent of claim order", JSON.stringify(fwd) === JSON.stringify(rev), `${fwd} vs ${rev}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
