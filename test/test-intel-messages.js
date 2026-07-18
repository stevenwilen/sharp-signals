// FIGHT INTELLIGENCE MESSAGES — one combined message per report (§6), concise state-change updates
// tied to the original record (§6C/D + §7), and a bet that STILL passes the mechanical invariants (§10).
// These pin the phone experience: no repeated disclaimers, no internal taxonomy, no BUY when the price
// or side is inconsistent, and no alert once the fight has begun.
const IM = require("../lib/intel-messages");
const TM = require("../lib/telegram-messages");
const I = require("../lib/intelligence");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

// A record in a given lifecycle state (minimal fields the message layer reads).
const rec = (o = {}) => ({
  intelligenceId: "intel_x", fight: "Jacobe Smith vs Kevin Holland", fighter: "Kevin Holland",
  claim: "Holland may be injured or withdrawing", rawWording: "sources say Holland hurt his knee",
  topic: "injury_health", reportType: I.REPORT_TYPE.CURRENT_CONDITION,
  truthStatus: I.TRUTH_STATUS.PLAUSIBLE, accessRelevance: I.ACCESS.FIRSTHAND, independentOrigins: 1,
  actionStatus: I.ACTION_STATUS.WATCH, actionHistory: [{}], ...o,
});

// Substrings that must never reach the phone.
const TAXONOMY = /injury_health|weight_cut|credible_single_origin|favors_about|against_about|EVENT_STATUS|CURRENT_CONDITION|ANALYTICAL|KXUFCFIGHT|logOdds|originId/i;
const REPEATED_DISCLAIMERS = /trading path|cannot place|no write|not demonstrated|contaminated|not Kelly|prospective edge|Alerts (remain|are) disarmed/i;
const oneFooter = (t) => (t.match(/For entertainment use/g) || []).length === 1;

console.log("COMBINED FIGHT INTEL — WATCH (§6B): one message, discovery + assessment + market");
{
  const m = IM.buildIntelMessage(rec(), { forecastImpactPoints: 0, marketReaction: { moved: false } });
  const t = m.text;
  ok("headlines FIGHT INTEL — WATCH", /^🛰️ FIGHT INTEL — WATCH$/m.test(t));
  ok("names the fight", /Jacobe Smith vs Kevin Holland/.test(t));
  ok("carries the plain report", /Report: Holland may be injured or withdrawing/.test(t));
  ok("states the assessment once", (t.match(/Assessment:/g) || []).length === 1 && /Assessment: Plausible, 1 access-relevant origin/.test(t));
  ok("forecast impact None yet", /Forecast impact: None yet/.test(t));
  ok("market reaction No meaningful move", /Market reaction: No meaningful move/.test(t));
  ok("no internal taxonomy", !TAXONOMY.test(t), (t.match(TAXONOMY) || [])[0]);
  ok("no repeated disclaimers", !REPEATED_DISCLAIMERS.test(t));
  ok("one short footer", oneFooter(t));
  ok("under 700 chars", t.length < 700, t.length);
}

console.log("\nCOMBINED SPECULATIVE INTEL BET (§6A): intel + assessment + forecast + price in ONE message");
{
  const bet = { recommendedSide: "Jacobe Smith", fighterA: "Jacobe Smith", fighterB: "Kevin Holland",
    buyLine: "Smith YES", stake: 3, ask: 0.54, allInPrice: 0.55, maximumAcceptablePrice: 0.57,
    centralProb: 0.60, rangeLow: 0.55, rangeHigh: 0.66, centralEV: 0.05, conservativeEV: 0.01 };
  const m = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }),
    { bet, forecastImpactPoints: 0.031, helps: "Smith", recommendedFirst: "Jacobe Smith vs Kevin Holland",
      whyMatters: "A withdrawal or impaired Holland directly changes the matchup." });
  const t = m.text;
  ok("verdict is BUY (passed the invariants)", m.verdict === "BUY", m.verdict);
  ok("headlines SPECULATIVE INTEL BET with the stake", /^🧪 SPECULATIVE INTEL BET — \$3$/m.test(t));
  ok("single Buy line", (t.match(/^Buy: Smith YES$/gm) || []).length === 1);
  ok("carries Report + Assessment + Forecast impact together", /Report: /.test(t) && /Assessment: /.test(t) && /Forecast impact: Smith \+3\.1 points/.test(t));
  ok("Current and Maximum prices", /Current: 54¢/.test(t) && /Maximum: 57¢/.test(t));
  ok("the price ceiling instruction", /Place only at 57¢ or lower\./.test(t));
  ok("why it may matter + main risk", /Why it may matter: /.test(t) && /Main risk: /.test(t));
  ok("one footer, no repeated disclaimers", oneFooter(t) && !REPEATED_DISCLAIMERS.test(t));
  ok("no internal taxonomy", !TAXONOMY.test(t), (t.match(TAXONOMY) || [])[0]);
  ok("under 1000 chars", t.length < 1000, t.length);
}

