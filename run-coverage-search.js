// COVERAGE-GATED PER-FIGHT SEARCH — for each bout the ~50-channel roster leaves UNDER-COVERED, YouTube-search
// "<A> vs <B> prediction" and ingest the hits through the SAME transcript -> extract -> picks path the
// channel scan uses (lib/blotato getTranscript, lib/extractor extractFromTranscript, lib/picks-cache). A
// re-run of make-card-selection + run-card-evidence (done by dispatch) then folds them into the corpus, and
// the frozen originAnalysis re-decides independence. This script ADDS candidate videos; it NEVER writes an
// origin count or touches evidence-eval / the numerical rules.
//
//   node run-coverage-search.js <evidence-eval-file> [<selection-file>]
//
// SAFETY (each learned from the adversarial review):
//  - ORIGINS, NOT VOICES: a searched video from a channel ALREADY in the roster is SKIPPED. The roster
//    labels that channel by its curated sources.json name; a searched copy would carry the raw YouTube
//    channelTitle, and originAnalysis keys origins on the source string — so the same channel under two
//    labels would count as TWO independent origins, inflating the exact under-covered bouts the gate
//    targets. Skipping roster channels (by channelId) keeps one identity per channel.
//  - FAIL CLOSED on capability: needs YouTube (search) AND Blotato (transcripts) AND an extraction key. A
//    missing one is a refusal BEFORE spending the shared YouTube quota, never a crash or a 400-unit no-op.
//  - QUOTA-GUARDED: search.list = 100 units/call; caps at COVERAGE_MAX_BOUTS neediest-first, aborts loudly
//    on the first quota/rate-limit (403) error, and won't re-search the same bout within COVERAGE_MIN_HOURS.
//  - HONEST: found != ingested != scorable. A <4000-char transcript can never be scored by
//    make-card-selection, so it is reported as shortTranscript, NOT as coverage.
require("./lib/env");
const path = require("path");
const { paths, readJson, writeJson } = require("./lib/store");
const { capabilities } = require("./lib/env");
const YT = require("./lib/youtube");
const picksCache = require("./lib/picks-cache");
const { selectUnderCovered } = require("./lib/coverage-gate");
const { extractFromTranscript, promptFingerprint } = require("./lib/extractor");
const { getTranscript } = require("./lib/blotato");

const say = (s) => process.stdout.write(s + "\n");
const numEnv = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const MIN_ORIGINS = numEnv(process.env.COVERAGE_MIN_ORIGINS, 3);
const MAX_BOUTS = numEnv(process.env.COVERAGE_MAX_BOUTS, 4);
const WINDOW_DAYS = numEnv(process.env.COVERAGE_WINDOW_DAYS, 14);
const MIN_HOURS = numEnv(process.env.COVERAGE_MIN_HOURS, 20);   // don't re-search the same bout within this
const TRANSCRIPT_MIN_CHARS = 4000;                              // matches make-card-selection's scoring floor

function boutNames(b, cardBouts) {
  const cb = (cardBouts || []).find((x) => x.boutId === b.boutId);
  if (cb && cb.a && cb.b && cb.a.name && cb.b.name) return { a: cb.a.name, b: cb.b.name };
  const parts = String(b.fight || "").split(/\s+vs\.?\s+/i);
  return parts.length === 2 && parts[0].trim() && parts[1].trim() ? { a: parts[0].trim(), b: parts[1].trim() } : null;
}

