// SPECULATIVE RESEARCH RUNNER — the ONE-WAY research adapter. Spawned by dispatch.js as a child process
// (never require()d by production), it reads SEALED production artifacts + read-only production calc,
// applies the deterministic research profile, and writes ONLY its own artifacts:
//   data/research-ledger.json      the isolated $10k experiment ledger
//   data/research-health.json       the never-silent health receipt
//   data/research-exploration-<CARD>.json  (only when RESEARCH_EXPLORATION_ENABLED=1)
// It NEVER writes forecast/alerts/intel/combo/bankrolls, never sends Telegram, never touches real or
// normal-paper money, and has no Kalshi write path (settlement + orderbook reads only).
//
//   node run-research.js [--settle] [--now=<ISO>] [--card=<eventDate>]
//
// FAIL-CLOSED ACTIVATION. Runs only when RESEARCH_ENABLED=1 AND RESEARCH_MODE in {OBSERVE,PAPER}. Absent
// or unrecognized => DISABLED (does nothing but write a health receipt). Ships DISABLED. OBSERVE builds
// observations + eligibility and reports what WOULD fund, creating no positions and changing no balance.
// PAPER creates + settles funded positions and stamps the official prospective start once.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { paths, readJson } = require("./lib/store");
const RL = require("./lib/research-ledger");
const C = require("./lib/contracts");
const FR = require("./lib/freshness");

const say = (s) => process.stdout.write(s + "\n");
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);
const argv = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const HEALTH = path.join(paths.data, "research-health.json");
const PROFILE_VERSION = process.env.RESEARCH_PROFILE_VERSION || "research-profile-v1";
const CORE_TIER_FRACTION = { "standard experimental": 0.03, "strong experimental": 0.04, "rare maximum": 0.05 };

function resolveMode() {
  if (process.env.RESEARCH_ENABLED !== "1") return RL.MODES.DISABLED;         // fail-closed: opt-in only
  const m = String(process.env.RESEARCH_MODE || "").toUpperCase();
  return m === RL.MODES.OBSERVE || m === RL.MODES.PAPER ? m : RL.MODES.DISABLED;
}
function activeCard() {
  const forced = argv("card");
  if (forced) return { eventDate: forced };
  const r = readJson(path.join(paths.data, "dispatch-receipts.json"), null);
  return r && r.lastCard ? r.lastCard : null;
}
function fileHash(file) { try { return sha(fs.readFileSync(file)); } catch { return "0"; } }
// Deterministic fingerprint over every input the research runner consumes, plus the profile + mode, so a
// new intel/combo record triggers a run without waiting for an unrelated forecast/alert cycle, and an
// unchanged input set safely skips.
function inputFingerprint(eventDate, mode) {
  const f = (n) => fileHash(path.join(paths.data, n));
  // INPUTS only — never the runner's OWN outputs. research-exploration-<CARD>.json is an OUTPUT this run
  // rewrites with a fresh timestamp, so hashing it would self-invalidate the fingerprint and defeat the
  // skip. evidence-eval is the real upstream input the shadow-exploration pass reads.
  return sha([
    f(`forecast-${eventDate}.json`), f(`entertainment-alerts-${eventDate}.json`),
    f(`intelligence-${eventDate}.json`), f("combo-audit.json"),
    f(`evidence-eval-${eventDate}.json`), PROFILE_VERSION, mode,
    process.env.RESEARCH_EXPLORATION_ENABLED === "1" ? "xp1" : "xp0",
  ].join("|"));
}
function writeHealth(h) {
  const tmp = HEALTH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2));
  fs.renameSync(tmp, HEALTH);
}

// ---- signal extraction (read-only from sealed artifacts) -------------------------------------
const fighterFromText = (t) => (String(t || "").match(/^Buy:\s+(.+?)\s+YES$/m) || [])[1] || null;
const opponentFromFight = (fight, subject) => {
  const parts = String(fight || "").split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  return parts.find((p) => p.trim().toLowerCase() !== String(subject || "").trim().toLowerCase()) || null;
};

