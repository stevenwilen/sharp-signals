// MANUAL ENTERTAINMENT ALERTS — Telegram-only buy instructions for a $100 bankroll.
//
//   node run-entertainment-alerts.js <forecast.json> [--send]
//
// NO ORDER PATH. This file cannot place, modify or close anything: there is no Kalshi write call
// here and none exists in the build. It produces text a human reads and then types into Kalshi
// themselves, or it produces nothing.
//
// SILENCE IS A VALID OUTPUT, AND CURRENTLY THE CORRECT ONE. If the research gates say NO BET, there
// is no buy instruction to soften. The system decides whether anything qualifies; the entertainment
// bankroll only decides how much a qualifying thing gets — it can never promote a refusal.
//
// --send is DISARMED and stays disarmed until two things are true:
//   1. authenticated unsubmitted Quick Order fee examples at $2-$5 reproduce exactly, and
//   2. one fresh full-pipeline card run passes.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const k = require("./lib/kalshi");
const C = require("./lib/contracts");
const V = require("./lib/contract-value");
const P = require("./lib/portfolio");
const EN = require("./lib/entertainment");
const TM = require("./lib/telegram-messages");
const AL = require("./lib/alert-ledger-v2");
const E = require("./lib/evidence-eval");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

const ARM = require("./lib/arming");

// Alerts are armed ONLY if the flag says so AND the evidence for it still exists. The prerequisites
// are re-read every run: an armed flag whose evidence has gone missing is worse than a disarmed one,
// because it looks like a decision somebody made rather than a file that got deleted.
function armingGate() {
  const pre = ARM.checkArmingPrerequisites();
  const blockers = [...pre.blockers];
  if (!ARM.ARMING.ALERTS_ARMED) blockers.push("ALERTS_ARMED is false in lib/arming.js");
  ARM.assertNoTradingPath();   // throws rather than trades if an order path ever appears
  return { armed: blockers.length === 0, blockers, prerequisites: ARM.ARMING.prerequisites };
}

// The unverified-news alerts. Sourced from the Phase 6 review queue, which is where the evaluator
// puts a claim it thinks a human should see BUT that could not clear the magnitude rules — a
// one-origin injury rumour being the canonical case. The forecast is right to ignore it; the human
// may still want to know.
function humanReviewAlerts(evalPath, fc) {
  if (!evalPath || !fs.existsSync(evalPath)) return [];
  const ev = JSON.parse(fs.readFileSync(evalPath, "utf8"));
  const out = [];
  for (const b of ev.bouts || []) {
    for (const r of b.reviewItems || []) {
      const f = fc.forecasts.find((x) => x.boutId === b.boutId);
      const applied = f ? (f.appliedAdjustments || []).filter((a) => a.finalAppliedLogOdds > 0) : [];
      const moved = f && f.marketDisagreementPoints ? Math.abs(f.marketDisagreementPoints) : 0;
      out.push({
        boutId: b.boutId, key: `review|${b.boutId}|${r.topic}|${String(r.about)}`,
        text: TM.humanReview({
          fight: f ? f.fight : b.boutId,
          about: r.about, claim: r.example, why: r.why, origins: r.origins, topic: r.topic,
          source: "a YouTube preview transcript collected for this card",
          forecastEffect: applied.length === 0
            ? "it applied no adjustment at all — a one-origin report cannot clear the magnitude rules, so this moved nothing"
            : `the forecast moved ${moved.toFixed(2)} points on this bout, from ${applied.length} mechanism(s) — not from this report`,
        }),
        meta: { about: r.about, topic: r.topic, origins: r.origins, why: r.why },
      });
    }
  }
  return out;
}

