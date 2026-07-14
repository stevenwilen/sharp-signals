// Re-grade the EXISTING resolved picks under the corrected rules, and show exactly what
// changed. Read-only: writes nothing. This is the honest-numbers preview.
//
//   node regrade.js
//
// It cannot fix priceAtCall (those were recorded at the MID; correcting them to the ASK needs
// a full re-resolve against Kalshi, which the next backfill does). So the numbers here are
// still slightly FLATTERING. The real ones will be a little worse again.
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const grade = require("./lib/grade");

const cfg = readJson(paths.config, {});
const all = readJson(paths.predictions, []);
const old = readJson(paths.graded, {});

// 1) Hindsight: a "pick" made after the fight was already over.
const hindsight = all.filter((p) => {
  const t = Date.parse(p.timestamp), f = Date.parse(p.fightTime);
  return t && f && t >= f;
});
const clean = all.filter((p) => !hindsight.includes(p));

console.log(`${all.length} resolved picks`);
console.log(`  ${hindsight.length} were made AFTER the fight finished (hindsight) -> dropped`);
if (hindsight.length) {
  const won = hindsight.filter((p) => p.result === 1).length;
  console.log(`  of those, ${won}/${hindsight.length} "won" (${Math.round(100 * won / hindsight.length)}%)`);
  for (const p of hindsight.slice(0, 8)) {
    const hrs = ((Date.parse(p.timestamp) - Date.parse(p.fightTime)) / 3600e3).toFixed(1);
    console.log(`    ${p.source} -> ${p.pick}: called ${hrs}h AFTER the fight, result=${p.result}`);
  }
}

// 2) Duplicates: the same source calling the same fight in several videos.
const seen = new Set();
let dupes = 0;
for (const p of clean) {
  const k = `${p.source}|${p.marketTicker}`;
  if (seen.has(k)) dupes++; else seen.add(k);
}
console.log(`  ${dupes} duplicate calls (same source, same fight, multiple videos) -> collapsed to one\n`);

const fresh = grade.gradeAll(clean, cfg);

const rows = Object.values(fresh).sort((a, b) => (b.shrunkRoi || -9) - (a.shrunkRoi || -9));
console.log("SOURCE                     n    edge   defensible   was      now");
console.log("                                 (avg)  (low bound)  trusted  trusted");
for (const g of rows) {
  if (!g.n) continue;
  const before = old[g.source] || {};
  const flag = before.trusted && !g.trusted ? "  <- LOST TRUST"
    : !before.trusted && g.trusted ? "  <- gained" : "";
  console.log(
    `${g.source.slice(0, 24).padEnd(25)} ${String(g.n).padStart(3)}  ` +
    `${String(g.shrunkRoi ?? "-").padStart(6)}  ${String(g.roiLcb ?? "-").padStart(10)}   ` +
    `${before.trusted ? " YES  " : "  -   "}   ${g.trusted ? " YES" : "  - "}${flag}`
  );
}

const wasT = Object.values(old).filter((g) => g.trusted).length;
const nowT = rows.filter((g) => g.trusted).length;
console.log(`\ntrusted sources: ${wasT} -> ${nowT}`);

// The number that actually decides bet size now.
const sizeable = rows.filter((g) => g.trusted && g.roiLcb > 0);
console.log(`of those, ${sizeable.length} have a DEFENSIBLE edge (lower bound > 0) and could size a bet:`);
for (const g of sizeable) {
  console.log(`  ${g.source}: n=${g.n}, avg edge ${g.shrunkRoi}, defensible ${g.roiLcb}`);
}
if (!sizeable.length) {
  console.log("  NONE. Every track record is small enough that the edge could be zero.");
  console.log("  That is the honest read of the data we have. More sample is the only fix.");
}
