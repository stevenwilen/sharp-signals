// Find each source's fight-PREDICTION videos via the YouTube Data API.
// (Transcripts themselves come from Blotato — see lib/blotato.js.)
//
// QUOTA MATTERS. Free tier = 10,000 units/day, and `search.list` costs 100 units PER CALL.
// A 13-channel scan on search.list burns ~2,600 units, so a few runs exhaust the whole day
// and every channel silently starts returning "not found" / 0 videos — which looks exactly
// like "nobody posted picks" and quietly guts the system.
// So we use the cheap endpoints instead:
//    channels.list      (1 unit) -> channelId + the channel's "uploads" playlist id
//    playlistItems.list (1 unit) -> recent uploads (title + date)
// ~2 units per channel => a full scan costs ~26 units instead of ~2,600.
require("./env");
const https = require("https");

function api(path) {
  return new Promise((resolve, reject) => {
    https.get({ host: "www.googleapis.com", path, timeout: 25000 }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch (_) {}
        if (j && j.error) {
          const msg = j.error.message || "youtube api error";
          return reject(Object.assign(new Error(msg), { quota: /quota/i.test(msg), code: j.error.code }));
        }
        resolve(j || {});
      });
    }).on("error", reject);
  });
}
const key = () => process.env.YOUTUBE_API_KEY;

// Analysts/bettors title their videos plainly ("UFC 329 Predictions").
const PRED_RE = /(prediction|predict|pick|picks|breakdown|best bet|betting|preview)/i;

// FIGHTERS AND COACHES DO NOT. Their videos are titled things like "Conor is back... UFC 329
// changed everything" — no "prediction" anywhere — yet they pick every fight inside. Filtering
// them with PRED_RE is why the whole insider hypothesis had ~1 graded pick per fighter.
// So for type: fighter|coach we cast a wider net: anything that looks fight-related.
const INSIDER_RE = /(ufc|fight|card|vs\.?|who wins|main event|breakdown|bout|title)/i;

// IS THIS EVEN ABOUT COMBAT SPORTS?
//
// Nothing used to check. It didn't matter while cap=20 kept only a handful of videos per
// channel, but the moment the cap came off, WagerTalk (a general sports-betting channel that
// posts daily picks for every sport) contributed 511 videos — overwhelmingly NBA and NFL. Their
// titles say "picks" and "betting", so PRED_RE happily matched all of them. We would have paid
// to transcribe basketball and fed it to a fight-pick extractor.
//
// So: every video must look like combat sports, whoever posted it.
const SPORT_RE = /(ufc|mma|boxing|boxer|fight|fighter|bout|octagon|knockout|\bko\b|main event|undercard|welterweight|middleweight|heavyweight|lightweight|featherweight|bantamweight|flyweight)/i;

// Exclude post-fight content. A "pick" made AFTER the fight is hindsight and would fake a
// perfect track record. (lib/results.js also requires the fight to postdate the pick.)
//
// \b MATTERS: without word boundaries, "review" matches inside "P-review" — which silently
// threw away every "Preview, Predictions and Picks" video. That is exactly how the highest-
// yield source (MMA Gambling Podcast) titles EVERY episode, so it gutted the best data.
const POST_RE = /\b(recap|review|reaction|reacts|aftermath|results|post.?fight|highlights)\b/i;

// @handle -> { channelId, uploads }  (uploads = the channel's uploads playlist id)
//
// CACHED ON DISK. This mapping is immutable — a channel's id and uploads-playlist id never
// change — yet it was re-fetched for all 45 channels on every run: ~45 wasted quota units each
// time, ~8,100/month. That waste didn't matter at a 4h cadence, but going hourly it does, and
// caching it halves the per-run quota so faster scanning stays comfortably under the 10k/day
// ceiling. A resolve failure (bad handle) is NOT cached, so a fixed typo re-resolves next run.
const fs = require("fs");
const path = require("path");
const CH_CACHE = path.join(__dirname, "..", "data", "channels.json");
let chMap = null;
function loadCh() {
  if (chMap) return chMap;
  try { chMap = JSON.parse(fs.readFileSync(CH_CACHE, "utf8")); } catch (_) { chMap = {}; }
  return chMap;
}
function saveCh() { try { fs.writeFileSync(CH_CACHE, JSON.stringify(chMap, null, 2)); } catch (_) {} }

