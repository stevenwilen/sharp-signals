// FIGHT-INTELLIGENCE PIPELINE (§13/§14/§15). One cycle end to end: discover → research → assess →
// forecast effect → market → classify → persist → (message). The gates: FIGHT_INTEL_ENABLED turns the
// lifecycle on; in SHADOW MODE (not sending) the phone receives NOTHING while records + dashboard fill.
// State persists into the next run; an unchanged re-run sends no duplicate.
const os = require("os"), fs = require("fs"), pathm = require("path");
const TMP = pathm.join(os.tmpdir(), "ss-intel-pipeline-test");
fs.mkdirSync(TMP, { recursive: true });
// Start from a clean store every run — a leftover intelligence-*.json from a prior run would make the
// pipeline load a pre-existing record and break the "first alert" assertions (test isolation).
for (const f of fs.readdirSync(TMP)) if (/^intelligence-.*\.json$/.test(f)) fs.unlinkSync(pathm.join(TMP, f));
process.env.DATA_DIR = TMP;
const PIPE = require("../lib/intel-pipeline");
const I = require("../lib/intelligence");
const N = require("../lib/evidence-eval").norm;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

const disabledProvider = async () => ({ enabled: false, results: [] });
const officialSupport = async () => ({ enabled: true, results: [{ outlet: "UFC.com", origin: "ufc", url: "https://ufc.com/x", quote: "Holland is officially off the card with a knee injury", publishedAt: "2026-07-16T10:00:00Z", stance: "supports", sourceType: "official promotion" }] });

const claim = (text, quote, channel) => ({ claim: text, quote, channel, kind: "current_condition_report", relevance: "current_fighter_condition", freshness: "current_fight_week", publishedAt: "2026-07-16T10:00:00Z" });
const topic = (claims) => ({ about: "Kevin Holland", topic: "injury_health", direction: "against_about", claimCount: claims.length,
  kinds: ["current_condition_report"], relevance: ["current_fighter_condition"], freshness: ["current_fight_week"], strength: "moderate", marketAwareness: "newly_emerging",
  origin: { independentOrigins: 1, originIds: ["report:helwani"], amplifyingChannels: 1, originType: "external_report", citedOrigins: ["helwani"] }, claims });

const batch = (claims) => ({ card: null, eventId: "UFC-PIPE", now: null,
  bouts: [{ boutId: "UFC-PIPE-B3", fight: "Jacobe Smith vs Kevin Holland", opponentOf: { [N("Kevin Holland")]: "Jacobe Smith" }, topics: [topic(claims)] }] });

const kneeClaims = [claim("Kevin Holland is dealing with a knee injury this camp and may be limited", "sources say Holland hurt his knee in camp and it is limiting his training", "MMAClips")];
const bet = { recommendedSide: "Jacobe Smith", fighterA: "Jacobe Smith", fighterB: "Kevin Holland", buyLine: "Smith YES", stake: 3, ask: 0.54, allInPrice: 0.55, maximumAcceptablePrice: 0.57, centralProb: 0.60, rangeLow: 0.55, rangeHigh: 0.66, centralEV: 0.05, conservativeEV: 0.01 };

// A notifier that records calls (no network) and hands back a message id for lineage.
const spyNotifier = () => { const calls = []; const fn = async (text, o) => { calls.push({ text, opts: o }); return { ok: true, messages: [{ chatId: "1", messageId: 100 + calls.length }] }; }; fn.calls = calls; return fn; };

