// Sharp Signals pipeline: Listen -> Extract -> Grade -> Match -> Signal.
// Reports which stages are live vs waiting on API keys.
//   node pipeline.js          (real: pulls social feeds; needs keys)
//   node pipeline.js --mock   (proves grade->match->signal with sample data, NO keys)
require("./lib/env");
const { capabilities } = require("./lib/env");
const { paths, readJson, writeJson } = require("./lib/store");
const grade = require("./lib/grade");
const match = require("./lib/match");
const { notify } = require("./lib/notify");
const { sizeBet } = require("./lib/sizing");
const ledger = require("./lib/alert-ledger");

// ============================ SAFETY: ALERTS ARE DISARMED ============================
// A full audit (2026-07-14) found the alert path can currently:
//   1. match the WRONG SIDE of a fight (lib/match.js surname-only fallback: "Usman over
//      Du Plessis" resolves to the Du Plessis market) -> a BET on the fighter the source
//      picked AGAINST;
//   2. alert on a fight that is IN PROGRESS or ALREADY DECIDED (the live path has no
//      fight-date guard, and Kalshi leaves markets open until an operator settles them —
//      a decided fight produces the LARGEST computed edge, so it alerts hardest);
//   3. re-send the identical BET on every run (no alert ledger) — ~18 copies over a fight
//      week, which defeats the "never more than 5% on one fight" cap by repetition;
//   4. size the bet from Gemini's *conviction* score, which is empirically +11 points
//      overconfident vs. the actual hit rate.
// Until those are fixed, the pipeline still SCANS, EXTRACTS, GRADES and writes data —
// it just does not tell a human to put money down. Failure alerts still go out, so the
// system cannot die quietly. Flip this to true only when Tier-1 is fixed and verified.
const ALERTS_ARMED = false;
// =====================================================================================

// Optional: set BANKROLL=500 in .env and alerts will show dollars, not just a %.
const BANKROLL = Number(process.env.BANKROLL) || 0;

const MOCK = process.argv.includes("--mock");

function banner(caps) {
  const yn = (b) => (b ? "✅" : "⛔ needs key");
  console.log("Sharp Signals — capability status");
  console.log(`  Kalshi market reads : ${yn(caps.kalshiMarketReads)}`);
  console.log(`  Extract             : ${yn(caps.extractPredictions)}  GEMINI_API_KEY (free) or ANTHROPIC_API_KEY  [${caps.extractProvider}]`);
  console.log(`  Pull X/Twitter      : ${yn(caps.pullTwitter)}  TWITTERAPI_KEY`);
  console.log(`  Pull YouTube        : ${yn(caps.pullYouTube)}  YOUTUBE_API_KEY`);
  console.log(`  Kalshi trading      : ${yn(caps.kalshiTrading)}  (optional, later)\n`);
}

