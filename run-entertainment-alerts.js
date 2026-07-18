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
const crypto = require("crypto");
const k = require("./lib/kalshi");
const C = require("./lib/contracts");
const V = require("./lib/contract-value");
const P = require("./lib/portfolio");
const EN = require("./lib/entertainment");
const TM = require("./lib/telegram-messages");
const AL = require("./lib/alert-ledger-v2");
const MB = require("./lib/manual-bankroll");
const MI = require("./lib/message-invariants");
const E = require("./lib/evidence-eval");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);

const ARM = require("./lib/arming");

// Alerts are armed ONLY if the flag says so AND the evidence for it still exists. The prerequisites
// are re-read every run: an armed flag whose evidence has gone missing is worse than a disarmed one,
// because it looks like a decision somebody made rather than a file that got deleted.
// A production send requires THREE independent things to all be true, and they are deliberately
// separate so no single act can arm the system:
//   1. ALERTS_ARMED    — the alert path is wired and meant to be usable (committed code).
//   2. a machine attestation matching THIS card AND this sealed forecast (data/attestation.json).
//   3. SHARP_PRODUCTION=1 in the environment — the explicit human "go", set only after review, and
//      living outside the repo so neither a generator nor a commit can flip it.
// Generating the attestation satisfies (2) and touches neither (1) nor (3): it cannot arm anything.
function armingGate(cardId, forecastHash) {
  const pre = ARM.checkArmingPrerequisites(cardId, forecastHash);
  const blockers = [...pre.blockers];
  if (!ARM.ARMING.ALERTS_ARMED) blockers.push("ALERTS_ARMED is false in lib/arming.js");
  if (!ARM.productionEnabled()) blockers.push("SHARP_PRODUCTION is not set — production sends require the explicit environment switch, set only after review");
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
  const out = [], refused = [];
  for (const b of ev.bouts || []) {
    for (const r of b.reviewItems || []) {
      const f = fc.forecasts.find((x) => x.boutId === b.boutId);

      // IDENTITY, BEFORE ANYTHING ELSE. The fight NAME comes from the forecast and the claim comes
      // from the eval bout, joined on boutId alone. boutId is a positional index (lib/target-card.js:68)
      // over an array that renumbers whenever a bout drops off the card, so the two sides of this join
      // can silently describe different fights. On 2026-07-17 they did: three HUMAN REVIEW messages
      // were sent binding a Kevin Holland withdrawal rumour to Kamaru Usman's bout, for a Holland fight
      // that was not on the card at all.
      //
      // b.fight was on the object being iterated the entire time. Nothing compared them. This is the
      // same check lib/contracts.js:265-268 already makes on the contract path — a mapping whose
      // subject matches neither fighter in the bout is refused, not rendered.
      if (f && b.fight && f.fight !== b.fight) {
        refused.push(`${b.boutId}: eval says "${b.fight}", forecast says "${f.fight}" — refusing to alert on a bout whose two halves disagree`);
        continue;
      }
      if (!f) {
        refused.push(`${b.boutId}: no forecast for this bout — refusing rather than alerting on a bout the forecast never saw`);
        continue;
      }

      const applied = (f.appliedAdjustments || []).filter((a) => a.finalAppliedLogOdds > 0);
      const moved = f.marketDisagreementPoints ? Math.abs(f.marketDisagreementPoints) : 0;
      out.push({
        boutId: b.boutId, key: `review|${b.boutId}|${r.topic}|${String(r.about)}`,
        text: TM.humanReview({
          fight: f.fight,
          about: r.about, claim: r.example, why: r.why, origins: r.origins, topic: r.topic,
          source: "a YouTube preview transcript collected for this card",
          forecastEffect: applied.length === 0
            ? "it applied no adjustment at all — a one-origin report cannot clear the magnitude rules, so this moved nothing"
            : `the forecast moved ${moved.toFixed(2)} points on this bout, from ${applied.length} mechanism(s) — not from this report`,
        }),
        // claimHash lets the ledger notice that DIFFERENT news arrived about the same fighter and
        // topic. The key omits the claim text on purpose (a re-worded transcript must not re-send), so
        // without this a withdrawal rumour is swallowed because a knee rumour was already sent.
        meta: { about: r.about, topic: r.topic, origins: r.origins, why: r.why,
                claimHash: sha(String(r.example || "")), fight: b.fight || null },
      });
    }
  }
  // Never silent. A refusal that only a reader of the console would notice is how the last one shipped.
  for (const m of refused) say(`  ⛔ REFUSED ${m}`);
  return out;
}

