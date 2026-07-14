// Which sources are worth the API cost of scanning every week?
//
// Two rules only:
//   CUT (zero yield)   : produces no gradeable picks at all -> we pay to scan, get nothing.
//   CUT (proven bad)   : big enough sample to be sure there's no edge (n >= MIN_N_TO_JUDGE).
//   KEEP (unproven)    : small sample. Do NOT cut these. Dan Tom would have been cut at n=3.
//
// The asymmetry matters: cutting a zero-yield source costs nothing. Cutting a source that
// merely hasn't proved itself yet could throw away the next Dan Tom.
const { paths, readJson } = require("./lib/store");

const MIN_N_TO_JUDGE = 40; // below this, a negative ROI is noise, not evidence

const graded = readJson(paths.graded, {});
const sources = readJson(paths.sources, { sources: [] }).sources || [];
const recFor = (name) => Object.values(graded).find((x) => x.source === name) || { n: 0 };

const cut = [], keep = [], watch = [];
for (const s of sources) {
  const r = recFor(s.name);
  const n = r.n || 0;
  if (n === 0) { cut.push({ s, r, why: "zero yield (no gradeable picks)" }); continue; }
  if (n >= MIN_N_TO_JUDGE && (r.shrunkRoi ?? 0) < 0) {
    cut.push({ s, r, why: `proven no edge (n=${n}, ROI ${(r.roi * 100).toFixed(0)}%)` });
    continue;
  }
  if (r.trusted) keep.push({ s, r, why: `TRUSTED (n=${n}, ROI ${(r.roi * 100).toFixed(0)}%)` });
  else watch.push({ s, r, why: `unproven (n=${n}) - needs more data, do not cut` });
}

const show = (title, arr) => {
  console.log(`\n=== ${title} (${arr.length}) ===`);
  for (const x of arr) console.log(`  ${(x.s.name + " [" + x.s.platform + "]").padEnd(40)} ${x.why}`);
};
show("CUT", cut);
show("KEEP - earning their place", keep);
show("KEEP - unproven, still on trial", watch);

const ytCut = cut.filter((x) => x.s.platform === "youtube").length;
console.log(`\n${cut.length} sources to cut (${ytCut} YouTube channels = the expensive ones to scan).`);

// `node prune.js --apply` actually rewrites sources.json (cut sources are archived,
// not deleted, so you can see what was removed and why).
if (process.argv.includes("--apply")) {
  const { writeJson } = require("./lib/store");
  const cutNames = new Set(cut.map((x) => x.s.name));
  const file = readJson(paths.sources, { sources: [] });
  const archived = (file._pruned || []).concat(
    cut.map((x) => ({ ...x.s, prunedWhy: x.why, prunedAt: new Date().toISOString().slice(0, 10) }))
  );
  writeJson(paths.sources, {
    ...file,
    sources: (file.sources || []).filter((s) => !cutNames.has(s.name)),
    _pruned: archived,
  });
  console.log(`APPLIED. sources.json now has ${(file.sources || []).length - cut.length} active sources.`);
  console.log(`(cut sources archived under "_pruned" — nothing is lost)`);
} else {
  console.log(`\nDry run. Re-run with --apply to actually cut them.`);
}
