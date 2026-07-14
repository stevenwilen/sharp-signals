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
  const { extractPredictions, extractFromTranscript } = require("./lib/extractor");
  const all = (readJson(paths.sources, { sources: [] }).sources || []).filter((s) => s.handle);
  const preds = [];

  // last 10 days of prediction videos (covers the upcoming card's fight week)
  const sinceIso = new Date(Date.now() - 10 * 86400000).toISOString();
  const yt = all.filter((s) => s.platform === "youtube");
  console.log(`[live] scanning ${yt.length} channels for new prediction videos since ${sinceIso.slice(0, 10)}...`);
  const videos = await findVideos(yt, sinceIso, (m) => console.log(m));
  for (const v of videos) {
    const t = await getTranscript(v.url).catch(() => ({}));
    if (!t.text) continue;
    const got = await extractFromTranscript(t.text, {
      source: v.source, domain: v.domain, timestamp: v.publishedAt, url: v.url }).catch(() => []);
    preds.push(...got);
    console.log(`  ${got.length} picks <- ${v.source}: ${v.title.slice(0, 45)}`);
  }

  // recent tweets
  const xs = all.filter((s) => s.platform === "x");
  const posts = [];
  for (const s of xs) {
    const r = await pullTwitter(s, { limit: 20 }).catch(() => ({ posts: [] }));
    posts.push(...(r.posts || []));
  }
  console.log(`  ${posts.length} recent tweets`);
  if (posts.length) {
    try { preds.push(...(await extractPredictions(posts, { batchDelayMs: 200 }))); }
    catch (e) { console.log("  extract:", e.message); }
  }
  writeJson(paths.rawPosts, posts);
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

  // GRADE
  const graded = grade.gradeAll(resolved, cfg);
  writeJson(paths.graded, graded);
  const ranked = Object.values(graded).sort((a, b) => (b.shrunkRoi || -9) - (a.shrunkRoi || -9));
  console.log("Source track records (beat-the-line):");
  console.log("  ROI    shrunk  n   trusted  source");
  for (const g of ranked)
    console.log(`  ${String(g.roi ?? "-").padStart(5)}  ${String(g.shrunkRoi ?? "-").padStart(5)}` +
      `  ${String(g.n).padStart(2)}  ${g.trusted ? "  YES  " : "   -   "}  ${g.source}`);

  // MATCH + SIGNAL
  const signals = [];
  for (const f of fresh) {
    const mkt = await match.matchToMarket(f).catch(() => null);
    if (!mkt || mkt.price == null) continue;
    const g = graded[f.source] || {};
    signals.push({
      source: f.source, trusted: !!g.trusted, domain: f.domain,
      pick: f.pick, market: mkt.matchTitle, ticker: mkt.ticker,
      marketProb: mkt.price, sourceProb: f.confidence,
      edge: f.confidence != null ? +(f.confidence - mkt.price).toFixed(3) : null,
      sourceRoi: g.shrunkRoi ?? null, quote: f.quote || "",
    });
  }
  const minEdge = (cfg.signals && cfg.signals.minTrustedEdge) || 0.05;
  signals.sort((a, b) => (b.trusted - a.trusted) || ((b.edge || -9) - (a.edge || -9)));
  writeJson(paths.signals, signals);

  console.log("\nLIVE SIGNALS (trusted voice disagrees with Kalshi):");
  const trusted = signals.filter((s) => s.trusted && (s.edge || 0) >= minEdge);
  if (!trusted.length) console.log("  (none clear the edge threshold right now)");
  for (const s of trusted)
    console.log(`  ⭐ ${s.pick} — ${(s.sourceProb * 100).toFixed(0)}% src vs ${(s.marketProb * 100).toFixed(0)}% mkt` +
      `  (edge +${(s.edge * 100).toFixed(0)}pts, ROI ${s.sourceRoi})  [${s.source}]  ${s.market}`);

  const research = signals.filter((s) => !(s.trusted && (s.edge || 0) >= minEdge));
  if (research.length) {
    console.log("\n  research-only (untrusted / thin edge):");
    for (const s of research)
      console.log(`   · ${s.pick} ${(s.sourceProb * 100).toFixed(0)}% vs ${(s.marketProb * 100).toFixed(0)}% mkt  [${s.source}${s.trusted ? "" : ", untrusted"}]`);
  }
  console.log(`\nwrote ${paths.signals}`);

  // ---- TELEGRAM -----------------------------------------------------------
  // Alert on a real edge. Stay QUIET otherwise — six "no signals" pings a day
  // would train you to ignore the one that matters. But send one daily heartbeat
  // so silence is never ambiguous ("is it broken, or is there just nothing?").
  // Kept deliberately plain: cents, not percentages. A Kalshi contract costs X cents
  // and pays $1 if you're right, so "costs 32c, worth 52c" needs no betting knowledge.
  if (trusted.length) {
    const c = (v) => Math.round(v * 100); // probability -> cents

    // Several trusted sources landing on the SAME fighter is a stronger signal than one,
    // not two separate ones. Group by market so agreement reads as agreement.
    const byTicker = {};
    for (const s of trusted) (byTicker[s.ticker] = byTicker[s.ticker] || []).push(s);

    const lines = Object.values(byTicker).map((group) => {
      const s0 = group[0];
      const fight = (s0.market || "").replace(/^Will .*? win the /, "")
        .replace(/ professional MMA fight.*/, "").replace(/\?$/, "").trim() || s0.market;
      const avg = group.reduce((a, x) => a + x.sourceProb, 0) / group.length;
      const out = [`BET: ${s0.pick}`, `Fight: ${fight}`, ``,
        `Kalshi price: ${c(s0.marketProb)}c (pays $1 if he wins)`, ``];

      if (group.length === 1) {
        const g = graded[s0.source] || {};
        out.push(`${s0.source} says it's worth: ${c(s0.sourceProb)}c`,
          `So it looks ${c(s0.sourceProb - s0.marketProb)}c too cheap.`, ``,
          `${s0.source}'s record: ${g.n} past picks, beat the market by ${Math.round((g.roi || 0) * 100)}%.`);
      } else {
        out.push(`${group.length} trusted sources all like him:`);
        for (const s of group) {
          const g = graded[s.source] || {};
          out.push(`- ${s.source} says ${c(s.sourceProb)}c  (${g.n} picks, beats market by ${Math.round((g.roi || 0) * 100)}%)`);
        }
        out.push(``, `Together: worth about ${c(avg)}c, so it looks ${c(avg - s0.marketProb)}c too cheap.`);
      }

      // How much to actually bet (Kelly, shrunk by sample size, quarter-staked, capped)
      const size = sizeBet(
        group.map((s) => ({ sourceProb: s.sourceProb, n: (graded[s.source] || {}).n || 0 })),
        s0.marketProb
      );
      out.push(``);
      if (size.skip) {
        out.push(`Bet: skip. Once you account for how few picks back this, the edge is too thin.`);
      } else {
        out.push(`BET ${size.pct}% of your bankroll.`);
        if (BANKROLL) out.push(`On your $${BANKROLL} that's about $${Math.round(BANKROLL * size.pct / 100)}.`);
        if (size.capped) out.push(`(capped at 5% - never more on one fight)`);
      }
      out.push(`Market code: ${s0.ticker}`);
      return out.join("\n");
    });

    await notify(`SIGNAL\n\n${lines.join("\n\n———\n\n")}\n\nBet small.`).catch(() => {});
  } else {
    const hour = new Date().getUTCHours();
    const force = process.env.FORCE_HEARTBEAT === "1";
    if (force || (hour >= 12 && hour < 16)) { // one quiet-day note (the 12:00 UTC run)
      await notify(`No bets today.\n\nChecked ${fresh.length} picks. Nothing worth it.`).catch(() => {});
    }
  }
}

run().catch(async (e) => {
  console.error("pipeline error:", e.message);
  await notify(`⚠️ Sharp Signals pipeline FAILED: ${e.message}`).catch(() => {});
  process.exit(1);
});
