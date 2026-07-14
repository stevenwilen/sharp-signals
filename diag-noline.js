// Why did 1302 matched picks get dropped for "no line"? Legit (pick predates the market's
// price history) or a bug (we're throwing away gradeable data)?
//   node diag-noline.js
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const { findVideos } = require("./lib/youtube");
const { promptFingerprint } = require("./lib/extractor");
const names = require("./lib/names");
const k = require("./lib/kalshi");
const picksCache = require("./lib/picks-cache");

const SERIES = { mma: "KXUFCFIGHT", boxing: "KXBOXING" };

(async () => {
  const all = readJson(paths.sources, { sources: [] }).sources || [];
  const yt = all.filter((s) => s.platform === "youtube" && s.handle);
  const FP = promptFingerprint();
  const videos = await findVideos(yt, "2026-05-01T00:00:00Z", () => {});

  // gather raw picks with their timestamps
  const picks = [];
  for (const v of videos) {
    const got = picksCache.get(v.url, FP);
    if (!got) continue;
    for (const p of got) picks.push({ ...p, domain: v.domain, timestamp: v.publishedAt });
  }

  // settled MMA/boxing markets with their OPEN time
  const settled = {};
  for (const dom of ["mma", "boxing"]) {
    const ms = await k.marketsAll({ series_ticker: SERIES[dom], status: "settled" });
    settled[dom] = ms;
  }

  let matched = 0, pickBeforeOpen = 0, pickAfterClose = 0, inWindow = 0, sampleShown = 0;
  const examples = [];
  for (const p of picks) {
    const ms = settled[p.domain] || [];
    const pick = names.canonical(p.pick);
    const hit = ms.find((m) => names.nameScore(p.pick, m.yes_sub_title) >= 2);
    if (!hit) continue;
    matched++;
    const t = Date.parse(p.timestamp) || 0;
    const openT = Date.parse(hit.open_time) || 0;
    const closeT = Date.parse(hit.close_time) || 0;
    if (t < openT) { pickBeforeOpen++; if (examples.length < 8) examples.push(`  pick ${p.timestamp.slice(0,10)} BEFORE market opened ${hit.open_time.slice(0,10)}  (${p.pick})`); }
    else if (t > closeT) pickAfterClose++;
    else inWindow++;
  }

  console.log(`matched to a settled market: ${matched}`);
  console.log(`  pick made BEFORE the market opened (no price could exist yet): ${pickBeforeOpen}`);
  console.log(`  pick made AFTER the market closed (fight over): ${pickAfterClose}`);
  console.log(`  pick inside the market's live window (SHOULD have a line): ${inWindow}`);
  console.log(`\nexamples of before-open (legit no-line):`);
  for (const e of examples) console.log(e);
  console.log(`\nVERDICT: if before-open dominates, the no-line drops are correct (Kalshi listed`);
  console.log(`the fight only days before it happened, so an early pick genuinely has no price).`);
})();
