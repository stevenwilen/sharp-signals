// Cache the PICKS extracted from a video, keyed by video id.
//
// The transcript cache stopped us re-buying transcripts. But we were still re-running Gemini
// over every cached transcript on every run — 163 videos x 6 runs/day = ~1,000 redundant
// extractions daily, each ~15k tokens. A video's transcript never changes, so the picks we
// derive from it never change either. Extract once, reuse forever.
//
// Effect: Gemini calls per run drop from ~163 to just the genuinely new videos (a handful).
const fs = require("fs");
const path = require("path");
const { paths } = require("./store");

const DIR = path.join(paths.data, "picks");
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const idOf = (url) => {
  const m = String(url).match(/[?&]v=([A-Za-z0-9_-]{6,})/) || String(url).match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : String(url).replace(/[^A-Za-z0-9]+/g, "_").slice(0, 100);
};
const fileFor = (url) => path.join(DIR, idOf(url) + ".json");

// Returns an array of picks, or null if we've never extracted this video.
// NOTE: an empty array is a REAL result ("this video contains no picks") and is cached too —
// otherwise we'd re-pay to re-learn that a vlog has no predictions in it, every single run.
function get(url) {
  try {
    const f = fileFor(url);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(j.picks) ? j.picks : null;
  } catch (_) { return null; }
}

function set(url, picks) {
  try {
    fs.writeFileSync(fileFor(url), JSON.stringify({ url, picks, at: new Date().toISOString() }));
  } catch (_) {}
}

const stats = () => {
  try { return { count: fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).length }; }
  catch (_) { return { count: 0 }; }
};

module.exports = { get, set, stats, DIR };
