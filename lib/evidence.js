// V2 EVIDENCE EXTRACTOR — the reason the refresh exists.
//
// lib/extractor.js (V1, still running, untouched) reduces a transcript of up to 394,000 characters
// to a name, a number and one sentence: {pick, confidence, directness, quote}. Every hypothesis this
// project tested was therefore built on the CONCLUSION a pundit reached, and every one was rejected:
// 11,452 picks put the average source at -0.4% vs the closing line, 0 of 50 survive out-of-sample,
// and the market does not move toward them (CLV -1.34 pts). The one thing never examined is WHY they
// think it — the reasoning, which is 99.9% of what we paid to collect and still have on disk.
//
// So this extracts CLAIMS, not picks:
//    "his takedown defence against the fence is poor"  -- a checkable assertion about a fighter
// not
//    "I'm taking Cannonier"                            -- a conclusion with the reasoning thrown away
//
// WHAT THE MODEL IS ALLOWED TO DECIDE: only what is visible in the transcript.
// WHAT WE COMPUTE OURSELVES: `corroborated` (needs every other source) and `knownBeforeBet` (needs
// the fight time). A model asked whether its own claim is corroborated will happily say yes; that is
// how you build a machine that certifies its own hallucinations. Those two fields are the ones the
// V2 reasoning engine leans on hardest, so neither is ever left to the model.
//
// Runs BESIDE V1: separate prompt, separate fingerprint, separate cache (data/evidence/). Nothing
// here reads or writes anything V1 owns.
require("./env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { provider } = require("./extractor"); // reuse the throttled, rate-limit-safe model gate

const DIR = path.join(__dirname, "..", "data", "evidence");

// The V1 lesson that cost the most, carried forward. Naive prompting reads negative talk ABOUT a
// fighter and files it as support FOR them. A backwards claim is worse than a missing one: it
// poisons the evidence base in a way nothing downstream can detect.
const DIRECTION_RULE = `
DIRECTION IS THE MOST IMPORTANT FIELD. "about" is the fighter the claim CONCERNS. "direction" says
whether the claim HELPS or HURTS that fighter:
  - "his cardio is gone" (about A)              -> about=A, direction="against_about"
  - "A's jab is the best in the division"       -> about=A, direction="favors_about"
  - "A has never been finished"                 -> about=A, direction="favors_about"
  - "B has no answer for A's wrestling"         -> about=B, direction="against_about"  (the claim is ABOUT B)
If you cannot tell whether a claim helps or hurts, use "neutral". Never guess.`;

const CLASS_RULE = `
"claimClass" is what KIND of assertion this is. It is the most important judgement you make, because
downstream these are never treated alike: the whole project has been fooled by confident narrative
before. Pick exactly one:
  - "hard_fact"           : verifiable, external, specific. "He missed weight by 3lbs."
                            "He tested positive for nandrolone." "He's coming off a 14-month layoff."
  - "statistical"         : a number about performance. "86% takedown defence." "He lands 5.2 sig
                            strikes a minute." "0 finishes since 2023."
  - "film_study"          : a read of something observable on tape. "His chin rises when he trades."
                            "He circles into power." "His TDD breaks down on the fence."
  - "matchup_analysis"    : how two fighters' attributes interact. "His wrestling neutralises that
                            jab." "Southpaw gives him trouble."
  - "injury_health"       : an injury, illness, or physical condition. "He fought with a torn ACL."
  - "training_camp"       : camp, coaching, sparring, preparation. "He left ATT." "Short camp."
  - "psychological"       : mindset, motivation, nerves, ego. "He doesn't want it any more."
  - "rumor"               : reported second-hand, unconfirmed. "I'm hearing he was dropped in camp."
  - "prediction"          : a forecast of what will happen. "He gets finished in round two."
  - "unsupported_narrative": vibes with no basis offered. "Father time is undefeated."
When in doubt choose the WEAKER class (rumor/psychological/unsupported_narrative over hard_fact).
Over-calling a vibe a fact is the expensive error here. An UNCONFIRMED injury is "rumor", not
"injury_health"; a CONFIRMED one is "injury_health".`;

const SYSTEM = `You extract STRUCTURED MATCHUP CLAIMS from combat-sports (UFC) analysis transcripts.

You are NOT extracting who they pick. You are extracting the REASONS — the specific, attributable
assertions an analyst makes about a fighter that could be checked, corroborated, or contradicted.

For each distinct claim return:
{"claim": "<the assertion, one specific sentence, in your words>",
 "about": "<the fighter the claim concerns>",
 "opponent": "<the other fighter in that fight, or null>",
 "direction": "favors_about" | "against_about" | "neutral",
 "evidenceType": "striking" | "grappling" | "cardio" | "durability" | "weight_cut" | "layoff" |
                 "camp" | "injury" | "travel" | "motivation" | "opponent_quality" | "judging" |
                 "market" | "record" | "other",
 "claimClass": "hard_fact" | "statistical" | "film_study" | "matchup_analysis" | "injury_health" |
               "training_camp" | "psychological" | "rumor" | "prediction" | "unsupported_narrative",
 "confidence": <0..1 how strongly the ANALYST asserts it, not how true it is>,
 "quote": "<short verbatim snippet from the transcript that supports it>"}
${DIRECTION_RULE}
${CLASS_RULE}

RULES:
- One claim per assertion. "He's old and his chin is gone" is TWO claims (record/durability).
- The claim must be about a FIGHTER, specific enough to be checked or contradicted later.
- "quote" must be VERBATIM from the transcript. Never invent one. If you cannot quote it, drop it.
- Do NOT extract: pure picks with no reason ("I'm taking Jones"), hype, insults, promos, or
  anything about a non-fighter.
- Extract claims even when the analyst reaches no pick at all. The reasoning is the asset.
- Prefer fewer, well-attributed claims over many vague ones.

Return ONLY a single JSON array. No prose.`;

// The prompt fingerprint. If this prompt or the model changes, every cached extraction was produced
// by different logic and must be redone — otherwise the corpus silently becomes a mix of two rule
// sets and nobody ever finds out. (V1 learned this the hard way; the mechanism is copied on purpose.)
function fingerprint() {
  const model = process.env.EXTRACT_MODEL || "gemini-3.5-flash-lite";
  return crypto.createHash("sha256").update("evidence-v1|" + model + "|" + SYSTEM).digest("hex").slice(0, 12);
}

const TYPES = new Set(["striking", "grappling", "cardio", "durability", "weight_cut", "layoff",
  "camp", "injury", "travel", "motivation", "opponent_quality", "judging", "market", "record", "other"]);
const CLASSES = new Set(["hard_fact", "statistical", "film_study", "matchup_analysis", "injury_health",
  "training_camp", "psychological", "rumor", "prediction", "unsupported_narrative"]);
const DIRS = new Set(["favors_about", "against_about", "neutral"]);

function normConf(c) {
  if (typeof c === "number" && c >= 0 && c <= 1) return +c.toFixed(2);
  const s = String(c || "").toLowerCase();
  if (s.startsWith("high")) return 0.9;
  if (s.startsWith("med")) return 0.6;
  if (s.startsWith("low")) return 0.3;
  const n = parseFloat(s);
  return isFinite(n) && n >= 0 && n <= 1 ? +n.toFixed(2) : 0.5;
}

function parseArray(text) {
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : null; } catch (_) {}
  const s = String(text).indexOf("["), e = String(text).lastIndexOf("]");
  if (s < 0 || e <= s) return null;
  try { const j = JSON.parse(String(text).slice(s, e + 1)); return Array.isArray(j) ? j : null; } catch (_) { return null; }
}

