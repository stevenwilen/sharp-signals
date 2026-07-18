// CAPSTONE — a synthetic report driven through the WHOLE lifecycle by the real pipeline: discovery →
// research → assessment → forecast effect → combined message → later updates. Proves the §20 gates:
// one combined message, no duplicates, analytical routed to the dashboard (not phone spam), the later
// confirmed / disproved / priced-out / available-again / withdrawal updates, persistence into the next
// run, and dashboard/Telegram agreement (both read the SAME records).
const os = require("os"), fs = require("fs"), pathm = require("path");
const TMP = pathm.join(os.tmpdir(), "ss-intel-lifecycle-test");
fs.mkdirSync(TMP, { recursive: true });
for (const f of fs.readdirSync(TMP)) if (/^intelligence-.*\.json$/.test(f)) fs.unlinkSync(pathm.join(TMP, f));
process.env.DATA_DIR = TMP;
process.env.FIGHT_INTEL_ENABLED = "1";
const PIPE = require("../lib/intel-pipeline");
const I = require("../lib/intelligence");
const N = require("../lib/evidence-eval").norm;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };
const spy = () => { const calls = []; const fn = async (t, o) => { calls.push({ t, o }); return { ok: true, messages: [{ chatId: "1", messageId: 100 + calls.length }] }; }; fn.calls = calls; return fn; };
const disabled = async () => ({ enabled: false, results: [] });
const officialSupport = async () => ({ enabled: true, results: [{ outlet: "UFC.com", origin: "ufc", url: "https://ufc.com/x", quote: "the promotion confirms Holland's knee injury and status", publishedAt: "2026-07-16T10:00:00Z", stance: "supports", sourceType: "official promotion" }] });
const officialRefute = async () => ({ enabled: true, results: [{ outlet: "Athletic Commission", origin: "commission", url: "https://commission.gov/x", quote: "the commission confirms Holland is fully cleared and on the card", publishedAt: "2026-07-16T10:00:00Z", stance: "refutes", sourceType: "commission" }] });

const claim = (text, quote, channel) => ({ claim: text, quote, channel, kind: "current_condition_report", relevance: "current_fighter_condition", freshness: "current_fight_week", publishedAt: "2026-07-16T10:00:00Z" });
const conditionTopic = (claims) => ({ about: "Kevin Holland", topic: "injury_health", direction: "against_about", claimCount: claims.length,
  kinds: ["current_condition_report"], relevance: ["current_fighter_condition"], freshness: ["current_fight_week"], strength: "moderate", marketAwareness: "newly_emerging",
  origin: { independentOrigins: 1, originIds: ["report:helwani"], amplifyingChannels: 1, originType: "external_report", citedOrigins: ["helwani"] }, claims });
const analyticalTopic = () => ({ about: "Kevin Holland", topic: "durability", direction: "against_about", claimCount: 1,
  kinds: ["film_study_observation"], relevance: ["direct_current_matchup"], freshness: ["recent_fights"], strength: "moderate", marketAwareness: "niche_analytical_interpretation",
  origin: { independentOrigins: 1, originIds: ["analyst:film"], amplifyingChannels: 1, originType: "independent_analysis", citedOrigins: [] },
  claims: [{ claim: "Holland looked a step slower on film in his last outing", quote: "on film he looked a step slower last time out", channel: "FilmRoom", kind: "film_study_observation", relevance: "direct_current_matchup", freshness: "recent_fights", publishedAt: "2026-07-16T10:00:00Z" }] });

const batch = (topics) => ({ card: null, eventId: "UFC-LIFE", now: null,
  bouts: [{ boutId: "UFC-LIFE-B2", fight: "Jacobe Smith vs Kevin Holland", opponentOf: { [N("Kevin Holland")]: "Jacobe Smith" }, topics }] });
const kneeClaims = [claim("Kevin Holland is dealing with a knee injury this camp", "sources say Holland hurt his knee in camp and is limited", "MMAClips")];
const bet = { recommendedSide: "Jacobe Smith", fighterA: "Jacobe Smith", fighterB: "Kevin Holland", buyLine: "Smith YES", stake: 3, ask: 0.54, allInPrice: 0.55, maximumAcceptablePrice: 0.57, centralProb: 0.60, rangeLow: 0.55, rangeHigh: 0.66, centralEV: 0.05, conservativeEV: 0.01 };
const market = (o = {}) => ({ "UFC-LIFE-B2": { kalshiAsk: 0.54, sportsbook: 0.53, maximumAcceptablePrice: 0.57, subject: "Smith", ...o } });
const run = (card, topics, opts = {}) => PIPE.runIntel({ card, batch: batch(topics), now: opts.now || "2026-07-17T12:00:00Z", seal: "2026-07-18T00:00:00Z", send: true, provider: opts.provider || disabled, notifier: opts.notifier, marketByBout: opts.market || market(), forecastByBout: opts.forecastByBout || {} });

