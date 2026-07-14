// Fetch a YouTube video's transcript with plain HTTPS (no binary, no API key).
// Reads the caption track URL off the watch page, then downloads the timedtext JSON.
const https = require("https");

function fetch(url, { headers = {} } = {}, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ host: u.host, path: u.pathname + u.search,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+1", ...headers }, timeout: 25000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(fetch(new URL(res.headers.location, url).href, { headers }, redirects - 1));
        }
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
      }).on("error", reject).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}

function post(host, path, bodyObj, headers = {}) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11)", ...headers }, timeout: 25000 },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d)); });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body); req.end();
  });
}

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // public web key

function tracksFromJson(j) {
  const t = j && j.captions && j.captions.playerCaptionsTracklistRenderer;
  return (t && t.captionTracks) || [];
}

async function getTranscript(videoId) {
  // Try player API with a few clients; their caption URLs usually bypass the gate.
  const clients = [
    { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30 },
    { clientName: "IOS", clientVersion: "19.09.3", deviceModel: "iPhone14,3" },
    { clientName: "WEB", clientVersion: "2.20240101.00.00" },
  ];
  for (const client of clients) {
    let tracks = [];
    try {
      const resp = await post("www.youtube.com", `/youtubei/v1/player?key=${INNERTUBE_KEY}`,
        { videoId, context: { client: { hl: "en", gl: "US", ...client } } });
      tracks = tracksFromJson(JSON.parse(resp));
    } catch (_) { continue; }
    if (!tracks.length) continue;
    const track = tracks.find((t) => /^en/i.test(t.languageCode || "")) || tracks[0];
    if (!track || !track.baseUrl) continue;
    const raw = await fetch(track.baseUrl + "&fmt=json3");
    if (!raw) continue;
    let j; try { j = JSON.parse(raw); } catch (_) { continue; }
    const text = (j.events || [])
      .map((e) => (e.segs || []).map((s) => s.utf8 || "").join(""))
      .join(" ").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}

module.exports = { getTranscript, fetch };
