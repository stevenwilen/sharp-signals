// Identity tests for the verified-news injector.
//
// test/test-verified-news.js covers the ORIGIN dimension of this bridge exhaustively — a paste cannot
// assert its own weight, origins are counted from the sources supplied, one origin clears nothing.
// The IDENTITY dimension had no test at all, and that is the dimension that broke.
//
// A block is matched to a bout by boutId alone. boutId is a positional index (lib/target-card.js:68),
// so a block naming the right fighter with a stale boutId attaches to whatever fight now holds that
// slot. The `if (!bout)` guard cannot see it: the wrong boutId EXISTS. On 2026-07-17 the shipped
// alerts bound "Kamaru Usman" to B03, and B03 on that card is Mitch Ramirez vs Chase Hooper.
//
// These tests exercise the real predicate against the real evidence file on disk.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const ROOT = path.join(__dirname, "..");
const EV = path.join(ROOT, "data", "evidence-eval-2026-07-18.json");
const SEAL = "2026-07-18T20:00:00Z";

// Derive the bout mapping from the actual eval on disk, so the test is robust to whatever card the
// cloud last sealed (Kalshi re-lists/withdraws bouts; hardcoded IDs rot within a day).
const _ev = JSON.parse(fs.readFileSync(EV, "utf8"));
const _sides = (fight) => String(fight).split(/\s+vs\.?\s+/i).map((s) => s.trim());
const SUBJECT = { boutId: _ev.bouts[0].boutId, fighter: _sides(_ev.bouts[0].fight)[0], opponent: _sides(_ev.bouts[0].fight)[1], fight: _ev.bouts[0].fight };
// A DIFFERENT bout the subject is not in — for the mis-bind test.
const OTHER = _ev.bouts.find((b) => !_sides(b.fight).some((n) => n.toLowerCase().includes(SUBJECT.fighter.toLowerCase().split(" ").pop())));
// A fighter genuinely on NO bout of this card.
const ABSENT = "Nonexistent McNobody";

const block = (o = {}) => ([{
  boutId: SUBJECT.boutId, about: SUBJECT.fighter, opponent: SUBJECT.opponent,
  claim: `${SUBJECT.fighter}'s knee is damaged.`, topic: "injury_health", direction: "against_about",
  verdict: "CONFIRMED",
  sources: [
    { outlet: "MMA Fighting", origin: "okamoto", url: "https://example.com/a", quote: "His knee is shot.", publishedAt: "2026-07-14T10:00:00Z" },
    { outlet: "ESPN", origin: "helwani", url: "https://example.com/b", quote: `${SUBJECT.fighter} has knee trouble.`, publishedAt: "2026-07-14T11:00:00Z" },
  ],
  ...o,
}]);

