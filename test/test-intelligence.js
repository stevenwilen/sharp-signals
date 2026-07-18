// FIGHT INTELLIGENCE — the lifecycle spine. These tests pin the two rules the module exists to keep:
// (1) origins, not voices — ten channels repeating one report stay ONE origin; (2) a repeat is not a
// new report — the same story re-seen updates the SAME record and never spawns a duplicate. Plus the
// report-type routing (§4), the truth/action classifiers (§3/§5), and cross-run persistence (§15).
const os = require("os"), fs = require("fs"), pathm = require("path");
// Isolate persistence into a scratch dir BEFORE requiring the module (store.js reads DATA_DIR on load).
const TMP = pathm.join(os.tmpdir(), "ss-intel-test");
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;
const I = require("../lib/intelligence");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

// An evaluated-topic fixture in the exact shape lib/bout-evidence.topicsFor() produces. Default = a
// credible, access-relevant, single-origin current-condition report (the WATCH baseline).
const topic = (o = {}) => ({
  about: "Kevin Holland", topic: "injury_health", direction: "against_about",
  claimCount: 1, kinds: ["current_condition_report"], relevance: ["current_fighter_condition"],
  freshness: ["current_fight_week"], strength: "moderate", marketAwareness: "newly_emerging",
  origin: { independentOrigins: 1, originIds: ["report:helwani"], amplifyingChannels: 1, originType: "external_report", citedOrigins: ["helwani"] },
  claims: [{ claim: "Kevin Holland is dealing with a knee injury this camp and may be limited", quote: "my sources say Holland hurt his knee in camp and it is limiting his training badly", channel: "MMAFightingClips", publishedAt: "2026-07-16T10:00:00Z" }],
  ...o,
});

const NOW = "2026-07-17T12:00:00Z";
const batch = (topics, extra = {}) => ({
  card: "TEST-2026-07-18", eventId: "UFC-TEST", now: NOW,
  bouts: [{ boutId: "UFC-TEST-B4", fight: "Jacobe Smith vs Kevin Holland", opponentOf: { [require("../lib/evidence-eval").norm("Kevin Holland")]: "Jacobe Smith" }, topics, ...extra }],
});
const one = (store, topics, extra) => I.ingest(store, batch(topics, extra));
const fresh = () => ({ card: "TEST-2026-07-18", updatedAt: null, records: {} });

console.log("ORIGINS, NOT VOICES — ten amplifiers are still one origin");
{
  // 10 distinct channels, but the counter (upstream) says ONE origin. The record must echo the counter.
  const chans = Array.from({ length: 10 }, (_, i) => ({ claim: "Holland is hurt", quote: "Holland reportedly hurt his knee in camp per one report going around", channel: `Channel${i}`, publishedAt: "2026-07-16T10:00:00Z" }));
  const r = one(fresh(), [topic({ origin: { independentOrigins: 1, originIds: ["report:helwani"], amplifyingChannels: 10, originType: "external_report", citedOrigins: ["helwani"] }, claims: chans })]).results[0].record;
  ok("independentOrigins stays 1 despite 10 channels", r.independentOrigins === 1, r.independentOrigins);
  ok("amplifierCount reflects the 10 megaphones", r.amplifierCount === 10, r.amplifierCount);
  ok("the record does not treat repetition as corroboration", r.factors.corroborated === false);
}

console.log("\nTWO GENUINELY INDEPENDENT ORIGINS are counted as two");
{
  const r = one(fresh(), [topic({ origin: { independentOrigins: 2, originIds: ["report:helwani", "report:okamoto"], amplifyingChannels: 4, originType: "external_report", citedOrigins: ["helwani", "okamoto"] } })]).results[0].record;
  ok("independentOrigins is 2", r.independentOrigins === 2, r.independentOrigins);
  ok("corroborated is true at 2 origins", r.factors.corroborated === true);
}