async function resolveChannel(handle) {
  const h = String(handle).replace(/^@/, "");
  const cache = loadCh();
  if (cache[h]) return cache[h];
  const j = await api(`/youtube/v3/channels?part=contentDetails&forHandle=@${encodeURIComponent(h)}&key=${key()}`);
  const it = (j.items || [])[0];
  if (!it || !it.contentDetails) return null; // not cached — a fixed handle re-resolves next run
  const resolved = { channelId: it.id, uploads: it.contentDetails.relatedPlaylists.uploads };
  cache[h] = resolved;
  saveCh();
  return resolved;
}

// 1 unit PER PAGE (50 videos). Pages back through the uploads playlist until it passes
// `sinceIso`. High-volume channels (e.g. MMA Gambling Podcast posts daily) need this —
// a single 50-item page only reaches back ~2 weeks and would silently drop most of their
// prediction videos. Still ~100x cheaper than search.list.
async function recentUploads(uploadsPlaylistId, sinceIso, { maxPages = 8 } = {}) {
  const since = Date.parse(sinceIso);
  const out = [];
  let pageToken = "";
  for (let page = 0; page < maxPages; page++) {
    const j = await api(`/youtube/v3/playlistItems?part=snippet&maxResults=50` +
      `&playlistId=${encodeURIComponent(uploadsPlaylistId)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "") + `&key=${key()}`);
    const items = j.items || [];
    if (!items.length) break;
    let reachedEnd = false;
    for (const it of items) {
      const vid = it.snippet.resourceId && it.snippet.resourceId.videoId;
      const at = it.snippet.publishedAt;
      if (!vid || !at) continue;
      if (Date.parse(at) < since) { reachedEnd = true; continue; } // older than window
      out.push({ videoId: vid, title: it.snippet.title || "", publishedAt: at });
    }
    if (reachedEnd || !j.nextPageToken) break; // walked past the window
    pageToken = j.nextPageToken;
  }
  return out;
}

// Prediction videos for one channel. Returns null if the handle doesn't resolve.
// `insider` widens the net (fighters/coaches don't label their videos "predictions").
// `cap` bounds the cost: each video = one Blotato transcript + one Gemini call, so a
// prolific channel could otherwise quietly drain the budget.
// `cap` and `maxPages` were quietly destroying half the data.
//
// maxPages defaulted to 8 and was NEVER FORWARDED from here, so recentUploads could only ever
// see a channel's newest ~400 uploads no matter what window you asked for. Then `.slice(0, cap)`
// with cap=20 (12 for fighters) threw away everything but the newest 20 MATCHES. Measured over
// the window Kalshi can actually grade, that discarded 118 of 239 prediction videos across ten
// channels — 49% — with no log line and no error. Sean Brady posted 72 matching videos and is
// graded on n=7, below the trust threshold, because 60 of them were never read.
//
// The cap was a cost guard from when transcripts were thought to be expensive. They are not:
// extraction runs about half a cent a video. It was guarding pennies and spending the thing
// the entire system is short of — SAMPLE.
async function predictionVideos(handle, sinceIso, { insider = false, cap = 0, maxPages = 12 } = {}) {
  const ch = await resolveChannel(handle);
  if (!ch) return null;
  const vids = await recentUploads(ch.uploads, sinceIso, { maxPages });
  const match = insider ? INSIDER_RE : PRED_RE;
  const hits = vids
    // SPORT_RE first: it must be about fighting at all. Then the usual test — a prediction
    // title for analysts, a wider net for fighters/coaches who never label their videos.
    .filter((v) => SPORT_RE.test(v.title) && match.test(v.title) && !POST_RE.test(v.title))
    .map((v) => ({ ...v, url: `https://www.youtube.com/watch?v=${v.videoId}` }));
  // cap = 0 means no cap. If one is set, say out loud what is being dropped — a silent
  // truncation reads as "this channel posted nothing else", which is how we got here.
  if (cap > 0 && hits.length > cap) {
    return Object.assign(hits.slice(0, cap), { dropped: hits.length - cap });
  }
  return hits;
}

// All prediction videos across the YouTube roster.
// A quota error is thrown loudly, NOT swallowed — silently returning 0 videos would look
// like "no picks this week" and would hollow out the whole system without anyone noticing.
async function findVideos(sources, sinceIso, log = () => {}, opts = {}) {
  const { cap = 0, maxPages = 12 } = opts; // cap 0 = take everything in the window
  const out = [];
  for (const s of sources) {
    if (s.platform !== "youtube" || !s.handle) continue;
    try {
      // Wide net for anyone who doesn't put "prediction" in their titles. Fighters/coaches
      // never do. Neither do some analysts (e.g. VictorMMA titles everything "X vs Y Will
      // Not Be Close"). A source can opt in explicitly with wideNet: true.
      const wide = s.wideNet === true || ["fighter", "coach"].includes(s.type);
      const vids = await predictionVideos(s.handle, sinceIso, { insider: wide, cap, maxPages });
      if (vids === null) { log(`  ${s.name}: channel not found (check the handle)`); continue; }
      log(`  ${s.name}: ${vids.length} videos${wide ? " (wide net)" : ""}` +
        (vids.dropped ? `  !! ${vids.dropped} MORE were dropped by the cap` : ""));
      for (const v of vids) out.push({ ...v, source: s.name, domain: s.domain });
    } catch (e) {
      if (e.quota) {
        log(`  !! YOUTUBE QUOTA EXCEEDED — aborting. Quota resets at midnight Pacific.`);
        throw Object.assign(new Error("YOUTUBE_QUOTA_EXCEEDED"), { quota: true });
      }
      // A ReferenceError/TypeError is a BUG IN THIS CODE, not a flaky channel. Swallowing it
      // here is what let a one-word typo silently take out all 45 channels and kill four
      // consecutive backfills: every channel "errored", 0 videos were found, and the run
      // aborted looking like a data problem. Crash loudly instead.
      if (e instanceof ReferenceError || e instanceof TypeError) throw e;
      log(`  ${s.name}: err ${e.message}`);
    }
  }
  return out;
}

// COVERAGE-GATED SEARCH. Unlike the roster scan, this uses search.list (100 units/call — see the header),
// so the CALLER must bound how many bouts trigger it (run-coverage-search caps at COVERAGE_MAX_BOUTS). It
// exists for exactly one job: when the ~50 channels leave a specific bout under-covered, look for videos
// that talk about THAT matchup regardless of channel. It ADDS candidate videos; it asserts NO origin — the
// frozen originAnalysis still decides independence downstream (a searched channel that merely re-reads an
// existing story stays the same origin). Routes through api() so a quota error carries {quota:true} and is
// NOT swallowed (the same loud-abort discipline as findVideos).
//
// search.list result shape differs from playlistItems: the id is at it.id.videoId (NOT
// snippet.resourceId.videoId). Pulled out as a pure mapper so the shape/filter logic is unit-testable.
function mapSearchResults(items) {
  const out = [];
  for (const it of items || []) {
    const vid = it && it.id && it.id.videoId;
    const sn = (it && it.snippet) || {};
    const at = sn.publishedAt;
    const title = sn.title || "";
    if (!vid || !at) continue;
    // Same discipline as the roster scan: must be combat sports, must look like a prediction, must not be
    // post-fight hindsight. A general-sports "picks" result is dropped by SPORT_RE.
    if (!(SPORT_RE.test(title) && PRED_RE.test(title) && !POST_RE.test(title))) continue;
    out.push({
      videoId: vid, title, publishedAt: at,
      url: `https://www.youtube.com/watch?v=${vid}`,
      // channelTitle is the raw YouTube name, which does NOT match the roster's curated s.name (e.g. "Chael
      // Sonnen (YT)"). The caller must reconcile a roster channel to its canonical identity — or skip it —
      // via channelId, or the frozen originAnalysis counts one channel as two origins. channelId is stable.
      channelId: sn.channelId || null,
      source: sn.channelTitle || "youtube-search",
      domain: null,
    });
  }
  return out;
}
async function searchVideos(query, sinceIso, { maxResults = 50 } = {}) {
  const j = await api(`/youtube/v3/search?part=snippet&type=video&order=date&maxResults=${maxResults}` +
    `&publishedAfter=${encodeURIComponent(sinceIso)}&q=${encodeURIComponent(query)}&key=${key()}`);
  return mapSearchResults(j.items || []); // api() rejections (incl. {quota:true}) propagate — never swallowed
}

// channelId -> "@handle" (the reverse of resolveChannel), for auto-promoting a discovered channel that has
// no roster handle yet. Best-effort: returns null on any miss (the caller degrades gracefully).
async function resolveHandleById(channelId) {
  if (!channelId) return null;
  try {
    const j = await api(`/youtube/v3/channels?part=snippet&id=${encodeURIComponent(channelId)}&key=${key()}`);
    const cu = (((j.items || [])[0] || {}).snippet || {}).customUrl;   // e.g. "@handle"
    return cu ? (String(cu).startsWith("@") ? cu : "@" + cu) : null;
  } catch { return null; }
}

module.exports = { resolveChannel, recentUploads, predictionVideos, findVideos, searchVideos, mapSearchResults, resolveHandleById };
