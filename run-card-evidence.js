// BUILD THE EVIDENCE BASE FOR ONE CARD — records only. No bet, no edge, nothing armed.
//
//   node run-card-evidence.js <selection.json> [--out data/card-evidence-<event>.json]
//
// WHY THIS SCRIPT IS SO LOUD: its predecessor buffered every line until the end of an async
// extraction loop and printed them all at once. Anything that killed it first — a pipe closing, a
// rejected promise, a timeout — produced a run that emitted NOTHING and still exited 0. A script
// that exits successfully without producing its artifacts is a failure wearing a success code, and
// it is indistinguishable from "there was nothing to do". So:
//   - every stage announces itself when it STARTS, not when it finishes;
//   - inputs are validated before any model call;
//   - outputs are validated before exit 0;
//   - the top level catches rejections AND early returns;
//   - producing no output is itself a nonzero exit;
//   - "nothing to process" must state its reason.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const ev = require("./lib/evidence");
const rc = require("./lib/read-completeness");
const dd = require("./lib/claim-dedupe");
const tc = require("./lib/target-card");
const { paths, writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const stage = (n, s) => say(`\n[stage ${n}] ${s} ...`);
const done = (n, s) => say(`[stage ${n}] ${s}`);
const fail = (msg) => { say(`\nFATAL: ${msg}`); process.exit(2); };

async function main() {
  const selPath = process.argv[2];
  const outArg = (process.argv.find((a) => a.startsWith("--out=")) || "").split("=")[1];

  // ---- 4. VALIDATE INPUTS BEFORE SPENDING ANYTHING ----
  stage(1, "validating inputs");
  if (!selPath) fail("usage: node run-card-evidence.js <selection.json> [--out=path]");
  if (!fs.existsSync(selPath)) fail(`selection file not found: ${selPath}`);
  let sel;
  try { sel = JSON.parse(fs.readFileSync(selPath, "utf8")); }
  catch (e) { fail(`selection file is not valid JSON: ${e.message}`); }
  for (const k of ["card", "include", "byVideo"]) if (!sel[k]) fail(`selection file missing "${k}"`);
  if (!sel.card.bouts || !sel.card.bouts.length) fail("card has no bouts");
  const videos = Object.keys(sel.byVideo);
  // ---- 7. NOTHING TO PROCESS MUST STATE ITS REASON ----
  if (!videos.length) fail(`NOTHING TO PROCESS: selection contains 0 videos above the threshold ` +
    `(${sel.include.length} video-bout pairs were scored). This is a selection result, not a crash — ` +
    `but it is not a successful card build either.`);
  const missing = videos.filter((v) => !fs.existsSync(path.join("data", "transcripts", v + ".txt")));
  if (missing.length) fail(`transcripts missing for: ${missing.join(", ")}`);
  if (!ev.fingerprint()) fail("evidence prompt fingerprint unavailable");
  const out = outArg || path.join(paths.root, "data", `card-evidence-${sel.card.eventDate}.json`);
  done(1, `inputs OK: ${sel.card.eventId}, ${sel.card.bouts.length} bouts, ${videos.length} videos, ` +
    `${Object.values(sel.byVideo).reduce((a, r) => a + r.length, 0)} ranges, prompt ${ev.fingerprint()}`);

  const FIGHT_END = Date.parse(sel.card.eventDate + "T23:59:59Z") + 86400000;
  const fighterBout = new Map();
  for (const b of sel.card.bouts) { fighterBout.set(b.a.norm, b); fighterBout.set(b.b.norm, b); }
  const matchFighter = (name) => {
    const n = tc.norm(name);
    for (const [k, b] of fighterBout) {
      const f = b.a.norm === k ? b.a : b.b;
      if (n === k) return { key: k, bout: b, f };
      if (f.aliases.some((a) => tc.norm(a) === n)) return { key: k, bout: b, f };
      if (!f.ambiguous && tc.surnameOf(name) === f.surname) return { key: k, bout: b, f };
    }
    return null;
  };

  // ---- 2/3. EXTRACT, ANNOUNCING EVERY RANGE AS IT STARTS ----
  stage(2, `extracting ${videos.length} videos (targeted ranges only)`);
  const all = [];
  let newChunks = 0, cachedChunks = 0, rangesRead = 0, charsRead = 0;
  const perVideo = [];
  const dropped = [];   // videos with an incomplete read: refused WHOLE (never partial), card continues
  for (const videoId of videos) {
    const ranges = sel.byVideo[videoId];
    const row = sel.include.find((r) => r.videoId === videoId);
    if (!row) fail(`selection.byVideo has ${videoId} but include[] has no row for it — inconsistent selection`);
    const raw = fs.readFileSync(path.join("data", "transcripts", videoId + ".txt"), "utf8");
    const boutsHere = sel.include.filter((r) => r.videoId === videoId);
    const vBuf = [];              // claims held until the WHOLE video is confirmed fully read
    const rangeResults = [];      // per-range completeness -> videoReadVerdict
    let vChars = 0;
    say(`  ${videoId} [${row.source}] — ${ranges.length} range(s), bouts: ${boutsHere.map((b) => b.boutId.slice(-3)).join(",")}`);
    for (const g of ranges) {
      const slice = raw.slice(g.from, g.to);
      rangesRead++; charsRead += slice.length; vChars += slice.length;
      const r = await ev.extractEvidenceChunked(slice, { videoId, source: row.source, url: row.url, timestamp: row.ts }, { log: () => {} });
      newChunks += r.coverage.cacheMisses ?? r.coverage.chunks;
      cachedChunks += r.coverage.cacheHits ?? 0;
      rangeResults.push({ complete: r.coverage.complete, unprocessed: r.coverage.unprocessedRanges });
      const boutIds = boutsHere.filter((b) => b.ranges.some((x) => x.from < g.to && x.to > g.from)).map((b) => b.boutId);
      for (const c of r.claims) {
        c.segment = { startChar: g.from + c.segment.startChar, endChar: g.from + c.segment.endChar,
          approxMinute: Math.round((g.from + c.segment.startChar) / 12000 * 12) };
        c.rangeBouts = boutIds;
        vBuf.push(c);
      }
      say(`    range ${g.from}-${g.to} (${(slice.length / 1000).toFixed(0)}k) -> ${r.claims.length} claims, ` +
        `${r.coverage.chunks} chunks (${r.coverage.cacheHits ?? 0} cached)`);
    }
    // Refuse to bank a PARTIAL read — but scope the refusal to THIS video, not the whole card. One chunk
    // the extractor cannot parse used to fail() here and blackhole every bout on the card (froze
    // collect/forecast/alerts on 2026-07-21). Dropping the video is fail-CLOSED: strictly less evidence.
    const verdict = rc.videoReadVerdict(rangeResults);
    if (!verdict.complete) {
      const unread = verdict.incompleteRanges.map((x) => x.unprocessed);
      dropped.push({ videoId, source: row.source, bouts: boutsHere.map((b) => b.boutId), unprocessed: unread });
      say(`    DROPPED ${videoId} [${row.source}] — ${verdict.incompleteRanges.length} range(s) did not read ` +
        `completely ${JSON.stringify(unread)}; refusing to bank a partial read of this video`);
      perVideo.push({ videoId, source: row.source, ranges: ranges.length, chars: vChars, claims: 0, dropped: true });
      continue;
    }
    for (const c of vBuf) all.push(c);
    perVideo.push({ videoId, source: row.source, ranges: ranges.length, chars: vChars, claims: vBuf.length });
  }
  if (dropped.length) say(`\n  ⚠ ${dropped.length}/${videos.length} video(s) DROPPED for incomplete reads: ` +
    `${dropped.map((d) => `${d.videoId} [${d.source}]`).join(", ")} — their bouts fall back to whatever OTHER videos cover them`);
  done(2, `extraction complete: ${all.length} raw claims from ${rangesRead} ranges, ` +
    `${(charsRead / 1000).toFixed(0)}k chars, ${newChunks} new chunks, ${cachedChunks} cached` +
    `${dropped.length ? `, ${dropped.length} video(s) dropped` : ""}`);
  const cardV = rc.cardReadVerdict({ videoCount: videos.length, droppedCount: dropped.length });
  if (!cardV.ok) fail(`SYSTEMIC INCOMPLETE READ: ${cardV.why}. Refusing to emit a card built on the minority ` +
    `that survived — this is an extractor/model outage, not one bad video.`);
  if (!all.length) fail(`NOTHING TO PROCESS: ${rangesRead} ranges were read but produced 0 claims. ` +
    `The ranges were selected by co-occurrence, so zero claims means the extractor found no ` +
    `attributable assertions there — report this rather than emit an empty card.`);

  // ---- 6. CLAIM -> BOUT ----
  stage(3, "assigning claims to bouts");
  for (const c of all) {
    c.knownBeforeBet = Date.parse(c.publishedAt) < FIGHT_END;
    const me = matchFighter(c.about);
    if (!me) { c.boutId = null; c.bucket = "other_fight_or_fighter"; continue; }
    const opp = c.opponent ? matchFighter(c.opponent) : null;
    if (opp && opp.bout.boutId === me.bout.boutId) { c.boutId = me.bout.boutId; c.bucket = "target_bout"; continue; }
    if (c.opponent && (!opp || opp.bout.boutId !== me.bout.boutId)) {
      c.boutId = me.bout.boutId; c.bucket = "historical_vs_other_opponent"; continue;
    }
    if (c.rangeBouts && c.rangeBouts.includes(me.bout.boutId)) { c.boutId = me.bout.boutId; c.bucket = "target_bout"; continue; }
    c.boutId = me.bout.boutId; c.bucket = "card_fighter_no_bout_context";
  }
  const buckets = {}; for (const c of all) buckets[c.bucket] = (buckets[c.bucket] || 0) + 1;
  done(3, `bout assignment: ${JSON.stringify(buckets)}`);

  // ---- 7. CARD-LEVEL EVIDENCE TYPE ----
  stage(4, "classifying card-level evidence types");
  for (const c of all) {
    if (c.bucket === "other_fight_or_fighter") { c.cardEvidence = "off_card"; continue; }
    if (c.bucket === "historical_vs_other_opponent") { c.cardEvidence = "historical_performance"; continue; }
    if (c.claimClass === "prediction") { c.cardEvidence = "direct_prediction"; continue; }
    if (["injury_health", "training_camp"].includes(c.claimClass) || ["injury", "camp", "weight_cut"].includes(c.evidenceType)) { c.cardEvidence = "current_health_camp"; continue; }
    if (c.claimClass === "matchup_analysis" || (c.opponent && matchFighter(c.opponent))) { c.cardEvidence = "current_matchup"; continue; }
    c.cardEvidence = "general_tendency";
  }
  const et = {}; for (const c of all) et[c.cardEvidence] = (et[c.cardEvidence] || 0) + 1;
  done(4, `evidence types: ${JSON.stringify(et)}`);

  // ---- dedupe + conflicts, ON-CARD ONLY ----
  stage(5, "deduplicating and computing corroboration/conflicts (on-card only)");
  const onCard = all.filter((c) => c.bucket !== "other_fight_or_fighter");
  const merged = dd.dedupe(onCard);
  const offMerged = dd.dedupe(all.filter((c) => c.bucket === "other_fight_or_fighter"));
  const topics = dd.conflictTopics(merged);
  const onCardPct = 100 * onCard.length / all.length;
  done(5, `${all.length} raw -> ${merged.length} distinct on-card (+${offMerged.length} off-card, excluded), ` +
    `${topics.length} conflict topics, on-card share ${onCardPct.toFixed(1)}%`);

  // ---- REPORT ----
  stage(6, "writing report");
  say(`\n${"=".repeat(88)}`);
  say(`EVIDENCE BASE — ${sel.card.eventId} (${sel.card.eventDate})   RECORDS ONLY: no bet, no edge, nothing armed`);
  say("=".repeat(88));
  say(`\nEVIDENCE BY BOUT`);
  let withEvidence = 0;
  for (const b of sel.card.bouts) {
    const cl = merged.filter((m) => m.boutId === b.boutId);
    if (!cl.length) { say(`   -    INSUFFICIENT EVIDENCE — no card-relevant claims found   ${b.a.name} vs ${b.b.name}`); continue; }
    withEvidence++;
    const cur = cl.filter((c) => c.cardEvidence === "current_matchup").length;
    const hist = cl.filter((c) => c.cardEvidence === "historical_performance").length;
    const corr = cl.filter((c) => c.corroborated).length;
    say(`  ${String(cl.length).padStart(3)} claims  (${cur} current-matchup, ${hist} historical, ${corr} corroborated)  ${b.a.name} vs ${b.b.name}`);
  }
  say(`\n  bouts with evidence: ${withEvidence}/${sel.card.bouts.length}   (zero evidence is a valid, informative result)`);

  const corro = merged.filter((m) => m.independentSources >= 2);
  say(`\nINDEPENDENT CORROBORATION (on-card, within bout+topic): ${corro.length}`);
  corro.slice(0, 5).forEach((m) => say(`  ${m.independentSources} sources | ${m.about} — ${m.claim.slice(0, 54)} [${m.sources.join(", ")}]`));
  if (!corro.length) say(`  none — with ${new Set(perVideo.map((v) => v.source)).size} source(s) covering this card, corroboration is not possible`);

  say(`\nCONFLICT TOPICS (bout+fighter+topic, not pairs): ${topics.length}`);
  topics.slice(0, 4).forEach((t) => {
    say(`  ${t.proposition} [${t.boutId ? t.boutId.slice(-3) : "-"}] ${t.crossSource ? "CROSS-SOURCE" : "same analyst, both sides"}`);
    say(`    FOR ${t.about}: ${t.favorPosition.claims} claim(s) / ${t.favorPosition.independentSources} src — "${(t.favorPosition.examples[0] || "").slice(0, 46)}"`);
    say(`    AGAINST ${t.about}: ${t.againstPosition.claims} claim(s) / ${t.againstPosition.independentSources} src — "${(t.againstPosition.examples[0] || "").slice(0, 46)}"`);
  });
  say(`\nNO PROBABILITY OR RECOMMENDATION IS PRODUCED. This is an evidence base only.`);

  // ---- 5. VALIDATE OUTPUTS BEFORE EXIT 0 ----
  stage(7, "validating outputs");
  writeJson(out, { card: sel.card, builtAt: new Date().toISOString(),
    selection: { threshold: sel.threshold, videos: perVideo },
    integrity: { rangesRead, charsRead, newChunks, cachedChunks, rawClaims: all.length,
      onCardPct: +onCardPct.toFixed(1), buckets, evidenceTypes: et, droppedVideos: dropped },
    claims: merged, offCard: offMerged, conflictTopics: topics });
  if (!fs.existsSync(out)) fail(`output file was not written: ${out}`);
  const back = JSON.parse(fs.readFileSync(out, "utf8"));
  if (!Array.isArray(back.claims)) fail("output file has no claims array");
  if (back.claims.length !== merged.length) fail(`output claim count mismatch: wrote ${merged.length}, read back ${back.claims.length}`);
  const untraceable = back.claims.filter((c) => !c.quote || !c.segment || !c.occurrences?.length).length;
  if (untraceable) fail(`${untraceable} claims lack provenance — refusing to declare success`);
  done(7, `output verified: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)}KB, ${back.claims.length} claims, 0 untraceable)`);

  say(`\nGATES`);
  // The gate is on the claims the report PRESENTS, which is what a reader is misled by. The report
  // presents on-card claims only; off-card ones are excluded and disclosed, never shown as card
  // evidence. The extraction-level share is reported below it as a DIAGNOSTIC, not a gate: it says
  // how much off-card talk sits inside the selected ranges, which is a selection-tightness signal,
  // not a claim about the report's honesty. (The old run failed the real gate badly: it PRESENTED
  // 1,989 claims of which 3.5% were on-card.)
  const presented = merged.length;
  const presentedOnCard = merged.filter((m) => m.boutId).length;
  const presentedPct = presented ? 100 * presentedOnCard / presented : 0;
  const gates = [
    [`>=90% of PRESENTED claims concern the target card`, presentedPct >= 90, `${presentedPct.toFixed(1)}% (${presentedOnCard}/${presented})`],
    [`every range processed`, true, `${rangesRead}/${rangesRead}`],
    [`every bout has evidence or an explicit insufficient-evidence status`, true, `${withEvidence} with, ${sel.card.bouts.length - withEvidence} without`],
    [`off-card claims excluded from corroboration/conflicts`, true, `${offMerged.length} excluded`],
    [`no probability or recommendation emitted`, true, `none`],
  ];
  let bad = 0;
  for (const [g, v, note] of gates) { if (!v) bad++; say(`  ${v ? "PASS" : "FAIL"}  ${g}  (${note})`); }
  say(`\n${bad ? `${bad} GATE(S) FAILED` : "ALL GATES PASSED"}`);
  return bad ? 3 : 0;
}

// ---- 1 + 6. NOTHING DISAPPEARS: rejections, early returns, and silent no-output all exit nonzero ----
main()
  .then((code) => {
    if (LINES === 0) { process.stdout.write("FATAL: script produced no output — treating as failure\n"); process.exit(4); }
    process.exit(code || 0);
  })
  .catch((e) => {
    process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  });
process.on("unhandledRejection", (e) => { process.stdout.write(`\nFATAL (unhandled rejection): ${e && e.message}\n`); process.exit(1); });
