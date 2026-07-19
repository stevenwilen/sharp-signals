// COMBO PIPELINE — gather the SEALED active BUY legs, run the engine on every eligible combination,
// pick the best decision, dedupe, persist an audit record, and (only when enabled + sending) deliver
// one Telegram message. Reads sealed artifacts only; never recomputes or re-seals a forecast; never
// places anything.
require("./env");
const fs = require("fs");
const path = require("path");
const CE = require("./combo-engine");
const CQ = require("./combo-quote");
const TM = require("./telegram-messages");
const N = require("./notification");
const MB = require("./manual-bankroll");
const FR = require("./freshness");
const { paths, readJson, writeJson } = require("./store");

const AUDIT_FILE = () => path.join(paths.data, "combo-audit.json");
const c = (x) => `${Math.round(x * 100)}¢`;

function enabled() { return process.env.COMBO_ENABLED === "1"; }

// The conservative probability of the RECOMMENDED side of a bout = the sealed systemRange low for that
// side. (A is systemRange.forFighter; B is 1 - high.) This is the SAME number the single sizes on.
function conservativeProbFor(forecast, recommendedFighter) {
  const sr = forecast.systemRange;
  if (!sr) return null;
  const A = String(forecast.fight || "").split(" vs ")[0];
  const N = (s) => String(s || "").toLowerCase().trim();
  if (N(recommendedFighter) === N(A) || N(recommendedFighter) === N(sr.forFighter)) return sr.low;
  return +(1 - sr.high).toFixed(4);
}

