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
const alertLedger = require("./lib/alert-ledger");
const ledger = require("./lib/pick-ledger");
const positions = require("./lib/positions");
const k = require("./lib/kalshi");

// ============================ V1 NEVER SENDS A BUY ALERT ============================
// V1's guru-rank betting thesis failed out-of-sample (0 of 50 sources survive), and its alert path
// had four separate defects (wrong-side surname matching, no fight-date guard, no dedup, conviction
// sizing). Rather than gate that path behind a flag — which the previous audit showed is an invitation
// to flip it — the path is GONE. V1 records paper positions for research and nothing else; every
// betting decision now runs through the unified V2 path (run-entertainment-alerts.js) and its single
// arming gate (lib/arming.js: ALERTS_ARMED + machine attestation + SHARP_PRODUCTION).
//
// This module may still Telegram exactly two NON-betting things: the daily PAPER summary (research
// results, never an instruction) and a pipeline-failure alert (so the system cannot die quietly).
// There is no ALERTS_ARMED flag here anymore, because there is no buy path for it to guard.
// ===================================================================================

// Optional: set BANKROLL=500 in .env and the paper summary shows dollars, not just a %.
const BANKROLL = Number(process.env.BANKROLL) || 0;

// The identity of the V1 live-signal gate, stamped onto every position it admits so the row can always
// be attributed to the rules in force when it opened. Bump this when the gate at :408 changes, so a
// position opened under an old gate is distinguishable from one opened under the new one — the exact
// distinction whose absence let three repealed positions look like current calls.
const GATE_VERSION = "v1-gate:b1399bd (survives && !isFighter && roiLcb>0)";

const MOCK = process.argv.includes("--mock");
// --watch: a CHEAP re-check. No YouTube, no Gemini — just re-run the EXISTING watch list against
// Kalshi to catch a market that opened since the last run (the "get in at the open" edge). Runs
// often and costs almost nothing; the expensive discovery scan stays on its slower schedule.
const WATCH = process.argv.includes("--watch");

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
  if (WATCH) {
    // Cheap path: re-use the picks we already wrote down and re-check them against Kalshi. No
    // new video scan, no Gemini extraction — the market may have opened since last run, and this
    // is how we pounce on it fast without paying the full-scan cost. Shares the same ledger.
    const ledgerMap = ledger.load();
    const c = ledger.counts(ledgerMap);
    console.log(`[watch] re-checking ${c.waiting} waiting + ${c.live} live pick(s) against Kalshi (no scan)`);
    const fresh = ledger.active(ledgerMap).map((e) => ({
      source: e.source, domain: e.domain, pick: e.pick, opponent: e.opponent,
      timestamp: e.pickTime, quote: e.quote, url: e.url, _key: e.key,
    }));
    const history = readJson(paths.predictions, []);
    const resolved = history.filter((p) => p.result === 0 || p.result === 1);
    return { resolved, fresh, ledgerMap };
  }
  // LIVE: fresh prediction VIDEOS (high yield) + recent tweets -> picks
  const { pullTwitter } = require("./lib/sources");
  const { findVideos } = require("./lib/youtube");
  const { getTranscript } = require("./lib/blotato");
  const { extractPredictions, extractFromTranscript, promptFingerprint } = require("./lib/extractor");
  const picksCache = require("./lib/picks-cache");
  const FP = promptFingerprint();
  // SPORT GATE: only scan sources whose domain is enabled in config.sports (default UFC/MMA only).
  const sports = cfg.sports || ["mma", "boxing"];
  const all = (readJson(paths.sources, { sources: [] }).sources || [])
    .filter((s) => s.handle && sports.includes(s.domain));
  const preds = [];

  // last 10 days of prediction videos (covers the upcoming card's fight week)
  const sinceIso = new Date(Date.now() - 10 * 86400000).toISOString();
  const yt = all.filter((s) => s.platform === "youtube");
  console.log(`[live] scanning ${yt.length} channels for new prediction videos since ${sinceIso.slice(0, 10)}...`);
  const videos = await findVideos(yt, sinceIso, (m) => console.log(m));
  let reused = 0, extracted = 0, extractFailed = 0, transcriptFailed = 0;
  for (const v of videos) {
    // A video's transcript never changes, so its picks never change. Re-running Gemini over
    // the same 163 cached videos 6x/day was ~1,000 redundant extractions (~$4/day) to
    // re-derive picks we already had. Extract once, reuse forever.
    const hit = picksCache.get(v.url, FP);
    if (hit) { preds.push(...hit); reused++; continue; }

    // A transcript FAILURE is not "no transcript": count it so discovery health can distinguish
    // "nothing new" from "the fetcher is failing". Uncached -> retried next run either way.
    const t = await getTranscript(v.url).catch(() => { transcriptFailed++; return {}; });
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
    (extractFailed ? `, ${extractFailed} EXTRACT-FAILED (uncached, will retry)` : "") +
    (transcriptFailed ? `, ${transcriptFailed} TRANSCRIPT-FAILED (will retry)` : ""));
  // Discovery health receipt: actual counts with a real timestamp, so the health view can tell
  // "nothing new" from "the discovery/transcript path is failing". Never fatal.
  try {
    writeJson(require("path").join(paths.data, "discovery-status.json"), {
      schemaVersion: 1, at: new Date().toISOString(), channelsScanned: yt.length,
      videosFound: videos.length, reusedFromCache: reused, newlyExtracted: extracted,
      extractFailed, transcriptFailed,
    });
  } catch (_) {}

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
  console.log(`[live] ${preds.length} picks from this scan`);

  // WRITE THEM DOWN. Every pick from this scan goes into the persistent ledger (new ones added,
  // existing ones refreshed). The ledger — not the 10-day scan — is then the source of truth for
  // what we are watching. A pick stays on it from the moment it is spoken until its fight
  // resolves, so a call made weeks before Kalshi opens the market is no longer lost after 10 days.
  const ledgerMap = ledger.load();
  for (const p of preds) if (p.result == null) ledger.upsert(ledgerMap, p);
  const c = ledger.counts(ledgerMap);
  console.log(`[ledger] ${c.waiting} waiting for a market, ${c.live} live, ${c.settled} settled`);

  // `fresh` is now the ACTIVE ledger (waiting + live), not the raw scan. This is what removes
  // both the loss (picks persist past 10 days) and the waste (settled fights drop off and are
  // never re-matched again). Each active pick carries its ledger key so run() can update status.
  const fresh = ledger.active(ledgerMap).map((e) => ({
    source: e.source, domain: e.domain, pick: e.pick, opponent: e.opponent,
    timestamp: e.pickTime, quote: e.quote, url: e.url, _key: e.key,
  }));

  const history = readJson(paths.predictions, []);
  const resolved = history.filter((p) => p.result === 0 || p.result === 1);
  return { resolved, fresh, ledgerMap };
}

