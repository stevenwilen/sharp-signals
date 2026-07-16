// PHASE 9B — Telegram message construction.
//
// Telegram is the TIME-SENSITIVE DECISION CHANNEL, not the research interface. It answers one
// question — "is there something I might act on in the next hour, and at what price?" — and defers
// everything else to the dashboard.
//
// NO AI CONFIDENCE SCORE. Not "confidence: 82%", not four stars, not "high conviction". A single
// scalar invites the reader to trust a number that has never been validated, and this system has
// never demonstrated prospective edge. What a message may carry instead is the stuff a human can
// actually argue with: a probability RANGE, how many INDEPENDENT origins support it, what the
// evidence does NOT cover, and the model's validation status.
//
// EVERY MESSAGE CARRIES ITS OWN COUNTERARGUMENT. A proposal that cannot state what would make it
// wrong is not a proposal, it is an advertisement.
require("./env");
const crypto = require("crypto");

const TYPES = {
  NEW_EXPERIMENTAL_POSITION: "NEW EXPERIMENTAL POSITION",
  PRICE_UPDATE: "PRICE UPDATE",
  EVIDENCE_UPDATE: "EVIDENCE UPDATE",
  POSITION_WITHDRAWN: "POSITION WITHDRAWN",
  NO_BET_STATUS_CHANGE: "NO-BET STATUS CHANGE",
  DAILY_SHADOW_SUMMARY: "DAILY SHADOW SUMMARY",
  PIPELINE_FAILURE: "PIPELINE FAILURE",
};

// Anything resembling a single confidence scalar is refused at construction time. This is a
// structural guard, not a style note: the moment a message carries "confidence: 82%" the reader
// stops reading the range and the caveats.
const BANNED = /\bconfidence\s*[:=]\s*\d|\bconviction\s*[:=]|\bAI\s+(confidence|score|rating)|\b\d+\s*\/\s*10\b|★|\bstars?\b\s*[:=]|\bcertainty\s*[:=]\s*\d/i;
function assertNoConfidenceScore(text) {
  const m = String(text).match(BANNED);
  if (m) throw new Error(`message contains a confidence score ("${m[0]}") — use a probability range, origin count, evidence coverage and model status instead`);
  return true;
}

const pct = (x) => x == null ? "n/a" : `${(x * 100).toFixed(1)}%`;
const cents = (x) => x == null ? "n/a" : `${(x * 100).toFixed(1)}¢`;

// ---- the proposed-position message ----
// ONE MESSAGE PER FIGHT. Correlated contracts from the same bout are grouped, because two messages
// about one fight read as two independent opportunities — which is precisely how a 1%-per-fight cap
// gets breached by a human acting on each in turn.
function experimentalPosition(p) {
  const L = [];
  L.push("🧪 EXPERIMENTAL POSITION");
  L.push("");
  L.push(p.fight);
  L.push("");
  L.push(`Contract: ${p.contractLabel}`);
  L.push(`Ask: ${cents(p.ask)}`);
  L.push(`Maximum price: ${cents(p.maximumAcceptablePrice)}`);
  L.push(`System range: ${pct(p.rangeLow)}–${pct(p.rangeHigh)}`);
  L.push(`Conservative value after fees: ${p.conservativeValuePoints >= 0 ? "+" : ""}${p.conservativeValuePoints.toFixed(1)} pts`);
  L.push("");
  L.push(`Suggested stake: ${p.stakePercent.toFixed(2)}%`);
  L.push(`Total fight exposure: ${p.fightExposurePercent.toFixed(2)}%`);
  if (p.groupedContracts && p.groupedContracts.length > 1) {
    L.push("");
    L.push(`Grouped — ${p.groupedContracts.length} contracts on this fight are correlated, not separate opportunities:`);
    for (const g of p.groupedContracts) L.push(`  • ${g}`);
  }
  L.push("");
  L.push("Why:");
  for (const w of p.why) L.push(`• ${w}`);
  L.push("");
  L.push("Against:");
  for (const a of p.against) L.push(`• ${a}`);
  L.push("");
  L.push(`Evidence coverage: ${p.evidenceCoverage}`);
  L.push(`Model status: ${p.modelStatus}`);
  L.push(`Snapshot: ${p.snapshotTimestamp}`);
  if (p.envelopeExceptions && p.envelopeExceptions.length) {
    L.push("");
    L.push("⚠ Fee is EXTRAPOLATED beyond the verified envelope:");
    for (const e of p.envelopeExceptions) L.push(`  • ${e}`);
  }
  L.push("");
  L.push("Expires if:");
  for (const e of p.expiresIf) L.push(`• ${e}`);
  L.push("");
  L.push(`Dashboard: ${p.dashboardRef}`);
  L.push("");
  L.push("Manual placement only");
  L.push("Alerts remain disarmed");
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  return text;
}