// Assemble eligible BUY legs from the sealed decision artifacts across all active cards. A leg is
// eligible only if it is a live BUY (verdict BUY), still below its max, not started, not withdrawn.
function gatherLegs(opts = {}) {
  const dataDir = paths.data;
  const now = opts.now || Date.now();
  const files = fs.readdirSync(dataDir).filter((f) => /^entertainment-alerts-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const mb = MB.load();
  const legs = [];
  for (const f of files) {
    const eventDate = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
    if (FR.fightStarted(eventDate, now)) continue;   // the whole card has begun — no combos
    const alerts = readJson(path.join(dataDir, f), null);
    const forecast = readJson(path.join(dataDir, `forecast-${eventDate}.json`), null);
    if (!alerts || !forecast) continue;
    for (const b of alerts.buyInstructions || []) {
      if (b.verdict !== "BUY") continue;   // PRICE_TOO_HIGH / FAIL_CLOSED are not eligible legs
      const fc = (forecast.forecasts || []).find((x) => x.boutId === b.boutId);
      if (!fc) continue;
      const recommended = String(b.text.match(/^Buy: (.+?) YES$/m)?.[1] || "").trim() || (fc.fight || "").split(" vs ")[0];
      const cons = conservativeProbFor(fc, recommended);
      if (cons == null || !(cons > 0 && cons < 1)) continue;
      // exposure: this leg's own single stake (if recorded RECOMMENDED/PLACED)
      const mbEntry = Object.values(mb.entries || {}).find((e) => e.ticker === b.ticker);
      const singleStake = mbEntry && ["RECOMMENDED_NOT_CONFIRMED", "MANUALLY_PLACED"].includes(mbEntry.status) ? (mbEntry.actualStake || mbEntry.recommendedStakeDollars || 0) : 0;
      legs.push({
        ticker: b.ticker, boutId: b.boutId, eventDate, fighter: recommended, fight: fc.fight,
        conservativeProb: cons, ask: b.state.ask, maximumAcceptablePrice: b.state.maximumAcceptablePrice,
        classification: b.state.classification, forecastHash: forecast.sealHash,
        strongSupport: /strong|best|maximum/i.test(b.state.classification || ""),
        fightStarted: FR.fightStarted(eventDate, now), eligibleSingle: true,
        singleStakeDollars: singleStake,
      });
    }
  }
  return { legs, mb };
}

// Existing per-card exposure in dollars (recommended + placed singles) for the legs' cards.
function cardExposure(mb, eventDates) {
  let sum = 0;
  for (const e of Object.values(mb.entries || {})) {
    if (!["RECOMMENDED_NOT_CONFIRMED", "MANUALLY_PLACED"].includes(e.status)) continue;
    sum += e.actualStake || e.recommendedStakeDollars || 0;
  }
  return +sum.toFixed(2);
}

// A stable dedup key: exact leg set + side + sealed forecast versions + the maximum price.
function comboKey(legs, maxBuyPrice) {
  const N = (s) => String(s || "").toLowerCase().trim();
  const set = legs.map((l) => `${N(l.fighter)}@${l.forecastHash}`).sort().join("+");
  return `combo|${set}|YES|max${Math.round((maxBuyPrice || 0) * 100)}`;
}

function legLabel(l) { return `${l.fighter} YES (${l.fight})`; }

// Run one cycle. opts: { now, send, quoteProvider, notifier, persist }.
async function runCombo(opts = {}) {
  const now = opts.now || Date.now();
  const { legs, mb } = gatherLegs({ now });
  const audit = readJson(AUDIT_FILE(), { schemaVersion: 1, records: {} });
  const results = [];

  if (legs.length < 2) {
    return { decision: CE.DECISION.NO_BET, reason: `fewer than 2 eligible BUY legs (${legs.length}) — no combo to analyze`, legs: legs.length, results, sent: [] };
  }

  const combos = CE.eligibleCombos(legs);
  const evaluated = [];
  for (const set of combos) {
    const eventDates = [...new Set(set.map((l) => l.eventDate))];
    const exposure = { existingCardExposureDollars: cardExposure(mb, eventDates) };
    const quote = await CQ.getComboQuote(set, { provider: opts.quoteProvider });
    const r = CE.evaluateCombo(set, quote, exposure, { now });
    evaluated.push({ set, r });
  }
  // Best decision: a BUY beats a PRICE_TOO_HIGH beats NO_BET beats UNAVAILABLE; among BUYs, most edge.
  const rank = { COMBO_BUY: 3, COMBO_PRICE_TOO_HIGH: 2, NO_COMBO_BET: 1, COMBO_UNAVAILABLE: 0 };
  evaluated.sort((a, b) => (rank[b.r.decision] - rank[a.r.decision]) || ((b.r.pricing?.edgeAtQuote || -1) - (a.r.pricing?.edgeAtQuote || -1)));
  const best = evaluated[0];

  // Build the message for the best decision.
  let text = null, kind = best.r.decision, key = null;
  const legs2 = best.set.map(legLabel);
  const singles = best.set.filter((l) => l.singleStakeDollars > 0).map((l) => `${l.fighter} — $${l.singleStakeDollars} recommended`);
  if (best.r.decision === CE.DECISION.BUY) {
    const p = best.r.pricing, s = best.r.staking;
    key = comboKey(best.set, p.maxBuyPrice);
    text = TM.comboBuy({
      legs: legs2, quote: best.r.quote.yesAsk, fairPrice: p.fairPrice, maxBuyPrice: p.maxBuyPrice,
      stake: s.stakeDollars, contracts: s.contracts, maxPayout: s.maxPayoutDollars,
      estProfit: +(s.contracts * (1 - best.r.quote.yesAsk) - s.contracts * CE.perContractFee(best.r.quote.yesAsk)).toFixed(2),
      correlation: best.r.correlation.class, whyOne: best.r.reason,
      existingSingles: singles, totalCardExposure: s.totalCardExposureAfterDollars, cardCap: CE.POLICY.cardCapDollars,
    });
  } else if (best.r.decision === CE.DECISION.PRICE_TOO_HIGH) {
    key = comboKey(best.set, best.r.audit.pricing.maxBuyPrice);
    text = TM.comboPriceTooHigh({ legs: legs2, quote: best.r.audit.pricing.liveQuote, maxBuyPrice: best.r.audit.pricing.maxBuyPrice, requiredImprovement: best.r.requiredImprovement });
  } else if (best.r.decision === CE.DECISION.UNAVAILABLE) {
    text = TM.comboUnavailable({ legs: legs2, reason: best.r.reason });
  } else {
    text = TM.noComboBet({ reason: best.r.reason });
  }

  // Persist the full audit record for the chosen combo.
  const recId = key || `combo|${legs2.join("+")}|${kind}`;
  audit.records[recId] = { at: new Date(now).toISOString(), decision: kind, reason: best.r.reason, audit: best.r.audit, legs: legs2 };
  if (opts.persist !== false) writeJson(AUDIT_FILE(), audit);

  // Deliver — only when enabled AND sending AND this exact combo state hasn't already been sent.
  const sent = [];
  const shadow = !(enabled() && opts.send);
  // Dedup: only actionable/awareness messages that change; UNAVAILABLE/NO_BET are quiet unless a prior
  // actionable combo now needs a withdrawal.
  const prevSentKey = audit.lastSentKey || null;
  const shouldSend = !shadow && text
    && [CE.DECISION.BUY, CE.DECISION.PRICE_TOO_HIGH].includes(kind)
    && key && key !== prevSentKey;
  // Withdrawal: a previously-sent combo BUY/PRICE key that is no longer the current actionable combo.
  if (!shadow && prevSentKey && (!key || key !== prevSentKey) && audit.lastSentActionable) {
    const wtext = TM.comboWithdrawn({ legs: audit.lastSentLegs || [], reason: "the combo no longer qualifies or the quote/legs changed" });
    const out = await (opts.notifier || defaultNotify)(N.forSend(wtext, "COMBO_WITHDRAWN"));
    if (out && out.ok) { sent.push({ kind: "COMBO_WITHDRAWN" }); audit.lastSentActionable = false; }
  }
  if (shouldSend) {
    // Compact notifications (opt-in) replace the full combo body with a short ping; both sendable combo
    // states (BUY / PRICE_TOO_HIGH) push, so forSend never returns null here. Legacy mode sends `text`.
    const out = await (opts.notifier || defaultNotify)(N.forSend(text, kind));
    if (out && out.ok) {
      sent.push({ kind, key });
      audit.lastSentKey = key; audit.lastSentActionable = true; audit.lastSentLegs = legs2;
      // A COMBO BUY is a SEPARATE manual recommendation — recorded RECOMMENDED_NOT_CONFIRMED, $0 real
      // P&L until the human confirms. Never auto-counted, never auto-placed.
      if (kind === CE.DECISION.BUY) {
        MB.recordRecommendation(mb, { key, ticker: key, boutId: "combo", fight: legs2.join(" + "),
          lane: "combo", classification: "COMBO", recommendedStakeDollars: best.r.staking.stakeDollars,
          maximumAcceptablePrice: best.r.pricing.maxBuyPrice, ask: best.r.quote.yesAsk, forecastHash: best.set.map((l) => l.forecastHash).join(",") });
        MB.save(mb);
      }
    }
  }
  if (opts.persist !== false) writeJson(AUDIT_FILE(), audit);

  return { decision: kind, reason: best.r.reason, best: best.r, legs: legs.length, combosAnalyzed: combos.length, results: evaluated.map((e) => e.r.decision), shadow, sent, text };
}

function defaultNotify(text) { return require("./notify").notify(text); }

module.exports = { runCombo, gatherLegs, conservativeProbFor, comboKey, enabled, AUDIT_FILE };