async function main() {
  const fPath = process.argv[2];
  if (!fPath || !fs.existsSync(fPath)) fail("usage: node run-entertainment-alerts.js <forecast.json> [--send]");
  const wantSend = process.argv.includes("--send");
  const gate = armingGate();

  const fc = JSON.parse(fs.readFileSync(fPath, "utf8"));
  const nowTs = Date.now();
  say(`ENTERTAINMENT ALERTS — ${fc.card.eventId}`);
  say(`  bankroll $${EN.BANKROLL.amount} (${EN.BANKROLL.label}) · tiers ${Object.values(EN.TIERS).map((t) => `${t.fraction * 100}%=$${t.dollars}`).join(" / ")}`);
  say(`  caps: ${EN.CAPS.maxFractionPerFight * 100}% per fight · ${EN.CAPS.maxFractionPerCard * 100}% per card`);
  say(`  alerts: ${ARM.ARMING.ALERTS_ARMED ? "ARMED" : "DISARMED"} (manual instructions only)`);
  say(`  trading: ${ARM.ARMING.TRADING_ENABLED ? "ENABLED" : "NONE — no Kalshi write path exists in this build"}`);
  say(`  mode: ${gate.armed && wantSend ? "SEND" : "TEST"}`);
  if (!gate.armed) for (const b of gate.blockers) say(`    ⛔ ${b}`);

  // ---- contract ranking across EVERY contract Kalshi lists on each fight ----
  say(`\n[1] inspecting every contract Kalshi lists for this card ...`);
  const markets = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" }).catch((e) => fail(`kalshi: ${e.message}`));
  const snapshotTs = Date.now();
  const mapped = [];
  for (const m of markets) {
    if (m.status !== "active") continue;
    const sub = (m.yes_sub_title || "").trim();
    const bout = fc.card.bouts.find((b) => E.norm(sub) === b.a.norm || E.norm(sub) === b.b.norm);
    if (!bout) continue;
    mapped.push(C.mapMarket(m, bout, snapshotTs));
  }
  const byType = {};
  for (const c of mapped) byType[c.outcomeType] = (byType[c.outcomeType] || 0) + 1;
  say(`[1] ${mapped.length} active contracts across ${new Set(mapped.map((c) => c.boutId)).size} bouts`);
  say(`[1] canonical outcome types actually listed: ${JSON.stringify(byType)}`);

  // The method restriction, reported from what is ACTUALLY listed rather than assumed.
  const types = new Set(mapped.map((c) => c.outcomeType));
  const onlyOutright = types.size === 1 && types.has(C.OUTCOME.FIGHTER_WINS);
  if (onlyOutright) {
    say(`[1] This card lists ONLY outright winner markets. There are no method, round or distance`);
    say(`    contracts to compare, so the ranking covers outright markets only — not because we`);
    say(`    prefer them, but because Kalshi lists nothing else.`);
  } else {
    const unval = mapped.filter((c) => c.unvalidatedModel);
    say(`[1] ${unval.length} method/round contract(s) are listed. They are DISPLAYED and COMPARED but stay`);
    say(`    ANALYSIS ONLY — their probability rests on v7.0.0's fixed, unvalidated method priors.`);
  }

  say(`\n[2] valuing and ranking (executable price, fees, slippage, liquidity, uncertainty, correlation) ...`);
  const valued = [];
  for (const c of mapped) {
    const f = fc.forecasts.find((x) => x.boutId === c.boutId);
    let ob = null;
    try { ob = await k.orderbook(c.ticker); } catch (e) { /* handled by the valuer */ }
    const v = V.valueContract(c, f, ob, { contracts: 100, nowTs, maxSnapshotAgeMs: 30 * 60 * 1000 });
    v.contract = c;
    v.mechanisms = f && f.appliedAdjustments ? [...new Set(f.appliedAdjustments.filter((a) => a.finalAppliedLogOdds > 0).map((a) => a.mechanism))] : [];
    valued.push(v);
  }
  const ranked = P.rankContracts(valued, { contracts: 100 });
  const counts = {};
  for (const r of ranked) counts[r.classification] = (counts[r.classification] || 0) + 1;
  for (const s of P.STATUSES) say(`    ${s.padEnd(26)} ${counts[s] || 0}`);

  say(`\n[3] entertainment sizing (only on what the research gates already cleared) ...`);
  for (const r of ranked) r.entertainment = EN.sizeEntertainment(r, { bankroll: EN.BANKROLL.amount, maxSnapshotAgeMs: 30 * 60 * 1000 });
  const capped = EN.applyEntertainmentCaps(ranked, { bankroll: EN.BANKROLL.amount });
  const eligible = capped.positions.filter((r) => r.entertainment && r.entertainment.eligible && r.entertainment.stake > 0);
  say(`[3] positions the system would instruct you to buy: ${eligible.length}`);
  if (!eligible.length) {
    const blocked = {};
    for (const r of capped.positions) {
      const b = r.entertainment && r.entertainment.blockedBy;
      if (b) blocked[b] = (blocked[b] || 0) + 1;
    }
    say(`[3] every contract was refused. Blocked by: ${JSON.stringify(blocked)}`);
    say(`[3] NO BUY INSTRUCTION WILL BE SENT. That is the correct output, not a failure.`);
  }

  // ---- one message per FIGHT, naming the single highest-ranked eligible contract ----
  const messages = [];
  const byBout = {};
  for (const r of eligible) (byBout[r.boutId] = byBout[r.boutId] || []).push(r);
  for (const [boutId, list] of Object.entries(byBout)) {
    list.sort((a, b) => (b.leverageScore ?? -1) - (a.leverageScore ?? -1));
    const top = list[0];
    const f = fc.forecasts.find((x) => x.boutId === boutId);
    const onThisFight = ranked.filter((r) => r.boutId === boutId);
    const runnerUp = onThisFight.filter((r) => r !== top)[0];
    const { why, against } = TM.reasonsFor(top, f, null);
    const A = f.fight.split(" vs ")[0];
    const msg = TM.buyInstruction({
      fight: f.fight, ticker: top.ticker, contractWording: top.contractWording,
      ask: top.topOfBookPrice, maximumAcceptablePrice: top.maximumAcceptablePrice,
      percentOfBankroll: top.entertainment.percentOfBankroll, bankroll: EN.BANKROLL.amount,
      stake: top.entertainment.stake, contracts: top.entertainment.contracts,
      tierLabel: top.entertainment.tierLabel,
      contractsCompared: onThisFight.length,
      whyTopRanked: runnerUp
        ? `risk-adjusted conservative value after costs beats ${runnerUp.ticker} (${runnerUp.classification}${runnerUp.reason ? ": " + String(runnerUp.reason).slice(0, 60) : ""})`
        : "it is the only contract Kalshi lists on this fight",
      why, against,
      doNotPlaceIf: [
        `the ask is above ${(top.maximumAcceptablePrice * 100).toFixed(1)}¢ when you look`,
        "the sportsbook consensus has moved materially since this snapshot",
        "the fight has started or the market is suspended",
        "you cannot fill the whole size at or under the maximum price",
      ],
      rangeLow: f.systemRange ? f.systemRange.low : null,
      rangeHigh: f.systemRange ? f.systemRange.high : null,
      conservativeValuePoints: top.entertainment.conservativeMarginPoints,
      evidenceCoverage: f.evidenceCoverage || "unknown",
      modelStatus: top.probabilityModelStatus,
      snapshotTimestamp: new Date(snapshotTs).toISOString(),
      feeGate: top.entertainment.feeGate,
    });
    const key = `${boutId}|${top.ticker}`;
    const state = { ask: top.topOfBookPrice, maximumAcceptablePrice: top.maximumAcceptablePrice,
      forecastHash: fc.sealHash, classification: top.classification,
      stakePercent: top.entertainment.percentOfBankroll, topTicker: top.ticker,
      stale: false, pipelineFailed: false, withinEnvelope: top.entertainment.feeGate.withinVerifiedEnvelope };
    const decision = AL.shouldSend(key, state);
    messages.push({ boutId, ticker: top.ticker, wouldSend: decision.send, why: decision.why, text: msg, state });
  }

  // ---- delivery ----
  // The transport is loaded ONLY here, ONLY when the gate passed, --send was asked for, and there is
  // actually something to say. An earlier version printed "mode: SEND" while importing no transport
  // at all — a label promising something the code could not do. If the gate is shut or nothing
  // qualifies, no Telegram module is ever required, so there is no path to a message.
  // ---- HUMAN REVIEW alerts (unverified news) ----
  // These travel on their own track. They are NOT gated on anything qualifying as a bet, because
  // their whole point is news the forecast correctly refused to act on. They are deduped by the
  // ledger so the same rumour does not re-send every run.
  const evalPath = (process.argv.find((a) => a.startsWith("--eval=")) || "").split("=")[1];
  const reviews = humanReviewAlerts(evalPath, fc);
  const reviewsToSend = reviews.filter((r) => AL.shouldSend(r.key, { newsKey: r.key, ...r.meta }).send);
  say(`\n[4] human-review alerts (unverified news): ${reviews.length} found, ${reviewsToSend.length} new`);
  for (const r of reviews) say(`    ${reviewsToSend.includes(r) ? "NEW " : "seen"} ${r.meta.about}: ${r.meta.why} (${r.meta.origins ?? "?"} origin)`);

  const toSend = messages.filter((m) => m.wouldSend);
  let delivery = { attempted: 0, delivered: 0, buyInstructions: 0, humanReviews: 0, transport: "none loaded" };
  const anything = toSend.length + reviewsToSend.length;
  if (wantSend && gate.armed && anything) {
    const notify = require("./lib/notify");   // Telegram ONLY. There is no trading API in this build.
    delivery.transport = "telegram (manual instruction + human review)";
    for (const m of toSend) {
      delivery.attempted++;
      try { await notify.notify(m.text); delivery.delivered++; delivery.buyInstructions++; AL.record(`${m.boutId}|${m.ticker}`, m.state, "BUY_INSTRUCTION"); }
      catch (e) { say(`  ⚠ delivery failed for ${m.ticker}: ${e.message}`); }
    }
    for (const r of reviewsToSend) {
      delivery.attempted++;
      try { await notify.notify(r.text); delivery.delivered++; delivery.humanReviews++; AL.record(r.key, { newsKey: r.key, ...r.meta }, "HUMAN_REVIEW"); }
      catch (e) { say(`  ⚠ delivery failed for review ${r.meta.about}: ${e.message}`); }
    }
  } else if (wantSend && gate.armed) {
    delivery.transport = "none loaded — nothing qualified and no new news, so there was nothing to deliver";
  }

  const out = {
    card: fc.card.eventId, ranAt: new Date(nowTs).toISOString(),
    mode: gate.armed && wantSend ? "SEND (manual instruction)" : "TEST",
    delivery,
    alertsArmed: ARM.ARMING.ALERTS_ARMED, tradingEnabled: false, ordersPlaced: 0, orderPathExists: false,
    armingGate: gate,
    bankroll: EN.BANKROLL, tiers: EN.TIERS, caps: EN.CAPS,
    contractsListed: byType, onlyOutrightMarketsListed: onlyOutright,
    classificationCounts: counts,
    forecastHash: fc.sealHash, snapshotTimestamp: new Date(snapshotTs).toISOString(),
    humanReviewAlerts: reviews.map(function(r){ return { boutId:r.boutId, about:r.meta.about, topic:r.meta.topic, origins:r.meta.origins, why:r.meta.why, text:r.text }; }),
    buyInstructions: messages,
    decisions: capped.positions.map((r) => ({
      ticker: r.ticker, bout: r.bout, classification: r.classification, rank: r.rank,
      entertainmentEligible: r.entertainment ? r.entertainment.eligible : false,
      blockedBy: r.entertainment ? r.entertainment.blockedBy || null : null,
      reason: r.reason || null,
    })),
  };
  writeJson(`data/entertainment-alerts-${fc.card.eventDate}.json`, out);

  say(`\n${"=".repeat(80)}`);
  if (!messages.length) {
    say(`  NO BUY INSTRUCTION. The system found nothing that qualifies.`);
    say(`  ${reviewsToSend.length ? `${reviewsToSend.length} HUMAN REVIEW alert(s) will still go out — unverified news travels on its own` : "Telegram sends NOTHING — silence is the instruction."}`);
    if (reviewsToSend.length) say(`  track and is NOT a betting instruction.`);
  } else {
    for (const m of messages) say(`\n  [${m.wouldSend ? "WOULD SEND" : "suppressed: " + m.why}]\n${m.text.split("\n").map((l) => "  " + l).join("\n")}`);
  }
  for (const r of reviewsToSend) say(`\n  [HUMAN REVIEW — unverified]\n${r.text.split("\n").map((l) => "  " + l).join("\n")}`);
  say(`\n  alerts=${ARM.ARMING.ALERTS_ARMED ? "ARMED" : "DISARMED"} · trading=NONE (no write path) · ordersPlaced=0`);
  say(`  delivered: ${delivery.buyInstructions} buy instruction(s), ${delivery.humanReviews} human-review alert(s) via ${delivery.transport}`);
  if (wantSend && !gate.armed) say(`  --send was requested but the arming gate REFUSED: ${gate.blockers.length} blocker(s) above.`);
  say(`  written: data/entertainment-alerts-${fc.card.eventDate}.json`);
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