// CORE_BUY (copied so incremental value can be isolated) + UNCONFIRMED_CANDIDATE (PRICE_TOO_HIGH), both
// from the sealed alerts artifact's real top-of-book ask. Deterministic; no network.
function fromAlerts(alerts, forecast, eventDate, nowMs) {
  if (!alerts || !Array.isArray(alerts.buyInstructions)) return [];
  const snapTs = alerts.snapshotTimestamp || null;
  const priceStatus = snapTs ? FR.marketPriceStatus({ snapshotTs: snapTs, now: nowMs }).status : FR.S.WAITING;
  const fightStartTimestamp = `${eventDate}T22:00:00Z`;
  const postBell = FR.fightStarted(eventDate, nowMs);
  const obs = [];
  for (const b of alerts.buyInstructions) {
    const st = b.state || {};
    const fc = (forecast.forecasts || []).find((x) => x.boutId === b.boutId) || {};
    const fighter = fighterFromText(b.text) || null;
    const prob = fighter && fc.systemCentral ? num(fc.systemCentral[fighter]) : null;
    const opponent = opponentFromFight(fc.fight, fighter);
    const base = {
      signalId: b.key || `${b.boutId}|${b.ticker}`, event: forecast.eventId || eventDate, eventDate,
      market: b.ticker, ticker: b.ticker, side: "YES", fighter, opponent, fight: fc.fight || null,
      estProbability: prob, marketPriceTimestamp: snapTs, marketPriceStatus: priceStatus, askSource: "SEALED_ALERT",
      signalTimestamp: snapTs, forecastHash: st.forecastHash || null, sealedForecastVersion: forecast.version || st.forecastHash || null,
      fightStartTimestamp, postBell, cutoffSource: RL.CUTOFF.CARD, recommendationId: `${b.boutId}|${b.ticker}`,
    };
    const lane = st.lane || (CORE_TIER_FRACTION[st.classification] ? "core" : null);
    if (b.verdict === "BUY" && lane === "core") {
      obs.push({ ...base, category: "CORE_BUY", observedAsk: num(st.ask),
        coreFraction: st.stakePercent != null ? st.stakePercent / 100 : CORE_TIER_FRACTION[st.classification] || null,
        qualifiedReason: `formal core BUY (${st.classification || "core"})`, reasonProductionRejected: null });
    } else if (st.classification === "PRICE_TOO_HIGH") {
      obs.push({ ...base, category: "UNCONFIRMED_CANDIDATE", observedAsk: num(st.ask),
        productionMaximumAcceptablePrice: num(st.maximumAcceptablePrice),
        qualifiedReason: "production wanted it but the price was above the maximum acceptable",
        reasonProductionRejected: `PRICE_TOO_HIGH: ask ${st.ask} > max acceptable ${st.maximumAcceptablePrice}` });
    }
  }
  return obs;
}

// EXPERIMENTAL_COMBO — structurally-acceptable non-BUY combos, entered ONLY on a real fresh liveQuote.
function fromCombo(eventDate, nowMs) {
  const audit = readJson(path.join(paths.data, "combo-audit.json"), null);
  if (!audit || !audit.records) return [];
  const obs = [];
  for (const rec of Object.values(audit.records)) {
    if (rec.decision === "COMBO_BUY") continue;                        // that is the paper ledger's job
    const est = (rec.audit && rec.audit.estimate) || {};
    if (!est.structurallyAcceptable) continue;
    const pr = (rec.audit && rec.audit.pricing) || {};
    const liveQuote = num(pr.liveQuote);
    const quoteTs = pr.quoteTs || null;
    const status = quoteTs ? FR.marketPriceStatus({ snapshotTs: quoteTs, now: nowMs }).status : FR.S.WAITING;
    const key = `combo|${(rec.legs || []).join("+")}`;
    obs.push({
      signalId: key, event: eventDate, eventDate, market: key, ticker: key, side: "YES",
      fighter: null, opponent: null, fight: (rec.legs || []).join(" + "), category: "EXPERIMENTAL_COMBO",
      estProbability: num(est.combinedProb), observedAsk: liveQuote, marketPriceTimestamp: quoteTs, marketPriceStatus: status,
      askSource: "SEALED_COMBO", signalTimestamp: rec.at || null, forecastHash: null, sealedForecastVersion: null,
      fightStartTimestamp: `${eventDate}T22:00:00Z`, postBell: FR.fightStarted(eventDate, nowMs), cutoffSource: RL.CUTOFF.CARD,
      recommendationId: key, qualifiedReason: `structurally acceptable combo, not bought (${rec.decision})`,
      reasonProductionRejected: rec.reason || rec.decision,
    });
  }
  return obs;
}

