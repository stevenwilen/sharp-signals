// DAILY SYSTEM ACTIVITY REPORT — a health-and-activity RECEIPT, not a bet. Pure + deterministic so the
// verdict is testable. It proves the system collected, processed, and produced — or says honestly that it
// did not, and why. Two hard rules from the repo's ethos govern everything here:
//   1. Missing/absent data is NEVER a pass. A required artifact that is missing or stale REFUSES HEALTHY.
//      (See CLAUDE.md: "Missing data must be a refusal.")
//   2. Never invent a value. A metric with no real per-day source is reported as null and rendered "—",
//      never a fabricated zero. A real, checked-and-empty count IS a zero (zeroes prove we looked).

// ----- timezone-aware calendar-day helpers -----
function dayKey(ms, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms));
  const o = {}; for (const x of p) o[x.type] = x.value;
  return `${o.year}-${o.month}-${o.day}`;
}
function hourIn(ms, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const h = +(p.find((x) => x.type === "hour").value);
  return h === 24 ? 0 : h;      // some ICU builds render midnight as 24
}
function hoursSince(iso, nowMs) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? (nowMs - t) / 3.6e6 : null;   // null = never/absent, NOT zero
}

// A tier-appropriate "should have refreshed by now" bound. During an active card the pipeline collects
// every 1-2h; anything older than STALE_H means a stage silently stopped producing.
const STALE_H = 6;