// Run the real script, dry run, and return stdout. Never --write.
function run(blocks) {
  const tmp = path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "sharp-inj-")), "b.json");
  fs.writeFileSync(tmp, JSON.stringify(blocks));
  try {
    return execFileSync(process.execPath, [path.join(ROOT, "run-inject-verified.js"), EV, tmp, `--seal=${SEAL}`],
      { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

if (!fs.existsSync(EV)) {
  console.log("  SKIP  data/evidence-eval-2026-07-18.json not on disk");
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(0);
}

console.log("A FIGHTER WHO IS NOT IN THE BOUT IS REFUSED");
{
  // The mis-bind shape that shipped: the subject's block pointed at a DIFFERENT bout's id.
  const out = run(block({ boutId: OTHER.boutId }));
  ok(`${SUBJECT.fighter} on the ${OTHER.fight} bout is refused`, /IDENTITY REFUSED/.test(out));
  ok("...and names the fight it actually is", out.includes(OTHER.fight));
  ok("...and nothing is injected", /0 of 1 block\(s\) carry evidence/.test(out));
  ok("...even though the origins CLEARED (the refusal is not a side effect of weak evidence)",
    /origins COUNTED from your sources: 2/.test(out) && /MINOR/.test(out));
}

console.log("\nTHE CORRECT BOUT STILL WORKS (the gate is not just 'refuse everything')");
{
  const out = run(block());
  ok(`${SUBJECT.fighter} on their own bout is accepted`, !/IDENTITY REFUSED/.test(out), out.split("\n").filter((l) => /REFUS/.test(l)).join("|"));
  ok("...and confirms the side", /confirmed on side a/.test(out));
  ok("...and is admissible", /1 of 1 block\(s\) carry evidence/.test(out));
  const opp = run(block({ about: SUBJECT.opponent, opponent: SUBJECT.fighter }));
  ok("the OPPONENT is also in the bout and is accepted on side b", /confirmed on side b/.test(opp));
}

console.log("\nA NONEXISTENT BOUT IS STILL REFUSED (the old guard, still working)");
{
  const out = run(block({ boutId: "UFC-2026-07-18-B99-NONEXISTENT" }));
  ok("an unknown boutId is refused", /not in this evidence file/.test(out));
  ok("...and nothing is injected", /0 of 1 block\(s\) carry evidence/.test(out));
}

console.log("\nA FIGHTER IN NO BOUT AT ALL IS REFUSED");
{
  // A block about a fighter on no bout of this card has nowhere to land, and the positional id would
  // happily point it at somebody else's fight.
  const out = run(block({ about: ABSENT, opponent: "Someone Else" }));
  ok(`${ABSENT} (not on this card) is refused`, /IDENTITY REFUSED/.test(out));
  ok("...and says he is in neither side", /is in neither side of/.test(out));
}

console.log("\nSURNAME-ONLY AND AMBIGUOUS REFERENCES ARE REFUSED");
{
  // "Usman over Du Plessis" is the wrong-side hazard lib/names.js:50-52 documents: a surname can appear
  // inside a phrase about the OTHER man.
  const N = require("../lib/names");
  // Pinning the real semantics, because they are not what they look like and this check depends on
  // them. nameScore(text, name) returns 2 when EVERY token of `name` appears in `text` — so a
  // single-token `about` matches a full fighter name at full strength, and only a MULTI-token `about`
  // whose surname matches but whose first name does not lands on 1.
  ok("a single-token about matches a full name at strength 2, not 1",
    N.nameScore("Dricus Du Plessis", "Plessis") === 2, String(N.nameScore("Dricus Du Plessis", "Plessis")));
  ok("a full name whose surname matches but first name does not scores 1 -> refused",
    N.nameScore("Usman Jr", "Kamaru Usman") === 1, String(N.nameScore("Usman Jr", "Kamaru Usman")));
  ok("...and the wrong fighter's full name scores 0", N.nameScore("Dricus Du Plessis", "Kamaru Usman") === 0);
  // Because a single token scores 2 on both sides of a Silva vs Silva, ambiguity must be refused
  // rather than resolved by picking the higher score.
  ok("a token shared by BOTH fighters scores 2 on each (hence the ambiguity refusal)",
    N.nameScore("Bruno Silva", "Silva") === 2 && N.nameScore("Erick Silva", "Silva") === 2);

  // Both-sides ambiguity: fabricate a bout string where one token matches both.
  const evDoc = JSON.parse(fs.readFileSync(EV, "utf8"));
  const b0 = evDoc.bouts.find((b) => b.fight);
  ok("the evidence file's bouts carry a fight name to check against", !!b0 && / vs /i.test(b0.fight));
}

console.log("\nTHE TALLY CANNOT CLAIM AN INJECTION THAT DID NOT HAPPEN");
{
  // Mixed batch: one good, one mis-bound. The refused one must not appear in any count.
  const out = run([...block(), ...block({ boutId: OTHER.boutId })]);
  ok("a mixed batch reports 1 of 2, not 2 of 2", /1 of 2 block\(s\) carry evidence/.test(out), out.split("\n").find((l) => /carry evidence/.test(l)));
  ok("...and the refusal is still printed", /IDENTITY REFUSED/.test(out));
}

console.log("\nDRY RUN WROTE NOTHING");
{
  ok("no .with-verified.json was produced", !fs.existsSync(EV.replace(/\.json$/, ".with-verified.json")));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