console.log("\nONE ACCESS-RELEVANT ORIGIN can matter (PLAUSIBLE, not dismissed)");
{
  const r = one(fresh(), [topic()]).results[0].record;
  ok("access relevance is firsthand", r.accessRelevance === I.ACCESS.FIRSTHAND, r.accessRelevance);
  ok("status is PLAUSIBLE on one access-relevant origin", r.truthStatus === I.TRUTH_STATUS.PLAUSIBLE, r.truthStatus);
  ok("action is WATCH with no bet context", r.actionStatus === I.ACTION_STATUS.WATCH, r.actionStatus);
  // Contrast: one UNRELATED analyst on the same claim is weaker and does not become WATCH-worthy news.
  const analyst = one(fresh(), [topic({ kinds: ["unsupported_narrative"], origin: { independentOrigins: 1, originIds: ["analyst:somepod"], amplifyingChannels: 1, originType: "independent_analysis", citedOrigins: [] }, claims: [{ claim: "Holland just seems off to me", quote: "he just seems off, I don't like his energy", channel: "SomePod", publishedAt: "2026-07-16T10:00:00Z" }] })]).results[0].record;
  ok("a lone unrelated pundit is NOT urgent news", analyst.actionStatus !== I.ACTION_STATUS.WATCH && analyst.actionStatus !== I.ACTION_STATUS.SPECULATIVE_BET, analyst.actionStatus);
}

console.log("\nREPORT-TYPE ROUTING (§4)");
{
  const ev = one(fresh(), [topic({ claims: [{ claim: "Kevin Holland has withdrawn from the card due to a knee injury", quote: "Holland is OUT, he pulled out of the fight this morning", channel: "MMAFighting", publishedAt: "2026-07-16T10:00:00Z" }] })]).results[0].record;
  ok("withdrawal → EVENT_STATUS", ev.reportType === I.REPORT_TYPE.EVENT_STATUS, ev.reportType);

  const cond = one(fresh(), [topic()]).results[0].record;
  ok("injury-in-camp (fight still on) → CURRENT_CONDITION", cond.reportType === I.REPORT_TYPE.CURRENT_CONDITION, cond.reportType);

  const anaTopic = topic({ topic: "durability", kinds: ["film_study_observation"], relevance: ["direct_current_matchup"], marketAwareness: "niche_analytical_interpretation",
    origin: { independentOrigins: 1, originIds: ["analyst:filmroom"], amplifyingChannels: 1, originType: "independent_analysis", citedOrigins: [] },
    claims: [{ claim: "Holland is returning too soon after his knockout and looked a step slower last time out", quote: "coming back this fast after that KO, he looked slower on film", channel: "FilmRoom", publishedAt: "2026-07-16T10:00:00Z" }] });
  const ana = one(fresh(), [anaTopic]).results[0].record;
  ok("film-study inference → ANALYTICAL", ana.reportType === I.REPORT_TYPE.ANALYTICAL_HYPOTHESIS, ana.reportType);
  ok("analytical with no forecast move is DASHBOARD_ONLY, NOT urgent news", ana.actionStatus === I.ACTION_STATUS.DASHBOARD_ONLY, ana.actionStatus);
  const anaMoved = one(fresh(), [anaTopic], { actionCtxByKey: { [require("../lib/evidence-eval").norm("Kevin Holland") + "|durability"]: { forecastImpactPoints: 0.03 } } }).results[0].record;
  ok("analytical that moved the forecast → FORECAST_UPDATED", anaMoved.actionStatus === I.ACTION_STATUS.FORECAST_UPDATED, anaMoved.actionStatus);

  const hist = one(fresh(), [topic({ topic: "durability", kinds: ["verified_hard_fact"], relevance: ["stable_historical_tendency"], freshness: ["long_term_tendency"], marketAwareness: "widely_public_probably_in_the_market",
    claims: [{ claim: "Holland has longstanding knee problems dating back years across his career", quote: "his knees have bothered him for years, everyone knows this", channel: "Wiki", publishedAt: "2026-07-16T10:00:00Z" }] })]).results[0].record;
  ok("old general fact → PUBLIC_HISTORY", hist.reportType === I.REPORT_TYPE.PUBLIC_HISTORY, hist.reportType);
  ok("widely-known public history is not a phone alert (IGNORE/DASHBOARD)", [I.ACTION_STATUS.IGNORE, I.ACTION_STATUS.DASHBOARD_ONLY].includes(hist.actionStatus), hist.actionStatus);

  const low = one(fresh(), [topic({ topic: "psychological", kinds: ["unsupported_narrative"], relevance: ["weakly_relevant"], marketAwareness: "unknown",
    claims: [{ claim: "Holland just wants it more", quote: "you can tell he just wants it more", channel: "FanCast", publishedAt: "2026-07-16T10:00:00Z" }] })]).results[0].record;
  ok("vague motivation → LOW_VALUE", low.reportType === I.REPORT_TYPE.LOW_VALUE, low.reportType);
  ok("low-value stays DASHBOARD_ONLY (never a phone alert)", low.actionStatus === I.ACTION_STATUS.DASHBOARD_ONLY, low.actionStatus);
}

