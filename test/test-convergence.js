// CONVERGENCE EVALUATOR — read-only, and it must REFUSE a verdict below the minimum sample.
//
// This is the only live structural experiment left (does Kalshi's birth price walk to the sharp book,
// or vice versa). The failure mode to guard against is fooling ourselves with n=1: two births that are
// the two sides of one fight are ONE event, not two, and one event answers nothing. These tests pin
// the fight-level unit and the refusal.
const C = require("../lib/convergence");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

// A minimal birth record with a sample trajectory.
const side = (fighter, opponent, birthAsk, birthSharp, samples, o = {}) => ({
  ticker: `KX-${fighter}`, fighter, opponent, fightDate: "2026-07-18", firstSeen: "2026-07-16T17:00:00Z",
  preExisting: false, birth: { ask: birthAsk, bid: birthAsk - 0.04, sharp: birthSharp, gap: +(birthSharp - birthAsk).toFixed(4), feeAtAsk: 0.017 },
  samples, ...o,
});
const traj = (pts) => pts.map(([ask, sharp], i) => ({ t: `2026-07-16T${18 + i}:00:00Z`, ask, sharp, bid: ask - 0.04 }));

console.log("TWO SIDES OF ONE FIGHT ARE ONE EVENT");
{
  const state = { markets: {
    A: side("Elliott", "Anderson", 0.44, 0.41, traj([[0.44, 0.41], [0.42, 0.415]])),
    B: side("Anderson", "Elliott", 0.61, 0.585, traj([[0.61, 0.585], [0.59, 0.585]])),
  } };
  const events = C.toEvents(state);
  ok("the two sides collapse to ONE event", events.length === 1);
  ok("...with both sides attached", events[0].sides.length === 2);
}

console.log("\npreExisting MARKETS ARE EXCLUDED");
{
  const state = { markets: {
    A: side("Elliott", "Anderson", 0.44, 0.41, traj([[0.44, 0.41], [0.42, 0.415]])),
    P: { ...side("Old", "Timer", 0.5, 0.5, traj([[0.5, 0.5]])), preExisting: true, birth: null },
  } };
  const events = C.toEvents(state);
  ok("a preExisting market is not counted as a birth event", events.length === 1);
  ok("...and never appears in any event", !events.some((e) => e.sides.some((s) => s.fighter === "Old")));
}

console.log("\nA VERDICT IS REFUSED BELOW THE MINIMUM SAMPLE");
{
  const state = { markets: {
    A: side("Elliott", "Anderson", 0.44, 0.41, traj([[0.44, 0.41], [0.42, 0.415]])),
    B: side("Anderson", "Elliott", 0.61, 0.585, traj([[0.61, 0.585], [0.59, 0.585]])),
  } };
  const v = C.evaluate(state, { minEvents: 20 });
  ok("one event is NOT ready for a verdict", v.ready === false);
  ok("...it reports usableEvents = 1", v.usableEvents === 1);
  ok("...and says n=1 answers nothing", /answers nothing|NOT ENOUGH DATA/.test(v.finding));
  ok("...it does NOT emit a who-moves conclusion", v.kalshiWalkedToSharp === undefined);

  // The per-event analysis is still shown (transparency), just never aggregated into a verdict.
  const analysed = v.events.find((e) => e.usable);
  ok("the single event is still analysed for inspection", !!analysed && analysed.samples === 2);
}

console.log("\nWHO-MOVED IS MEASURED ON A CONSISTENT SIDE");
{
  // Kalshi ask walks from 44c toward the sharp 41c (birth gap -3); sharp holds. That is kalshi->sharp.
  const state = { markets: {
    A: side("Elliott", "Anderson", 0.44, 0.41, traj([[0.44, 0.41], [0.43, 0.41], [0.415, 0.41]])),
    B: side("Anderson", "Elliott", 0.61, 0.585, traj([[0.61, 0.585], [0.60, 0.585], [0.585, 0.585]])),
  } };
  const a = C.analyseEvent(C.toEvents(state)[0]);
  ok("the canonical side is deterministic (alphabetical)", a.canonicalSide === "Anderson");
  ok("it detects Kalshi moving farther than the book", a.whoMovedFarther === "kalshi");
  ok("...and attributes convergence kalshi->sharp", /kalshi->sharp/.test(a.convergedBy));
}

console.log("\nA VERDICT IS PRODUCED ONLY WITH ENOUGH EVENTS");
{
  // Fabricate 20 independent one-sided events all showing kalshi->sharp convergence.
  const markets = {};
  for (let i = 0; i < 20; i++) {
    markets[`E${i}`] = { ...side(`F${i}`, `O${i}`, 0.44, 0.40, traj([[0.44, 0.40], [0.41, 0.40]])), fightDate: `2026-08-${String(i + 1).padStart(2, "0")}` };
  }
  const v = C.evaluate({ markets }, { minEvents: 20 });
  ok("20 usable events IS ready for a verdict", v.ready === true);
  ok("...it counts the convergence direction", v.kalshiWalkedToSharp === 20);
  ok("...and states a finding", /Kalshi tends to walk|sharp book walks/.test(v.finding));
}

console.log("\nIT IS NOT CONNECTED TO ANY LIVE DECISION");
{
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "convergence.js"), "utf8").replace(/\r/g, "");
  ok("convergence.js does not require the forecast, alerts, or positions", !/require\(["'][^"']*(forecast|entertainment|positions|arming)/.test(src));
  // And no production script on the decision path imports it.
  const runner = fs.readFileSync(path.join(__dirname, "..", "run-entertainment-alerts.js"), "utf8");
  ok("the alert runner does not import convergence", !/require\(["'][^"']*convergence/.test(runner));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
