// Deep historical tweet harvest via twitterapi.io advanced_search.
// Free tier = 1 request / 5s, so we throttle globally + retry on 429, and use
// wide time windows (cursor pagination re-serves recent tweets on long ranges).
require("./env");
const https = require("https");
const HOST = "api.twitterapi.io";
// Free tier needs >5s between requests; paid plans allow far higher QPS.
const SPACING_MS = Number(process.env.TWITTERAPI_SPACING_MS || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
async function throttle() {
  const wait = Math.max(0, SPACING_MS - (Date.now() - lastReq));
  if (wait) await sleep(wait);
  lastReq = Date.now();
}

function rawGet(path) {
  return new Promise((resolve, reject) => {
    https.get({ host: HOST, path, headers: { "X-API-Key": process.env.TWITTERAPI_KEY }, timeout: 30000 },
      (res) => { let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 150))); } }); })
      .on("error", reject);
  });
}

async function get(path, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    await throttle();
    let j;
    try { j = await rawGet(path); } catch (_) { continue; }
    if (j && j.error && /Too Many Requests|QPS/i.test(j.error + (j.message || ""))) {
      await sleep(SPACING_MS); continue; // throttled — wait and retry
    }
    return j;
  }
  return null;
}

// All tweets from `handle` since `sinceUnix` (seconds), via 14-day windows.
async function tweetsSince(handle, sinceUnix, { windowDays = 14, maxPagesPerWindow = 8, log = () => {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const win = windowDays * 86400;
  const out = [], seen = new Set();
  for (let ws = sinceUnix; ws < now; ws += win) {
    const we = Math.min(ws + win, now);
    let cursor = "", pages = 0;
    while (pages < maxPagesPerWindow) {
      const q = encodeURIComponent(`from:${handle} since_time:${ws} until_time:${we}`);
      const j = await get(`/twitter/tweet/advanced_search?query=${q}&queryType=Latest&cursor=${encodeURIComponent(cursor)}`);
      if (!j) break;
      const tw = j.tweets || (j.data && j.data.tweets) || [];
      let added = 0;
      for (const t of tw) { if (t.id && !seen.has(t.id)) { seen.add(t.id); out.push(t); added++; } }
      if (!j.has_next_page || !j.next_cursor || j.next_cursor === cursor || added === 0) break;
      cursor = j.next_cursor; pages++;
    }
  }
  log(`  @${handle}: ${out.length} tweets`);
  return out;
}

async function harvest(sources, sinceUnix, log = () => {}) {
  const posts = [];
  for (const s of sources) {
    if (s.platform !== "x" || !s.handle) continue;
    const tw = await tweetsSince(s.handle, sinceUnix, { log });
    for (const t of tw)
      posts.push({ source: s.name, domain: s.domain, platform: "x",
        text: t.text || "", timestamp: t.createdAt, url: t.url || t.twitterUrl || null });
  }
  return posts;
}

module.exports = { tweetsSince, harvest };