// WATCH_EXPERIMENT — directional intel. The sealed intel record has no ticker and its kalshiBefore.ask is
// a subject-side implied probability, not an executable quote, so a funded WATCH REQUIRES resolving the
// live market + a genuine executable ask + a system probability. Network; fail-soft (any gap -> the signal
// simply carries no usable ask and becomes OBSERVED_NO_ENTRY downstream).
async function fromIntel(eventDate, forecast, nowMs) {
  const intel = readJson(path.join(paths.data, `intelligence-${eventDate}.json`), null);
  if (!intel || !intel.records) return [];
  const M = require("./lib/match");
  const K = require("./lib/kalshi");
  const obs = [];
  for (const rec of Object.values(intel.records)) {
    if (rec.actionStatus !== "WATCH" && rec.actionStatus !== "SPECULATIVE_BET") continue;
    const subject = rec.fighter || null;
    const opponent = (rec.outcomeAffected && rec.outcomeAffected.helps && rec.outcomeAffected.helps !== subject ? rec.outcomeAffected.helps : null) || opponentFromFight(rec.fight, subject);
    const base = {
      signalId: rec.intelligenceId, event: rec.eventId || eventDate, eventDate, market: null, ticker: null,
      side: null, sideReason: null, fighter: subject, opponent, fight: rec.fight || null, direction: rec.direction || "neutral",
      category: "WATCH_EXPERIMENT", estProbability: null, observedAsk: null, marketPriceTimestamp: null,
      marketPriceStatus: null, askSource: "LIVE_KALSHI", signalTimestamp: rec.firstSeenAt || null,
      forecastHash: forecast.forecastSealHash || null, sealedForecastVersion: forecast.version || null,
      fightStartTimestamp: `${eventDate}T22:00:00Z`, postBell: FR.fightStarted(eventDate, nowMs), cutoffSource: RL.CUTOFF.CARD,
      independentOrigins: num(rec.independentOrigins), recommendationId: rec.intelligenceId,
      qualifiedReason: `directional intel ${rec.direction} (${rec.actionStatus}, ${rec.independentOrigins} origins)`,
      reasonProductionRejected: `intel actionStatus ${rec.actionStatus} — production takes no position`,
    };
    let match = null;
    try { match = await M.matchToMarket({ pick: subject, opponent, domain: "mma", timestamp: rec.firstSeenAt }, { now: new Date(nowMs) }); } catch { match = null; }
    if (!match || !match.ok) { base.sideReason = (match && match.reason) || "could not resolve the Kalshi market for this bout"; obs.push(base); continue; }
    base.ticker = match.ticker; base.market = match.ticker;
    const map = RL.mapDirectionToSide({ about: subject, direction: rec.direction, contractYesFighter: match.fighter, contractNoFighter: match.opponent });
    base.side = map.side; base.sideReason = map.reason;
    // system probability for the resolved side (fail closed without one)
    const fc = (forecast.forecasts || []).find((x) => x.fight && match.fighter && x.fight.toLowerCase().includes(String(match.fighter).toLowerCase().split(" ").pop())) || {};
    if (base.side === "YES" && fc.systemCentral) base.estProbability = num(fc.systemCentral[match.fighter]);
    else if (base.side === "NO" && fc.systemCentral) base.estProbability = num(fc.systemCentral[match.opponent]);
    // executable ask for the resolved side
    if (base.side === "YES") { base.observedAsk = num(match.yesAsk); base.marketPriceTimestamp = new Date(nowMs).toISOString(); base.marketPriceStatus = FR.S.CURRENT; }
    else if (base.side === "NO") {
      try { const mk = await K.market(match.ticker); const px = C.readPrices((mk && (mk.market || mk)) || {}); base.observedAsk = num(px.noAsk); base.marketPriceTimestamp = new Date(nowMs).toISOString(); base.marketPriceStatus = FR.S.CURRENT; } catch { base.observedAsk = null; }
    }
    obs.push(base);
  }
  return obs;
}