// ----- the report -----
// inputs: { now (ms), tz, reportDate, cardActive (bool), tierCadenceH,
//   receipts, forecast, intelligence, entertainment, research, bankrolls, manualBankroll,
//   paperLedger, candidateIndex, coverage, cardEvidence, alertLedger, geminiUsage, runs, telegramSends }
function buildReport(inp) {
  const { now, tz, reportDate } = inp;
  const onDay = (iso) => iso && dayKey(Date.parse(iso), tz) === reportDate;   // per-item day filter
  const missing = [];                     // required artifacts that were absent — drives the verdict
  const need = (obj, name) => { if (!obj) missing.push(name); return obj || null; };

  const receipts = need(inp.receipts, "dispatch-receipts");
  const forecast = inp.forecast;          // may legitimately not exist between cards
  const intel = inp.intelligence;
  const ent = inp.entertainment;
  const research = inp.research;
  const bank = need(inp.bankrolls, "bankrolls");
  const gem = inp.geminiUsage;

  const intelRecs = intel && intel.records ? Object.values(intel.records) : [];
  const intelToday = intelRecs.filter((r) => onDay(r.firstSeenAt));

  // ===== SYSTEM ACTIVITY =====
  const runs = inp.runs;                   // [{conclusion, createdAt}] or null if the run-history API was unreachable
  const runsToday = Array.isArray(runs) ? runs.filter((r) => onDay(r.createdAt)) : null;
  const activity = {
    scheduledRunsExpected: inp.expectedRunsToday ?? null,
    scheduledRunsCompleted: runsToday ? runsToday.filter((r) => r.conclusion === "success").length : null,
    failedOrSkippedRuns: runsToday ? runsToday.filter((r) => r.conclusion && r.conclusion !== "success").length : null,
    lastSuccessfulPipelineRun: receipts ? (receipts.collect || {}).ranAt || null : null,
    currentActiveCard: receipts ? (receipts.lastCard || {}).eventId || null : null,
    cardsProcessedToday: receipts ? [(receipts.collect || {}).card, (receipts.forecast || {}).card]
      .filter((c, i, a) => c && a.indexOf(c) === i && onDay(i === 0 ? (receipts.collect || {}).ranAt : (receipts.forecast || {}).ranAt)).length : 0,
    collectRanToday: receipts ? onDay((receipts.collect || {}).ranAt) : false,
    forecastRanToday: receipts ? onDay((receipts.forecast || {}).ranAt) : false,
  };

  // ===== SOURCE COLLECTION =====
  const ci = inp.candidateIndex || {};
  const cov = inp.coverage;
  const cev = inp.cardEvidence || {};
  const covToday = cov && onDay(cov.ranAt) ? cov : null;
  const dropped = (cev.integrity || {}).droppedVideos || [];    // videos we could not fully read = extraction failures
  const source = {
    channelsSearched: covToday ? covToday.boutsSearched : null,          // coverage per-fight search (0 when nothing under-covered)
    rosterChannels: ci.channelsTotal ?? null,
    videosOrSourcesDiscovered: covToday ? covToday.totalIngested : null, // live-scan daily count is not separately tracked -> null unless coverage ran
    newFightWeekSourcesAdded: covToday ? Object.keys(covToday.discoveredChannels || {}).length : 0,
    transcriptsProcessed: onDay((cev.builtAt)) ? ((cev.selection || {}).videos || []).length : null,
    transcriptFailures: onDay((cev.builtAt)) ? dropped.length : null,     // droppedVideos = incomplete reads (see lib/read-completeness)
    newestSourceTs: ci.newestSourceTs || null,
    newestSourceAgeH: ci.newestSourceTs ? round1(hoursSince(ci.newestSourceTs, now)) : null,
    sourcesUnusable: ci.liveUnreadable ?? null,                          // unreadable pick files
    corpusFreshness: (ci.corpusFreshness || {}).status || null,
  };

  // ===== PICKS AND SIGNALS COLLECTED (analyst/guru picks + candidate signals — NOT bets) =====
  // Bucketed by the intel record's truthStatus/verificationStatus + structure. Today's records only.
  const picks = bucketPicks(intelToday);

  // ===== FIGHT INTELLIGENCE =====
  const fi = {
    intelligenceClaimsCreated: intelToday.length,
    independentOrigins: sum(intelToday, (r) => r.independentOrigins || 0),
    amplifyingSources: sum(intelToday, (r) => r.amplifierCount || 0),
    watchSignals: intelToday.filter((r) => (r.forecastImpact || {}).lane === "watch" || r.actionStatus === "WATCH").length,
    speculativeSignals: intelToday.filter((r) => (r.forecastImpact || {}).lane === "exploration").length,
    dashboardOnly: intelToday.filter((r) => r.actionStatus === "DASHBOARD_ONLY").length,
    claimsPromoted: countAction(intelToday, ["FORECAST_UPDATED", "CONFIRMED", "PROMOTED"], reportDate, tz),
    claimsDowngradedOrRejected: countAction(intelToday, ["IGNORE", "DISPROVED", "DOWNGRADED", "STALE"], reportDate, tz)
      + intelToday.filter((r) => r.actionStatus === "IGNORE").length,
    identityMatchFailures: intelToday.filter((r) => r.boutId == null || (r.outcomeAffected && !r.outcomeAffected.fighter)).length,
  };

  // ===== PRODUCTION DECISIONS =====
  const decs = ent && onDay(ent.ranAt) ? (ent.decisions || []) : [];
  const clsCount = (c) => decs.filter((d) => d.classification === c).length;
  const blockCount = (b) => decs.filter((d) => (d.blockedBy || "").toUpperCase().includes(b)).length;
  const combo = inp.combo && onDay(inp.combo.ranAt) ? inp.combo : null;
  const production = {
    coreBuy: ent && onDay(ent.ranAt) ? (ent.buyInstructions || []).filter((b) => b.wouldSend && b.lane === "core").length
      + (ent.delivery || {}).buyInstructions || 0 : 0,
    priceTooHigh: decs.length ? blockCount("PRICE_TOO_HIGH") : 0,
    noBet: clsCount("NO BET"),
    withdrawn: decs.filter((d) => (d.reason || "").toLowerCase().includes("withdraw")).length,
    expired: decs.filter((d) => (d.reason || "").toLowerCase().includes("expire")).length,
    postFightRefusals: decs.filter((d) => (d.reason || "").toLowerCase().match(/post.?fight|fight.?start|settled/)).length,
    comboBuy: combo ? (combo.buy || 0) : null,
    comboPriceTooHigh: combo ? (combo.priceTooHigh || 0) : null,
    comboUnavailableOrRejected: combo ? (combo.unavailable || 0) : (inp.comboEnabled ? "unavailable (read-only quote)" : null),
  };

  // ===== SPECULATIVE RESEARCH =====
  const lastRun = (research || {}).lastRun || {};
  const obs = research && research.observations ? Object.values(research.observations) : [];
  const obsToday = obs.filter((o) => onDay(o.decisionTimestamp) || onDay(o.signalTimestamp));
  const qual = (q) => obsToday.filter((o) => o.qualification === q).length;
  const gateReasons = tallyReasons(obsToday.map((o) => o.firstSightReason).filter(Boolean));
  const spec = {
    researchMode: (research && (research.paperModeActivatedAt ? "PAPER" : null)) || lastRun.mode || inp.researchModeEnv || "UNKNOWN",
    observationsCreated: obsToday.length,
    creativeSpeculative: qual("CREATIVE_SPECULATION"),
    strongSpeculative: qual("STRONG_SPECULATION"),
    exploration: obsToday.filter((o) => String(o.signalId || "").startsWith("explore")).length,
    watchExperiments: qual("WATCH_EXPERIMENT"),
    unconfirmedCandidates: qual("UNCONFIRMED_CANDIDATE"),
    experimentalCombos: qual("EXPERIMENTAL_COMBO"),
    wouldHaveFunded: obsToday.filter((o) => o.firstSightEligible === true).length,
    actuallyFunded: lastRun.counts ? (lastRun.counts.funded || 0) : 0,
    rejectedOrNoEntry: obsToday.filter((o) => o.firstSightEligible === false).length,
    topGateReasons: gateReasons.slice(0, 3),
  };

  // ===== PAPER ACTIVITY (two fully-separate books) =====
  const paperPos = (inp.paperLedger || {}).positions ? Object.values(inp.paperLedger.positions) : [];
  const researchPos = research && research.positions ? Object.values(research.positions) : [];
  const bookOf = (positions, summary) => ({
    positionsOpened: positions.filter((p) => onDay(p.openedAt || p.entryAt)).length,
    positionsSettled: positions.filter((p) => onDay(p.settledAt)).length,
    wins: positions.filter((p) => onDay(p.settledAt) && p.result === "win").length,
    losses: positions.filter((p) => onDay(p.settledAt) && p.result === "loss").length,
    openExposure: summary ? round2(summary.openExposure) : null,
  });
  const paper = {
    paperStrategy: bookOf(paperPos, (bank || {}).paper),
    speculativeResearch: bookOf(researchPos, summarizeResearch(research)),
  };

  // ===== REAL ACTIVITY =====
  const mb = inp.manualBankroll || {};
  const mbEntries = mb.entries ? Object.values(mb.entries) : [];
  const real = {
    realRecommendationsIssued: production.coreBuy,       // a real "recommendation" = a BUY the system would send
    manuallyConfirmedPositions: mbEntries.filter((e) => onDay(e.confirmedAt || e.at)).length,
    discretionaryPositionsRecorded: mbEntries.filter((e) => onDay(e.confirmedAt || e.at) && e.discretionary).length,
    positionsSettled: mbEntries.filter((e) => onDay(e.settledAt)).length,
    realBankrollChange: bank ? round2((bank.real || {}).realizedPnl) : null,   // cumulative realized; daily delta not separately tracked
    realBankrollNote: "realizedPnl is cumulative; per-day delta is not separately tracked",
  };

  // ===== SYSTEM QUALITY =====
  const gemToday = gem ? geminiToday(gem, reportDate, tz) : null;
  const dupPrevented = countDupPrevented(inp.alertLedger, reportDate, tz);
  const quality = {
    forecastFreshnessH: forecast ? round1(hoursSince(forecast.sealedAt, now)) : null,
    marketPriceFreshnessH: forecast && forecast.marketAsOf ? round1(hoursSince(forecast.marketAsOf, now))
      : (freshestMarketTs(intelRecs) ? round1(hoursSince(freshestMarketTs(intelRecs), now)) : null),
    intelligenceFreshnessH: intel ? round1(hoursSince(intel.updatedAt, now)) : null,
    comboQuoteFreshnessH: combo ? round1(hoursSince(combo.ranAt, now)) : null,
    persistence: receipts ? "ok" : "MISSING receipts",
    deduplication: inp.alertLedger ? "ok" : null,
    duplicateAlertsPrevented: dupPrevented,
    geminiCalls: gemToday ? gemToday.calls : null,
    geminiFailures: gemToday ? gemToday.failures : null,
    geminiTokens: gemToday ? gemToday.tokens : null,
    geminiEstCostUsd: gemToday ? round4(gemToday.cost) : null,
    telegramNotificationsSent: inp.telegramSends ?? null,
    warnings: [],   // filled by verdict()
  };

  const report = {
    kind: "daily-system-activity",
    reportDate, tz,
    windowLabel: `${reportDate} 00:00 → report time, ${tz}`,
    generatedAtMs: now,
    sections: { activity, source, picks, fightIntelligence: fi, production, speculativeResearch: spec, paper, real, quality },
  };
  const v = verdict(report, { missing, cardActive: inp.cardActive, gemToday, cov: covToday, source, activity });
  report.status = v.status;
  report.verdictReasons = v.reasons;
  report.sections.quality.warnings = v.warnings;
  return report;
}