console.log("\nA BET NEVER RENDERS WHEN THE INVARIANTS FAIL (§10)");
{
  // ask 67¢ above the 57¢ maximum -> PRICE_TOO_HIGH, never a buy.
  const pricedOut = { recommendedSide: "Jacobe Smith", fighterA: "Jacobe Smith", fighterB: "Kevin Holland",
    buyLine: "Smith YES", stake: 3, ask: 0.67, allInPrice: 0.55, maximumAcceptablePrice: 0.57,
    centralProb: 0.60, rangeLow: 0.55, rangeHigh: 0.66, centralEV: 0.05, conservativeEV: 0.01 };
  const m1 = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }), { bet: pricedOut });
  ok("ask above max → PRICE_TOO_HIGH, not BUY", m1.verdict === "PRICE_TOO_HIGH", m1.verdict);
  ok("...renders a wait message, no 'Buy:' line", /PRICE TOO HIGH/.test(m1.text) && !/^Buy:/m.test(m1.text));

  // range belongs to the opposite fighter -> FAIL_CLOSED, no message at all.
  const wrongSide = { ...pricedOut, ask: 0.54, rangeLow: 0.34, rangeHigh: 0.45 };
  const m2 = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }), { bet: wrongSide });
  ok("wrong-side range → FAIL_CLOSED", m2.verdict === "FAIL_CLOSED", m2.verdict);
  ok("...no betting instruction text at all", m2.text === null);
}

console.log("\nLATER STATE CHANGES ARE SHORT UPDATES, NOT FULL RE-SENDS (§6C/D)");
{
  const confirmed = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.REPORT_CONFIRMED, truthStatus: I.TRUTH_STATUS.CONFIRMED, reportType: I.REPORT_TYPE.EVENT_STATUS }), {});
  ok("CONFIRMED update header", /^✅ REPORT CONFIRMED$/m.test(confirmed.text));
  ok("says the market suspended, no bet", /Fight market suspended\. No bet\./.test(confirmed.text));
  ok("confirmed update is short (no full source dump)", confirmed.text.length < 400, confirmed.text.length);
  ok("no repeated disclaimers in the update", !REPEATED_DISCLAIMERS.test(confirmed.text));

  const disproved = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.REPORT_DISPROVED, truthStatus: I.TRUTH_STATUS.DISPROVED }), {});
  ok("DISPROVED update header", /^❌ REPORT DISPROVED$/m.test(disproved.text));
  ok("says the recommendation is withdrawn", /withdrawn/.test(disproved.text));

  const moved = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.MARKET_ALREADY_MOVED }), { marketReaction: { subject: "Smith", beforeAsk: 0.54, afterAsk: 0.72, moved: true } });
  ok("MARKET ALREADY MOVED update header", /^📉 MARKET ALREADY MOVED$/m.test(moved.text));
  ok("shows the move and says do not chase", /Smith 54¢ → 72¢/.test(moved.text) && /Do not chase/.test(moved.text));

  const withdrawn = IM.buildIntelMessage(rec({ actionStatus: I.ACTION_STATUS.POSITION_WITHDRAWN }), { reason: "conservative EV went negative", recommendedFirst: "Jacobe Smith vs Kevin Holland" });
  ok("WITHDRAWN update header", /^❌ BET WITHDRAWN$/m.test(withdrawn.text));
  ok("says do not place the previous recommendation", /Do not place the previous recommendation\./.test(withdrawn.text));
}

console.log("\nALERT DECISION (§7): only material changes, none after the fight starts");
{
  const watch = rec();
  ok("first material sighting alerts", IM.shouldAlert(null, watch, {}).alert === true);
  ok("identical state does NOT re-alert", IM.shouldAlert(watch, { ...watch }, {}).alert === false);
  ok("WATCH → SPECULATIVE_BET alerts", IM.shouldAlert(watch, { ...watch, actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }, {}).alert === true);
  ok("origins 1 → 5 alerts", IM.shouldAlert(watch, { ...watch, independentOrigins: 5 }, {}).alert === true);
  ok("an access-relevant source appearing alerts", IM.shouldAlert({ ...watch, accessRelevance: I.ACCESS.ANALYST_ONLY }, { ...watch, accessRelevance: I.ACCESS.FIRSTHAND }, {}).alert === true);
  ok("NOTHING alerts once the fight has begun", IM.shouldAlert(watch, { ...watch, actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }, { fightStarted: true }).alert === false);
  ok("dashboard-only never interrupts the phone", IM.shouldAlert(null, rec({ actionStatus: I.ACTION_STATUS.DASHBOARD_ONLY }), {}).alert === false);
}

console.log("\nTHREADING (§7): updates carry reply_to so they attach to the original alert");
{
  // Exercise notify()'s param-building with a stubbed transport (no network).
  const notify = require("../lib/notify");
  const calls = [];
  const orig = notify.api;
  notify.api = async (method, params) => { calls.push({ method, params }); return { ok: true, result: { message_id: 4242 } }; };
  process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "999";
  (async () => {
    const first = await notify.notify("first alert");
    ok("send captures the message id (used to be discarded)", first.messages[0] && first.messages[0].messageId === 4242, JSON.stringify(first.messages));
    calls.length = 0;
    await notify.notify("update", { replyTo: { "999": 4242 } });
    ok("a later update replies to the original message", calls[0].params.reply_to_message_id === 4242, JSON.stringify(calls[0].params));
    notify.api = orig;
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  })();
}