// Resolve finished PAPER positions from Kalshi. For a fighter's YES market, result "yes" = that
// fighter won. Unreadable or not-yet-settled markets are LEFT OPEN and retried — never guessed
// (guessing an outcome is exactly the confident-wrong-number this project forbids).
async function settlePositions(posState) {
  let settled = 0;
  // settleable, not open: a quarantined position's outcome is still recorded (inside its quarantine
  // block, for history) — it just never reaches the P&L. See lib/positions.js settle().
  for (const p of positions.settleablePositions(posState)) {
    if (!p.fightDate || Date.parse(p.fightDate) > Date.now()) continue; // fight not over yet
    try {
      const s = await k.settlement(p.ticker);
      const st = String(s.status || "").toLowerCase();
      const res = String(s.result || "").toLowerCase();
      if (res === "yes" || res === "no") {
        positions.settle(posState, p.ticker, res === "yes" ? 1 : 0, res === "yes" ? 1 : 0, `kalshi ${st || "settled"}`);
        settled++;
      } else if ((st === "settled" || st === "finalized") && (res === "" || res === "void" || res === "voided")) {
        positions.settle(posState, p.ticker, null, null, "void/cancelled");
        settled++;
      }
      // otherwise still active/closed-but-unsettled -> leave open, retry next run
    } catch (_) { /* transient read failure -> leave open, retry next run */ }
  }
  return settled;
}

// buildAlert() — the V1 "🥊 BUY" message builder — was DELETED in the arming consolidation. V1 no
// longer constructs a buy instruction at all; that is the structural guarantee behind "no rejected V1
// betting alert can reach Telegram". Betting messages are built only by lib/telegram-messages.js on the
// unified V2 path.