// Extract claims from one transcript.
// meta: { source, url, timestamp }  — timestamp is when the analyst SPOKE (video publish time).
// Throws (never returns []) on a failed extraction, so a model failure can never be cached as
// "this video contains no reasoning". An empty array from a real parse IS a valid answer.
async function extractEvidence(text, meta) {
  const p = provider();
  if (!p) throw new Error("NO_KEY: set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in .env");
  let items;
  try { items = parseArray(await p.call(SYSTEM, String(text).slice(0, 200000))); }
  catch (e) {
    if (String(e.message).startsWith("NO_KEY")) throw e;
    throw Object.assign(new Error("EVIDENCE_FAILED: " + e.message), { extractFailed: true });
  }
  if (items === null) throw Object.assign(new Error("EVIDENCE_FAILED: no usable JSON array"), { extractFailed: true });

  const seen = new Set();
  const stats = { raw: items.length, noFields: 0, badQuote: 0, dupe: 0 };
  const out = items
    .filter((it) => { const ok = it && it.claim && it.about && it.quote; if (!ok) stats.noFields++; return ok; })
    // The quote must really appear in the transcript — a fabricated quote is an invented fact
    // wearing evidence's clothes, indistinguishable from a real one downstream.
    //
    // BUT COMPARE NORMALISED, NOT BYTE-EXACT. The first cut of this filter demanded an exact
    // 60-char substring and silently destroyed 13 of 14 real claims on the first transcript it
    // touched, because the model tidies punctuation and whitespace while quoting honestly. The
    // video would then have been cached as "contains no reasoning" — a lie, permanently. An
    // over-strict validator deleting the truth is the same class of bug as no validator at all.
    .filter((it) => {
      const probe = normText(it.quote).slice(0, 40);
      const ok = probe.length > 12 && normText(text).includes(probe);
      if (!ok) stats.badQuote++;
      return ok;
    })
    .filter((it) => { // drop duplicate claims within a video
      const k = `${String(it.about).toLowerCase()}|${String(it.claim).toLowerCase().slice(0, 60)}`;
      if (seen.has(k)) { stats.dupe++; return false; }
      seen.add(k); return true;
    })
    .map((it) => ({
      claim: String(it.claim).trim(),
      about: String(it.about).trim(),
      opponent: it.opponent ? String(it.opponent).trim() : null,
      direction: DIRS.has(it.direction) ? it.direction : "neutral",
      evidenceType: TYPES.has(it.evidenceType) ? it.evidenceType : "other",
      claimClass: CLASSES.has(it.claimClass) ? it.claimClass : "unsupported_narrative", // unknown -> weakest
      confidence: normConf(it.confidence),
      quote: String(it.quote).trim().slice(0, 300),
      source: meta.source,
      timestamp: meta.timestamp,     // when it was SAID
      url: meta.url || null,
      // NOT the model's to decide — see the header. Filled by the reasoning layer, which alone
      // knows the other sources and the fight time.
      corroborated: null,
      knownBeforeBet: null,
    }));

  // Make the filters' damage VISIBLE. Silent attrition is how a validator turns into a data-loss
  // bug nobody notices: the count just looks low, and "low" is indistinguishable from "this video
  // had little to say". Callers log this; a high badQuote rate means the filter is broken again,
  // not that the analysts stopped reasoning.
  lastStats = { ...stats, kept: out.length };
  return out;
}

