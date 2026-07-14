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

// Exclude post-fight content. A "pick" made AFTER the fight is hindsight and would fake a
// perfect track record. (lib/results.js also requires the fight to postdate the pick.)
//
// \b MATTERS: without word boundaries, "review" matches inside "P-review" — which silently
// threw away every "Preview, Predictions and Picks" video. That is exactly how the highest-
// yield source (MMA Gambling Podcast) titles EVERY episode, so it gutted the best data.
const POST_RE = /\b(recap|review|reaction|reacts|aftermath|results|post.?fight|highlights)\b/i;

// 1 unit. @handle -> { channelId, uploads }  (uploads = the channel's uploads playlist id)
async function resolveChannel(handle) {
  const h = String(handle).replace(/^@/, "");
  const j = await api(`/youtube/v3/channels?part=contentDetails&forHandle=@${encodeURIComponent(h)}&key=${key()}`);
  const it = (j.items || [])[0];
  if (!it || !it.contentDetails) return null;
  return { channelId: it.id, uploads: it.contentDetails.relatedPlaylists.uploads };
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
async function predictionVideos(handle, sinceIso, { insider = false, cap = 20 } = {}) {
  const ch = await resolveChannel(handle);
  if (!ch) return null;
  const vids = await recentUploads(ch.uploads, sinceIso);
  const match = insider ? INSIDER_RE : PRED_RE;
  return vids
    .filter((v) => match.test(v.title) && !POST_RE.test(v.title))
    .slice(0, cap) // newest first, so this keeps the most recent `cap` videos
    .map((v) => ({ ...v, url: `https://www.youtube.com/watch?v=${v.videoId}` }));
}

// All prediction videos across the YouTube roster.
// A quota error is thrown loudly, NOT swallowed — silently returning 0 videos would look
// like "no picks this week" and would hollow out the whole system without anyone noticing.
async function findVideos(sources, sinceIso, log = () => {}) {
  const out = [];
  for (const s of sources) {
    if (s.platform !== "youtube" || !s.handle) continue;
    try {
      // Wide net for anyone who doesn't put "prediction" in their titles. Fighters/coaches
      // never do. Neither do some analysts (e.g. VictorMMA titles everything "X vs Y Will
      // Not Be Close"). A source can opt in explicitly with wideNet: true.
      const wide = s.wideNet === true || ["fighter", "coach"].includes(s.type);
      const vids = await predictionVideos(s.handle, sinceIso, { insider: wide, cap: wide ? 12 : 20 });
      if (vids === null) { log(`  ${s.name}: channel not found (check the handle)`); continue; }
      log(`  ${s.name}: ${vids.length} videos${wide ? " (wide net)" : ""}`);
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

module.exports = { resolveChannel, recentUploads, predictionVideos, findVideos };
