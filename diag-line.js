// Directly probe lineAtCall for in-window picks: is the candlestick fetch erroring,
// returning empty, or returning candles that don't cover the pick time?
//   node diag-line.js
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
  const picks = [];
  for (const v of videos) {
    const got = picksCache.get(v.url, FP);
    if (!got) continue;
    for (const p of got) picks.push({ ...p, domain: v.domain, timestamp: v.publishedAt });
  }

  const settled = {};
  for (const dom of ["mma", "boxing"]) settled[dom] = await k.marketsAll({ series_ticker: SERIES[dom], status: "settled" });

  // find in-window picks
  const inWindow = [];
  for (const p of picks) {
    const hit = (settled[p.domain] || []).find((m) => names.nameScore(p.pick, m.yes_sub_title) >= 2);
    if (!hit) continue;
    const t = Date.parse(p.timestamp) || 0;
    const openT = Date.parse(hit.open_time) || 0, closeT = Date.parse(hit.close_time) || 0;
    if (t >= openT && t <= closeT) inWindow.push({ p, m: hit, closeT });
  }
  console.log(`in-window picks to probe: ${inWindow.length}\n`);

  let noCandles = 0, apiErr = 0, allBeforePick = 0, gotLine = 0;
  const errs = {};
  for (const { p, m, closeT } of inWindow.slice(0, 60)) {
    const pickSec = Math.floor((Date.parse(p.timestamp) || 0) / 1000);
    try {
      const c = await k.candlesticks(SERIES[p.domain], m.ticker, {
        start_ts: pickSec - 3 * 86400, end_ts: Math.floor(closeT / 1000), period_interval: 60,
      });
      const cs = (c && c.candlesticks) || [];
      if (!cs.length) { noCandles++; continue; }
      const after = cs.filter((cd) => cd.end_period_ts >= pickSec);
      if (!after.length) { allBeforePick++; continue; }
      const cd = after[0];
      const ya = cd.yes_ask && parseFloat(cd.yes_ask.close_dollars);
      const px = cd.price && parseFloat(cd.price.close_dollars);
      if ((ya > 0 && ya < 1) || (px > 0 && px < 1)) gotLine++;
      else noCandles++;
    } catch (e) {
      apiErr++;
      const key = String(e.message).slice(0, 50);
      errs[key] = (errs[key] || 0) + 1;
    }
  }
  console.log(`probed ${Math.min(60, inWindow.length)}:`);
  console.log(`  got a line          : ${gotLine}`);
  console.log(`  API ERROR           : ${apiErr}`);
  console.log(`  zero candles back   : ${noCandles}`);
  console.log(`  candles all pre-pick: ${allBeforePick}`);
  if (Object.keys(errs).length) { console.log(`\n  error breakdown:`); for (const [e, n] of Object.entries(errs)) console.log(`    ${n}x  ${e}`); }

  // dump one raw candlestick response to see the actual shape
  if (inWindow.length) {
    const { p, m, closeT } = inWindow[0];
    const pickSec = Math.floor((Date.parse(p.timestamp) || 0) / 1000);
    const c = await k.candlesticks(SERIES[p.domain], m.ticker, {
      start_ts: pickSec - 3 * 86400, end_ts: Math.floor(closeT / 1000), period_interval: 60,
    }).catch((e) => ({ error: e.message }));
    console.log(`\nraw sample for ${m.ticker} (pick ${p.timestamp.slice(0,10)}):`);
    console.log(JSON.stringify(c).slice(0, 500));
  }
})();
