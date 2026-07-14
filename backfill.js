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
const { extractPredictions, extractFromTranscript, promptFingerprint } = require("./lib/extractor");
const { resolveAll, settledFor } = require("./lib/results");
const { norm } = require("./lib/match");
const picksCache = require("./lib/picks-cache");
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
      log("ABORTING: YouTube quota exhausted  refusing to overwrite track records with tweet-only data.");
      log("          Quota resets at midnight Pacific. Re-run then. Existing data left untouched.");
      await notify(" Backfill ABORTED: YouTube quota exhausted. No transcripts available, so it refused " +
        "to overwrite the track records with tweet-only data. Existing results are intact. Retry after midnight Pacific.").catch(() => {});
      process.exit(1);
    }
    throw e;
  }
  if (!videos.length && ytSources.length) {
    log("ABORTING: 0 prediction videos found across all channels  that is almost certainly an API");
    log("          failure, not a real absence of picks. Refusing to overwrite good data.");
    await notify(" Backfill ABORTED: 0 prediction videos found across every channel (likely a YouTube API " +
      "issue). Refused to overwrite track records. Existing results are intact.").catch(() => {});
    process.exit(1);
  }
  log(`  ${videos.length} prediction videos since ${SINCE_ISO.slice(0, 10)}`);

  // PARALLEL. Doing this one-at-a-time was the reason the job kept hitting GitHub's timeout
  // and getting killed before it could commit anything: each Blotato call polls until the
  // transcript is ready, so 300 videos serially is hours. Both Blotato and Gemini are
  // network-bound, so a modest pool of workers cuts wall-clock by ~6x with no extra credits
  // (the same videos get fetched either way).
  const WORKERS = 6;
  const FP = promptFingerprint();
  let vi = 0, fetched = 0, cached = 0, failed = 0, reused = 0, extractFailed = 0;
  const queue = videos.slice();

  async function worker() {
    while (queue.length) {
      const v = queue.shift();
      if (!v) return;
      const n = ++vi;

      // Already extracted this video under the SAME prompt+model? Reuse it. Transcripts never
      // change, so neither do the picks. Skips both the Blotato fetch AND the Gemini call.
      const hit = picksCache.get(v.url, FP);
      if (hit) { picks.push(...hit); reused++; continue; }

      const t = await getTranscript(v.url).catch(() => ({}));
      if (!t.text) { failed++; log(`  [${n}/${videos.length}] no transcript: ${v.title.slice(0, 42)}`); continue; }
      if (t.cached) cached++; else fetched++;

      // A FAILED extraction must NOT be cached. 6 workers hammering Gemini in parallel is
      // exactly how you earn a 429 burst; caching those as [] would permanently blank real
      // prediction videos and quietly shrink every track record. Leave it uncached; retry.
      let got;
      try {
        got = await extractFromTranscript(t.text, {
          source: v.source, domain: v.domain, timestamp: v.publishedAt, url: v.url,
        });
      } catch (e) {
        // Out of Gemini credit. Waiting does not fix this, a human topping up does. Stop the
        // whole run now instead of backing off for 10 minutes on each of hundreds of videos,
        // burning the 6-hour budget to produce nothing. Nothing is lost: failed extractions are
        // never cached, and if:always() commits every transcript already paid for.
        if (e.outOfCredit) {
          log(`ABORTING: ${e.message}`);
          await notify(
            "Backfill stopped: the Gemini account is out of credit.\n\n" +
            "Nothing was lost. Every transcript it already paid for is saved, and failed " +
            "extractions are never cached, so a re-run picks up exactly where it stopped.\n\n" +
            "Top up Gemini, then re-run."
          ).catch(() => {});
          process.exit(1);
        }
        extractFailed++;
        log(`  [${n}/${videos.length}] EXTRACT FAILED (uncached, will retry): ${v.source}: ${e.message}`);
        continue;
      }
      picksCache.set(v.url, got, FP);
      picks.push(...got);
      log(`  [${n}/${videos.length}]${t.cached ? " (cached)" : ""} ${got.length} picks <- ${v.source}: ${v.title.slice(0, 34)}`);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));

  log(`transcript picks: ${picks.length}  |  ${reused} reused (0 cost), ${fetched} Blotato fetched, ` +
    `${cached} transcript-cached, ${failed} no-transcript, ${extractFailed} extract-FAILED`);

  // An extraction wipeout (Gemini outage / sustained rate-limiting) yields a fraction of the
  // real picks. Writing that would gut every track record while looking like a normal run.
  const attempted = fetched + cached;
  if (attempted >= 10 && extractFailed / attempted > 0.3) {
    log(`ABORTING: ${Math.round((extractFailed / attempted) * 100)}% of extractions failed.`);
    await notify(`Backfill ABORTED: ${extractFailed} of ${attempted} extractions failed (likely a ` +
      `Gemini outage or rate limiting). Refused to overwrite track records with partial data. ` +
      `Nothing was cached, so a retry loses nothing.`).catch(() => {});
    process.exit(1);
  }

  // SAFETY: if most transcripts failed (Blotato balance exhausted, API down), this run's
  // picks are a fraction of reality. Writing them would silently gut every track record
  // while looking like a normal, successful run. Refuse.
  const gotTranscripts = fetched + cached;
  const failRate = videos.length ? 1 - gotTranscripts / videos.length : 0;
  if (videos.length >= 10 && failRate > 0.4) {
    log(`ABORTING: ${Math.round(failRate * 100)}% of transcripts failed (${gotTranscripts}/${videos.length}).`);
    log(`          Likely Blotato credits exhausted. Refusing to overwrite good track records`);
    log(`          with a partial dataset. Existing results left untouched.`);
    await notify(` Backfill ABORTED: ${Math.round(failRate * 100)}% of transcripts failed ` +
      `(likely Blotato credits exhausted). Refused to overwrite track records with partial data. ` +
      `Existing results are intact.`).catch(() => {});
    process.exit(1);
  }

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
  const { resolved, matched, unmatched, noLine } = await resolveAll(picks, cfg);
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
  const top = ranked.slice(0, 5).map((g) => ` ${g.source}: ROI ${g.roi} (n=${g.n})${g.trusted ? " TRUSTED" : ""}`).join("\n");
  await notify(
    ` Backfill complete.\n\n${resolved.length} gradeable picks across ${ranked.length} sources.\n` +
    `Trusted (beat the line w/ enough sample): ${trusted.length}\n\nTop by ROI:\n${top}`
  ).catch(() => {});
})().catch(async (e) => {
  console.error("backfill error:", e.stack || e.message);
  await notify("Backfill FAILED: " + e.message).catch(() => {});
  // MUST exit non-zero. Without this a crash exited 0, the Actions job went GREEN, and
  // GitHub never emailed - so the weekly backfill could be dead for months behind an
  // unbroken column of green checks, with Telegram (which itself no-ops when the token is
  // missing) as the only signal that anything was wrong.
  process.exit(1);
});