// One readable sentence from a hypothesis record, WITHOUT the internal topic slug (injury_health,
// weight_cut) or the (favors_about) direction tag — those are dashboard/artifact detail, not phone copy.
function shortHypothesis(h) {
  if (!h) return "an uncertain qualitative signal";
  let s = String(h);
  const colon = s.indexOf(": ");
  if (colon >= 0) s = s.slice(colon + 2);         // drop "Fighter — topic:" prefix
  s = s.replace(/\s*\((favors_about|against_about|neutral)\)\s*$/i, "").trim();   // drop direction tag
  return s || "an uncertain qualitative signal";
}

// Build a compact ACTION message for one valued, sized contract, gated by the pre-render invariants.
// Returns { verdict, text, state, recommendedFighter } or { verdict:"FAIL_CLOSED", violations } — a
// betting instruction is NEVER produced for a contradictory recommendation.
//
//   v    : the valued contract (contract-value output; already side-correct on prob & max price)
//   f    : the sealed forecast for this bout
//   opts : { classification, stake, fraction, whyOne, riskOne, lane, whyRankedFirst, approxContracts,
//            cardExposureRemaining, dashboard }
function buildActionMessage(v, f, opts) {
  const [A, B] = f.fight.split(" vs ");
  const rec = v.contract ? v.contract.outcomeSubject : v.outcomeSubject;   // the recommended fighter
  const recIsA = E.norm(rec) === E.norm(A);
  const other = recIsA ? B : A;

  // THE RANGE, FLIPPED TO THE RECOMMENDED SIDE. f.systemRange is expressed for fighter A; showing it
  // unflipped on a fighter-B recommendation is exactly the Du Plessis bug (Usman's 27–38% shown on a
  // Du Plessis buy). The central probability and the max acceptable price are already side-correct
  // (contract-value computed them for the contract's own subject).
  const range = f.systemRange
    ? (recIsA ? { low: f.systemRange.low, high: f.systemRange.high }
              : { low: +(1 - f.systemRange.high).toFixed(4), high: +(1 - f.systemRange.low).toFixed(4) })
    : { low: null, high: null };

  const fields = {
    recommendedSide: rec, fighterA: A, fighterB: B,
    centralProb: v.systemCentralProbability,
    rangeLow: range.low, rangeHigh: range.high,
    ask: v.topOfBookPrice, allInPrice: v.allInPrice, maximumAcceptablePrice: v.maximumAcceptablePrice,
    centralEV: v.expectedValueCentral, conservativeEV: v.expectedValueConservative,
  };
  const evalResult = MI.evaluateRecommendation(fields);
  const recommendedFirst = `${rec} vs ${other}`;
  const base = {
    boutId: v.boutId || (v.contract && v.contract.boutId), ticker: v.ticker || (v.contract && v.contract.ticker),
    recommendedFighter: rec, recommendedFirst, verdict: evalResult.verdict, fields: evalResult.fields, violations: evalResult.violations,
  };

  if (evalResult.verdict === "FAIL_CLOSED") {
    say(`  ⛔ FAIL-CLOSED (${rec}): ${evalResult.violations.join("; ")} — no betting instruction sent`);
    return { ...base, text: null };
  }

  const state = {
    ask: v.topOfBookPrice, maximumAcceptablePrice: v.maximumAcceptablePrice, forecastHash: fc0.sealHash,
    classification: evalResult.verdict === "PRICE_TOO_HIGH" ? "PRICE_TOO_HIGH" : opts.classification,
    lane: opts.lane || "core", stakePercent: opts.fraction != null ? opts.fraction * 100 : null,
    topTicker: base.ticker, stale: false, pipelineFailed: false, withinEnvelope: true, verdict: evalResult.verdict,
  };

  if (evalResult.verdict === "PRICE_TOO_HIGH") {
    return { ...base, text: TM.priceTooHigh({ recommendedFirst, ask: v.topOfBookPrice, maximumAcceptablePrice: v.maximumAcceptablePrice }), state };
  }
  // BUY
  const text = TM.buyInstruction({
    classification: opts.classification, stake: opts.stake, bankroll: EN.BANKROLL.amount,
    recommendedFirst, buyLine: `${rec} YES`,
    ask: v.topOfBookPrice, maximumAcceptablePrice: v.maximumAcceptablePrice,
    whyOne: opts.whyOne, riskOne: opts.riskOne,
    centralProb: v.systemCentralProbability, rangeLow: range.low, rangeHigh: range.high,
    approxContracts: opts.approxContracts, cardExposureRemaining: opts.cardExposureRemaining,
    dashboard: opts.dashboard, whyRankedFirst: opts.whyRankedFirst,
  });
  return { ...base, text, state };
}