// Normalised for comparison: case, punctuation and whitespace differences are transcription noise,
// not evidence of fabrication.
function normText(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
let lastStats = null;
const filterStats = () => lastStats;

// ---- cache: same discipline as picks-cache, separate store so V1 is untouched ----
const idOf = (url) => {
  const m = String(url).match(/[?&]v=([A-Za-z0-9_-]{6,})/) || String(url).match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : String(url).replace(/[^A-Za-z0-9]+/g, "_").slice(0, 100);
};
const fileFor = (url) => path.join(DIR, idOf(url) + ".json");

// null = miss (never extracted, or extracted under different logic). [] = a real "no claims here".
function cacheGet(url, fp) {
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(url), "utf8"));
    if (fp && j.fp !== fp) return null;
    return Array.isArray(j.claims) ? j.claims : null;
  } catch (_) { return null; }
}
function cacheSet(url, claims, fp) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = fileFor(url) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ url, claims, fp: fp || null, at: new Date().toISOString() }));
    fs.renameSync(tmp, fileFor(url)); // atomic: a half-written cache file is worse than none
  } catch (_) {}
}
function stats() {
  try { return { files: fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).length, dir: DIR }; }
  catch (_) { return { files: 0, dir: DIR }; }
}

// ---------------------------------------------------------------------------------------------
// CHUNKED EXTRACTION — the fix for the output ceiling.
//
// One call over a whole transcript returned raw=14 claims from 87k chars AND raw=14 from 359k. That
// is the model satisfying "give me a reasonable list", not extracting. The per-transcript limit is
// unfixable by prompting; moving it to a per-chunk limit is. A 12k chunk can genuinely be exhausted.
// ---------------------------------------------------------------------------------------------
const chunker = require("./chunker");

// A 12k window (~12 min of speech) realistically holds well under 20 claims. At or above this we
// assume the model stopped early rather than ran out of things to say, and we re-read it smaller.
const CLAIM_CEILING = 18;

// Truncation is not one signal but several, and any of them means "do not trust this chunk".
// Accepting a partial extraction silently is indistinguishable from a quiet analyst.
function truncationSignals(raw, items) {
  const t = String(raw || "").trim();
  const s = [];
  if (!t.endsWith("]")) s.push("JSON array never closed");
  if (items === null && t.includes("[")) s.push("array started but did not parse");
  if (items && items.length >= CLAIM_CEILING) s.push(`hit the ${CLAIM_CEILING}-claim ceiling`);
  return s;
}

