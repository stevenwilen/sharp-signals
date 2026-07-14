// Social-pull adapters. Fetch recent posts for the roster handles.
// Each platform activates when its key is present; otherwise reports "needs key".
require("./env");
const https = require("https");

function httpsJson(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// --- X / Twitter via twitterapi.io ---
async function pullTwitter(source, { limit = 20 } = {}) {
  const key = process.env.TWITTERAPI_KEY;
  if (!key) return { needsKey: "TWITTERAPI_KEY", posts: [] };
  if (!source.handle) return { posts: [] };
  const path = `/twitter/user/last_tweets?userName=${encodeURIComponent(source.handle)}&count=${limit}`;
  try {
    const j = await httpsJson({
      host: "api.twitterapi.io", path, method: "GET",
      headers: { "X-API-Key": key }, timeout: 30000,
    });
    // twitterapi.io shape: { data: { tweets: [...] } }
    const tweets = (j.data && j.data.tweets) || j.tweets || (Array.isArray(j.data) ? j.data : []);
    return {
      posts: tweets.map((t) => ({
        source: source.name, domain: source.domain, platform: "x",
        text: t.text || t.full_text || "", timestamp: t.createdAt || t.created_at,
        url: t.url || t.twitterUrl || (t.id ? `https://x.com/${source.handle}/status/${t.id}` : null),
      })),
    };
  } catch (e) { return { error: e.message, posts: [] }; }
}

// --- YouTube via Data API v3 (recent uploads; title+description as post text) ---
async function pullYouTube(source, { limit = 10 } = {}) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { needsKey: "YOUTUBE_API_KEY", posts: [] };
  if (!source.handle) return { posts: [] };
  // NOTE: resolving @handle -> channelId is a follow-up; search by name for now.
  const q = encodeURIComponent(source.name + " prediction");
  const path = `/youtube/v3/search?part=snippet&type=video&order=date&maxResults=${limit}&q=${q}&key=${key}`;
  try {
    const j = await httpsJson({ host: "www.googleapis.com", path, method: "GET", timeout: 30000 });
    return {
      posts: (j.items || []).map((it) => ({
        source: source.name, domain: source.domain, platform: "youtube",
        text: `${it.snippet.title}. ${it.snippet.description}`,
        timestamp: it.snippet.publishedAt,
        url: it.id && it.id.videoId ? `https://youtube.com/watch?v=${it.id.videoId}` : null,
      })),
    };
  } catch (e) { return { error: e.message, posts: [] }; }
}

// Pull across the whole roster; returns { posts, missingKeys, errors }.
async function pullRoster(sources, opts = {}) {
  const posts = [], missingKeys = new Set(), errors = [];
  for (const s of sources) {
    const fn = s.platform === "youtube" ? pullYouTube : s.platform === "x" ? pullTwitter : null;
    if (!fn) continue;
    const r = await fn(s, opts);
    if (r.needsKey) missingKeys.add(r.needsKey);
    if (r.error) errors.push(`${s.name}: ${r.error}`);
    posts.push(...(r.posts || []));
  }
  return { posts, missingKeys: [...missingKeys], errors };
}

module.exports = { pullTwitter, pullYouTube, pullRoster };