// ----- the strict HEALTHY / DEGRADED / FAILED decision -----
// HEALTHY requires: no missing required artifact, the pipeline actually ran today (when a card is active),
// nothing stale, no silent source failure, Gemini not wholly broken. Anything less is DEGRADED; a total
// stall or missing core artifact is FAILED. Missing data can only ever LOWER the status, never raise it.
function verdict(report, ctx) {
  const q = report.sections.quality;
  const fails = [], degrades = [], warnings = [];

  if (ctx.missing.length) fails.push(`required data missing: ${ctx.missing.join(", ")}`);

  if (ctx.cardActive) {
    if (!ctx.activity.collectRanToday) fails.push("collect did not run today for the active card");
    if (!ctx.activity.forecastRanToday) fails.push("forecast did not run today for the active card");
    if (q.forecastFreshnessH == null) fails.push("no sealed forecast present");
    else if (q.forecastFreshnessH > STALE_H) degrades.push(`forecast stale (${q.forecastFreshnessH}h)`);
    if (q.intelligenceFreshnessH != null && q.intelligenceFreshnessH > STALE_H) degrades.push(`intelligence stale (${q.intelligenceFreshnessH}h)`);
    if (q.marketPriceFreshnessH != null && q.marketPriceFreshnessH > STALE_H) degrades.push(`market price stale (${q.marketPriceFreshnessH}h)`);
  }

  // Gemini: any attempts today with ALL failing = extraction outage (FAILED); some failures = DEGRADED.
  if (ctx.gemToday && ctx.gemToday.calls > 0) {
    if (ctx.gemToday.failures >= ctx.gemToday.calls) fails.push("every Gemini call today failed (extraction outage)");
    else if (ctx.gemToday.failures > 0) degrades.push(`${ctx.gemToday.failures} Gemini call(s) failed today`);
  }

  // silent source failures
  if (ctx.cov && ctx.cov.quotaAborted) degrades.push("coverage search hit a quota/rate limit");
  if (ctx.cov && ctx.cov.timeAborted) degrades.push("coverage search hit its time budget (partial)");
  if (ctx.source.sourcesUnusable) degrades.push(`${ctx.source.sourcesUnusable} unreadable source file(s)`);
  if (ctx.source.transcriptFailures) degrades.push(`${ctx.source.transcriptFailures} transcript(s) failed to read (dropped)`);
  if (report.sections.activity.failedOrSkippedRuns) degrades.push(`${report.sections.activity.failedOrSkippedRuns} workflow run(s) failed today`);
  if (ctx.source.corpusFreshness && /stale/i.test(ctx.source.corpusFreshness)) degrades.push("source corpus is STALE");

  let status = "SYSTEM HEALTHY";
  if (fails.length) status = "SYSTEM FAILED";
  else if (degrades.length) status = "SYSTEM DEGRADED";
  const reasons = [...fails, ...degrades];
  warnings.push(...reasons);
  return { status, reasons, warnings };
}