// ---- CHUNK-LEVEL CACHE ----------------------------------------------------------------------
// The unit of caching is the CHUNK, not the video. Keyed by the chunk's own text + prompt version +
// model, so:
//   - adding a new source to a card re-runs only that source's chunks, never the whole card;
//   - editing a transcript invalidates only the chunks whose text actually changed;
//   - the identical chunk appearing in two contexts is extracted once;
//   - changing the prompt or the model invalidates everything, which is correct — a mixed corpus
//     extracted under two rule sets is the silent-corruption failure V1 already taught us.
const CHUNK_DIR = path.join(DIR, "chunks");
const chunkHash = (text, fp, model) =>
  crypto.createHash("sha256").update(`${model}${fp}${text}`).digest("hex").slice(0, 20);

function chunkCacheGet(h) {
  try { const j = JSON.parse(fs.readFileSync(path.join(CHUNK_DIR, h + ".json"), "utf8"));
    return Array.isArray(j.items) ? j : null; } catch (_) { return null; }
}
function chunkCacheSet(h, items, extra) {
  try {
    fs.mkdirSync(CHUNK_DIR, { recursive: true });
    const f = path.join(CHUNK_DIR, h + ".json");
    fs.writeFileSync(f + ".tmp", JSON.stringify({ h, items, ...extra, at: new Date().toISOString() }));
    fs.renameSync(f + ".tmp", f); // atomic: a half-written cache entry is worse than a miss
  } catch (_) {}
}

async function extractOne(text, meta, opts = {}) {
  const model = process.env.EXTRACT_MODEL || "gemini-3.5-flash-lite";
  const fp = fingerprint();
  const h = chunkHash(text, fp, model);
  const hit = opts.noCache ? null : chunkCacheGet(h);
  if (hit) return { raw: "[cached]", items: hit.items, truncated: [], hash: h, cached: true };

  const p = provider();
  if (!p) throw new Error("NO_KEY: set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in .env");
  const raw = await p.call(SYSTEM, String(text).slice(0, 200000));
  const items = parseArray(raw);
  const truncated = truncationSignals(raw, items);
  // Only a clean read is cached. Caching a truncated chunk would freeze a partial answer forever,
  // and it would be indistinguishable from a chunk where the analyst simply said less.
  if (!truncated.length && items) chunkCacheSet(h, items, { model, promptVersion: fp, chars: text.length });
  return { raw, items, truncated, hash: h, cached: false };
}