let fc0 = null;   // the current forecast, so the helper can read its sealHash without threading it through

async function main() {
  const fPath = process.argv[2];
  if (!fPath || !fs.existsSync(fPath)) fail("usage: node run-entertainment-alerts.js <forecast.json> [--send]");
  const wantSend = process.argv.includes("--send");

  // Read the forecast BEFORE the gate: the gate cannot decide whether the freshness attestation is
  // about this card until it knows which card this is.
  const fc = JSON.parse(fs.readFileSync(fPath, "utf8"));
  fc0 = fc;   // let buildActionMessage read the seal hash
  const gate = armingGate(fc.card && fc.card.eventId, fc.sealHash);

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
  const rawMarkets = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" }).catch((e) => fail(`kalshi: ${e.message}`));
  // Evaluate only genuine fight-OUTCOME markets. This board is already KXUFCFIGHT-only, but the guard
  // is explicit so a future discovery expansion cannot price a KXFIGHTMENTION commentary prop — same
  // event codes, strikes named "Knockout"/"Decision", resolves on what the announcers say — as a bet.
  const disc = C.admissibleFightMarkets(rawMarkets);
  const markets = rawMarkets.filter((m) => disc.admitted.some((a) => a.ticker === m.ticker));
  if (disc.rejected.length) {
    say(`  refused ${disc.rejected.length} non-outcome contract(s):`);
    for (const r of disc.rejected.slice(0, 5)) say(`     ⛔ ${r.ticker}: ${r.reason}`);
  }
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
  const explorationCandidates = [];
  const XP = require("./lib/exploration");
  const explorationOn = XP.enabled();
  if (explorationOn) say(`[2] EXPLORATION lane ENABLED — creative speculative positions will be evaluated (capped, $3/$4/$5)`);
  for (const c of mapped) {
    const f = fc.forecasts.find((x) => x.boutId === c.boutId);
    let ob = null;
    try { ob = await k.orderbook(c.ticker); } catch (e) { /* handled by the valuer */ }
    const v = V.valueContract(c, f, ob, { contracts: 100, nowTs, maxSnapshotAgeMs: 30 * 60 * 1000 });
    v.contract = c;
    v.mechanisms = f && f.appliedAdjustments ? [...new Set(f.appliedAdjustments.filter((a) => a.finalAppliedLogOdds > 0).map((a) => a.mechanism))] : [];
    valued.push(v);
    // EXPLORATION lane: value the SAME contract against the creative probability, reusing every
    // mechanical gate (fees, stale-baseline, liquidity, identity) inside valueContract. Only when the
    // bout carries an active creative hypothesis.
    if (explorationOn && f && f.exploration && f.exploration.activeHypotheses > 0) {
      const vx = V.valueContract(c, f, ob, { contracts: 100, nowTs, maxSnapshotAgeMs: 30 * 60 * 1000, useExploration: true });
      vx.contract = c;
      explorationCandidates.push({ valued: vx, boutId: c.boutId, ticker: c.ticker, exploration: f.exploration });
    }
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
    const built = buildActionMessage(top, f, {
      classification: top.entertainment.tierLabel || "EXPERIMENTAL", stake: top.entertainment.stake,
      fraction: top.entertainment.percentOfBankroll / 100, lane: "core",
      whyOne: TM.toReasons(why)[0] || "the ranked contract clears the research gates after fees",
      riskOne: TM.toReasons(against)[0] || "the forecast has not demonstrated a prospective edge",
      whyRankedFirst: onThisFight.length > 1 ? "best conservative value after costs on this fight" : null,
      approxContracts: top.entertainment.contracts,
    });
    if (built.verdict === "FAIL_CLOSED") continue;   // contradictory recommendation — never a message
    const key = `${boutId}|${top.ticker}`;
    const decision = AL.shouldSend(key, built.state);
    messages.push({ boutId, ticker: top.ticker, wouldSend: decision.send, why: decision.why, text: built.text, state: built.state, verdict: built.verdict });
  }

  // ---- EXPLORATION LANE positions -------------------------------------------------------------
  // Classify + size the creative candidates, apply the $5/fight $10/card exposure caps, and build a
  // buy instruction for each tiered position. They flow through the SAME alert ledger and Telegram
  // path as core, so dedup / price-cross / withdrawal triggers apply identically.
  const explorationMessages = [];
  if (explorationOn && explorationCandidates.length) {
    const sized = explorationCandidates.map((cand) => ({ ...cand, sized: XP.classifyAndSize(cand.valued, cand.exploration) }));
    // Keep the single best-tier candidate per bout, then cap exposure.
    const bestByBout = {};
    for (const s of sized) {
      if (!s.sized || s.sized.stake <= 0) continue;
      const cur = bestByBout[s.boutId];
      if (!cur || s.sized.stake > cur.sized.stake) bestByBout[s.boutId] = s;
    }
    const { positions: capped2, cardExposure } = XP.applyExposureCaps(Object.values(bestByBout));
    say(`\n[3b] EXPLORATION positions: ${capped2.filter((p) => p.sized.stake > 0).length} tiered, card exposure $${cardExposure} (cap $10)`);
    for (const p of capped2) {
      if (!p.sized || p.sized.stake <= 0) continue;
      const f = fc.forecasts.find((x) => x.boutId === p.boutId);
      const v = p.valued;
      // One short reason and one short risk — plain language, no lane names or taxonomy.
      const whyOne = shortHypothesis(p.sized.hypothesis);
      const riskOne = p.sized.evidenceAgainst && p.sized.evidenceAgainst !== "none recorded"
        ? p.sized.evidenceAgainst
        : `Based on ${p.sized.independentOrigins} uncorroborated origin`;
      const built = buildActionMessage(v, f, {
        classification: p.sized.tier, stake: p.sized.stake, fraction: p.sized.fraction, lane: "exploration",
        whyOne, riskOne, approxContracts: v.maxFillable != null ? Math.floor(p.sized.stake / (v.allInPrice || 1)) : null,
        cardExposureRemaining: +(XP.RULES.caps_exposure.maxPerCardDollars - cardExposure).toFixed(2),
      });
      // A creative candidate that fails the invariants is not sent as anything betting; it just drops.
      if (built.verdict === "FAIL_CLOSED") continue;
      const key = `explore|${p.boutId}|${p.ticker}`;
      const decision = AL.shouldSend(key, built.state);
      explorationMessages.push({ boutId: p.boutId, ticker: p.ticker, key, wouldSend: decision.send, why: decision.why, text: built.text, state: built.state, lane: "exploration", verdict: built.verdict });
    }
    for (const m of explorationMessages) messages.push(m);
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
  // The REAL money ledger (separate from the paper book). A buy instruction that is actually delivered
  // is recorded as RECOMMENDED_NOT_CONFIRMED — the system told the human what to buy; it has NOT been
  // confirmed placed and contributes $0 to the real P&L until the human confirms. A parallel RECORD of
  // what was sent; it does not change what is decided or sent.
  const mbState = MB.load();
  let mbTouched = false;
  if (wantSend && gate.armed && anything) {
    const notify = require("./lib/notify");   // Telegram ONLY. There is no trading API in this build.
    delivery.transport = "telegram (manual instruction + human review)";
    for (const m of toSend) {
      delivery.attempted++;
      try {
        await notify.notify(m.text); delivery.delivered++; delivery.buyInstructions++;
        AL.record(m.key || `${m.boutId}|${m.ticker}`, m.state, "BUY_INSTRUCTION");
        // Only a BUY becomes a real-money RECOMMENDED_NOT_CONFIRMED entry. A PRICE_TOO_HIGH notice is
        // explicitly "do not buy" — it must never be recorded as a recommendation to place.
        if (m.verdict === "BUY" || m.verdict === undefined) {
          MB.recordRecommendation(mbState, {
            key: m.key || `${m.boutId}|${m.ticker}`, boutId: m.boutId, ticker: m.ticker,
            fight: (fc.forecasts.find((x) => x.boutId === m.boutId) || {}).fight,
            lane: m.lane || "core", classification: m.state.classification,
            recommendedFraction: m.state.stakePercent != null ? m.state.stakePercent / 100 : null,
            recommendedStakeDollars: m.state.stakePercent != null ? +(EN.BANKROLL.amount * m.state.stakePercent / 100).toFixed(2) : null,
            maximumAcceptablePrice: m.state.maximumAcceptablePrice, ask: m.state.ask, forecastHash: fc.sealHash,
          });
          mbTouched = true;
        }
      }
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
  if (mbTouched) MB.save(mbState);   // persist the real-money ledger (recommendations recorded this run)

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