console.log("\nACTION CLASSIFICATION (§5) — the state machine");
{
  const KEY = require("../lib/evidence-eval").norm("Kevin Holland") + "|injury_health";
  const withCtx = (ctx, tp = topic()) => one(fresh(), [tp], { actionCtxByKey: { [KEY]: ctx } }).results[0].record.actionStatus;
  ok("bet qualifies at a favorable price → SPECULATIVE_BET", withCtx({ betQualifies: true, priceFavorable: true }) === I.ACTION_STATUS.SPECULATIVE_BET);
  ok("price already gone → MARKET_ALREADY_MOVED (not a buy)", withCtx({ betQualifies: true, priceFavorable: true, marketMovedBeyondMax: true }) === I.ACTION_STATUS.MARKET_ALREADY_MOVED);
  ok("material forecast move, no bet → FORECAST_UPDATED", withCtx({ forecastImpactPoints: 0.04 }) === I.ACTION_STATUS.FORECAST_UPDATED);
  ok("plausible, nothing actionable → WATCH", withCtx({}) === I.ACTION_STATUS.WATCH);
  ok("unreachable material source → HUMAN_ACTION_REQUIRED", withCtx({ unreachable: true }) === I.ACTION_STATUS.HUMAN_ACTION_REQUIRED);
  ok("prior recommendation invalidated → POSITION_WITHDRAWN", withCtx({ priorRecommendationInvalidated: true }) === I.ACTION_STATUS.POSITION_WITHDRAWN);
}

console.log("\nA REPEAT IS NOT A NEW REPORT (no duplicate record; origins do not inflate)");
{
  let s = fresh();
  s = one(s, [topic()]).store;
  const firstCount = Object.keys(s.records).length;
  // Same story, a later run, three MORE channels but still one origin from the counter.
  const later = topic({ origin: { independentOrigins: 1, originIds: ["report:helwani"], amplifyingChannels: 4, originType: "external_report", citedOrigins: ["helwani"] },
    claims: [{ claim: "Holland is hurt", quote: "same knee report is going around again from more clip channels now", channel: "ClipD", publishedAt: "2026-07-16T12:00:00Z" }] });
  const r2 = I.ingest(s, { ...batch([later]), now: "2026-07-17T18:00:00Z" });
  ok("still exactly one record (matched, not duplicated)", Object.keys(r2.store.records).length === firstCount, Object.keys(r2.store.records).length);
  ok("the re-ingest was a match, not a create", r2.results[0].created === false);
  ok("origins did NOT inflate on the repeat", r2.results[0].record.independentOrigins === 1, r2.results[0].record.independentOrigins);
  ok("amplifiers accumulated across runs", r2.results[0].record.amplifierCount >= 2, r2.results[0].record.amplifierCount);
}

console.log("\nboutId RENUMBERING SURVIVAL (match on fighter+topic, not positional id)");
{
  let s = one(fresh(), [topic()]).store;
  const id1 = Object.keys(s.records)[0];
  // Same fighter/topic/direction, but the bout renumbered from B4 to B2 (a bout dropped off the card).
  const r = I.ingest(s, { card: "TEST-2026-07-18", eventId: "UFC-TEST", now: "2026-07-17T20:00:00Z",
    bouts: [{ boutId: "UFC-TEST-B2", fight: "Jacobe Smith vs Kevin Holland", opponentOf: { [require("../lib/evidence-eval").norm("Kevin Holland")]: "Jacobe Smith" }, topics: [topic()] }] });
  ok("same record id despite renumber", Object.keys(r.store.records).length === 1 && r.store.records[id1], id1);
  ok("boutId updated to the current position", r.store.records[id1].boutId === "UFC-TEST-B2", r.store.records[id1].boutId);
}

