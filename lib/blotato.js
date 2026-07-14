// YouTube (and podcast/article) transcript retrieval via the Blotato API.
// Reliable (Blotato handles YouTube's token gate server-side). Async: create a
// source-resolution, then poll until `content` is ready.
//
// CACHED ON DISK. A video's transcript never changes, so re-fetching it is pure waste.
// Without this, every scheduled run re-downloads the entire back catalogue (~75 videos)
// and burns ~75 Blotato credits per day, forever. With the cache, only genuinely NEW
// videos cost anything — typically 2-5 per week.
require("./env");
const https = require("https");
const fs = require("fs");
const path = require("path");
const HOST = "backend.blotato.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ROOTED AT THE REPO, NOT DATA_DIR — deliberately.
// The cache is only worth anything if it is COMMITTED and therefore shared between the cloud
// and the laptop. When it honoured DATA_DIR (which .env points at OneDrive), the 419 paid
// transcripts sat in the repo while every local run started from an empty OneDrive folder and
// re-bought all of them — data the cloud had already paid for, two directories away.
// DATA_DIR still governs the output JSONs the dashboard reads. It must not govern the caches.
const CACHE_DIR = path.join(__dirname, "..", "data", "transcripts");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// stable cache key: the YouTube video id, else a sanitised url
function cacheKey(url) {
  const m = String(url).match(/[?&]v=([A-Za-z0-9_-]{6,})/) || String(url).match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  return String(url).replace(/[^A-Za-z0-9]+/g, "_").slice(0, 120);
}
const cachePath = (url) => path.join(CACHE_DIR, cacheKey(url) + ".txt");

function readCache(url) {
  try {
    const p = cachePath(url);
    if (!fs.existsSync(p)) return null;
    const t = fs.readFileSync(p, "utf8");
    return t && t.length > 20 ? t : null; // ignore empty/failed cache entries
  } catch (_) { return null; }
}
function writeCache(url, text) {
  try { fs.writeFileSync(cachePath(url), text); } catch (_) {}
}

function req(method, p, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = https.request({ host: HOST, path: `/v2${p}`, method,
      headers: { "blotato-api-key": process.env.BLOTATO_API_KEY, "content-type": "application/json",
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) }, timeout: 30000 },
      (res) => { let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }); }
          catch (_) { resolve({ status: res.statusCode, json: null, raw: d }); } }); });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("timeout")));
    if (payload) r.write(payload); r.end();
  });
}

// Fetch a transcript. Returns { text, cached? } | { needsKey } | { error }.
// Set { noCache: true } to force a fresh pull.
async function getTranscript(url, { sourceType = "youtube", maxWaitMs = 90000, pollMs = 3000, noCache = false } = {}) {
  if (!noCache) {
    const hit = readCache(url);
    if (hit) return { text: hit, cached: true }; // zero Blotato credits
  }
  if (!process.env.BLOTATO_API_KEY) return { needsKey: "BLOTATO_API_KEY" };
  const created = await req("POST", "/source-resolutions-v3", { source: { sourceType, url } });
  if (created.status >= 400) return { error: `create ${created.status}`, raw: created.json };
  const id = created.json && (created.json.id || (created.json.data && created.json.data.id));
  if (!id) return { error: "no id", raw: created.json };
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const g = await req("GET", `/source-resolutions-v3/${id}`);
    const j = (g.json && (g.json.data || g.json)) || {};
    if (j.content) {
      const text = String(j.content);
      writeCache(url, text);
      return { text, cached: false };
    }
    if (/fail|error/i.test(j.status || "")) return { error: j.status };
    await sleep(pollMs);
  }
  return { error: "timeout" };
}

const cacheStats = () => {
  try {
    const f = fs.readdirSync(CACHE_DIR).filter((x) => x.endsWith(".txt"));
    return { count: f.length, dir: CACHE_DIR };
  } catch (_) { return { count: 0, dir: CACHE_DIR }; }
};

module.exports = { getTranscript, req, cacheStats, CACHE_DIR };