// Extract every claim from a full transcript, with provable coverage.
// meta: { videoId, source, url, timestamp }
// Returns { claims, coverage } — coverage.complete is FALSE if any range failed, and a caller must
// never treat such a transcript as fully read.
async function extractEvidenceChunked(text, meta, opts = {}) {
  const log = opts.log || (() => {});
  const model = process.env.EXTRACT_MODEL || "gemini-3.5-flash-lite";
  const fp = fingerprint();
  const { chunks, meta: cmeta } = chunker.chunk(text, opts);
  const cov = chunker.verifyCoverage(text.length, chunks);

  const out = [];
  const failed = [], retried = [];
  const rawCounts = [];
  const chunkRecords = [];
  let cacheHits = 0;
  const rejects = { noFields: 0, badQuote: 0, dupeInChunk: 0 };

  // process one window; on a truncation signal, split it and read the halves instead
  async function run(c, depth = 0) {
    let r;
    try { r = await extractOne(c.text, meta); }
    catch (e) {
      if (depth < 1 && c.text.length > 3000) { retried.push({ chunk: c.id, why: "error: " + e.message }); return split(c, depth); }
      failed.push({ chunk: c.id, range: [c.startChar, c.endChar], why: e.message });
      return;
    }
    if (r.truncated.length) {
      if (depth < 2 && c.text.length > 3000) {
        retried.push({ chunk: c.id, why: r.truncated.join("; "), depth });
        log(`    chunk ${c.id} truncated (${r.truncated.join("; ")}) -> re-reading in smaller windows`);
        return split(c, depth);
      }
      // cannot shrink further: record the range as FAILED rather than bank a partial read
      failed.push({ chunk: c.id, range: [c.startChar, c.endChar], why: "truncated: " + r.truncated.join("; ") });
      return;
    }
    if (r.items === null) { failed.push({ chunk: c.id, range: [c.startChar, c.endChar], why: "no usable JSON array" }); return; }
    if (r.cached) cacheHits++;
    chunkRecords.push({ id: String(c.id), startChar: c.startChar, endChar: c.endChar, chunkHash: r.hash, cached: !!r.cached });
    rawCounts.push(r.items.length);
    out.push(...shape(r.items, c, meta, model, fp, rejects));
  }
  async function split(c, depth) {
    const sub = chunker.chunk(c.text, { targetChars: Math.max(2500, Math.floor(c.text.length / 2)), overlapChars: 500 });
    for (const s of sub.chunks) {
      await run({ id: `${c.id}.${s.id}`, startChar: c.startChar + s.startChar, endChar: c.startChar + s.endChar,
        text: s.text, approxMinute: c.approxMinute }, depth + 1);
    }
  }

  log(`  ${(text.length / 1000).toFixed(0)}k chars -> ${chunks.length} chunks (${cmeta.boundaryKind}, ~${cmeta.overlapChars} overlap)`);
  for (const c of chunks) await run(c);

  // "suspiciously identical output counts" across chunks — the ceiling wearing a different hat
  const same = {};
  for (const n of rawCounts) same[n] = (same[n] || 0) + 1;
  const suspicious = Object.entries(same).filter(([n, k]) => k >= 3 && +n >= 8).map(([n, k]) => `${k} chunks each returned exactly ${n}`);

  return {
    claims: out,
    coverage: {
      // A transcript is complete ONLY if the chunks tile it AND every chunk was read.
      complete: cov.complete && failed.length === 0,
      totalChars: text.length,
      approxMinutes: cmeta.approxMinutes,
      chunks: chunks.length,
      boundaryKind: cmeta.boundaryKind,
      overlapChars: cmeta.overlapChars,
      coveredChars: cov.coveredChars,
      tilingGaps: cov.gaps,          // ranges no chunk covers (should always be [])
      failedChunks: failed,          // ranges we could not read -> UNPROCESSED
      retriedChunks: retried,
      unprocessedRanges: failed.map((f) => f.range),
      rejects,
      suspiciousCounts: suspicious,
      model, promptVersion: fp,
      transcriptHash: crypto.createHash("sha256").update(text).digest("hex").slice(0, 20),
      chunkRecords,        // boundaries + per-chunk hash: the record that makes incremental re-runs safe
      cacheHits, cacheMisses: chunkRecords.length - cacheHits,
    },
  };
}

// Shape raw model items into fully-provenanced claims. Same validation as the single-shot path.
function shape(items, c, meta, model, fp, rejects) {
  const seen = new Set();
  return items
    .filter((it) => { const ok = it && it.claim && it.about && it.quote; if (!ok) rejects.noFields++; return ok; })
    .filter((it) => {
      const probe = normText(it.quote).slice(0, 40);
      const ok = probe.length > 12 && normText(c.text).includes(probe);
      if (!ok) rejects.badQuote++;
      return ok;
    })
    .filter((it) => {
      const k = `${String(it.about).toLowerCase()}|${String(it.claim).toLowerCase().slice(0, 60)}`;
      if (seen.has(k)) { rejects.dupeInChunk++; return false; }
      seen.add(k); return true;
    })
    .map((it) => ({
      claim: String(it.claim).trim(),
      about: String(it.about).trim(),
      opponent: it.opponent ? String(it.opponent).trim() : null,
      direction: DIRS.has(it.direction) ? it.direction : "neutral",
      evidenceType: TYPES.has(it.evidenceType) ? it.evidenceType : "other",
      claimClass: CLASSES.has(it.claimClass) ? it.claimClass : "unsupported_narrative",
      confidence: normConf(it.confidence),
      quote: String(it.quote).trim().slice(0, 300),
      // ---- provenance: every claim must be traceable back to the exact source text ----
      videoId: meta.videoId || null,
      channel: meta.source,
      publishedAt: meta.timestamp,
      url: meta.url || null,
      segment: { startChar: c.startChar, endChar: c.endChar, approxMinute: c.approxMinute },
      chunkId: String(c.id),
      model, promptVersion: fp,
      // ---- not the model's to decide (see header) ----
      corroborated: null,
      knownBeforeBet: null,
    }));
}

module.exports = { extractEvidence, extractEvidenceChunked, fingerprint, cacheGet, cacheSet,
  chunkHash, chunkCacheGet, chunkCacheSet, CHUNK_DIR,
  stats, filterStats, normText, SYSTEM, DIR, CLAIM_CEILING };
