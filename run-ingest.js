// INGEST — discover fresh prediction videos, transcribe them, extract each channel's picks.
//
//   node run-ingest.js
//
// This is the step that keeps data/picks FRESH — the raw material the confidence engine reads. It was
// lost when the old betting pipeline (pipeline.js) was torn out, which silently froze discovery: the
// dispatcher kept re-processing the same corpus and the confidence never changed. Restored here as a lean,
// bet-free ingest and wired into the dispatcher's collect stage.
//
// KEY-FREE + CHEAP: discovery reads YouTube RSS feeds (no key, no quota); a transcript never changes so its
// picks are cached (data/picks) and re-used forever — only genuinely NEW videos cost a Blotato transcript +
// a Gemini extraction. There is no Kalshi/order path anywhere here.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const { findVideos } = require("./lib/youtube");
const { getTranscript } = require("./lib/blotato");
const { extractFromTranscript, promptFingerprint } = require("./lib/extractor");
const picksCache = require("./lib/picks-cache");

const ROOT = __dirname;
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };

(async () => {
  const FP = promptFingerprint();
  const yt = (readJson(path.join(ROOT, "sources.json"), { sources: [] }).sources || [])
    .filter((s) => s.handle && s.platform === "youtube" && s.domain === "mma");
  // Last 10 days covers the upcoming card's fight week — channels post their predictions in the days before.
  const sinceIso = new Date(Date.now() - 10 * 86400000).toISOString();
  console.log(`[ingest] scanning ${yt.length} channels for new prediction videos since ${sinceIso.slice(0, 10)} (key-free RSS)`);

  let videos;
  try { videos = await findVideos(yt, sinceIso, (m) => console.log(m)); }
  catch (e) { console.error(`[ingest] discovery failed: ${e.message}`); process.exit(1); }

  let reused = 0, extracted = 0, extractFailed = 0, transcriptFailed = 0, newPicks = 0;
  for (const v of videos) {
    // A transcript never changes, so neither do its picks — extract once, reuse forever.
    if (picksCache.get(v.url, FP)) { reused++; continue; }
    const t = await getTranscript(v.url).catch(() => { transcriptFailed++; return {}; });
    if (!t.text) { if (!t || t.error) transcriptFailed++; continue; }
    let got;
    // A FAILED extraction must NOT be cached — leave it uncached so the next run retries it.
    try { got = await extractFromTranscript(t.text, { source: v.source, domain: v.domain, timestamp: v.publishedAt, url: v.url }); }
    catch (e) { extractFailed++; console.log(`  EXTRACT FAILED (retry next run) ${v.source}: ${e.message}`); continue; }
    picksCache.set(v.url, got, FP);   // [] is a REAL answer: "this video has no picks"
    extracted++; newPicks += got.length;
    if (got.length) console.log(`  ${got.length} picks <- ${v.source}: ${(v.title || "").slice(0, 48)}`);
  }

  console.log(`[ingest] ${videos.length} videos · ${reused} cached · ${extracted} newly extracted (${newPicks} picks)` +
    (extractFailed ? ` · ${extractFailed} extract-failed` : "") + (transcriptFailed ? ` · ${transcriptFailed} transcript-failed` : ""));

  // Discovery health receipt: real counts + timestamp, so the dashboard can tell "nothing new" from
  // "the fetcher is failing". Never fatal.
  try {
    fs.writeFileSync(path.join(ROOT, "data", "discovery-status.json"), JSON.stringify({
      schemaVersion: 1, at: new Date().toISOString(), channelsScanned: yt.length,
      videosFound: videos.length, reusedFromCache: reused, newlyExtracted: extracted,
      extractFailed, transcriptFailed,
    }, null, 2));
  } catch (_) {}
  process.exit(0);
})();
