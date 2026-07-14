// Which sport is actually more beatable, UFC or boxing? Answer from the data, not from vibes.
//   node compare-sports.js
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const grade = require("./lib/grade");

const cfg = readJson(paths.config, {});
const sources = readJson(paths.sources, { sources: [] }).sources || [];
const domainOf = {};
for (const s of sources) domainOf[s.name] = s.domain;

const all = readJson(paths.predictions, [])
  // drop hindsight rows (picks made after the fight was already over)
  .filter((p) => {
    const t = Date.parse(p.timestamp), f = Date.parse(p.fightTime);
    return !(t && f && t >= f);
  })
  .filter((p) => (p.result === 0 || p.result === 1) && p.priceAtCall > 0 && p.priceAtCall < 1);

const roiOf = (r, p) => r / p - 1;

for (const dom of ["mma", "boxing"]) {
  const rows = all.filter((p) => (p.domain || domainOf[p.source]) === dom);

  // dedupe: same source, same fight = one opinion, not several
  const seen = new Set();
  const uniq = rows.filter((p) => {
    const k = `${p.source}|${p.marketTicker}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  if (!uniq.length) { console.log(`\n=== ${dom.toUpperCase()} ===\n  no graded picks\n`); continue; }

  const rois = uniq.map((p) => roiOf(p.result, p.priceAtCall));
  const mean = rois.reduce((a, x) => a + x, 0) / rois.length;
  const sd = Math.sqrt(rois.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, rois.length - 1));
  const se = sd / Math.sqrt(rois.length);
  const lcb = mean - 1.645 * se;

  const hit = uniq.filter((p) => p.result === 1).length / uniq.length;
  const avgPrice = uniq.reduce((a, p) => a + p.priceAtCall, 0) / uniq.length;
  const favs = uniq.filter((p) => p.priceAtCall >= 0.5).length;
  const nSources = new Set(uniq.map((p) => p.source)).size;

  const bySrc = {};
  for (const p of uniq) (bySrc[p.source] = bySrc[p.source] || []).push(p);
  const graded = Object.entries(bySrc).map(([s, ps]) => ({ s, ...grade.gradeSource(ps, cfg) }));
  const trusted = graded.filter((g) => g.trusted);
  const defensible = graded.filter((g) => g.trusted && g.roiLcb > 0);

  console.log(`\n=== ${dom.toUpperCase()} ===`);
  console.log(`  graded picks         : ${uniq.length}  (from ${nSources} sources)`);
  console.log(`  hit rate             : ${(hit * 100).toFixed(1)}%`);
  console.log(`  avg price paid       : ${(avgPrice * 100).toFixed(0)}c   ${Math.round(100 * favs / uniq.length)}% of picks were favourites`);
  console.log(`  ROI vs the line      : ${(mean * 100).toFixed(1)}%  (std err ${(se * 100).toFixed(1)})`);
  console.log(`  DEFENSIBLE edge      : ${(lcb * 100).toFixed(1)}%   <- the honest number`);
  console.log(`  sources trusted      : ${trusted.length}`);
  console.log(`  ...with a real edge  : ${defensible.length}`);
  for (const g of defensible) console.log(`       ${g.s}: n=${g.n}, edge ${g.shrunkRoi}, defensible ${g.roiLcb}`);
}
console.log(`\nPRE-backfill corpus. Boxing is especially thin.`);
