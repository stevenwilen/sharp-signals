// FIGHT-INTELLIGENCE PIPELINE (§13). The one place that runs the whole lifecycle in order, the SAME
// way in manual and cloud modes: discover → research → assess → forecast effect → market reaction →
// classify → persist → (message). It reuses the tested modules; it does not re-implement any of them.
//
// TWO GATES:
//   FIGHT_INTEL_ENABLED  — is the lifecycle on at all (records + dashboard).
//   send                 — may it send Telegram. In SHADOW MODE (enabled but not sending) it populates
//                          records and the dashboard and touches the phone with NOTHING. The old HUMAN
//                          REVIEW path keeps running untouched until this is switched on for real.
require("./env");
const I = require("./intelligence");
const IR = require("./intel-research");
const IF = require("./intel-forecast");
const IMK = require("./intel-market");
const IM = require("./intel-messages");
const N = require("./notification");

function enabled() { return process.env.FIGHT_INTEL_ENABLED === "1"; }

// Run one cycle. opts:
//   card, batch (I.ingest batch: {eventId, now, bouts:[{boutId, fight, opponentOf, topics, ...}]}),
//   forecastByBout {boutId -> sealed bout forecast}, marketByBout {boutId -> {kalshiAsk, sportsbook, ts,
//     maximumAcceptablePrice, subject, betQualifies, priceFavorable, fightStarted, bet}},
//   seal, now, send (bool), provider (research), notifier (send fn), dashboard, persist (default true).
async function runIntel(opts) {
  const { card, batch, forecastByBout = {}, marketByBout = {}, seal, now, dashboard } = opts;
  const send = !!opts.send;
  const notifier = opts.notifier || ((text, o) => require("./notify").notify(text, o));
  const prior = I.load(card);

  // 1) DISCOVER — match/create records and their proposition signatures (ephemeral; re-run below with
  //    full context). This is how we learn each story's id before researching it.
  const discover = I.ingest(prior, { ...batch, now });

  // 2) ENRICH each story: research it, link its forecast effect, capture the market reaction.
  const confirmedByBout = {}, disprovedByBout = {}, ctxByBout = {}, enrich = {};
  for (const r of discover.results) {
    const rec = discover.store.records[r.id];
    const boutId = rec.boutId;
    const research = await IR.research(rec, { seal, provider: opts.provider });
    const bf = forecastByBout[boutId] || null;
    const link = bf ? IF.linkForecast(rec, bf) : { forecastImpact: null, forecastImpactPoints: 0, helps: rec.outcomeAffected && rec.outcomeAffected.helps };
    const mk = marketByBout[boutId] || {};
    const snap = { kalshiAsk: mk.kalshiAsk, sportsbook: mk.sportsbook, ts: now };
    const withMarket = (rec.kalshiBefore == null && rec.sportsbookBefore == null) ? IMK.recordBefore(rec, snap) : IMK.recordAfter(rec, snap);
    const mc = IMK.marketContext(withMarket, { maximumAcceptablePrice: mk.maximumAcceptablePrice, subject: mk.subject });

    const ctx = {
      forecastImpactPoints: link.forecastImpactPoints,
      marketMovedBeyondMax: mc.marketMovedBeyondMax,
      priceFavorable: mk.betQualifies ? (mc.valueRemainsAfterFees !== false) : false,
      betQualifies: !!mk.betQualifies,
      unreachable: !!research.inaccessible,
      priorRecommendationInvalidated: !!mk.priorRecommendationInvalidated,
      fightStarted: !!mk.fightStarted, marketSuspended: !!mk.marketSuspended,
    };
    const assessOpts = IR.toAssessOpts(research);
    const sig = r.proposition;
    (ctxByBout[boutId] = ctxByBout[boutId] || {})[sig] = ctx;
    if (assessOpts.confirmed) (confirmedByBout[boutId] = confirmedByBout[boutId] || []).push(sig);
    if (assessOpts.disproved) (disprovedByBout[boutId] = disprovedByBout[boutId] || []).push(sig);
    enrich[r.id] = {
      research, forecastImpact: link.forecastImpact, helps: link.helps,
      forecastVersion: bf && (bf.sealHash || bf.forecastId),
      market: { kalshiBefore: withMarket.kalshiBefore, kalshiAfter: withMarket.kalshiAfter, sportsbookBefore: withMarket.sportsbookBefore, sportsbookAfter: withMarket.sportsbookAfter },
      mc, mk,
    };
  }

  // 3) FINALIZE — re-ingest from the PRIOR store with the full context, so status/action reflect the
  //    research verdict, the forecast move and the market reaction.
  const finalBatch = {
    ...batch, now,
    bouts: (batch.bouts || []).map((b) => ({
      ...b,
      confirmedKeys: [...(b.confirmedKeys || []), ...(confirmedByBout[b.boutId] || [])],
      disprovedKeys: [...(b.disprovedKeys || []), ...(disprovedByBout[b.boutId] || [])],
      actionCtxByKey: { ...(b.actionCtxByKey || {}), ...(ctxByBout[b.boutId] || {}) },
    })),
  };
  const final = I.ingest(prior, finalBatch);

  // 4) ATTACH the enrichment fields ingest does not compute (research lineage, forecast object, market
  //    snapshots), and record forecast versions influenced.
  for (const r of final.results) {
    const e = enrich[r.id]; if (!e) continue;
    const rec = final.store.records[r.id];
    let merged = IR.attachResearch(rec, e.research);
    merged.forecastImpact = e.forecastImpact;
    if (e.forecastVersion) merged.forecastVersions = [...new Set([...(merged.forecastVersions || []), e.forecastVersion])];
    merged.kalshiBefore = e.market.kalshiBefore; merged.kalshiAfter = e.market.kalshiAfter;
    merged.sportsbookBefore = e.market.sportsbookBefore; merged.sportsbookAfter = e.market.sportsbookAfter;
    final.store.records[r.id] = merged;
  }

  // 5) MESSAGE — only when enabled AND sending. In shadow mode this whole block is skipped and the phone
  //    receives nothing (the old HUMAN REVIEW path is unchanged).
  const messages = [];
  const shadow = !(enabled() && send);
  if (!shadow) {
    for (const r of final.results) {
      const rec = final.store.records[r.id];
      const prev = prior.records[r.id] || null;
      const e = enrich[r.id] || { mk: {}, mc: { marketReaction: {} }, helps: null };
      const decision = IM.shouldAlert(prev, rec, { fightStarted: e.mk.fightStarted, marketSuspendedFinal: e.mk.marketSuspended });
      if (!decision.alert) continue;
      const built = IM.buildIntelMessage(rec, {
        bet: e.mk.bet, forecastImpactPoints: (e.forecastImpact && e.forecastImpact.impactPointsTowardHelps / 100) || 0,
        helps: e.helps, marketReaction: e.mc.marketReaction, recommendedFirst: e.mk.recommendedFirst, reason: e.mk.reason,
        whyMatters: e.mk.whyMatters, dashboard,
      });
      if (!built.text) continue;
      // Compact notifications (opt-in): bet events (SPECULATIVE_BET / PRICED_OUT / WITHDRAWN) PUSH a short
      // ping; pure forecast-movement events (WATCH / MARKET_MOVED / CONFIRMED / DISPROVED /
      // HUMAN_ACTION_REQUIRED) are DASHBOARD-ONLY. BUT once this record has pushed a bet to the phone, a
      // later disproval / suspension / market-move is a STAND-DOWN and must still reach the phone — so
      // forSendIntel promotes it to a push rather than suppressing it. Legacy mode sends built.text.
      const droveBet = (rec.telegramLineage || []).some((m) => m.type === "SPECULATIVE_BET");
      const body = N.forSendIntel(built.text, built.threadKind, droveBet);
      if (!body) continue;
      // Thread the update under this record's original alert, per recipient.
      const replyTo = {}; for (const m of rec.telegramLineage || []) if (m.chatId && m.messageId) replyTo[m.chatId] = m.messageId;
      const out = await notifier(body, Object.keys(replyTo).length ? { replyTo } : {});
      const lineage = [...(rec.telegramLineage || [])];
      for (const m of (out && out.messages) || []) lineage.push({ chatId: m.chatId, messageId: m.messageId, type: built.threadKind, sentAt: now });
      rec.telegramLineage = lineage;
      messages.push({ id: r.id, threadKind: built.threadKind, text: built.text, action: rec.actionStatus });
    }
  }

  const store = { ...final.store, updatedAt: now };
  if (opts.persist !== false) I.save(card, store);
  return { store, results: final.results, messages, shadow, enabled: enabled() };
}

module.exports = { runIntel, enabled };