// Research-only SHADOW exploration. Reuses the production exploration calc READ-ONLY on the already-sealed
// forecast + evidence, writes ONLY data/research-exploration-<CARD>.json, and never re-seals the forecast.
// Gated by RESEARCH_EXPLORATION_ENABLED=1 (independent of production EXPLORATION_ENABLED). Best-effort and
// fully wrapped: any failure degrades to "no exploration observations", never a crash and never a write to
// a production artifact.
async function fromExplorationShadow(eventDate, forecast, evidence, nowMs, healthNotes) {
  if (process.env.RESEARCH_EXPLORATION_ENABLED !== "1") return [];
  const out = [];
  const shadow = { card: eventDate, generatedAt: new Date(nowMs).toISOString(), source: "research-shadow-exploration", note: "READ-ONLY research artifact. Reuses lib/exploration calc on the sealed forecast+evidence. NEVER modifies forecast-<CARD>.json or any production output.", bouts: [] };
  try {
    const XP = require("./lib/exploration");
    const ADM = require("./lib/admission");
    const V = require("./lib/contract-value");
    const K = require("./lib/kalshi");
    const mech = (readJson(path.join(paths.data, "mechanism-reliability.json"), {}) || {}).mechanisms || [];
    const sealTs = forecast.sealTimestamp || forecast.sealTs || forecast.generatedAt || new Date(nowMs).toISOString();
    for (const fbout of forecast.forecasts || []) {
      try {
        const beRaw = (evidence.bouts || []).find((x) => x.boutId === fbout.boutId);
        const bout = fbout.bout || (beRaw && beRaw.bout) || null;
        if (!beRaw || !bout) continue;
        const A = bout.a && bout.a.name, B = bout.b && bout.b.name;
        const adm = ADM.admissibleEvidence(bout, beRaw, sealTs);
        const ca = XP.creativeAdjustment(adm.be, A, B, { reliabilityRecords: mech });
        if (!ca || !(ca.activeHypotheses > 0)) continue;
        const pSys = num(fbout.systemCentral && fbout.systemCentral[A]);
        const creativeA = pSys != null ? XP.creativeCentral(pSys, ca.creativeLogOddsTowardA) : null;
        const explorationBlock = { lane: "exploration", hypotheses: ca.hypotheses, activeHypotheses: ca.activeHypotheses, creativeCentralA: creativeA, creativeAdjustmentLogOddsTowardA: ca.creativeLogOddsTowardA, capped: ca.capped, cap: ca.cap };
        shadow.bouts.push({ boutId: fbout.boutId, fight: fbout.fight, activeHypotheses: ca.hypotheses.map((h) => h.label || h.hypothesis) });
        const contracts = fbout.contracts || (fbout.kalshi && fbout.kalshi.contracts) || [];
        for (const c of contracts) {
          if (!c.ticker) continue;
          let ob = null; try { ob = await K.orderbook(c.ticker); } catch { ob = null; }
          if (!ob) continue;
          const vx = V.valueContract(c, { ...forecast, exploration: explorationBlock, forecasts: [{ ...fbout, exploration: explorationBlock }] }, ob, { contracts: 100, nowTs: nowMs, maxSnapshotAgeMs: 30 * 60 * 1000, useExploration: true });
          if (!vx || vx.classification !== "EXPLORATION CANDIDATE") continue;
          const cs = XP.classifyAndSize(vx, explorationBlock);
          if (!cs || !["CREATIVE SPECULATIVE", "STRONG SPECULATIVE", "BEST EXPERIMENTAL"].includes(cs.classification)) continue;
          const side = (vx.execution && vx.execution.side ? String(vx.execution.side).toUpperCase() : "YES");
          const ask = num(vx.execution && (vx.execution.executablePrice ?? vx.execution.topOfBookPrice)) ?? num(vx.quotedAsk);
          out.push({
            signalId: `explore|${c.ticker}`, event: forecast.eventId || eventDate, eventDate, market: c.ticker, ticker: c.ticker,
            side, fighter: vx.outcomeSubject || null, opponent: null, fight: fbout.fight || null,
            category: RL.loadProfile(PROFILE_VERSION).classificationMap[`exploration:${cs.classification}`] || null,
            estProbability: num(cs.centralEV != null && ask != null ? cs.centralEV + ask : creativeA), observedAsk: ask,
            marketPriceTimestamp: new Date(nowMs).toISOString(), marketPriceStatus: FR.S.CURRENT, askSource: "LIVE_KALSHI",
            signalTimestamp: sealTs, forecastHash: forecast.forecastSealHash || null, sealedForecastVersion: forecast.version || null,
            fightStartTimestamp: `${eventDate}T22:00:00Z`, postBell: FR.fightStarted(eventDate, nowMs), cutoffSource: RL.CUTOFF.CARD,
            recommendationId: `explore|${c.ticker}`, qualifiedReason: `shadow exploration ${cs.classification}: ${cs.reason || ""}`,
            reasonProductionRejected: "exploration lane is OFF in production; this is a research-only shadow signal",
          });
        }
      } catch (e) { healthNotes.push(`exploration bout ${fbout.boutId}: ${e.message}`); }
    }
  } catch (e) { healthNotes.push(`exploration shadow pass: ${e.message}`); }
  try { const f = path.join(paths.data, `research-exploration-${eventDate}.json`); fs.writeFileSync(f + ".tmp", JSON.stringify(shadow, null, 2)); fs.renameSync(f + ".tmp", f); } catch (e) { healthNotes.push(`exploration write: ${e.message}`); }
  return out;
}

