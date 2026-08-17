// EVIDENCE BALANCE + THE LIVE WATCHLIST — refusal-first.
//
// The failure this guards against is UFC 330's Njokuani vs Alvarez: 92% STRONG, four reasons FOR, an
// EMPTY counterpoint, rendered as though the other side had been weighed and dismissed. It lost to the
// underdog. A one-directional read must announce itself as one-directional, and the watchlist must never
// invent a cue the evidence did not support.
const { evidenceBalanceOf, watchFor, OBSERVABLE, LIVE_WATCH_PROTOCOL } = require("../run-confidence");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };
const claim = (topic, text, origins = 1) => ({ topic, claim: text, origins });

// 1. THE UFC 330 SHAPE: reasons for, nothing against -> flagged, with a note that says so in words.
{
  const b = evidenceBalanceOf([claim("durability", "he has been knocked out five times")], [], "Chidi Njokuani");
  ok(b.oneSided === true, "1. reasons FOR with an empty counterpoint is flagged one-sided");
  ok(/No channel made a case for Chidi Njokuani/.test(b.note || ""), "1b. the note names who nobody argued for");
}
// 2. A stress-tested read is NOT flagged — the flag has to mean something.
{
  const b = evidenceBalanceOf([claim("power", "big power")], [claim("wrestling_offense", "good takedowns")], "Dustin Stoltzfus");
  ok(b.oneSided === false && b.note === null, "2. a read with a real counterpoint is NOT flagged");
}
// 3. REFUSAL: no evidence at all is UNCOVERED, not one-sided — coverage already says that, and crying
//    wolf on every thin prelim would make the flag worthless.
{
  const b = evidenceBalanceOf([], [], "Someone");
  ok(b.oneSided === false && b.note === null, "3. no evidence either way is NOT reported as one-sided");
}
// 4. The counts are the real counts, not a summary someone can drift away from.
{
  const b = evidenceBalanceOf([claim("power", "a"), claim("cardio", "b")], [claim("speed", "c")], "X");
  ok(b.for === 2 && b.against === 1, "4. evidenceBalance reports the actual claim counts");
}

// 5. A known topic becomes something you can SEE, and names the fighter to watch.
{
  const [w] = watchFor([claim("wrestling_offense", "Stoltzfus has good takedowns and really good slams", 2)], "Dustin Stoltzfus");
  ok(w.signal === `Dustin Stoltzfus: ${OBSERVABLE.wrestling_offense}`, "5. a known topic maps to an observable cue");
  ok(w.origins === 2, "5b. the channel count behind the cue is carried through");
}
// 6. REFUSAL: an unmapped topic falls back to the claim VERBATIM — never a cue we made up.
{
  const [w] = watchFor([claim("some_new_topic", "he only fights well in Brazil")], "Y");
  ok(w.signal === "Y: he only fights well in Brazil", "6. an unmapped topic falls back to the claim, not an invented cue");
}
// 7. Every cue keeps the claim it came from, so the operator can check the reasoning.
{
  const ws = watchFor([claim("power", "one-punch power", 3), claim("cardio", "gasses in R3")], "Z");
  ok(ws.every((w) => w.because && w.signal), "7. every watch item carries the claim it was derived from");
}
// 8. REFUSAL: no counter-evidence means an EMPTY watchlist. It must not be padded with generic filler
//    dressed up as fight-specific evidence — the standing protocol covers that case instead.
{
  ok(watchFor([], "Nobody").length === 0, "8. no counter-evidence yields NO fabricated per-fight cues");
  ok(LIVE_WATCH_PROTOCOL.length >= 3, "8b. ...and the standing operator protocol exists to cover it");
}
// 9. The protocol covers the failure the operator actually saw: a favourite who will not engage.
{
  const all = LIVE_WATCH_PROTOCOL.join(" ").toLowerCase();
  ok(/reluctan|respect|deferential/.test(all), "9. the standing protocol names the reluctant-favourite failure");
  ok(/initiat|passive/.test(all), "9b. ...and gives a round-one behavioural check for it");
}
// 10. The protocol stays an OBSERVATION aid: it must never tell the operator what to stake or trade.
{
  const all = LIVE_WATCH_PROTOCOL.join(" ").toLowerCase();
  ok(!/\bhedge|\bstake|\bbet\b|cash out|sell|buy\b/.test(all), "10. the protocol gives no staking or trading instruction");
}

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
