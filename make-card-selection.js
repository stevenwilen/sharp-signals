// BUILD A CARD SELECTION — the pre-extraction gate. No model calls; decides what is worth reading.
//
//   node make-card-selection.js <26JUL18> <2026-07-18> <out.json>
//
// IDENTICAL RULES FOR EVERY CARD. The threshold and scoring live in lib/target-card.js and are not
// parameterised here on purpose: tuning selection per card until each one looks good is how you
// manufacture whatever result you were hoping for.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const tc = require("./lib/target-card");
const k = require("./lib/kalshi");
const { paths, readJson, writeJson } = require("./lib/store");

const THRESHOLD = 35;          // fixed. Do not tune per card.
const LOOKBACK_DAYS = 28;      // how far before a fight a video may be published to count

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

async function main() {
  const [tickerDate, eventDate, out] = process.argv.slice(2);
  if (!tickerDate || !eventDate || !out) fail("usage: node make-card-selection.js <26JUL18> <2026-07-18> <out.json>");

  say(`[1] finding bouts for ${tickerDate} on Kalshi ...`);
  const markets = [].concat(
    await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "settled" }).catch(() => []),
    await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" }).catch(() => []),
  );
  const byEvent = {};
  for (const m of markets) {
    if (!String(m.ticker).includes(tickerDate)) continue;
    (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);
  }
  const pairs = Object.values(byEvent).filter((a) => a.length === 2)
    .map((a) => ({ a: a[0].yes_sub_title, b: a[1].yes_sub_title, date: eventDate }));
  if (!pairs.length) fail(`no two-sided Kalshi markets found for ${tickerDate}`);
  say(`[1] ${pairs.length} bouts`);

  say(`[2] building canonical card identity (aliases + ambiguity from the corpus) ...`);
  const card = tc.buildCard(`UFC-${eventDate}`, eventDate, pairs);
  const amb = card.bouts.flatMap((b) => [b.a, b.b]).filter((f) => f.ambiguous).length;
  say(`[2] ${card.bouts.length} bouts, ${amb} fighters have an ambiguous surname -> full name required`);

  say(`[3] scoring candidate videos (threshold ${THRESHOLD}, fixed) ...`);
  const corpus = new Set();
  for (const p of readJson(paths.predictions, [])) { if (p.pick) corpus.add(p.pick); if (p.opponent) corpus.add(p.opponent); }
  const corpusFighters = [...corpus];
  const byUrl = new Map();
  for (const p of readJson(paths.predictions, [])) if (p.url && p.timestamp) byUrl.set(p.url, { url: p.url, src: p.source, ts: p.timestamp });

  const from = Date.parse(eventDate) - LOOKBACK_DAYS * 86400000;
  const rows = [];
  let scanned = 0;
  for (const [url, v] of byUrl) {
    const t = Date.parse(v.ts);
    if (!(t >= from && t <= Date.parse(eventDate) + 86400000)) continue; // pre-fight window only
    const id = (url.match(/v=([\w-]+)/) || [])[1];
    if (!id) continue;
    const f = path.join("data", "transcripts", id + ".txt");
    if (!fs.existsSync(f) || fs.statSync(f).size < 4000) continue;
    scanned++;
    const hay = tc.norm(fs.readFileSync(f, "utf8"));
    const dom = tc.dominance(hay, card, corpusFighters);
    for (const b of card.bouts) {
      const s = tc.scoreBout(hay, b, { timestamp: v.ts });
      if (s.score <= 0 && s.coOccurrences === 0) continue;
      rows.push({ videoId: id, url, source: v.src, ts: v.ts, chars: hay.length, dom, ...s });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  const include = rows.filter((r) => r.score >= THRESHOLD);
  say(`[3] scanned ${scanned} videos -> ${rows.length} (video x bout) pairs scored -> ${include.length} above threshold`);

  const byVideo = {};
  for (const r of include) (byVideo[r.videoId] = byVideo[r.videoId] || []).push(...r.ranges);
  for (const v of Object.keys(byVideo)) {
    const merged = [];
    for (const g of byVideo[v].sort((a, b) => a.from - b.from)) {
      const last = merged[merged.length - 1];
      if (last && g.from <= last.to) { last.to = Math.max(last.to, g.to); continue; }
      merged.push({ ...g });
    }
    byVideo[v] = merged;
  }
  const vids = Object.keys(byVideo);
  const rangeChars = Object.values(byVideo).flat().reduce((a, g) => a + (g.to - g.from), 0);
  say(`[4] selection: ${vids.length} videos, ${Object.values(byVideo).flat().length} ranges, ${(rangeChars / 1000).toFixed(0)}k chars -> ~${Math.ceil(rangeChars / 10000)} chunks`);
  const boutsCovered = new Set(include.map((r) => r.boutId)).size;
  say(`[4] bouts with at least one qualifying video: ${boutsCovered}/${card.bouts.length}`);
  if (!vids.length) fail(`NOTHING SELECTED: 0 videos scored >= ${THRESHOLD} for this card. That is a real ` +
    `answer about coverage, but there is nothing to extract.`);

  writeJson(out, { card, threshold: THRESHOLD, include, byVideo });
  if (!fs.existsSync(out)) fail(`selection file not written: ${out}`);
  say(`[5] wrote ${out}`);
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