async function getPredictions(cfg) {
  if (MOCK) {
    const m = require("./lib/mock").build();
    console.log(`[mock] ${m.resolved.length} resolved history + ${m.fresh.length} fresh picks\n`);
    return { resolved: m.resolved, fresh: m.fresh };
  }
  // LIVE: fresh prediction VIDEOS (high yield) + recent tweets -> picks
  const { pullTwitter } = require("./lib/sources");
  const { findVideos } = require("./lib/youtube");
  const { getTranscript } = require("./lib/blotato");
  const { extractPredictions, extractFromTranscript, promptFingerprint } = require("./lib/extractor");
  const picksCache = require("./lib/picks-cache");
  const FP = promptFingerprint();
  const all = (readJson(paths.sources, { sources: [] }).sources || []).filter((s) => s.handle);
  const preds = [];

  // last 10 days of prediction videos (covers the upcoming card's fight week)
  const sinceIso = new Date(Date.now() - 10 * 86400000).toISOString();
  const yt = all.filter((s) => s.platform === "youtube");
  console.log(`[live] scanning ${yt.length} channels for new prediction videos since ${sinceIso.slice(0, 10)}...`);
  const videos = await findVideos(yt, sinceIso, (m) => console.log(m));
  let reused = 0, extracted = 0, extractFailed = 0;
  for (const v of videos) {
    // A video's transcript never changes, so its picks never change. Re-running Gemini over
    // the same 163 cached videos 6x/day was ~1,000 redundant extractions (~$4/day) to
    // re-derive picks we already had. Extract once, reuse forever.
    const hit = picksCache.get(v.url, FP);
    if (hit) { preds.push(...hit); reused++; continue; }

    const t = await getTranscript(v.url).catch(() => ({}));
    if (!t.text) continue;

    // A FAILED extraction must never be cached. It would blank this video permanently.
    // Leave it uncached and the next run retries it — which is exactly what we want.
    let got;
    try {
      got = await extractFromTranscript(t.text, {
        source: v.source, domain: v.domain, timestamp: v.publishedAt, url: v.url });
    } catch (e) {
      extractFailed++;
      console.log(`  EXTRACT FAILED (will retry next run): ${v.source}: ${e.message}`);
      continue;
    }
    picksCache.set(v.url, got, FP); // [] here is a REAL answer: "this vlog has no picks"
    preds.push(...got);
    extracted++;
    console.log(`  ${got.length} picks <- ${v.source}: ${v.title.slice(0, 45)}`);
  }
  console.log(`[live] videos: ${reused} from cache (0 cost), ${extracted} newly extracted` +
    (extractFailed ? `, ${extractFailed} FAILED (uncached, will retry)` : ""));

  // Recent tweets — but NOT every run. The tweet path is the one cost that scales linearly with
  // cadence: it re-pulls 20 tweets x 15 handles (paid twitterapi.io) and re-extracts them with
  // no cache. At an hourly cadence that would 24x the Twitter bill — and it currently yields
  // ZERO gradeable picks (all 1745 come from YouTube). So run it only a few times a day. Videos
  // are the fast path that matters for the early-line edge; tweets, if they ever prove out, do
  // not need minute-fresh polling. Set TWITTER_EVERY_HOURS to change the interval.
  const twEvery = Number(process.env.TWITTER_EVERY_HOURS || 24);
  const doTwitter = MOCK ? false : (new Date().getUTCHours() % twEvery === 0);
  if (doTwitter) {
    const xs = all.filter((s) => s.platform === "x");
    const posts = [];
    for (const s of xs) {
      const r = await pullTwitter(s, { limit: 20 }).catch(() => ({ posts: [] }));
      posts.push(...(r.posts || []));
    }
    console.log(`  ${posts.length} recent tweets (twitter runs every ${twEvery}h)`);
    if (posts.length) {
      try { preds.push(...(await extractPredictions(posts, { batchDelayMs: 200 }))); }
      catch (e) { console.log("  extract:", e.message); }
    }
  } else {
    console.log(`  (skipping twitter this hour; runs every ${twEvery}h)`);
  }
  // NOTE: deliberately does NOT write raw_posts.json. That file is the BACKFILL's deep
  // multi-month harvest; the pipeline only sees the last 20 tweets per handle. Overwriting
  // it every 4h both destroyed the backfill's version and created a guaranteed git conflict
  // between two jobs that now run concurrently.
  console.log(`[live] ${preds.length} fresh picks`);
  // Track records come from the backfill (predictions.json holds RESOLVED history).
  // Fresh picks are the unresolved ones we just pulled.
  const history = readJson(paths.predictions, []);
  const resolved = history.filter((p) => p.result === 0 || p.result === 1);
  return { resolved, fresh: preds.filter((p) => p.result == null) };
}