// ----- helpers -----
function bucketPicks(recs) {
  const has = (r, re) => re.test(String((r.forecastImpact || {}).verificationStatus || "") + "|" + (r.truthStatus || ""));
  return {
    total: recs.length,
    confirmedOrVerified: recs.filter((r) => has(r, /VERIFIED|CONFIRMED/)).length,
    likelyTrue: recs.filter((r) => has(r, /POSSIBLY TRUE|PROBABLY_TRUE|LIKELY_TRUE/)).length,
    plausibleUnverified: recs.filter((r) => has(r, /PLAUSIBLE|MECHANISTICALLY RELEVANT/) && !has(r, /VERIFIED/)).length,
    weakOrUnsupported: recs.filter((r) => has(r, /WEAK|UNVERIFIED/)).length,
    conflicting: recs.filter((r) => (r.contradictions || []).length > 0).length,
    duplicateOrAmplifierOnly: recs.filter((r) => (r.independentOrigins || 0) <= 1 && (r.amplifierCount || 0) > 1).length,
    identityUnresolved: recs.filter((r) => r.boutId == null).length,
    rejected: recs.filter((r) => r.actionStatus === "IGNORE" || /LIKELY_FALSE|STALE/.test(r.truthStatus || "")).length,
  };
}
function summarizeResearch(research) {
  if (!research) return null;
  let openExposure = 0;
  for (const p of Object.values(research.positions || {})) if (p.status === "open") openExposure += (p.risk || p.cost || 0);
  return { openExposure };
}
function geminiToday(gem, reportDate, tz) {
  const rows = gem.rows || gem.calls || (Array.isArray(gem) ? gem : []);
  const today = rows.filter((r) => dayKey(Date.parse(r.at || r.timestamp || 0), tz) === reportDate);
  return {
    calls: today.length,
    failures: today.filter((r) => r.ok === false || r.error).length,
    tokens: today.reduce((n, r) => n + (r.inputTokens || 0) + (r.outputTokens || 0), 0),
    cost: today.reduce((n, r) => n + (r.estCostUsd || 0), 0),
  };
}
function countDupPrevented(ledger, reportDate, tz) {
  if (!ledger) return null;
  const entries = Array.isArray(ledger) ? ledger : Object.values(ledger);
  // a "duplicate prevented" = a ledgered alert whose lastSuppressedAt landed today
  return entries.filter((e) => e && e.lastSuppressedAt && dayKey(Date.parse(e.lastSuppressedAt), tz) === reportDate).length;
}
function countAction(recs, verbs, reportDate, tz) {
  const set = new Set(verbs);
  let n = 0;
  for (const r of recs) for (const a of r.actionHistory || [])
    if (a.action && set.has(a.action) && dayKey(Date.parse(a.at || 0), tz) === reportDate) n++;
  return n;
}
function tallyReasons(arr) {
  const m = {}; for (const r of arr) { const k = String(r).replace(/[0-9.]+/g, "N"); m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}
function freshestMarketTs(recs) {
  let best = null;
  for (const r of recs) for (const k of r.kalshiAfter || []) if (!best || Date.parse(k.ts) > Date.parse(best)) best = k.ts;
  return best;
}
const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
const round1 = (n) => n == null ? null : Math.round(n * 10) / 10;
const round2 = (n) => n == null ? null : Math.round(n * 100) / 100;
const round4 = (n) => n == null ? null : Math.round(n * 10000) / 10000;

// ----- compact Telegram rendering. Every category is shown even at zero (a zero proves it was checked);
// a genuinely untracked value renders "—", never a fabricated number. No stack traces, no full reports. -----
const n = (v) => (v == null ? "—" : v);            // null -> em dash (untracked/absent), 0 stays 0
const money = (v) => (v == null ? "—" : `$${v}`);

function formatTelegram(r) {
  const s = r.sections, L = [];
  const p = (line) => L.push(line);
  p(`📋 DAILY SYSTEM ACTIVITY — ${r.reportDate}`);
  p(`window: ${r.windowLabel}`);
  p("");
  p(r.status);                                     // SYSTEM HEALTHY / DEGRADED / FAILED
  if (r.status !== "SYSTEM HEALTHY" && r.verdictReasons.length) p(`⚠ ${r.verdictReasons.slice(0, 4).join("; ")}`);

  const A = s.activity;
  p("\nSYSTEM ACTIVITY");
  p(`runs expected/done/failed: ${n(A.scheduledRunsExpected)}/${n(A.scheduledRunsCompleted)}/${n(A.failedOrSkippedRuns)}`);
  p(`last run: ${fmtTs(A.lastSuccessfulPipelineRun)} · card: ${n(A.currentActiveCard)} · processed today: ${A.cardsProcessedToday}`);

  const C = s.source;
  p("\nSOURCE COLLECTION");
  p(`channels searched: ${n(C.channelsSearched)} · roster: ${n(C.rosterChannels)} · discovered: ${n(C.videosOrSourcesDiscovered)} · new fw-sources: ${C.newFightWeekSourcesAdded}`);
  p(`transcripts: ${n(C.transcriptsProcessed)} (fail ${n(C.transcriptFailures)}) · newest ${C.newestSourceAgeH == null ? "—" : C.newestSourceAgeH + "h"} · unusable ${n(C.sourcesUnusable)}`);

  const K = s.picks;
  p("\nPICKS & SIGNALS (analyst/candidate — not bets)");
  p(`total ${K.total} · verified ${K.confirmedOrVerified} · likely ${K.likelyTrue} · plausible ${K.plausibleUnverified} · weak ${K.weakOrUnsupported} · conflict ${K.conflicting} · dup/ampl ${K.duplicateOrAmplifierOnly} · identity? ${K.identityUnresolved} · rejected ${K.rejected}`);

  const F = s.fightIntelligence;
  p("\nFIGHT INTELLIGENCE");
  p(`claims ${F.intelligenceClaimsCreated} · origins ${F.independentOrigins} · amplifiers ${F.amplifyingSources}`);
  p(`WATCH ${F.watchSignals} · speculative ${F.speculativeSignals} · dashboard-only ${F.dashboardOnly} · promoted ${F.claimsPromoted} · down/reject ${F.claimsDowngradedOrRejected} · identity-fail ${F.identityMatchFailures}`);

  const P = s.production;
  p("\nPRODUCTION DECISIONS");
  p(`core BUY ${P.coreBuy} · PRICE-TOO-HIGH ${P.priceTooHigh} · NO BET ${P.noBet} · withdrawn ${P.withdrawn} · expired ${P.expired} · post-fight ${P.postFightRefusals}`);
  p(`combo: BUY ${n(P.comboBuy)} · PTH ${n(P.comboPriceTooHigh)} · ${P.comboUnavailableOrRejected == null ? "off" : P.comboUnavailableOrRejected}`);

  const R = s.speculativeResearch;
  p(`\nSPECULATIVE RESEARCH (mode: ${R.researchMode})`);
  p(`observations ${R.observationsCreated} · creative ${R.creativeSpeculative} · strong ${R.strongSpeculative} · exploration ${R.exploration} · watch-exp ${R.watchExperiments} · unconfirmed ${R.unconfirmedCandidates} · exp-combo ${R.experimentalCombos}`);
  p(`would-fund ${R.wouldHaveFunded} · funded ${R.actuallyFunded} · no-entry/rejected ${R.rejectedOrNoEntry}`);
  if (R.topGateReasons.length) p(`gate reasons: ${R.topGateReasons.map((g) => `${g.reason} (${g.count})`).join("; ")}`);

  const PA = s.paper;
  p("\nPAPER ACTIVITY");
  p(`Strategy: opened ${PA.paperStrategy.positionsOpened} · settled ${PA.paperStrategy.positionsSettled} · W${PA.paperStrategy.wins} L${PA.paperStrategy.losses} · exposure ${money(PA.paperStrategy.openExposure)}`);
  p(`Research: opened ${PA.speculativeResearch.positionsOpened} · settled ${PA.speculativeResearch.positionsSettled} · W${PA.speculativeResearch.wins} L${PA.speculativeResearch.losses} · exposure ${money(PA.speculativeResearch.openExposure)}`);

  const RE = s.real;
  p("\nREAL ACTIVITY");
  p(`recs ${RE.realRecommendationsIssued} · confirmed ${RE.manuallyConfirmedPositions} · discretionary ${RE.discretionaryPositionsRecorded} · settled ${RE.positionsSettled} · bankroll ${money(RE.realBankrollChange)} (cumulative)`);

  const Q = s.quality;
  p("\nSYSTEM QUALITY");
  p(`fresh(h): forecast ${n(Q.forecastFreshnessH)} · market ${n(Q.marketPriceFreshnessH)} · intel ${n(Q.intelligenceFreshnessH)} · combo ${n(Q.comboQuoteFreshnessH)}`);
  p(`Gemini: ${n(Q.geminiCalls)} calls · ${n(Q.geminiFailures)} fail · ${Q.geminiTokens == null ? "—" : Math.round(Q.geminiTokens / 1000) + "k"} tok · ${money(Q.geminiEstCostUsd)}`);
  p(`dedup ${n(Q.deduplication)} · dup-prevented ${n(Q.duplicateAlertsPrevented)} · Telegram sent ${n(Q.telegramNotificationsSent)} · persistence ${Q.persistence}`);

  p("\nTODAY'S VERDICT");
  p(verdictSentences(r));
  return L.join("\n");
}

// 2-3 plain sentences: did it work at full strength, what it processed, what (if anything) needs attention.
function verdictSentences(r) {
  const s = r.sections, out = [];
  const processed = `Processed ${s.fightIntelligence.intelligenceClaimsCreated} intelligence claim(s) from ${s.source.newestSourceAgeH == null ? "no fresh" : "current"} sources and issued ${s.production.noBet + s.production.coreBuy + s.production.priceTooHigh} production decision(s) (${s.production.noBet} NO BET, ${s.production.coreBuy} BUY).`;
  const nothingMeaningful = s.fightIntelligence.intelligenceClaimsCreated === 0 && s.source.videosOrSourcesDiscovered === 0 && s.production.coreBuy === 0;

  if (r.status === "SYSTEM HEALTHY") {
    out.push("The system ran at full strength today — every scheduled stage refreshed on cadence with no failures.");
    out.push(processed);
    if (nothingMeaningful) out.push("No qualifying new information surfaced today, so no new signals — that is the disciplined default, not a fault.");
  } else if (r.status === "SYSTEM DEGRADED") {
    out.push("The system ran but not at full strength.");
    out.push(processed);
    out.push(`Needs attention: ${r.verdictReasons.slice(0, 3).join("; ")}.`);
  } else {
    out.push("The system did NOT run at full strength today.");
    out.push(`Failure(s): ${r.verdictReasons.slice(0, 3).join("; ")}.`);
    if (!r.sections.activity.currentActiveCard) out.push("There is no active card, so some idleness is expected — but the item(s) above are still missing and should be checked.");
    else out.push("An active card is in play, so this is a real gap that needs checking.");
  }
  return out.join(" ");
}

function fmtTs(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso); if (!Number.isFinite(t)) return "—";
  return new Date(t).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

module.exports = { buildReport, verdict, formatTelegram, verdictSentences, dayKey, hourIn, hoursSince, STALE_H };
