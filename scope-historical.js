// Size the historical backfill BEFORE spending a cent. Counts how many videos exist going
// back N months, how many are NOT already cached (i.e. genuinely new work), and estimates the
// Gemini bill from real transcript sizes. Read-only. Costs only YouTube quota for discovery.
//   node scope-historical.js
require("./lib/env");
const fs = require("fs");
const { paths, readJson } = require("./lib/store");
const { findVideos } = require("./lib/youtube");
const { promptFingerprint } = require("./lib/extractor");
const picksCache = require("./lib/picks-cache");

const MONTHS = [3, 6, 12, 18, 24];
const AVG_TOKENS = 9000;          // measured mean transcript size
const GEMINI_PER_M = 0.30;        // gemini-flash-latest, $/1M input tokens

(async () => {
  const cfg = readJson(paths.config, {});
  const sports = cfg.sports || ["mma", "boxing"]; // match the backfill's sport gate
  const yt = (readJson(paths.sources, { sources: [] }).sources || [])
    .filter((s) => s.platform === "youtube" && s.handle && sports.includes(s.domain));
  const FP = promptFingerprint();
  const haveTranscript = new Set(fs.readdirSync(path("transcripts")).map((f) => f.replace(".txt", "")));

  // Scan the deepest window once, then bucket by age.
  const deepestSince = new Date(Date.now() - Math.max(...MONTHS) * 30 * 86400000).toISOString();
  console.log(`scanning ${yt.length} channels back to ${deepestSince.slice(0, 10)} (this uses YouTube quota, ~1 scan)...\n`);
  const videos = await findVideos(yt, deepestSince, () => {});

  console.log("window | videos | already have picks | NEW to extract | est. Gemini $ | new transcripts (Blotato)");
  console.log("-------|--------|--------------------|----------------|---------------|--------------------------");
  for (const m of MONTHS) {
    const since = Date.now() - m * 30 * 86400000;
    const inWin = videos.filter((v) => Date.parse(v.publishedAt) >= since);
    const haveP = inWin.filter((v) => picksCache.get(v.url, FP) !== null).length;
    const newP = inWin.length - haveP;
    const newTranscripts = inWin.filter((v) => picksCache.get(v.url, FP) === null && !haveTranscript.has(v.videoId)).length;
    const cost = (newP * AVG_TOKENS * GEMINI_PER_M / 1e6).toFixed(2);
    console.log(`${String(m + "mo").padStart(6)} | ${String(inWin.length).padStart(6)} | ${String(haveP).padStart(18)} | ${String(newP).padStart(14)} | ${String("$" + cost).padStart(13)} | ${newTranscripts}`);
  }

  console.log(`\nAssumptions: ~${AVG_TOKENS} tokens/transcript (measured mean), Gemini flash $${GEMINI_PER_M}/1M in.`);
  console.log(`Blotato = one fetch per NEW transcript; you believe it is effectively unmetered - verify on your dashboard.`);
  console.log(`YouTube discovery quota for the whole run: ~${yt.length * 12} units (well under 10k/day).`);
})();

function path(sub) { return require("path").join(__dirname, "data", sub); }
