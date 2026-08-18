// THE LIVE READ — refusal-first, and above all HONEST ABOUT NOISE.
//
// Two failures are guarded here. The first is UFC 330's Njokuani vs Alvarez: 92% STRONG, four reasons
// FOR, an EMPTY counterpoint, rendered as though the other side had been weighed and dismissed. It lost.
//
// The second is subtler and came from the operator watching a fight with the first version of this in
// hand: five equally-weighted red flags is the same as no guidance. Something on that list happens in
// EVERY fight, so the first one to occur reads as the pick collapsing — and selling a bet because a
// favourite got taken down once and immediately stood back up is a worse outcome than having no list at
// all. Every cue must therefore carry the bar that separates a pattern from a moment.
const RC = require("../run-confidence");
const { evidenceBalanceOf, watchFor, expectedOf, OBSERVABLE, DEFAULT_THRESHOLD,
  LIVE_WATCH_PRINCIPLE, LIVE_WATCH_PROTOCOL } = RC;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS  " + m); } else { fail++; console.log("  FAIL  " + m); } };
const claim = (topic, text, origins) => ({ topic, claim: text, origins: origins || 1 });

console.log("EVIDENCE BALANCE");
// 1. THE UFC 330 SHAPE: reasons for, nothing against -> flagged, in words.
{
  const b = evidenceBalanceOf([claim("durability", "knocked out five times")], [], "Chidi Njokuani");
  ok(b.oneSided === true, "1. reasons FOR with an empty counterpoint is flagged one-sided");
  ok(/No channel made a case for Chidi Njokuani/.test(b.note || ""), "1b. the note names who nobody argued for");
}
// 2. A stress-tested read is NOT flagged — the flag has to mean something.
ok(evidenceBalanceOf([claim("power", "big power")], [claim("wrestling_offense", "good takedowns")], "X").oneSided === false,
  "2. a read with a real counterpoint is NOT flagged");
// 3. REFUSAL: no evidence at all is UNCOVERED, not one-sided.
ok(evidenceBalanceOf([], [], "X").oneSided === false, "3. no evidence either way is NOT reported as one-sided");

console.log("");
console.log("ONE MOMENT IS NOT A PATTERN");
// 4. THE OPERATOR'S ACTUAL CASE: a takedown. The cue must say what counts and what to ignore, and the
//    dismissal must describe exactly the thing that nearly cost a bet — up once, straight back up.
{
  const [w] = watchFor([claim("wrestling_offense", "Stoltzfus has good takedowns", 2)], "Dustin Stoltzfus", "Mansur Abdul-Malik");
  ok(w.signal === "Dustin Stoltzfus " + OBSERVABLE.wrestling_offense.cue, "4. a known topic maps to an observable cue");
  ok(/STAYS there|sustained|next round/.test(w.confirms), "4b. `confirms` demands repetition or duration");
  ok(/single takedown/.test(w.dismisses) && /back up/.test(w.dismisses), "4c. `dismisses` names the one-off that must NOT count");
}
// 5. EVERY item carries both thresholds — a cue without a bar is the thing being fixed.
{
  const ws = watchFor([claim("power", "one-punch power", 3), claim("cardio", "gasses late"), claim("nope", "unmapped")], "A", "B");
  ok(ws.every((w) => w.confirms && w.dismisses), "5. every watch item carries confirms AND dismisses");
  ok(ws.every((w) => w.because), "5b. every item keeps the claim it came from");
}
// 6. REFUSAL: an unmapped topic still gets an honest bar rather than an invented cue.
{
  const [w] = watchFor([claim("some_new_topic", "only fights well in Brazil")], "Y", "Z");
  ok(w.signal === "Y: only fights well in Brazil", "6. an unmapped topic falls back to the claim, not an invented cue");
  ok(w.confirms === DEFAULT_THRESHOLD.confirms, "6b. ...and still says once is not a pattern");
}

