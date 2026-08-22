// EVIDENCE BALANCE — refusal-first.
//
// The failure this guards against is UFC 330's Njokuani vs Alvarez: 92% STRONG, four reasons FOR, an
// EMPTY counterpoint, rendered as though the other side had been weighed and dismissed. It lost to the
// underdog. Seventeen channels agreeing in one direction is not seventeen independent confirmations;
// it is one case, seventeen times. A read of that shape has to say so.
const { evidenceBalanceOf } = require("../run-confidence");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS  " + m); } else { fail++; console.log("  FAIL  " + m); } };
const claim = (topic, text, origins) => ({ topic, claim: text, origins: origins || 1 });

// 1. THE UFC 330 SHAPE: reasons for, nothing against -> flagged, and the note says it in words.
{
  const b = evidenceBalanceOf([claim("durability", "knocked out five times")], [], "Chidi Njokuani");
  ok(b.oneSided === true, "1. reasons FOR with an empty counterpoint is flagged one-sided");
  ok(/No channel made a case for Chidi Njokuani/.test(b.note || ""), "1b. the note names who nobody argued for");
  ok(/less settled than it looks/.test(b.note || ""), "1c. ...and says what that means for the number");
}
// 2. A stress-tested read is NOT flagged — the flag has to mean something or it is wallpaper.
{
  const b = evidenceBalanceOf([claim("power", "big power")], [claim("wrestling_offense", "good takedowns")], "X");
  ok(b.oneSided === false && b.note === null, "2. a read with a real counterpoint is NOT flagged");
}
// 3. REFUSAL: no evidence at all is UNCOVERED, not one-sided. `coverage`/NO-READ already says that, and
//    crying wolf on every thinly-covered prelim would make the flag worthless.
{
  const b = evidenceBalanceOf([], [], "Someone");
  ok(b.oneSided === false && b.note === null, "3. no evidence either way is NOT reported as one-sided");
}
// 4. The counts are the real counts, not a summary that can drift from them.
{
  const b = evidenceBalanceOf([claim("power", "a"), claim("cardio", "b")], [claim("speed", "c")], "X");
  ok(b.for === 2 && b.against === 1, "4. evidenceBalance reports the actual claim counts");
}
// 5. It stays a statement about the EVIDENCE, never an instruction about a bet.
{
  const note = evidenceBalanceOf([claim("power", "a")], [], "Y").note.toLowerCase();
  ok(!/\bhedge|\bstake|\bbet\b|cash out|\bsell\b|\bbuy\b/.test(note), "5. the note carries no staking or trading instruction");
}

console.log("");
console.log(pass + "/" + (pass + fail) + " passed");
process.exit(fail ? 1 : 0);
