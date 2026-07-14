// Cache the PICKS extracted from a video, keyed by video id + prompt fingerprint.
//
// Why it exists: the transcript cache stopped us re-buying transcripts, but we were still
// re-running Gemini over every cached transcript on every run — 163 videos x 6 runs/day =
// ~1,000 redundant extractions daily. A transcript never changes, so neither do its picks.
//
// TWO RULES, both learned the hard way:
//
// 1. NEVER CACHE A FAILURE. `extractFromTranscript` now THROWS on a failed call and only
//    returns [] when the model genuinely read the video and found no picks. Callers must
//    only reach set() on success. Caching a failed call as [] would blank a real prediction
//    video permanently — this cache has no TTL and is committed to git, so "the MMA Gambling
//    Podcast had no opinion on UFC 320" would become a permanent, invisible fact.
//
// 2. THE PROMPT IS PART OF THE KEY. DIRECTION_RULE is the single most important thing in the
//    system. If it is improved, every previously-cached video is still holding picks derived
//    from the OLD rule. Without a fingerprint the corpus silently splits in two and no one
//    ever finds out. A fingerprint mismatch = a cache miss = re-extract. That costs ~$2 for
//    the whole corpus, which is the correct price to pay for not being split-brain.
const fs = require("fs");
const path = require("path");
const { paths } = require("./store");

// NOTE: rooted at the repo, not DATA_DIR. This cache is only valuable if it is COMMITTED —
// it must be the same cache in CI and on the laptop, or every local run is a cold start that
// re-buys everything the cloud already paid for.
const DIR = path.join(__dirname, "..", "data", "picks");
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const idOf = (url) => {
  const m = String(url).match(/[?&]v=([A-Za-z0-9_-]{6,})/) || String(url).match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : String(url).replace(/[^A-Za-z0-9]+/g, "_").slice(0, 100);
};
const fileFor = (url) => path.join(DIR, idOf(url) + ".json");

// Returns an array of picks, or null for a miss (never extracted, or extracted under a
// different prompt/model). An empty array is a REAL hit: "this vlog contains no picks."
function get(url, fingerprint) {
  try {
    const f = fileFor(url);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!Array.isArray(j.picks)) return null;
    if (fingerprint && j.fp !== fingerprint) return null; // extracted by different logic — redo
    return j.picks;
  } catch (_) { return null; }
}

// Refuses to store anything that is not an array. A failed extraction must NOT reach here;
// if it somehow does, this is the last line of defence against poisoning the corpus.
function set(url, picks, fingerprint) {
  if (!Array.isArray(picks)) return false;
  try {
    fs.writeFileSync(fileFor(url), JSON.stringify({
      url, picks, fp: fingerprint || null, at: new Date().toISOString(),
    }));
    return true;
  } catch (_) { return false; }
}

const stats = () => {
  try { return { count: fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).length }; }
  catch (_) { return { count: 0 }; }
};

module.exports = { get, set, stats, DIR };