function priceUpdate(u) {
  const t = [
    "📊 PRICE UPDATE",
    "",
    u.fight,
    `Contract: ${u.contractLabel}`,
    "",
    `Ask: ${cents(u.previousAsk)} → ${cents(u.ask)}`,
    `Maximum price: ${cents(u.maximumAcceptablePrice)}`,
    u.ask > u.maximumAcceptablePrice
      ? `❌ Ask is ABOVE the maximum acceptable price — this position no longer qualifies`
      : `✅ Still within the maximum acceptable price`,
    "",
    `Conservative value after fees: ${u.conservativeValuePoints >= 0 ? "+" : ""}${u.conservativeValuePoints.toFixed(1)} pts`,
    `Snapshot: ${u.snapshotTimestamp}`,
    "",
    "Manual placement only",
  ].join("\n");
  assertNoConfidenceScore(t);
  return t;
}

function evidenceUpdate(u) {
  const t = [
    "📚 EVIDENCE UPDATE",
    "",
    u.fight,
    "",
    "The sealed forecast changed because the evidence changed:",
    ...u.changes.map((c) => `• ${c}`),
    "",
    `System range: ${pct(u.rangeLow)}–${pct(u.rangeHigh)} (was ${pct(u.previousRangeLow)}–${pct(u.previousRangeHigh)})`,
    `Evidence coverage: ${u.evidenceCoverage}`,
    "",
    `Previous forecast: ${u.previousForecastHash} (superseded, not overwritten)`,
    `Current forecast: ${u.forecastHash}`,
    "",
    `Dashboard: ${u.dashboardRef}`,
  ].join("\n");
  assertNoConfidenceScore(t);
  return t;
}

function positionWithdrawn(w) {
  const t = [
    "🚫 POSITION WITHDRAWN",
    "",
    w.fight,
    `Contract: ${w.contractLabel}`,
    "",
    `Reason: ${w.reason}`,
    "",
    w.wasProposedStake != null ? `Previously suggested stake: ${w.wasProposedStake.toFixed(2)}%` : "",
    "This position no longer qualifies. If you placed it manually, that is your decision to review —",
    "this system has no order path and cannot close anything.",
    "",
    `Dashboard: ${w.dashboardRef}`,
  ].filter(Boolean).join("\n");
  assertNoConfidenceScore(t);
  return t;
}

function noBetStatusChange(n) {
  const t = [
    "🔄 NO-BET STATUS CHANGE",
    "",
    n.fight,
    `Contract: ${n.contractLabel}`,
    "",
    `Was: ${n.previousClassification}`,
    `Now: ${n.classification}`,
    "",
    `Why: ${n.reason}`,
    "",
    n.classification === "ACTIONABLE EXPERIMENTAL"
      ? "This became eligible. A separate EXPERIMENTAL POSITION message carries the detail."
      : "No action. Recorded so the forward record shows what changed and when.",
    "",
    `Dashboard: ${n.dashboardRef}`,
  ].join("\n");
  assertNoConfidenceScore(t);
  return t;
}