console.log("\nLIFECYCLE TRANSITIONS on the SAME record (§6C) + persistence (§15)");
{
  const KEY = require("../lib/evidence-eval").norm("Kevin Holland") + "|injury_health";
  // Run 1: WATCH. Persist to disk.
  let s = one(fresh(), [topic()]).store;
  I.save("TEST-2026-07-18", s);
  const id = Object.keys(s.records)[0];
  ok("run 1 → WATCH", s.records[id].actionStatus === I.ACTION_STATUS.WATCH);

  // The NEXT cloud run loads prior state from disk (not memory).
  const loaded = I.load("TEST-2026-07-18");
  ok("state persisted and reloaded", !!loaded.records[id], Object.keys(loaded.records).length);

  // Run 2: same report, now becomes actionable.
  const actionable = I.ingest(loaded, { ...batch([topic()]), now: "2026-07-18T02:00:00Z", bouts: [{ ...batch([topic()]).bouts[0], actionCtxByKey: { [KEY]: { betQualifies: true, priceFavorable: true } } }] });
  ok("WATCH → SPECULATIVE_BET (later became actionable)", actionable.store.records[id].actionStatus === I.ACTION_STATUS.SPECULATIVE_BET, actionable.store.records[id].actionStatus);

  // Run 3: the price runs away.
  const priced = I.ingest(actionable.store, { ...batch([topic()]), now: "2026-07-18T03:00:00Z", bouts: [{ ...batch([topic()]).bouts[0], actionCtxByKey: { [KEY]: { betQualifies: true, priceFavorable: true, marketMovedBeyondMax: true } } }] });
  ok("SPECULATIVE_BET → MARKET_ALREADY_MOVED (priced out)", priced.store.records[id].actionStatus === I.ACTION_STATUS.MARKET_ALREADY_MOVED, priced.store.records[id].actionStatus);

  // Run 4: available again.
  const again = I.ingest(priced.store, { ...batch([topic()]), now: "2026-07-18T04:00:00Z", bouts: [{ ...batch([topic()]).bouts[0], actionCtxByKey: { [KEY]: { betQualifies: true, priceFavorable: true, marketMovedBeyondMax: false } } }] });
  ok("MARKET_ALREADY_MOVED → SPECULATIVE_BET (available again)", again.store.records[id].actionStatus === I.ACTION_STATUS.SPECULATIVE_BET, again.store.records[id].actionStatus);

  // Run 5: officially confirmed → fight suspended, no bet.
  const confirmed = I.ingest(again.store, { ...batch([topic()]), now: "2026-07-18T05:00:00Z", bouts: [{ ...batch([topic()]).bouts[0], confirmedKeys: [KEY] }] });
  ok("→ REPORT_CONFIRMED", confirmed.store.records[id].actionStatus === I.ACTION_STATUS.REPORT_CONFIRMED, confirmed.store.records[id].actionStatus);
  ok("truth status is CONFIRMED", confirmed.store.records[id].truthStatus === I.TRUTH_STATUS.CONFIRMED);

  // A parallel record that gets DISPROVED instead.
  const disp = I.ingest(fresh(), { ...batch([topic()]), now: "2026-07-18T05:00:00Z", bouts: [{ ...batch([topic()]).bouts[0], disprovedKeys: [KEY] }] });
  ok("disproved report → REPORT_DISPROVED", Object.values(disp.store.records)[0].actionStatus === I.ACTION_STATUS.REPORT_DISPROVED);

  // The lifecycle timeline recorded the transitions.
  ok("actionHistory grew across the lifecycle", confirmed.store.records[id].actionHistory.length >= 4, confirmed.store.records[id].actionHistory.length);
}

