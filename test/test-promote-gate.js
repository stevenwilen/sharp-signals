// PROMOTION GATE — refusal-first. A channel is promoted ONLY on a real, positive-lower-bound graded track
// record; roster channels, thin samples, and negative-edge channels are all REFUSED.
const { selectPromotable } = require("../lib/promote-gate");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };
const S = (source, over = {}) => ({ source, platform: "youtube", domain: "mma", type: "analyst", handle: "@" + source, n: 20, roiLcb: 0.05, roi: 0.1, hitRate: 0.6, ...over });

const roster = new Set(["Roster Guy"]);

// 1. A non-roster channel with a real sample + positive roiLcb is promotable.
{
  const out = selectPromotable({ a: S("Discovered Winner") }, roster);
  ok(out.length === 1 && out[0].source === "Discovered Winner", "1. non-roster, n>=10, roiLcb>0 -> promotable");
}
// 2. A roster channel is REFUSED (nothing to promote).
ok(selectPromotable({ a: S("Roster Guy") }, roster).length === 0, "2. a roster channel is REFUSED");
// 3. Thin sample REFUSED.
ok(selectPromotable({ a: S("Small", { n: 5 }) }, roster).length === 0, "3. n below minN is REFUSED");
// 4. Negative-edge REFUSED (roiLcb <= 0) — the common case, correctly rejected.
ok(selectPromotable({ a: S("Loser", { roiLcb: -0.174 }) }, roster).length === 0, "4. roiLcb <= 0 is REFUSED (no proven edge)");
ok(selectPromotable({ a: S("Breakeven", { roiLcb: 0 }) }, roster).length === 0, "4b. roiLcb exactly 0 is REFUSED (strict >)");
// 5. Non-YouTube REFUSED.
ok(selectPromotable({ a: S("Tweeter", { platform: "x" }) }, roster).length === 0, "5. non-YouTube platform is REFUSED");
// 6. Sorted by roiLcb descending (best first).
{
  const out = selectPromotable({ a: S("Good", { roiLcb: 0.03 }), b: S("Better", { roiLcb: 0.09 }), c: S("Ok", { roiLcb: 0.01 }) }, roster);
  ok(out.map((x) => x.source).join(",") === "Better,Good,Ok", "6. promotable list sorted by roiLcb desc");
}
// 7. Carries the fields needed to add to sources.json (handle/type/domain).
{
  const [x] = selectPromotable({ a: S("HasHandle", { handle: "@hh", type: "bettor" }) }, roster);
  ok(x && x.handle === "@hh" && x.type === "bettor" && x.domain === "mma", "7. carries handle/type/domain for sources.json");
}
// 8. Today's reality: all graded sources are roster -> zero promotions (data-gated, not a bug).
ok(selectPromotable({ a: S("Roster Guy") }, new Set(["Roster Guy"])).length === 0, "8. when every graded source is already on the roster, promotes nothing");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