console.log("");
console.log("ONE HEADLINE, RANKED — not five equal bullets");
// 7. Exactly one primary; the rest are explicitly secondary.
{
  const ws = watchFor([claim("power", "power", 1), claim("wrestling_offense", "wrestling", 3)], "A", "B");
  ok(ws.filter((w) => w.rank === "primary").length === 1, "7. exactly one item is ranked primary");
  ok(ws[0].rank === "primary" && ws[0].origins === 3, "7b. the primary is the most independently-corroborated");
}
// 8. A claim you cannot SEE must not become the headline, however many channels said it. "Fights like
//    their recent run" outranked "gets the fight to the mat" on origins alone and led three fights.
{
  const ws = watchFor([claim("recent_form", "in great form", 9), claim("wrestling_offense", "good takedowns", 1)], "A", "B");
  ok(ws[0].topic === "wrestling_offense", "8. an observable cue outranks background, even 1 origin vs 9");
  ok(OBSERVABLE.recent_form.live === false, "8b. background topics are marked not-live");
}

console.log("");
console.log("WHAT IT LOOKS LIKE WORKING (the counterweight)");
// 9. Falsifiers alone make every fight look like it is going wrong.
{
  const e = expectedOf([claim("striking_defense", "hard to hit", 2)], "Lerryan Douglas", "Jamall Emmers");
  ok(e && e.signal === "Lerryan Douglas " + OBSERVABLE.striking_defense.cue.replace("{o}", "Jamall Emmers"),
    "9. expect renders the pick's own case as an observable");
  ok(expectedOf([], "A", "B") === null, "9b. REFUSAL: no case for the pick -> no invented expectation");
}
// 10. THE PLACEHOLDER. The same table serves both directions; without {o} the pick's side rendered as
//     self-referential nonsense ("Douglas walks the pick down").
{
  const e = expectedOf([claim("pressure_pace", "walks people down", 2)], "Douglas", "Emmers");
  ok(/Emmers/.test(e.signal) && !/\{o\}/.test(e.signal), "10. {o} resolves to the OTHER fighter, never left raw");
  const [w] = watchFor([claim("pressure_pace", "walks people down", 2)], "Emmers", "Douglas");
  ok(/Douglas/.test(w.signal) && !/\{o\}/.test(w.signal), "10b. ...and flips correctly for the opponent's side");
}
// 11. NO GENDERED PRONOUNS anywhere in the generated cues. This roster has women's divisions, and a
//     table that calls Shanelle Dyer "he" is wrong the moment it renders.
{
  const bad = [];
  for (const [topic, o] of Object.entries(OBSERVABLE)) {
    for (const k of ["cue", "confirms", "dismisses"]) {
      if (/\b(he|his|him|she|her|hers)\b/i.test(o[k] || "")) bad.push(topic + "." + k);
    }
  }
  ok(bad.length === 0, "11. no cue in the table uses a gendered pronoun" + (bad.length ? " -> " + bad.join(", ") : ""));
}

console.log("");
console.log("THE STANDING PROTOCOL");
// 12. The governing rule is stated ONCE, up front, and is the noise rule.
ok(/not a pattern/i.test(LIVE_WATCH_PRINCIPLE) && /REPEATS or PERSISTS/.test(LIVE_WATCH_PRINCIPLE),
  "12. the principle leads with once-is-not-a-pattern");
// 13. It covers the failure the operator actually watched happen.
{
  const all = LIVE_WATCH_PROTOCOL.join(" ").toLowerCase();
  ok(/reluctan|respect|deferential/.test(all), "13. the protocol names the reluctant-favourite failure");
  ok(/initiat|passive/.test(all), "13b. ...with a round-one behavioural check");
  ok(LIVE_WATCH_PROTOCOL.length <= 3, "13c. the protocol stays short enough to hold in your head");
}
// 14. It stays an OBSERVATION aid. Deciding what to do about what you see is the operator's call, and
//     the system has never measured a live observation, so it is in no position to price one.
{
  const all = (LIVE_WATCH_PRINCIPLE + " " + LIVE_WATCH_PROTOCOL.join(" ")).toLowerCase();
  ok(!/\bhedge|\bstake|\bbet\b|cash out|\bsell\b|\bbuy\b/.test(all), "14. no staking or trading instruction anywhere");
}

console.log("");
console.log(pass + "/" + (pass + fail) + " passed");
process.exit(fail ? 1 : 0);