console.log("\nSTORY IDENTITY — separate stories about one fighter stay separate records");
{
  const N = require("../lib/evidence-eval").norm;
  const claim = (text, quote, channel) => ({ claim: text, quote, channel, kind: "current_condition_report", relevance: "current_fighter_condition", freshness: "current_fight_week", publishedAt: "2026-07-16T10:00:00Z" });
  const injuryTopic = (claims) => topic({ claims });

  // (1) Same rumor, paraphrased wording, more amplifiers → ONE record.
  {
    let s = one(fresh(), [injuryTopic([claim("Holland hurt his knee in camp", "Holland tweaked his knee in camp per one report", "ChA")])]).store;
    const id = Object.keys(s)[0] || Object.keys(s.records)[0];
    const r = I.ingest(s, { ...batch([injuryTopic([claim("Holland's knee is banged up this camp", "his knee is banged up in camp, same story going around", "ChB")])]), now: "2026-07-17T15:00:00Z" });
    ok("paraphrased same story → one record", Object.keys(r.store.records).length === 1, Object.keys(r.store.records).length);
  }

  // (2) Same fighter, two DIFFERENT injuries → TWO records.
  {
    const r = one(fresh(), [injuryTopic([
      claim("Holland hurt his knee in camp", "Holland's knee is hurt", "ChA"),
      claim("Holland reportedly has a staph infection", "word is Holland has staph", "ChB"),
    ])]);
    ok("knee injury and staph → two records", Object.keys(r.store.records).length === 2, Object.keys(r.store.records).length);
  }

  // (3) Injury rumor and withdrawal rumor → TWO records (condition vs event).
  {
    const r = one(fresh(), [injuryTopic([
      claim("Holland has a knee injury this camp", "his knee is hurt in camp", "ChA"),
      claim("Holland may have withdrawn from the card", "hearing Holland pulled out of the fight", "ChB"),
    ])]);
    ok("injury vs withdrawal → two records", Object.keys(r.store.records).length === 2, Object.keys(r.store.records).length);
    const types = Object.values(r.store.records).map((x) => x.reportType).sort();
    ok("...one CURRENT_CONDITION, one EVENT_STATUS", JSON.stringify(types) === JSON.stringify([I.REPORT_TYPE.CURRENT_CONDITION, I.REPORT_TYPE.EVENT_STATUS].sort()), types.join(","));
  }

  // (4) Later confirmation updates the ORIGINAL record (same proposition).
  {
    const KEY = "event:exit";
    let s = one(fresh(), [injuryTopic([claim("Holland may have withdrawn", "hearing Holland pulled out of the fight", "ChA")])]).store;
    const id = Object.keys(s.records)[0];
    const conf = I.ingest(s, { card: "TEST-2026-07-18", eventId: "UFC-TEST", now: "2026-07-18T02:00:00Z",
      bouts: [{ boutId: "UFC-TEST-B4", fight: "Jacobe Smith vs Kevin Holland", opponentOf: { [N("Kevin Holland")]: "Jacobe Smith" },
        topics: [injuryTopic([claim("Holland officially withdrew", "Holland has officially withdrawn from the card", "MMAFighting")])], confirmedKeys: [KEY] }] });
    ok("confirmation updates the same withdrawal record", Object.keys(conf.store.records).length === 1 && conf.store.records[id], id);
    ok("...now CONFIRMED", conf.store.records[id].truthStatus === I.TRUTH_STATUS.CONFIRMED);
  }

  // (5) Opponent replacement stays stable without a stable boutId (keyed on fighter+proposition).
  {
    let s = one(fresh(), [injuryTopic([claim("Holland may have withdrawn", "Holland pulled out", "ChA")])]).store;
    const id = Object.keys(s.records)[0];
    const moved = I.ingest(s, { card: "TEST-2026-07-18", eventId: "UFC-TEST", now: "2026-07-18T03:00:00Z",
      bouts: [{ boutId: "UFC-TEST-B7", fight: "Jacobe Smith vs Late Replacement", opponentOf: { [N("Kevin Holland")]: "Late Replacement" },
        topics: [injuryTopic([claim("Holland pulled out", "Holland pulled out of the fight", "ChB")])] }] });
    ok("same record despite bout renumber + opponent swap", Object.keys(moved.store.records).length === 1 && moved.store.records[id], id);
  }

  // (6) The SAME claim on a DIFFERENT event is a different record.
  {
    let s = one(fresh(), [injuryTopic([claim("Holland may have withdrawn", "Holland pulled out", "ChA")])]).store;
    const other = I.ingest(s, { card: "TEST-2026-08-01", eventId: "UFC-OTHER", now: "2026-07-18T04:00:00Z",
      bouts: [{ boutId: "UFC-OTHER-B1", fight: "Jacobe Smith vs Kevin Holland", opponentOf: { [N("Kevin Holland")]: "Jacobe Smith" },
        topics: [injuryTopic([claim("Holland may have withdrawn", "Holland pulled out", "ChA")])] }] });
    ok("same claim, different event → two records", Object.keys(other.store.records).length === 2, Object.keys(other.store.records).length);
  }
}

console.log("\nDASHBOARD GROUPING (§16) partitions by lifecycle stage");
{
  const watch = one(fresh(), [topic()]).results[0].record;
  const bet = one(fresh(), [topic()], { actionCtxByKey: { [require("../lib/evidence-eval").norm("Kevin Holland") + "|injury_health"]: { betQualifies: true, priceFavorable: true } } }).results[0].record;
  const g = I.groupByAction([watch, bet]);
  ok("WATCH goes to the watching group", g.watching.length === 1);
  ok("SPECULATIVE_BET goes to the bet-proposed group", g.betProposed.length === 1);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
