// THE test this project has never run: out-of-sample validation.
//
// Everything else is in-sample — we choose who to trust by looking at the same fights we then
// judge them on. That is how you fool yourself: across 30 sources, some look good by luck. The
// only honest question is whether an edge GENERALISES.
//
// So: freeze the trusted list using ONLY fights up to a cutoff (training). Then measure those
// same sources on fights AFTER the cutoff (test) — data that had no say in who we trusted. If
// the training-trusted sources beat the line out of sample, the edge is real. If they regress
// to zero, it was hindsight.
//   node holdout.js
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const grade = require("./lib/grade");

const cfg = readJson(paths.config, {});
const all = readJson(paths.predictions, [])
  .filter((p) => (p.result === 0 || p.result === 1) && p.priceAtCall > 0 && p.priceAtCall < 1);

const roiOf = (r, p) => r / p - 1;
const fightDate = (p) => Date.parse(p.fightTime) || 0;

// Show the timeline so the split is honest, not cherry-picked.
const dates = all.map(fightDate).filter(Boolean).sort((a, b) => a - b);
const iso = (t) => new Date(t).toISOString().slice(0, 10);
console.log(`${all.length} graded picks, fights ${iso(dates[0])} .. ${iso(dates[dates.length - 1])}\n`);

// Cutoff: fights that settled on/after July 1 are the held-out test. Everything before trains.
const CUTOFF = Date.parse("2026-07-01T00:00:00Z");
const train = all.filter((p) => fightDate(p) < CUTOFF);
const test = all.filter((p) => fightDate(p) >= CUTOFF);
console.log(`TRAIN (fights before Jul 1): ${train.length} picks`);
console.log(`TEST  (fights Jul 1 onward): ${test.length} picks\n`);

if (test.length < 30) {
  console.log("WARNING: the test set is small. Treat the result as directional, not proof.\n");
}

// 1) Who would we have trusted, using ONLY the training fights?
const trainGraded = grade.gradeAll(train, cfg);
const trusted = Object.values(trainGraded).filter((g) => g.trusted).map((g) => g.source);
const defensible = Object.values(trainGraded).filter((g) => g.trusted && g.roiLcb > 0).map((g) => g.source);

console.log(`Trusted on training data: ${trusted.length ? trusted.join(", ") : "(none)"}`);
console.log(`  ...of those, defensible edge: ${defensible.length ? defensible.join(", ") : "(none)"}\n`);

// 2) How did each group actually do on the held-out July fights?
function perf(sourceList, label) {
  const rows = test.filter((p) => sourceList.includes(p.source));
  if (!rows.length) { console.log(`${label}: no test picks`); return; }
  const roi = rows.reduce((a, p) => a + roiOf(p.result, p.priceAtCall), 0) / rows.length;
  const hit = rows.reduce((a, p) => a + p.result, 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((a, p) => a + (roiOf(p.result, p.priceAtCall) - roi) ** 2, 0) / Math.max(1, rows.length - 1));
  const se = sd / Math.sqrt(rows.length);
  console.log(`${label}:`);
  console.log(`  ${rows.length} out-of-sample picks, hit ${(hit * 100).toFixed(0)}%`);
  console.log(`  ROI vs line OUT OF SAMPLE: ${(roi * 100).toFixed(1)}%  (std err ${(se * 100).toFixed(1)}, so ~${((roi - 1.645 * se) * 100).toFixed(1)}% lower bound)`);
}

// Benchmark: everyone. If "trusted" doesn't beat "everyone", the selection added nothing.
const allSources = [...new Set(test.map((p) => p.source))];
perf(allSources, "ALL sources (baseline)");
console.log("");
perf(trusted, "TRUSTED-on-training");
console.log("");
if (defensible.length) perf(defensible, "DEFENSIBLE-on-training");

console.log(`\nREAD: if TRUSTED-on-training beats the ALL baseline and stays positive out of`);
console.log(`sample, the selection is picking real edge, not noise. If it collapses to ~0 or`);
console.log(`negative, the in-sample edges were hindsight and we should NOT bet on them.`);