// The once-a-day paper scoreboard: what STARTED (bought, not ended) and what ENDED (with paper
// P&L + 🟢/🔴). Everything here is explicitly paper — the bot alerts, it does not trade.
function buildSummary(posState) {
  const cents = (v) => Math.round(v * 100);
  const opened = positions.newlyOpened(posState);
  const settled = positions.newlySettled(posState);
  const L = [`📊 Sharp Signals — daily paper summary (${new Date().toISOString().slice(0, 10)})`, ``];

  L.push(`🆕 Started (${opened.length}) — bought, not yet ended:`);
  if (!opened.length) L.push(`   nothing new`);
  for (const p of opened)
    L.push(`   • ${p.fighter} vs ${p.opponent || "?"} — ${cents(p.entryCost)}c, stake ${p.stakePct}%  [${(p.sources || []).join(", ")}]`);
  L.push(``);

  L.push(`🏁 Ended (${settled.length}):`);
  if (!settled.length) L.push(`   nothing settled`);
  let net = 0, haveMoney = false;
  for (const p of settled) {
    if (p.result == null) { L.push(`   ◻️ ${p.fighter} — void/cancelled`); continue; }
    const d = positions.pnlDollars(p, BANKROLL);
    const emoji = p.result === 1 ? "🟢" : "🔴";
    let money;
    if (d != null) { money = `${d >= 0 ? "+" : "-"}$${Math.abs(d)} paper`; net += d; haveMoney = true; }
    else money = `${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct}% paper`;
    L.push(`   ${emoji} ${p.fighter} — ${p.result === 1 ? "WON" : "lost"}, ${money}`);
  }
  if (haveMoney) L.push(``, `Net today: ${net >= 0 ? "+" : "-"}$${Math.abs(+net.toFixed(2))} paper`);
  L.push(``, `Paper only — the bot alerts, it doesn't trade. This is "if you'd taken each call as given."`);
  return { text: L.join("\n"), opened, settled };
}