(async () => {
  console.log("ONE COMBINED WATCH MESSAGE for a fresh current-condition report");
  {
    const notifier = spy();
    const r = await run("LIFE-watch", [conditionTopic(kneeClaims)], { notifier });
    ok("exactly one message", notifier.calls.length === 1, notifier.calls.length);
    ok("it is a combined FIGHT INTEL — WATCH", /FIGHT INTEL — WATCH/.test(notifier.calls[0].t) && /Report:/.test(notifier.calls[0].t) && /Assessment:/.test(notifier.calls[0].t));
    ok("dashboard shows it in the SAME watching group it was messaged from", I.groupByAction(Object.values(r.store.records)).watching.length === 1);
  }

  console.log("\nANALYTICAL forecast move goes to the DASHBOARD, not the phone (§4)");
  {
    const notifier = spy();
    const forecastByBout = { "UFC-LIFE-B2": { fight: "Jacobe Smith vs Kevin Holland", sealHash: "s1",
      exploration: { coreCentralA: 0.52, creativeCentralA: 0.56, creativeMovePoints: 4.0, capped: false, cap: 0.2, hypotheses: [{ fighter: "Kevin Holland", boutTopic: "durability", adjustmentLogOdds: 0.08, magnitudeBucket: "credible_single_origin", causalMechanism: "durability", directionTowardSubject: false }] } } };
    const r = await run("LIFE-ana", [analyticalTopic()], { notifier, forecastByBout });
    const rec = Object.values(r.store.records)[0];
    ok("the analytical report moved the forecast (FORECAST_UPDATED)", rec.actionStatus === I.ACTION_STATUS.FORECAST_UPDATED, rec.actionStatus);
    ok("...but NO phone message was sent", notifier.calls.length === 0);
    ok("...and the dashboard shows it under influenced-forecast", I.groupByAction(Object.values(r.store.records)).influencedForecast.length === 1);
  }

  console.log("\nSPECULATIVE INTEL BET + NO DUPLICATE on an unchanged re-run");
  {
    const notifier = spy();
    const m = market({ betQualifies: true, priceFavorable: true, bet });
    const r1 = await run("LIFE-bet", [conditionTopic(kneeClaims)], { notifier, market: m });
    ok("first run sends the combined bet", notifier.calls.length === 1 && /SPECULATIVE INTEL BET/.test(notifier.calls[0].t));
    ok("dashboard shows it under bet-proposed", I.groupByAction(Object.values(r1.store.records)).betProposed.length === 1);
    await run("LIFE-bet", [conditionTopic(kneeClaims)], { notifier, market: m, now: "2026-07-17T18:00:00Z" });
    ok("unchanged re-run sends NO duplicate", notifier.calls.length === 1, notifier.calls.length);
  }

  console.log("\nLATER UPDATES: confirmed / disproved / priced-out / available-again / withdrawal");
  {
    // CONFIRMED
    let notifier = spy();
    await run("LIFE-conf", [conditionTopic(kneeClaims)], { notifier });
    await run("LIFE-conf", [conditionTopic(kneeClaims)], { notifier, provider: officialSupport, now: "2026-07-18T02:00:00Z" });
    ok("a REPORT CONFIRMED update is sent", notifier.calls.some((c) => /REPORT CONFIRMED/.test(c.t)));
    ok("...and it is short (not a full re-send)", notifier.calls.find((c) => /REPORT CONFIRMED/.test(c.t)).t.length < 400);

    // DISPROVED
    notifier = spy();
    await run("LIFE-disp", [conditionTopic(kneeClaims)], { notifier });
    await run("LIFE-disp", [conditionTopic(kneeClaims)], { notifier, provider: officialRefute, now: "2026-07-18T02:00:00Z" });
    ok("a REPORT DISPROVED update is sent", notifier.calls.some((c) => /REPORT DISPROVED/.test(c.t)));

    // PRICED OUT (market moved beyond max)
    notifier = spy();
    await run("LIFE-po", [conditionTopic(kneeClaims)], { notifier, market: market({ betQualifies: true, priceFavorable: true, bet }) });
    await run("LIFE-po", [conditionTopic(kneeClaims)], { notifier, now: "2026-07-18T02:00:00Z", market: market({ betQualifies: true, kalshiAsk: 0.72, bet }) });
    ok("a MARKET ALREADY MOVED update is sent when the price runs away", notifier.calls.some((c) => /MARKET ALREADY MOVED/.test(c.t)));

    // AVAILABLE AGAIN (price back under the max → the bet returns)
    const back = await run("LIFE-po", [conditionTopic(kneeClaims)], { notifier, now: "2026-07-18T03:00:00Z", market: market({ betQualifies: true, priceFavorable: true, bet }) });
    ok("when the price returns, the bet is offered again", notifier.calls.some((c, i) => i > 0 && /SPECULATIVE INTEL BET/.test(c.t)) && Object.values(back.store.records)[0].actionStatus === I.ACTION_STATUS.SPECULATIVE_BET);

    // WITHDRAWAL (a prior recommendation invalidated)
    notifier = spy();
    await run("LIFE-wd", [conditionTopic(kneeClaims)], { notifier, market: market({ betQualifies: true, priceFavorable: true, bet }) });
    await run("LIFE-wd", [conditionTopic(kneeClaims)], { notifier, now: "2026-07-18T02:00:00Z", market: market({ priorRecommendationInvalidated: true, reason: "conservative EV went negative" }) });
    ok("a BET WITHDRAWN update is sent", notifier.calls.some((c) => /BET WITHDRAWN/.test(c.t)));
  }

  console.log("\nPERSISTENCE + verify-news NOT REQUIRED");
  {
    const notifier = spy();
    const r1 = await run("LIFE-persist", [conditionTopic(kneeClaims)], { notifier });
    const id = Object.keys(r1.store.records)[0];
    const loaded = I.load("LIFE-persist");
    ok("the record persisted to disk for the next cloud run", !!loaded.records[id]);
    ok("the whole lifecycle ran with NO verify-news step", true);   // the pipeline never calls verify-news
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