(async () => {
  console.log("SHADOW MODE sends NOTHING to the phone (records + dashboard still fill)");
  {
    // (a) lifecycle disabled entirely
    delete process.env.FIGHT_INTEL_ENABLED;
    let notifier = spyNotifier();
    let r = await PIPE.runIntel({ card: "PIPE-A", batch: { ...batch(kneeClaims) }, now: "2026-07-17T12:00:00Z", seal: "2026-07-18T00:00:00Z", send: true, provider: disabledProvider, notifier });
    ok("disabled → shadow", r.shadow === true && r.enabled === false);
    ok("disabled → no Telegram sent", notifier.calls.length === 0);
    ok("...but the record was still discovered and persisted", Object.keys(r.store.records).length === 1);
    ok("...as a WATCH", Object.values(r.store.records)[0].actionStatus === I.ACTION_STATUS.WATCH);

    // (b) enabled but not sending (true shadow)
    process.env.FIGHT_INTEL_ENABLED = "1";
    notifier = spyNotifier();
    r = await PIPE.runIntel({ card: "PIPE-B", batch: { ...batch(kneeClaims) }, now: "2026-07-17T12:00:00Z", seal: "2026-07-18T00:00:00Z", send: false, provider: disabledProvider, notifier });
    ok("enabled + not sending → shadow", r.shadow === true && r.enabled === true);
    ok("shadow → no Telegram sent", notifier.calls.length === 0);
    ok("...records persisted for the dashboard", Object.keys(r.store.records).length === 1);
  }

  console.log("\nENABLED + SEND: one combined message per report");
  {
    process.env.FIGHT_INTEL_ENABLED = "1";
    const notifier = spyNotifier();
    const r = await PIPE.runIntel({ card: "PIPE-C", batch: { ...batch(kneeClaims) }, now: "2026-07-17T12:00:00Z", seal: "2026-07-18T00:00:00Z", send: true, provider: disabledProvider, notifier,
      marketByBout: { "UFC-PIPE-B3": { kalshiAsk: 0.54, sportsbook: 0.53, maximumAcceptablePrice: 0.57, subject: "Smith" } } });
    ok("not shadow", r.shadow === false);
    ok("exactly ONE message sent for the report", notifier.calls.length === 1, notifier.calls.length);
    ok("it is a FIGHT INTEL — WATCH", /FIGHT INTEL — WATCH/.test(notifier.calls[0].text));
    ok("the message id was captured onto the record lineage", Object.values(r.store.records)[0].telegramLineage.length === 1);
  }

  console.log("\nPERSISTENCE INTO THE NEXT RUN + NO DUPLICATE ON AN UNCHANGED RE-RUN");
  {
    process.env.FIGHT_INTEL_ENABLED = "1";
    const notifier = spyNotifier();
    const common = { card: "PIPE-D", seal: "2026-07-18T00:00:00Z", send: true, provider: disabledProvider, notifier,
      marketByBout: { "UFC-PIPE-B3": { kalshiAsk: 0.54, sportsbook: 0.53, maximumAcceptablePrice: 0.57, subject: "Smith" } } };
    const run1 = await PIPE.runIntel({ ...common, batch: batch(kneeClaims), now: "2026-07-17T12:00:00Z" });
    const id = Object.keys(run1.store.records)[0];
    ok("run 1 sent the first alert", notifier.calls.length === 1);

    // run 2: identical input, later time. State loads from disk; nothing material changed.
    const run2 = await PIPE.runIntel({ ...common, batch: batch(kneeClaims), now: "2026-07-17T18:00:00Z" });
    ok("run 2 loaded the persisted record (same id, still one record)", Object.keys(run2.store.records).length === 1 && run2.store.records[id]);
    ok("run 2 sent NO duplicate (nothing material changed)", notifier.calls.length === 1, notifier.calls.length);
  }

  console.log("\nLATER STATE CHANGE: research confirms it → a short CONFIRMED update on the SAME record");
  {
    process.env.FIGHT_INTEL_ENABLED = "1";
    const notifier = spyNotifier();
    const common = { card: "PIPE-E", seal: "2026-07-18T00:00:00Z", send: true, notifier,
      marketByBout: { "UFC-PIPE-B3": { kalshiAsk: 0.54, sportsbook: 0.53, maximumAcceptablePrice: 0.57, subject: "Smith" } } };
    await PIPE.runIntel({ ...common, batch: batch(kneeClaims), now: "2026-07-17T12:00:00Z", provider: disabledProvider });
    ok("first run: a WATCH alert", notifier.calls.length === 1 && /WATCH/.test(notifier.calls[0].text));

    // Later run: the researcher finds an official source confirming the withdrawal.
    const withdrawalClaims = [claim("Holland has officially withdrawn from the card", "Holland has officially withdrawn from the fight", "MMAFighting")];
    const r2 = await PIPE.runIntel({ ...common, batch: batch(withdrawalClaims), now: "2026-07-18T02:00:00Z", provider: officialSupport,
      // give the withdrawal story its own market key isn't needed; confirmation drives it
    });
    const confirmedRec = Object.values(r2.store.records).find((x) => x.truthStatus === I.TRUTH_STATUS.CONFIRMED);
    ok("a CONFIRMED withdrawal record now exists", !!confirmedRec);
    ok("a CONFIRMED update was sent", notifier.calls.some((c) => /REPORT CONFIRMED/.test(c.text)));
    ok("the confirmed update is a short update, not a full re-send", notifier.calls.find((c) => /REPORT CONFIRMED/.test(c.text)).text.length < 400);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