// The summary reports NO-BETS as a headline, not a footnote. A daily digest that only counts the
// bets teaches the reader that declining is not an outcome.
function dailyShadowSummary(s) {
  const t = [
    "📋 DAILY SHADOW SUMMARY",
    "",
    `${s.date} — ${s.cards} card(s), ${s.totalDecisions} decisions`,
    "",
    `Actionable experimental: ${s.actionable}`,
    `Watch: ${s.watch}`,
    `No bet: ${s.noBet}`,
    `Analysis only: ${s.analysisOnly}`,
    `Unpriced: ${s.unpriced}`,
    `Human review required: ${s.humanReview}`,
    "",
    `No-bet frequency: ${s.noBetFrequency}`,
    `Card exposure: ${s.cardExposure} (cap ${s.cardCap})`,
    "",
    `Pipeline: ${s.pipelineIndicator}${s.failedStages.length ? ` — ${s.failedStages.length} failed stage(s)` : ""}`,
    ...s.failedStages.map((f) => `  ⚠ ${f.stage}: ${f.why}`),
    "",
    `Alerts: DISARMED · Trading capability: NONE · Orders placed: 0`,
    "",
    `Dashboard: ${s.dashboardRef}`,
  ].join("\n");
  assertNoConfidenceScore(t);
  return t;
}

// A failure is ALWAYS sent. Silence is the one thing a monitoring channel may never do with an
// error: a pipeline that dies quietly looks exactly like a pipeline with nothing to say.
function pipelineFailure(f) {
  const t = [
    "🔴 PIPELINE FAILURE",
    "",
    `Stage: ${f.stage}`,
    `When: ${f.at}`,
    "",
    `What happened: ${f.why}`,
    "",
    f.consequence ? `Consequence: ${f.consequence}` : "Consequence: this run produced no sealed decision. Nothing on the dashboard advanced.",
    "",
    "No positions were proposed from a failed run.",
    `Alerts: DISARMED · Trading capability: NONE`,
  ].join("\n");
  assertNoConfidenceScore(t);
  return t;
}

// Build the "why"/"against" bullets from the sealed record. They are DERIVED, never authored: a
// hand-written rationale drifts from the artifact it claims to describe, and the drift always
// flatters the position.
function reasonsFor(decision, forecast, consensus) {
  const why = [], against = [];
  const adj = (forecast.appliedAdjustments || []).filter((a) => a.finalAppliedLogOdds > 0);
  const byMech = {};
  for (const a of adj) (byMech[a.mechanism] = byMech[a.mechanism] || []).push(a);
  for (const [m, list] of Object.entries(byMech)) {
    const origins = new Set(list.flatMap((x) => x.originIds || []));
    if (origins.size >= 2) why.push(`${origins.size} independent origins support the same ${m} mechanism`);
  }
  if (consensus && consensus.ok) why.push(`Current sportsbook consensus is ${pct(consensus.probability)} across ${consensus.booksIncluded} books`);
  if (!why.length) why.push("No mechanism cleared the magnitude rules — this position rests on the price alone");

  if (forecast.evidenceCoverage && forecast.evidenceCoverage !== "WELL COVERED")
    against.push(`Evidence is ${forecast.evidenceCoverage}`);
  if (forecast.capNote) against.push(`Forecast is CAP LIMITED: ${forecast.capNote}`);
  // this one is on EVERY proposal, always. It is the truest sentence available about this system.
  against.push("Forecast has not demonstrated prospective edge");
  if (decision.feeEnvelope && decision.feeEnvelope.withinVerifiedEnvelope === false)
    against.push("Fee is extrapolated beyond the verified envelope");
  return { why, against };
}

module.exports = {
  TYPES, experimentalPosition, priceUpdate, evidenceUpdate, positionWithdrawn,
  noBetStatusChange, dailyShadowSummary, pipelineFailure, reasonsFor,
  assertNoConfidenceScore, BANNED,
};
