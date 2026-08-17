// CHANNEL GRADING — refusal-first. The measure is edge vs the FIELD, and the tier it drives must be
// EARNED: a channel is only promoted when its whole confidence interval clears the field, only demoted
// when the whole interval sits below it, and never judged at all on a thin sample.
const CG = require("../lib/channel-grade");
const W = require("../lib/channel-weights");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const NOW = Date.parse("2026-08-17T00:00:00Z");
const DAY = 86400000;
// n rows, all at the same recency, each won/fieldShare as given.
const rows = (n, won, fieldShare, daysAgo = 30) =>
  Array.from({ length: n }, () => ({ won, fieldShare, fightTime: new Date(NOW - daysAgo * DAY).toISOString() }));
const grade = (rs) => CG.gradeOne(rs, { halfLifeDays: 365, priorWeight: 10, now: NOW });

// 1. Agreeing with the field and being right earns almost NOTHING — the consensus already had it.
{
  const g = grade(rows(50, 1, 0.95));
  ok(Math.abs(g.edge - 0.05) < 0.001, "1. right about a 95%-obvious favourite scores +0.05, not +1");
}
// 2. Being WRONG about an obvious favourite is expensive.
{
  const g = grade(rows(50, 0, 0.95));
  ok(Math.abs(g.edge + 0.95) < 0.001, "2. wrong about a 95%-obvious favourite costs -0.95");
}
// 3. The measure is BOUNDED — no single fight can buy a tier the way an ROI longshot could.
{
  const g = grade([...rows(1, 1, 0.02), ...rows(49, 0, 0.5)]);
  ok(g.edge <= 1 && g.edge < 0, "3. one huge contrarian hit cannot outweigh 49 losses (bounded, unlike ROI)");
}
// 4. A channel that exactly tracks the field scores 0 — it adds no information to a consensus.
{
  const g = grade([...rows(70, 1, 0.7), ...rows(30, 0, 0.7)]);
  ok(Math.abs(g.edge) < 0.001, "4. a pure echo of the field scores exactly 0");
}
// 5. REFUSAL: no gradeable rows -> no numbers invented.
{
  const g = grade([{ won: null, fieldShare: 0.5 }, { won: 1, fieldShare: NaN }]);
  ok(g.n === 0 && g.edge === null, "5. rows with no outcome / no field share are REFUSED, not guessed");
}
// 6. Shrinkage: the same edge on a thin sample reports a smaller shrunkEdge than on a fat one.
{
  const thin = grade(rows(5, 1, 0.6)), fat = grade(rows(200, 1, 0.6));
  ok(thin.shrunkEdge < fat.shrunkEdge, "6. an identical edge shrinks harder on a thin sample");
}
// 7. Recency: an old record is worth less effN than a recent one of the same size.
{
  const old = grade(rows(40, 1, 0.6, 730)), recent = grade(rows(40, 1, 0.6, 10));
  ok(old.effN < recent.effN, "7. a two-year-old record carries less effN than a fresh one");
}

// ---- the tier rule these feed ----
// 8. REFUSAL: a thin sample can never earn a tier, however good it looks.
ok(W.tierOf({ effN: 39, edge: 0.9, edgeLcb: 0.5, edgeUcb: 1 }) === "D", "8. effN below 40 is tier D even with a spectacular edge");
// 9. A tier-A promotion requires the whole interval above the field, not a flattering point estimate.
ok(W.tierOf({ effN: 100, edge: 0.2, edgeLcb: -0.01, edgeUcb: 0.41 }) === "B", "9. a big edge whose interval straddles 0 is REFUSED tier A");
ok(W.tierOf({ effN: 100, edge: 0.2, edgeLcb: 0.02, edgeUcb: 0.38 }) === "A", "9b. an interval entirely above the field earns tier A");
// 10. Demotion is equally evidence-bound.
ok(W.tierOf({ effN: 100, edge: -0.2, edgeLcb: -0.41, edgeUcb: 0.01 }) === "B", "10. a bad-looking edge whose interval straddles 0 is NOT demoted");
ok(W.tierOf({ effN: 100, edge: -0.2, edgeLcb: -0.38, edgeUcb: -0.02 }) === "C", "10b. an interval entirely below the field earns tier C");
// 11. REFUSAL: a record with no bounds at all (a single fight) cannot be promoted.
ok(W.tierOf({ effN: 100, edge: 0.5, edgeLcb: null, edgeUcb: null }) === "B", "11. a record with no computable interval is never tier A");
// 12. The tier ordering the weights depend on still holds.
ok(W.TIER_BASE.A > W.TIER_BASE.B && W.TIER_BASE.B > W.TIER_BASE.C && W.TIER_BASE.C > W.UNGRADED_WEIGHT,
  "12. tier weights stay strictly ordered A > B > C > ungraded prior");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
