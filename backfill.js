// Backfill track records from BOTH sources:
//   X:        tweets -> picks
//   YouTube:  prediction videos -> Blotato transcript -> picks   (the high-yield path)
// Then resolve every pick against Kalshi's settled result AND the market price at the
// moment it was called, and grade who actually beats the line.
//   node backfill.js            (both)
//   node backfill.js --yt-only  (skip X; useful when Twitter balance is out)
require("./lib/env");
const { paths, readJson, writeJson } = require("./lib/store");
const { harvest } = require("./lib/history");
const { findVideos } = require("./lib/youtube");
const { getTranscript } = require("./lib/blotato");
const { extractPredictions, extractFromTranscript } = require("./lib/extractor");
const { resolveAll, settledFor } = require("./lib/results");
const { norm } = require("./lib/match");
const grade = require("./lib/grade");
const { notify } = require("./lib/notify");

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const SINCE_ISO = "2026-05-01T00:00:00Z"; // Kalshi settled-history starts ~here
const YT_ONLY = process.argv.includes("--yt-only");

(async () => {
  const cfg = readJson(paths.config, {});
  const all = readJson(paths.sources, { sources: [] }).sources || [];
  const xSources = all.filter((s) => s.platform === "x" && s.handle);
  const ytSources = all.filter((s) => s.platform === "youtube" && s.handle);
  const since = Math.floor(Date.parse(SINCE_ISO) / 1000);
  const picks = [];

  // name tokens (to pre-filter tweets cheaply)
  log("loading Kalshi settled markets...");
  const settled = [...(await settledFor("mma")), ...(await settledFor("boxing"))];
  const nameTokens = new Set();
  for (const m of settled) for (const t of norm(m.yes_sub_title || "").split(" ")) if (t.length >= 4) nameTokens.add(t);
  log(`  ${settled.length} settled markets, ${nameTokens.size} name-tokens`);

  // ---------- YouTube transcripts (high yield) ----------
  // SAFETY: transcripts supply ~99% of the gradeable picks. If the YouTube quota is blown,
  // this run would produce tweet-only records and OVERWRITE good track records with garbage.
  // So: abort loudly and write NOTHING. Stale-but-correct beats fresh-but-gutted.
  log(`finding prediction videos for ${ytSources.length} YouTube sources...`);
  let videos;
  try {
    videos = await findVideos(ytSources, SINCE_ISO, log);
  } catch (e) {
    if (e.quota) {
      log("ABORTING: YouTube quota exhausted — refusing to overwrite track records with tweet-only data.");
      log("          Quota resets at midnight Pacific. Re-run then. Existing data left untouched.");
      await notify("⚠️ Backfill ABORTED: YouTube quota exhausted. No transcripts available, so it refused " +
        "to overwrite the track records with tweet-only data. Existing results are intact. Retry after midnight Pacific.").catch(() => {});
      process.exit(1);
    }
    throw e;
  }
  if (!videos.length && ytSources.length) {
    log("ABORTING: 0 prediction videos found across all channels — that is almost certainly an API");
    log("          failure, not a real absence of picks. Refusing to overwrite good data.");
    await notify("⚠️ Backfill ABORTED: 0 prediction videos found across every channel (likely a YouTube API " +
      "issue). Refused to overwrite track records. Existing results are intact.").catch(() => {});
    process.exit(1);
  }
  log(`  ${videos.length} prediction videos since ${SINCE_ISO.slice(0, 10)}`);
  let vi = 0, fetched = 0, cached = 0;
  for (const v of videos) {
    vi++;
    const t = await getTranscript(v.url).catch(() => ({}));
    if (!t.text) { log(`  [${vi}/${videos.length}] no transcript: ${v.title.slice(0, 45)}`); continue; }
    if (t.cached) cached++; else fetched++;
    const got = await extractFromTranscript(t.text, {
      source: v.source, domain: v.domain, timestamp: v.publishedAt, url: v.url,
    }).catch(() => []);
    picks.push(...got);
    log(`  [${vi}/${videos.length}]${t.cached ? " (cached)" : ""} ${got.length} picks <- ${v.source}: ${v.title.slice(0, 38)}`);
  }
  log(`transcript picks: ${picks.length}  |  Blotato: ${fetched} fetched, ${cached} from cache (0 credits)`);

  // ---------- X tweets ----------
  if (!YT_ONLY) {
    log(`harvesting tweets for ${xSources.length} X sources...`);
    const posts = await harvest(xSources, since, log);
    writeJson(paths.rawPosts, posts);
    const filtered = posts.filter((p) => norm(p.text).split(" ").some((t) => nameTokens.has(t)));
    log(`  ${posts.length} tweets, ${filtered.length} mention a competitor -> extracting`);
    if (filtered.length) {
      const got = await extractPredictions(filtered, { batchDelayMs: 200, log });
      picks.push(...got);
      log(`  tweet picks: ${got.length}`);
    }
  } else log("skipping X (--yt-only)");

  log(`TOTAL picks: ${picks.length}`);

  // ---------- resolve + grade ----------
  log("resolving vs Kalshi results + line-at-call...");
  const { resolved, matched, unmatched, noLine } = await resolveAll(picks);
  log(`  matched ${matched} | with-line ${resolved.length} | no-line ${noLine} | unmatched ${unmatched}`);
  writeJson(paths.predictions, resolved);

  const meta = {};
  for (const s of all) meta[s.name] = { domain: s.domain, type: s.type, handle: s.handle, platform: s.platform };
  const graded = grade.gradeAll(resolved, cfg, meta);
  writeJson(paths.graded, graded);

  const ranked = Object.values(graded).sort((a, b) => (b.shrunkRoi || -9) - (a.shrunkRoi || -9));
  log("=== TRACK RECORDS (beat-the-line) ===");
  console.log("  TRUST    roi     shrunk    n   hit%   source");
  for (const g of ranked)
    console.log(`  ${g.trusted ? " YES  " : "  -   "}  ${String(g.roi ?? "-").padStart(6)}  ${String(g.shrunkRoi ?? "-").padStart(6)}  ${String(g.n).padStart(3)}  ${g.hitRate != null ? (g.hitRate * 100).toFixed(0) : "-"}    ${g.source}`);
  log("done. `node pipeline.js` now grades live picks against these records.");

  const trusted = ranked.filter((g) => g.trusted);
  const top = ranked.slice(0, 5).map((g) => `• ${g.source}: ROI ${g.roi} (n=${g.n})${g.trusted ? " ✅TRUSTED" : ""}`).join("\n");
  await notify(
    `📊 Backfill complete.\n\n${resolved.length} gradeable picks across ${ranked.length} sources.\n` +
    `Trusted (beat the line w/ enough sample): ${trusted.length}\n\nTop by ROI:\n${top}`
  ).catch(() => {});
})().catch(async (e) => {
  console.error("backfill error:", e.message);
  await notify(`⚠️ Backfill failed: ${e.message}`).catch(() => {});
});