async function run() {
  const cfg = readJson(paths.config, {});
  const caps = capabilities();
  banner(caps);

  const { resolved, fresh, ledgerMap } = await getPredictions(cfg);
  // The paper-trade book (null in --mock so the self-test never writes the real file).
  const posState = MOCK ? null : positions.load();

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

  // FRESHNESS. A pick is only as good as the information behind it. A call made weeks ago, never
  // re-confirmed, was made WITHOUT news that has since moved the market — a torn ligament, a
  // weight miss, a pulled fighter. That is worse than "less reliable": the stale view now
  // disagrees with an informed market, and the system reads that disagreement as a big EDGE when
  // it is really just the pundit not knowing what the market knows. So a pick older than this
  // stays on the watch list (we don't lose it) but does not fire a money-alert unless it was made
  // recently. Default 21 days; tune with config.freshness.staleAfterDays or STALE_AFTER_DAYS.
  const STALE_AFTER_DAYS = Number(
    (cfg.freshness && cfg.freshness.staleAfterDays) ?? process.env.STALE_AFTER_DAYS ?? 21);
  // A refusal reason is PERMANENT (the pick text is ambiguous, or the fight is over — settle it,
  // stop watching) or TRANSIENT (no market open yet, or below the volume floor for now — keep
  // waiting, re-check next hour). Only permanent reasons take a pick off the watch list.
  // A refusal is PERMANENT only if it is intrinsic to the pick text or the fight (over, hindsight,
  // names both fighters). `surname` and `equally` are NOT here on purpose: they depend on which
  // markets happen to be open right now (a same-surname decoy card, or an equally-scoring rival
  // card), so they are transient — the pick's real market may simply not be listed yet. Settling
  // on them would permanently drop a recoverable early call once the decoy card closes.
  const isPermanent = (reason) => /past|today|hindsight|postdates|both fighters|cannot read/i.test(reason || "");

  for (const f of fresh) {
    const e = f._key ? ledgerMap[f._key] : null;

    // Fetch the board FIRST and separately, so we can tell a transient Kalshi problem (empty or
    // failed board — never a reason to settle anything) from "this one fight's market is gone".
    let boardOk = false, mkt = null, threw = false;
    try {
      const board = await match.marketsFor(f.domain);
      boardOk = Array.isArray(board) && board.length > 0;
      mkt = await match.matchToMarket(f, { cfg });
    } catch (_) { threw = true; }

    // No candidate for this fight.
    if (!mkt) {
      // Only touch a LIVE pick, and only when the board was actually readable and non-empty. An
      // empty/failed board (or a throw) is a transient Kalshi hiccup, NOT "the fight is over" —
      // settling on it would silently discard the entire live watch list on one blip (finding #2).
      if (!threw && boardOk && e && e.status === "live") {
        // Its market is genuinely gone. If the fight date has passed, it's over -> settle. A
        // network blip cannot move e.fightDate, so gating on it is safe. Otherwise the market was
        // PULLED while the fight is still ahead (a postponement re-lists under a new ticker/date):
        // revert to waiting so the re-listed market can re-match, instead of settling it forever.
        const over = e.fightDate && Date.parse(e.fightDate) <= Date.now();
        if (over) ledger.settle(ledgerMap, f._key, "market closed (fight over)");
        else { e.status = "waiting"; e.ticker = null; e.fightDate = null; }
      }
      continue;
    }

    if (mkt.ok === false) {
      refused.push(`${f.source}: ${mkt.reason}`);
      // Only settle on a refusal for a pick that is already LIVE (its real fight was identified
      // before). For a WAITING pick a refusal is board-relative — a surname/ambiguity collision
      // with an unrelated open fight whose true market is not listed yet — so settling would
      // permanently drop a recoverable early call (findings #5, #9). Waiting picks are retired
      // only by the WAITING_EXPIRE timeout.
      if (e && e.status === "live" && isPermanent(mkt.reason)) ledger.settle(ledgerMap, f._key, mkt.reason);
      continue;
    }

    // BELT AND BRACES. The market we are about to price must BE the fighter who was picked.
    // The old matcher could return the right fight and the wrong side; nothing ever checked.
    if (match.nameScore(f.pick, mkt.fighter) < 1) {
      refused.push(`${f.source}: matched ${mkt.fighter} but the pick was "${f.pick}" — REFUSED`);
      if (e && e.status === "live") ledger.settle(ledgerMap, f._key, "name mismatch");
      continue;
    }

    // Matched a real, future fight: mark it live on the ledger (waiting -> live).
    if (f._key) ledger.setMatched(ledgerMap, f._key, mkt.ticker, mkt.fightDate);

    // The price is what you PAY: the ask. A one-sided book (no offers to lift) is not a
    // tradeable market — a lone stale bid would otherwise read as a huge edge.
    const cost = mkt.yesAsk;
    if (!(cost > 0 && cost < 1)) { refused.push(`${f.source}: ${mkt.fighter} has no offers to buy`); continue; }

    const g = graded[f.source] || {};
    // How old is the view we'd be betting on? Age is measured from the pick (video publish) time
    // to now, because "now" is what the market price already reflects — an old pick has had that
    // many days for news to arrive that the pundit never saw.
    const pickAgeDays = f.timestamp
      ? Math.round((Date.now() - Date.parse(f.timestamp)) / 86400000) : null;
    signals.push({
      source: f.source, trusted: !!g.trusted, domain: f.domain,
      survives: !!g.survives,           // OUT-OF-SAMPLE: edge held on held-out fights (the honest gate)
      isFighter: g.type === "fighter",  // an active fighter previewing (often) their own team — confounded
      oosRoiLcb: g.oos ? g.oos.testRoiLcb : null,
      pick: f.pick, fighter: mkt.fighter, opponent: mkt.opponent,
      market: mkt.matchTitle, ticker: mkt.ticker, fightDate: mkt.fightDate,
      cost,                             // the ask — what you actually pay
      mid: mkt.price, yesBid: mkt.yesBid,
      sourceRoi: g.shrunkRoi ?? null,   // the trust decision's number
      sourceRoiLcb: g.roiLcb ?? null,   // the DEFENSIBLE in-sample edge
      n: g.n || 0,
      pickAgeDays,                      // days from the pick to now
      stale: pickAgeDays != null && pickAgeDays > STALE_AFTER_DAYS,
      quote: f.quote || "",
    });
  }
  signals.sort((a, b) => (b.survives - a.survives) || (b.trusted - a.trusted) || ((b.sourceRoiLcb || -9) - (a.sourceRoiLcb || -9)));
  // NEVER let the mock self-test publish. `node pipeline.js --mock` is documented at the top of this
  // file as a safe no-keys self-test, but it runs on SAMPLE sources (Daniel Cormier, Chael Sonnen…)
  // and this line wrote them straight over the real board — silently replacing a live 147-signal
  // file with 3 fakes. It is the same silent-clobber the ledger is guarded against below, which
  // signals.json never got. Mock proves the logic; it does not get to write real data.
  if (!MOCK) writeJson(paths.signals, signals);

  // Persist the watch list: statuses updated above, old settled entries pruned, expired
  // never-opened picks retired. This is the "write it down" — next hour resumes from here
  // instead of re-deriving everything from a fresh video scan.
  // Guarded: in --mock mode getPredictions returns no ledgerMap. Skipping here (rather than
  // defaulting to {}) both avoids the crash AND protects the committed ledger — save({}) would
  // otherwise overwrite the real file with an empty map every time the mock self-test runs.
  if (ledgerMap) {
    ledger.prune(ledgerMap);
    ledger.save(ledgerMap);
    const lc = ledger.counts(ledgerMap);
    console.log(`[ledger] after matching: ${lc.waiting} waiting, ${lc.live} live, ${lc.settled} settled`);
  }
  alertLedger.pruneOld(45); // keep alerts_sent.json from growing forever (finding #15)

  if (refused.length) {
    console.log(`\nREFUSED ${refused.length} pick(s) rather than guess:`);
    for (const r of refused.slice(0, 20)) console.log(`  - ${r}`);
  }

  // A signal now requires: the source's edge SURVIVED out of sample (not just in-sample "trusted"),
  // the source is NOT an active fighter previewing their own team (confounded, not market-beating),
  // AND a FRESH view (see STALE_AFTER_DAYS above). The 24-month backfill proved in-sample "trusted"
  // is indistinguishable from luck, so it is no longer sufficient. Gemini's confidence is not used.
  const qualifying = signals.filter((s) => s.survives && !s.isFighter && (s.sourceRoiLcb || 0) > 0);
  const staleHeld = qualifying.filter((s) => s.stale);
  const trusted = qualifying.filter((s) => !s.stale);
  if (staleHeld.length) {
    // Never drop silently. These stay on the watch list; they just don't fire a bet on a view
    // that predates news the market has since absorbed.
    console.log(`\n[freshness] ${staleHeld.length} trusted signal(s) HELD BACK as stale ` +
      `(pick older than ${STALE_AFTER_DAYS}d — not alerted, still watched):`);
    for (const s of staleHeld) console.log(`  - ${s.fighter} [${s.source}, pick ${s.pickAgeDays}d old]`);
  }
  console.log("\nLIVE SIGNALS (edge SURVIVED out-of-sample, non-fighter source, fresh view):");
  if (!trusted.length) console.log("  (none)");
  for (const s of trusted)
    console.log(`  ${s.fighter} vs ${s.opponent} — costs ${Math.round(s.cost * 100)}c` +
      `  [${s.source}: n=${s.n}, edge ${s.sourceRoi} (lower bound ${s.sourceRoiLcb})]  ${s.fightDate}`);
  console.log(`\nwrote ${paths.signals}`);

  // ---- BETS: size, record as PAPER positions, and (if armed) alert ----------------------
  // One bet per market from the qualifying signals. We size it and record a PAPER position for it
  // whether or not alerts are armed — that paper record is the honest out-of-sample scoreboard
  // (lib/positions.js). V1 never tells a human to bet — it only records paper positions for research.
  const cents = (v) => Math.round(v * 100);
  const byTicker = {};
  for (const s of trusted) (byTicker[s.ticker] = byTicker[s.ticker] || []).push(s);

  const bets = [];
  for (const [ticker, all] of Object.entries(byTicker)) {
    // DEDUPE BY SOURCE: one channel's "Preview" + "Best Bets" videos are ONE opinion, not two.
    const bySource = new Map();
    for (const s of all) if (!bySource.has(s.source)) bySource.set(s.source, s);
    const group = Array.from(bySource.values());
    const s0 = group[0];
    const size = sizeBet(
      group.map((s) => ({ source: s.source, roiLcb: s.sourceRoiLcb, shrunkRoi: s.sourceRoi, n: s.n })),
      s0.cost);
    if (size.skip) { console.log(`  (skipping ${s0.fighter}: ${size.reason})`); continue; }
    bets.push({ ticker, group, s0, size });

    if (posState) {
      const opened = positions.recordOpen(posState, {
        ticker, fighter: s0.fighter, opponent: s0.opponent, domain: s0.domain,
        fightDate: s0.fightDate, entryCost: s0.cost, fairValueCents: size.p,
        stakePct: size.pct, sources: group.map((s) => s.source),
        // Provenance: which rules admitted this. V1 has no sealed forecast/decision, so those are
        // null; what it does have is the gate that let the signal through.
        rulesVersion: GATE_VERSION, pipeline: "v1-signals",
        gateResult: { survives: s0.survives, isFighter: s0.isFighter, sourceRoiLcb: s0.sourceRoiLcb },
      });
      if (opened === "opened") console.log(`  [paper] opened ${s0.fighter} @ ${cents(s0.cost)}c, stake ${size.pct}%`);
      else if (opened === "reactivated") console.log(`  [paper] reactivated ${s0.fighter} — qualifies again`);
    }
  }

  // VERSION-AWARE RECONCILE. Any position that is ACTIVE but whose ticker did NOT qualify this run no
  // longer clears the current gate — withdraw it, with the reason, rather than letting it sit "open"
  // until it settles into the P&L under rules that would now refuse it. This is the loop whose absence
  // let three repealed positions reach the eve of settlement.
  if (posState) {
    const qualifyingTickers = new Set(bets.map((b) => b.ticker));
    for (const p of positions.activePositions(posState)) {
      if (qualifyingTickers.has(p.ticker)) continue;
      const r = positions.reconcile(posState, p.ticker, {
        eligibleNow: false, rulesVersion: GATE_VERSION,
        reason: "did not clear the current live-signal gate this run",
      });
      if (r === "withdrawn") console.log(`  [paper] withdrew ${p.fighter} — no longer clears the gate`);
    }
  }

  // Resolve any paper positions whose fights have finished (reads Kalshi; unresolved ones stay
  // open and retry). Every run, so the daily summary always has up-to-date outcomes.
  if (posState) {
    const n = await settlePositions(posState);
    if (n) console.log(`  [paper] settled ${n} finished position(s)`);
    positions.prune(posState);
    const pc = positions.counts(posState);
    console.log(`[paper] book: ${pc.active} active, ${pc.withdrawn} withdrawn, ${pc.settled} settled, ${pc.quarantined} quarantined`);
  }

  // ---- V1 SENDS NO BUY ALERT ------------------------------------------------------------
  // The paper positions above are recorded for research only. There is deliberately no code here that
  // turns a V1 signal into a Telegram buy instruction — betting decisions run exclusively through the
  // unified V2 path. `bets` exists solely to drive recordOpen and the reconcile above.
  console.log(`\n[V1] ${bets.length} paper position(s) recorded for research. V1 sends no buy alerts.`);

  // ---- DAILY PAPER SUMMARY: one research message a day — Bought + Ended with paper P&L ---------
  // Not in --watch (that runs many times a day) and not in --mock. Once per calendar day in the
  // midday window, guarded by meta.lastSummaryDate so it can't double-send. This is NOT a betting
  // instruction — it reports paper results — so it is not gated by the arming mechanism.
  // ONE canonical Telegram path: the unified V2 lifecycle. This V1 archived-research paper summary is a
  // SECOND path, so it is OFF by default — opt in with V1_PAPER_SUMMARY=1 for a research digest. The
  // paper positions are still RECORDED for the dashboard's archived-research view; they just don't
  // interrupt the phone beside the production alerts. Reversible.
  if (posState && !WATCH && process.env.V1_PAPER_SUMMARY === "1") {
    const hour = new Date().getUTCHours();
    const today = new Date().toISOString().slice(0, 10);
    const due = process.env.FORCE_HEARTBEAT === "1" || (hour >= 12 && hour < 16);
    if (due && posState.meta.lastSummaryDate !== today) {
      const sum = buildSummary(posState);
      const status = `📎 V1 ARCHIVED RESEARCH — PAPER ONLY · DO NOT PLACE. Research tracking only, $0 real money, excluded from your real bankroll P&L. Every betting decision runs through the unified V2 path.`;
      await notify(`${sum.text}\n\n${status}`).catch(() => {});
      positions.markSummarized(posState, sum.opened.map((p) => p.ticker), "open");
      positions.markSummarized(posState, sum.settled.map((p) => p.ticker), "settled");
      posState.meta.lastSummaryDate = today;
    }
  }

  if (posState) positions.save(posState); // one atomic write after all mutations
}

run().catch(async (e) => {
  console.error("pipeline error:", e.message);
  await notify(`⚠️ Sharp Signals pipeline FAILED: ${e.message}`).catch(() => {});
  process.exit(1);
});