// ---- main ------------------------------------------------------------------------------------
(async () => {
  const now = argv("now") || new Date().toISOString();
  const nowMs = Date.parse(now);
  const mode = resolveMode();
  const enabled = process.env.RESEARCH_ENABLED === "1";
  const doSettle = process.argv.includes("--settle");
  const health = {
    enabledState: enabled, mode, lastAttemptedRun: now, lastSuccessfulRun: null,
    inputFingerprint: null, lastProcessedFingerprint: null, status: "OK", errorCategory: "NONE", errorDetail: null,
    observationsGenerated: 0, positionsProposed: 0, positionsFunded: 0, positionsSettled: 0,
    cardsProcessed: [], researchProfileVersion: PROFILE_VERSION, paperProspectiveStartAt: null, notes: [],
  };
  const prevHealth = readJson(HEALTH, null) || {};
  health.lastProcessedFingerprint = prevHealth.lastProcessedFingerprint || null;

  try {
    if (mode === RL.MODES.DISABLED) {
      health.status = "OK"; health.errorCategory = "NONE"; health.notes.push(enabled ? "RESEARCH_MODE unset/unrecognized — disabled" : "RESEARCH_ENABLED != 1 — disabled");
      writeHealth(health); say(`run-research: DISABLED (enabled=${enabled}, mode=${process.env.RESEARCH_MODE || "unset"}). Nothing done.`); return 0;
    }

    let profile;
    try { profile = RL.loadProfile(PROFILE_VERSION); }
    catch (e) { health.status = "ERROR"; health.errorCategory = "PROFILE_UNREADABLE"; health.errorDetail = e.message; writeHealth(health); say(`run-research: PROFILE ERROR — ${e.message}`); return 1; }

    const card = activeCard();
    if (!card || !card.eventDate) { health.notes.push("no active card"); writeHealth(health); say("run-research: no active card."); return 0; }
    const eventDate = card.eventDate;
    health.inputFingerprint = inputFingerprint(eventDate, mode);

    const state = RL.load();
    const openCount = Object.values(state.positions || {}).filter((p) => p.status === RL.STATUS.OPEN).length;
    const fingerprintChanged = health.inputFingerprint !== health.lastProcessedFingerprint;
    if (!fingerprintChanged && !(doSettle && openCount > 0)) {
      health.status = "OK"; health.notes.push("inputs unchanged — skipped"); health.lastSuccessfulRun = prevHealth.lastSuccessfulRun || now;
      health.paperProspectiveStartAt = state.prospectiveStartAt || null;
      writeHealth(health); say(`run-research: inputs unchanged (fp ${health.inputFingerprint.slice(0, 8)}). Skipped.`); return 0;
    }

    const forecast = readJson(path.join(paths.data, `forecast-${eventDate}.json`), {}) || {};
    const alerts = readJson(path.join(paths.data, `entertainment-alerts-${eventDate}.json`), {}) || {};
    const evidence = readJson(path.join(paths.data, `evidence-eval-${eventDate}.json`), {}) || {};

    const notes = [];
    const rawObs = [];
    rawObs.push(...fromAlerts(alerts, forecast, eventDate, nowMs));
    rawObs.push(...fromCombo(eventDate, nowMs));
    try { rawObs.push(...(await fromIntel(eventDate, forecast, nowMs))); } catch (e) { notes.push(`intel pass: ${e.message}`); }
    try { rawObs.push(...(await fromExplorationShadow(eventDate, forecast, evidence, nowMs, notes))); } catch (e) { notes.push(`exploration pass: ${e.message}`); }

    const { counts } = RL.processObservations(state, rawObs, { profile, mode, now });

    let settled = { settled: [], pending: [], unreadable: [] };
    if (doSettle && mode === RL.MODES.PAPER) {
      const K = require("./lib/kalshi");
      try { settled = await RL.settleFromMarket(state, { settlement: (t) => K.settlement(t), now }); }
      catch (e) { notes.push(`settle: ${e.message}`); }
    }

    RL.save(state);

    // Canonical research summary the Research Lab dashboard reads (mirrors bankrolls.json for the two real
    // ledgers). Includes the Paper Strategy comparison, read READ-ONLY from the production paper ledger.
    // Written to its OWN artifact — NEVER into bankrolls.json, so the research portfolio can never appear
    // in any combined bankroll total.
    try {
      const PL = require("./lib/paper-ledger");
      const summaryObj = RL.summary(state, { paperSummary: PL.summary(PL.load()) });
      const sf = path.join(paths.data, "research-summary.json");
      fs.writeFileSync(sf + ".tmp", JSON.stringify(summaryObj, null, 2)); fs.renameSync(sf + ".tmp", sf);
    } catch (e) { notes.push(`summary write: ${e.message}`); }

    health.status = "OK"; health.errorCategory = "NONE"; health.lastSuccessfulRun = now;
    health.lastProcessedFingerprint = health.inputFingerprint;
    health.observationsGenerated = Object.keys(state.observations || {}).length;
    health.positionsProposed = counts.proposed; health.positionsFunded = counts.funded;
    health.positionsSettled = settled.settled.length; health.cardsProcessed = [eventDate];
    health.paperProspectiveStartAt = state.prospectiveStartAt || null; health.notes = notes;
    writeHealth(health);

    const s = RL.summary(state);
    say(`run-research: mode=${mode} card=${eventDate} — ${counts.observations} new obs, ${counts.eligible} eligible, ${mode === RL.MODES.PAPER ? counts.funded + " funded" : counts.proposed + " would fund"}, ${settled.settled.length} settled.`);
    say(`  research account $${s.accountValue} (start ${s.prospectiveStartAt || "NOT STARTED — OBSERVE"}), open $${s.openExposure}, realized $${s.realizedPnl}.`);
    return 0;
  } catch (e) {
    health.status = "ERROR"; health.errorCategory = health.errorCategory === "NONE" ? "UNKNOWN" : health.errorCategory; health.errorDetail = e.message;
    writeHealth(health); say(`run-research: ERROR — ${e.message}`); return 1;
  }
})().then((c) => process.exit(c || 0)).catch((e) => { try { writeHealth({ status: "ERROR", errorCategory: "UNKNOWN", errorDetail: e.message, lastAttemptedRun: new Date().toISOString() }); } catch {} console.error("run-research fatal:", e.message); process.exit(1); });
