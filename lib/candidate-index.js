// THE LIVE CANDIDATE-VIDEO INDEX — the permanent fix for the frozen-universe defect.
//
// WHAT WENT WRONG: make-card-selection.js drew its candidate videos ONLY from data/predictions.json,
// which is written ONLY by the manual backfill (schedule disabled). Meanwhile the hourly V1 sensing
// discovered fight-week videos and extracted their picks into data/picks/<videoId>.json — and nothing
// consumed them. The system searched all 50 channels of a corpus frozen six days before the card and
// called it coverage. Discovery worked, ingestion worked, and the selector read a different file.
//
// THE FIX: one index that merges BOTH stores —
//   data/predictions.json     the historical corpus (manual backfill; useful context, labeled as such)
//   data/picks/*.json         the LIVE store the hourly sensing already writes (git-committed, so it
//                             survives runner turnover) — {url, picks:[{source,pick,opponent,timestamp,
//                             url,...}], fp, at}
// deduplicated by URL (the live entry wins: fresher extraction), with EXPLICIT freshness accounting so
// a stale universe can never again masquerade as a complete current search. No backfill, no guru
// grading, no manual step: the index is as fresh as the last hourly sensing run.
require("./env");
const fs = require("fs");
const path = require("path");
const { paths, readJson, writeJson } = require("./store");

const PICKS_DIR = () => path.join(path.dirname(paths.predictions), "picks");
const STATUS_FILE = () => path.join(path.dirname(paths.predictions), "candidate-index-status.json");

// Build the merged index. Returns:
//   byUrl    Map url -> { url, src, ts, origin: "live"|"corpus" }
//   fighters Set of fighter names seen in picks (feeds card-identity aliases exactly as before)
//   stats    freshness accounting — newest timestamps per store, channel counts, merge counts
function buildIndex(opts = {}) {
  const predictionsPath = opts.predictionsPath || paths.predictions;
  const picksDir = opts.picksDir || PICKS_DIR();

  const byUrl = new Map();
  const fighters = new Set();
  const channels = { corpus: new Set(), live: new Set() };
  let corpusRows = 0, corpusNewest = "", liveFiles = 0, liveNewest = "", liveUnreadable = 0;

  // 1) the historical corpus (may be stale — that is now VISIBLE, not hidden)
  for (const p of readJson(predictionsPath, [])) {
    corpusRows++;
    if (p.pick) fighters.add(p.pick);
    if (p.opponent) fighters.add(p.opponent);
    if (p.source) channels.corpus.add(p.source);
    if (p.timestamp && p.timestamp > corpusNewest) corpusNewest = p.timestamp;
    if (p.url && p.timestamp) byUrl.set(p.url, { url: p.url, src: p.source, ts: p.timestamp, origin: "corpus" });
  }

  // 2) the LIVE picks store the hourly sensing writes. Live entries WIN on URL collision (fresher
  //    extraction of the same video). A malformed file is counted, never fatal — one bad item must not
  //    block the channel.
  let picksFiles = [];
  try { picksFiles = fs.readdirSync(picksDir).filter((f) => f.endsWith(".json")); } catch (_) { picksFiles = []; }
  for (const f of picksFiles) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(picksDir, f), "utf8")); } catch (_) { liveUnreadable++; continue; }
    const rows = Array.isArray(j && j.picks) ? j.picks : [];
    const first = rows[0];
    const url = (j && j.url) || (first && first.url);
    if (!url || !first || !first.timestamp) continue;   // no timestamp -> cannot place in time; skip honestly
    liveFiles++;
    for (const p of rows) { if (p.pick) fighters.add(p.pick); if (p.opponent) fighters.add(p.opponent); }
    if (first.source) channels.live.add(first.source);
    if (first.timestamp > liveNewest) liveNewest = first.timestamp;
    byUrl.set(url, { url, src: first.source || null, ts: first.timestamp, origin: "live" });
  }

  const newestSourceTs = [corpusNewest, liveNewest].filter(Boolean).sort().pop() || null;
  const stats = {
    builtAt: new Date().toISOString(),
    corpusRows, corpusNewest: corpusNewest || null,
    livePicksFiles: liveFiles, liveNewest: liveNewest || null, liveUnreadable,
    merged: byUrl.size,
    channelsInCorpus: channels.corpus.size, channelsInLive: channels.live.size,
    channelsTotal: new Set([...channels.corpus, ...channels.live]).size,
    newestSourceTs,
  };
  return { byUrl, fighters, stats };
}

// Persist the freshness accounting so the dashboard/system-health can show discovery+ingestion state
// without rebuilding the index. Mutable operational store, atomic write via lib/store.
function saveStatus(stats, extra = {}) {
  const out = { schemaVersion: 1, ...stats, ...extra };
  writeJson(STATUS_FILE(), out);
  return out;
}
function loadStatus() { return readJson(STATUS_FILE(), null); }

module.exports = { buildIndex, saveStatus, loadStatus, STATUS_FILE, PICKS_DIR };