async function run() {
  const cfg = readJson(paths.config, {});
  const caps = capabilities();
  banner(caps);

  const { resolved, fresh } = await getPredictions(cfg);

  // GRADE (in memory only).
  // Two reasons this no longer writes sources_graded.json:
  //   1. It called gradeAll WITHOUT the source metadata the backfill passes, so every run
  //      silently stripped domain/type/handle/platform off every record until Monday.
  //   2. Both jobs writing the same file, concurrently, is what made the git rebase conflict
  //      that could silently discard a 5-hour backfill. The backfill OWNS this file now.
  const meta = {};
  for (const s of (readJson(paths.sources, { sources: [] }).sources || [])) {
    meta[s.name] = { domain: s.domain, type: s.type, handle: s.handle, platform: s.platform };
  }
  const graded = grade.gradeAll(resolved, cfg, meta);
  const ranked = Object.values(graded).sort((a, b) => (b.shrunkRoi || -9) - (a.shrunkRoi || -9));
  console.log("Source track records (beat-the-line):");
  console.log("  ROI    shrunk  n   trusted  source");
  for (const g of ranked)
    console.log(`  ${String(g.roi ?? "-").padStart(5)}  ${String(g.shrunkRoi ?? "-").padStart(5)}` +
      `  ${String(g.n).padStart(2)}  ${g.trusted ? "  YES  " : "   -   "}  ${g.source}`);

  // MATCH + SIGNAL
  const signals = [];
  const refused = [];
  for (const f of fresh) {
    const mkt = await match.matchToMarket(f, { cfg }).catch(() => null);
    if (!mkt) continue;
    // matchToMarket returns { ok:false, reason } when it cannot establish WHICH SIDE of the
    // fight the source was backing, or when the fight is today/over. Those refusals are the
    // whole point — log them, never bet them.
    if (mkt.ok === false) { refused.push(`${f.source}: ${mkt.reason}`); continue; }

    // BELT AND BRACES. The market we are about to price must BE the fighter who was picked.
    // The old matcher could return the right fight and the wrong side; nothing ever checked.
    if (match.nameScore(f.pick, mkt.fighter) < 1) {
      refused.push(`${f.source}: matched ${mkt.fighter} but the pick was "${f.pick}" — REFUSED`);
      continue;
    }

    // The price is what you PAY: the ask. A one-sided book (no offers to lift) is not a
    // tradeable market — a lone stale bid would otherwise read as a huge edge.
    const cost = mkt.yesAsk;
    if (!(cost > 0 && cost < 1)) { refused.push(`${f.source}: ${mkt.fighter} has no offers to buy`); continue; }

    const g = graded[f.source] || {};
    signals.push({
      source: f.source, trusted: !!g.trusted, domain: f.domain,
      pick: f.pick, fighter: mkt.fighter, opponent: mkt.opponent,
      market: mkt.matchTitle, ticker: mkt.ticker, fightDate: mkt.fightDate,
      cost,                             // the ask — what you actually pay
      mid: mkt.price, yesBid: mkt.yesBid,
      sourceRoi: g.shrunkRoi ?? null,   // the trust decision's number
      sourceRoiLcb: g.roiLcb ?? null,   // the DEFENSIBLE edge — what sizing uses
      n: g.n || 0,
      quote: f.quote || "",
    });
  }
  signals.sort((a, b) => (b.trusted - a.trusted) || ((b.sourceRoiLcb || -9) - (a.sourceRoiLcb || -9)));
  writeJson(paths.signals, signals);

  if (refused.length) {
    console.log(`\nREFUSED ${refused.length} pick(s) rather than guess:`);
    for (const r of refused.slice(0, 20)) console.log(`  - ${r}`);
  }

  // A signal now requires: a trusted source, AND a defensible (lower-bound) edge over the
  // price you actually pay. Gemini's confidence score is no longer part of this decision.
  const trusted = signals.filter((s) => s.trusted && (s.sourceRoiLcb || 0) > 0);
  console.log("\nLIVE SIGNALS (trusted source with a defensible edge):");
  if (!trusted.length) console.log("  (none)");
  for (const s of trusted)
    console.log(`  ${s.fighter} vs ${s.opponent} — costs ${Math.round(s.cost * 100)}c` +
      `  [${s.source}: n=${s.n}, edge ${s.sourceRoi} (lower bound ${s.sourceRoiLcb})]  ${s.fightDate}`);
  console.log(`\nwrote ${paths.signals}`);

  // ---- TELEGRAM -----------------------------------------------------------
  // Alert on a real edge. Stay QUIET otherwise — six "no signals" pings a day
  // would train you to ignore the one that matters. But send one daily heartbeat
  // so silence is never ambiguous ("is it broken, or is there just nothing?").
  // Kept deliberately plain: cents, not percentages. A Kalshi contract costs X cents
  // and pays $1 if you're right, so "costs 32c, worth 52c" needs no betting knowledge.
  if (!ALERTS_ARMED) {
    console.log(`\n[SAFETY] alerts DISARMED — ${trusted.length} signal(s) suppressed, not sent.`);
    console.log(`         data/signals.json is still written; see ALERTS_ARMED in pipeline.js.`);
  } else if (trusted.length) {
    const cents = (v) => Math.round(v * 100);

    // Group by market so agreement reads as agreement...
    const byTicker = {};
    for (const s of trusted) (byTicker[s.ticker] = byTicker[s.ticker] || []).push(s);

    const lines = [];
    for (const [ticker, all] of Object.entries(byTicker)) {
      // ...but DEDUPE BY SOURCE first. A channel that posts a "Preview" and a "Best Bets" video
      // in the same week was landing here twice, so the message said "2 trusted sources all like
      // him" and listed the same man twice — manufactured consensus — while also doubling his
      // weight in the bet size.
      const bySource = new Map();
      for (const s of all) if (!bySource.has(s.source)) bySource.set(s.source, s);
      const group = Array.from(bySource.values());
      const s0 = group[0];

      const size = sizeBet(
        group.map((s) => ({ source: s.source, roiLcb: s.sourceRoiLcb, shrunkRoi: s.sourceRoi, n: s.n })),
        s0.cost
      );
      if (size.skip) {
        console.log(`  (skipping ${s0.fighter}: ${size.reason})`);
        continue;
      }

      const gate = ledger.shouldSend(ticker, group.map((s) => s.source), size.pct);
      if (!gate.send) { console.log(`  (already alerted ${s0.fighter}: ${gate.why})`); continue; }

      const out = [
        `BET: ${s0.fighter}`,
        `Fight: ${s0.fighter} vs ${s0.opponent}, ${s0.fightDate}`,
        ``,
        `It costs ${cents(s0.cost)}c and pays $1 if he wins.`,
        `We think it is worth about ${size.p}c.`,
        ``,
      ];

      if (group.length === 1) {
        out.push(`${s0.source} picked him.`,
          `His record: ${s0.n} past picks, and he beats the market by ` +
          `${Math.round((s0.sourceRoi || 0) * 100)}% on average.`);
      } else {
        out.push(`${group.length} sources we trust all picked him:`);
        for (const s of group) {
          out.push(`- ${s.source} (${s.n} past picks, beats the market by ` +
            `${Math.round((s.sourceRoi || 0) * 100)}%)`);
        }
      }

      out.push(``, `BET ${size.pct}% of your bankroll.`);
      if (BANKROLL) out.push(`On your $${BANKROLL} that is about $${Math.round(BANKROLL * size.pct / 100)}.`);
      if (size.capped) out.push(`(capped at 5%, never more on one fight)`);
      out.push(``,
        `This is a small sample, so the size is deliberately cautious.`,
        `Market code: ${ticker}`);

      lines.push(out.join("\n"));
      ledger.record(ticker, group.map((s) => s.source), size.pct);
    }

    if (lines.length) {
      await notify(lines.join("\n\n-----\n\n")).catch(() => {});
    } else {
      console.log("  (all signals suppressed: already sent, or too thin to bet)");
    }
  } else {
    const hour = new Date().getUTCHours();
    const force = process.env.FORCE_HEARTBEAT === "1";
    if (force || (hour >= 12 && hour < 16)) { // one quiet-day note (the 12:00 UTC run)
      await notify(`No bets today.\n\nChecked ${fresh.length} picks. Nothing worth it.`).catch(() => {});
    }
  }

  // Silence must never be ambiguous. While disarmed, still send the one daily note so a
  // paused system is not mistaken for a dead one.
  if (!ALERTS_ARMED) {
    const hour = new Date().getUTCHours();
    if (process.env.FORCE_HEARTBEAT === "1" || (hour >= 12 && hour < 16)) {
      await notify(
        `Bet alerts are PAUSED while I fix some bugs.\n\n` +
        `The system is still running and still learning. It checked ${fresh.length} picks today ` +
        `and found ${trusted.length} it would have flagged.\n\n` +
        `Do not place any bets from this system until I turn alerts back on.`
      ).catch(() => {});
    }
  }
}

run().catch(async (e) => {
  console.error("pipeline error:", e.message);
  await notify(`⚠️ Sharp Signals pipeline FAILED: ${e.message}`).catch(() => {});
  process.exit(1);
});
