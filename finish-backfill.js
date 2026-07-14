// The cloud run did the expensive part (821 of 843 videos are extracted and cached) but the
// buggy abort guard refused to write. Everything needed to finish is on disk. This loads the
// cached picks, resolves + grades them, and writes predictions.json — no network extraction,
// no Blotato, no Gemini. It is the tail of backfill.js, run locally, once.
//   node finish-backfill.js
require("./lib/env");
const { paths, readJson, writeJson } = require("./lib/store");
const { findVideos } = require("./lib/youtube");
const { promptFingerprint } = require("./lib/extractor");
const { resolveAll } = require("./lib/results");
const picksCache = require("./lib/picks-cache");
const grade = require("./lib/grade");

const log = (m) => console.log(`[finish] ${m}`);
const SINCE_ISO = "2026-05-01T00:00:00Z";

(async () => {
  const cfg = readJson(paths.config, {});
  const all = readJson(paths.sources, { sources: [] }).sources || [];
  const yt = all.filter((s) => s.platform === "youtube" && s.handle);
  const FP = promptFingerprint();

  log("gathering videos in window...");
  const videos = await findVideos(yt, SINCE_ISO, () => {});
  log(`${videos.length} videos; pulling their cached picks...`);

  const picks = [];
  let hit = 0, miss = 0;
  for (const v of videos) {
    const got = picksCache.get(v.url, FP);
    if (got === null) { miss++; continue; }
    hit++;
    for (const p of got) picks.push({ ...p, source: v.source, domain: v.domain, timestamp: v.publishedAt, url: v.url });
  }
  log(`${hit} videos from picks-cache, ${miss} not cached (unfetchable tail), ${picks.length} raw picks`);

  log("resolving vs Kalshi + line-at-call (this hits Kalshi, ~a few min)...");
  const { resolved, matched, unmatched, noLine } = await resolveAll(picks, cfg);
  log(`matched ${matched} | with-line ${resolved.length} | no-line ${noLine} | unmatched ${unmatched}`);

  const existing = readJson(paths.predictions, []);
  log(`corpus: ${existing.length} -> ${resolved.length} gradeable picks`);
  if (resolved.length < existing.length) {
    log(`REFUSING to write: new corpus is smaller than the old one. Something is wrong.`);
    process.exit(1);
  }

  writeJson(paths.predictions, resolved);
  const meta = {};
  for (const s of all) meta[s.name] = { domain: s.domain, type: s.type, handle: s.handle, platform: s.platform };
  const graded = grade.gradeAll(resolved, cfg, meta);
  writeJson(paths.graded, graded);

  const ranked = Object.values(graded).sort((a, b) => (b.shrunkRoi || -9) - (a.shrunkRoi || -9));
  console.log("\n  TRUST   shrunk   defensible   n    source");
  for (const g of ranked) {
    if (!g.n) continue;
    console.log(`  ${g.trusted ? " YES " : "  -  "}  ${String(g.shrunkRoi ?? "-").padStart(6)}  ` +
      `${String(g.roiLcb ?? "-").padStart(9)}   ${String(g.n).padStart(3)}   ${g.source}`);
  }
  const trusted = ranked.filter((g) => g.trusted);
  const defensible = ranked.filter((g) => g.trusted && g.roiLcb > 0);
  console.log(`\ntrusted: ${trusted.length} | with a defensible edge: ${defensible.length}`);
  log("wrote predictions.json + sources_graded.json");
})();