(async () => {
  const evalArg = process.argv[2];
  if (!evalArg) { say("run-coverage-search: no evidence-eval file argument — nothing to do."); return 0; }

  // FAIL CLOSED, SYMMETRIC: every capability the run depends on must be present, or refuse BEFORE spending
  // the shared YouTube quota. A missing key is a refusal, not a crash and not a 400-unit no-op.
  const cap = capabilities();
  const missing = [!cap.pullYouTube && "YOUTUBE_API_KEY", !cap.transcripts && "BLOTATO_API_KEY", !cap.extractPredictions && "GEMINI_API_KEY/ANTHROPIC_API_KEY"].filter(Boolean);
  if (missing.length) { say(`run-coverage-search: missing ${missing.join(", ")} — skipping (fail closed, no quota spent).`); return 0; }

  const evalFile = path.isAbsolute(evalArg) ? evalArg : path.join(paths.root, evalArg);
  const evalData = readJson(evalFile, null);
  if (!evalData || !Array.isArray(evalData.bouts)) { say(`run-coverage-search: ${evalArg} unreadable / no bouts — skipping.`); return 0; }
  const card = (evalData.card && evalData.card.eventDate) || null;
  // Bout names come from evidence-eval's echoed card.bouts; the optional selection file is a FALLBACK if
  // that is ever missing (so the second arg dispatch passes is used, not dead).
  const selArg = process.argv[3];
  const selData = selArg ? readJson(path.isAbsolute(selArg) ? selArg : path.join(paths.root, selArg), null) : null;
  const cardBouts = (evalData.card && evalData.card.bouts) || (selData && selData.card && selData.card.bouts) || [];

  // ROSTER CHANNEL IDS (origins fix): channels the roster already scans, so a searched copy is skipped.
  const chCache = readJson(path.join(paths.data, "channels.json"), {}) || {};
  const rosterChannelIds = new Set(Object.values(chCache).map((v) => v && v.channelId).filter(Boolean));

  // CROSS-RUN BUDGET: read the prior receipt so a bout searched within MIN_HOURS is not searched again.
  const priorReceipt = card ? readJson(path.join(paths.data, `coverage-search-${card}.json`), null) : null;
  const lastSearched = {};
  for (const p of (priorReceipt && priorReceipt.perBout) || []) if (p.boutId && p.searchedAt) lastSearched[p.boutId] = p.searchedAt;
  const nowMs = Date.now();
  const searchedRecently = (boutId) => { const t = Date.parse(lastSearched[boutId] || ""); return Number.isFinite(t) && (nowMs - t) < MIN_HOURS * 3600e3; };

  const under = selectUnderCovered(evalData.bouts, { minOrigins: MIN_ORIGINS, maxBouts: MAX_BOUTS });
  say(`run-coverage-search: ${evalData.bouts.filter((b) => Number(b.independentOrigins || 0) < MIN_ORIGINS).length}/${evalData.bouts.length} bouts under ${MIN_ORIGINS} origins; up to ${MAX_BOUTS} neediest-first.`);

  const FP = promptFingerprint();
  const sinceIso = new Date(nowMs - WINDOW_DAYS * 86400000).toISOString();
  const perBout = [];
  let totalIngested = 0, quotaAborted = false;

  for (const b of under) {
    if (searchedRecently(b.boutId)) { perBout.push({ boutId: b.boutId, searchedAt: lastSearched[b.boutId], skipped: `searched < ${MIN_HOURS}h ago` }); say(`  ${b.boutId}: searched recently — skipping (cross-run budget)`); continue; }
    const nm = boutNames(b, cardBouts);
    if (!nm) { perBout.push({ boutId: b.boutId, skipped: "no fighter names" }); say(`  ${b.boutId}: no fighter names — skipped`); continue; }
    const query = `${nm.a} vs ${nm.b} prediction`;
    let hits;
    try { hits = await YT.searchVideos(query, sinceIso); }
    catch (e) {
      // Abort on ANY quota OR rate-limit (403) error — string-based e.quota misses "Rate Limit Exceeded".
      if (e.quota || e.code === 403) { quotaAborted = true; say(`  !! YOUTUBE QUOTA/RATE-LIMIT (${e.code || "quota"}) — aborting further searches (not swallowed).`); break; }
      perBout.push({ boutId: b.boutId, fight: `${nm.a} vs ${nm.b}`, query, error: e.message, searchedAt: new Date(nowMs).toISOString() });
      say(`  ${b.boutId} search error: ${e.message}`); continue;
    }
    let found = 0, ingested = 0, dupes = 0, rosterSkip = 0, shortTranscript = 0, noPicks = 0, transcriptFailed = 0, extractFailed = 0;
    for (const v of hits) {
      found++;
      // ORIGINS FIX: a roster channel's video belongs to the roster's labeling — skip it here.
      if (v.channelId && rosterChannelIds.has(v.channelId)) { rosterSkip++; continue; }
      // DEDUPE: already extracted under this prompt fingerprint -> already in the corpus.
      if (picksCache.get(v.url, FP) !== null) { dupes++; continue; }
      const t = await getTranscript(v.url).catch(() => ({}));
      if (!t || !t.text) { transcriptFailed++; continue; }
      // HONEST: a transcript below the scoring floor can never become coverage — do not extract or count it.
      if (t.text.length < TRANSCRIPT_MIN_CHARS) { shortTranscript++; continue; }
      let got;
      try { got = await extractFromTranscript(t.text, { source: v.source, domain: "mma", timestamp: v.publishedAt, url: v.url }); }
      catch (e) { extractFailed++; say(`  extract failed ${v.url}: ${e.message}`); continue; }
      picksCache.set(v.url, got, FP);   // [] is a real answer: "this video has no picks"
      ingested++; if (!got.length) noPicks++;
    }
    totalIngested += ingested;
    perBout.push({ boutId: b.boutId, fight: `${nm.a} vs ${nm.b}`, originsBefore: Number(b.independentOrigins || 0), query, searchedAt: new Date(nowMs).toISOString(), found, ingested, skippedDupes: dupes, skippedRoster: rosterSkip, shortTranscript, noPicks, transcriptFailed, extractFailed });
    say(`  ${b.boutId} "${nm.a} vs ${nm.b}" (${b.independentOrigins || 0} origins): ${found} found, ${ingested} ingested, ${dupes} dupes, ${rosterSkip} roster, ${shortTranscript} short`);
  }

  const receipt = { card, ranAt: new Date(nowMs).toISOString(), minOrigins: MIN_ORIGINS, maxBouts: MAX_BOUTS, minHours: MIN_HOURS, boutsSearched: perBout.length, totalIngested, quotaAborted, perBout };
  try { if (card) writeJson(path.join(paths.data, `coverage-search-${card}.json`), receipt); } catch (e) { say(`  (receipt write failed: ${e.message})`); }
  say(`run-coverage-search: ingested ${totalIngested} new video(s) across ${perBout.length} bout(s)${quotaAborted ? " — QUOTA/RATE ABORTED" : ""}. Re-run selection+evidence to fold them in.`);
  return 0;
})().then((c) => process.exit(c || 0)).catch((e) => { console.error("run-coverage-search error:", e.message); process.exit(1); });
