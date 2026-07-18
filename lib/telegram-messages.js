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

// REASONS ARE A LIST, NEVER A STRING. A bullet section (`for (const w of value) push("• " + w)`) fed a
// STRING iterates it CHARACTER BY CHARACTER — one bullet per letter. It happened: the exploration lane
// passed `why` as a single concatenated sentence, and the "Why it qualifies" section rendered "• W",
// "• h", "• y"... So every bullet section normalizes DEFENSIVELY here, at the render boundary, and no
// caller's shape can produce a one-character bullet again. A lone string becomes a single bullet; an
// array is kept; anything else (null, object, number) contributes nothing rather than throwing.
// Deliberately NOT spread / Array.from / raw iteration — those are exactly what break on a string.
function toReasons(value) {
  const reasons = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? [value.trim()]
      : [];
  return reasons.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim());
}
// Render a bullet section from an unvalidated reasons value. Returns [] of lines (already "• "-prefixed).
const bullets = (value) => toReasons(value).map((r) => `• ${r}`);

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
  for (const line of bullets(p.why)) L.push(line);
  L.push("");
  L.push("Against:");
  for (const line of bullets(p.against)) L.push(line);
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

// COMPACT WITHDRAWAL — a previously-recommended position no longer qualifies.
function positionWithdrawn(w) {
  const t = [
    "❌ BET WITHDRAWN",
    "",
    w.recommendedFirst || w.fight,
    "",
    `Reason: ${w.reason}`,
    "Do not place the previous recommendation.",
    w.dashboard ? `Details: ${w.dashboard}` : "",
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

// ---- the MANUAL BUY INSTRUCTION (entertainment bankroll) --------------------------------------
// Sent ONLY when the research gates have already ruled a contract ACTIONABLE EXPERIMENTAL. If the
// system says NO BET, no buy instruction exists to send — silence is the correct output, not a
// softer message.
//
// It names ONE contract: the highest-ranked eligible one, with a line on why it beat the
// alternatives. "Buy the outright YES" is an assumption, not a conclusion — the ranking has to
// actually compare what Kalshi lists.
// One standing footer for action messages. Everything else that used to be repeated on every alert —
// no-trading-path, cannot-place-orders, not-Kelly, contaminated-baseline, the confirm command, model
// provenance — lives on the dashboard and in the sealed artifacts, not in the phone message.
const FOOTER = "For entertainment use. Manual placement only.";

// Cents as a human reads them: whole cents, no trailing ".0".
const c = (x) => x == null ? "n/a" : `${Math.round(x * 100)}¢`;
const p0 = (x) => x == null ? "n/a" : `${Math.round(x * 100)}%`;

// THE COMPACT BUY RECOMMENDATION. Only what a human needs to understand and act. `b.recommendedFirst`
// is the fight with the recommended fighter named first; `b.buyLine` is e.g. "Du Plessis YES". The
// caller has ALREADY run lib/message-invariants and this rendered ONLY for a BUY verdict — the price
// gate (ask <= max) and the side/consistency checks are guaranteed before we get here.
function buyInstruction(b) {
  const L = [];
  L.push(`🧪 ${b.classification || "EXPERIMENTAL"} — $${Number(b.stake).toFixed(0)}`);
  L.push("");
  L.push(b.recommendedFirst || b.fight);
  L.push(`Buy: ${b.buyLine}`);
  L.push("");
  L.push(`Current: ${c(b.ask)}`);
  L.push(`Maximum: ${c(b.maximumAcceptablePrice)}`);
  L.push(`Stake: $${Number(b.stake).toFixed(0)} of $${b.bankroll}`);
  if (Number.isFinite(b.approxContracts)) L.push(`Approx contracts: ${b.approxContracts}`);
  if (Number.isFinite(b.cardExposureRemaining)) L.push(`Card exposure left: $${b.cardExposureRemaining}`);
  L.push("");
  if (b.whyOne) L.push(`Why: ${b.whyOne}`);
  if (b.riskOne) L.push(`Main risk: ${b.riskOne}`);
  L.push(`System estimate: ${p0(b.centralProb)} (range ${p0(b.rangeLow)}–${p0(b.rangeHigh)})`);
  if (b.whyRankedFirst) L.push(`Top pick because: ${b.whyRankedFirst}`);
  L.push("");
  L.push(`Place only if the displayed average price is ${c(b.maximumAcceptablePrice)} or less.`);
  if (b.dashboard) L.push(`Full reasoning: ${b.dashboard}`);
  L.push("");
  L.push(FOOTER);
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  return text;
}

// PRICE TOO HIGH — a real position that is priced out right now. Never a BUY. Sent when the current
// ask is above the maximum acceptable price (the exact Du Plessis situation: 67¢ vs a 61¢ ceiling).
function priceTooHigh(b) {
  const L = [];
  L.push("⏸️ PRICE TOO HIGH — DO NOT BUY");
  L.push("");
  L.push(b.recommendedFirst || b.fight);
  L.push(`Current: ${c(b.ask)}`);
  L.push(`Maximum: ${c(b.maximumAcceptablePrice)}`);
  L.push("");
  L.push(`Wait for ${c(b.maximumAcceptablePrice)} or lower. The system will alert again if it becomes available.`);
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  return text;
}

// ---- HUMAN REVIEW: unverified news a human should see -----------------------------------------
// A DIFFERENT KIND OF MESSAGE, AND IT MUST NEVER BE MISTAKEN FOR THE OTHER ONE. A reported
// withdrawal or injury is the highest-value thing this pipeline surfaces and the least verified: it
// is typically one person saying something on one video, with no corroboration and no way to check
// it before the fight.
//
// So this message carries NO price, NO stake, NO contract and NO instruction — not as a matter of
// wording but of construction. assertNotABettingInstruction() below refuses to build one that
// contains them. The failure mode being prevented is specific and very easy: a human reads "Holland
// reportedly out", concludes the market has not caught up, and bets on it. That inference might even
// be right — but it would be the human's inference from a rumour, not this system's forecast, and
// the message must not blur the two.
//
// The system's OWN forecast has already handled this evidence through the normal path: an injury
// claim with one origin cannot clear the magnitude rules, so it moved no probability. That is
// correct and it is why this alert exists separately — the human may want to know something the
// forecast is right to ignore.
const BETTING_WORDS = /\b(buy|sell|stake|bet|position|ask|price|contract|¢|cents?|EV|edge|kelly|max(?:imum)? price|place)\b/i;
function assertNotABettingInstruction(text) {
  const m = String(text).match(BETTING_WORDS);
  if (m) throw new Error(`a HUMAN REVIEW alert contains betting language ("${m[0]}") — this message reports unverified news and must not carry a price, stake, contract or instruction`);
  return true;
}

// COMPACT HUMAN REVIEW — 6–8 short lines. No internal topic names, no origin-methodology lecture, the
// unverified status stated once, whether the forecast moved, and a dashboard link when available.
function humanReview(r) {
  const origins = Number.isFinite(r.origins)
    ? `${r.origins} independent origin${r.origins === 1 ? "" : "s"}`
    : "origin count not available";
  const impact = r.forecastMoved === true ? "Moved the forecast (see dashboard)"
    : r.forecastMoved === false ? "None" : (r.forecastEffect && /moved nothing|no adjustment|did NOT move/i.test(r.forecastEffect) ? "None" : "None");
  const L = [];
  L.push("🔎 UNVERIFIED FIGHT UPDATE");
  L.push("");
  L.push(r.fight);
  L.push("");
  L.push(`Report: ${r.claim}`);
  L.push(`Sources: ${origins}`);
  L.push(`Forecast impact: ${impact}`);
  if (r.dashboard) L.push(`Details: ${r.dashboard}`);
  L.push("");
  L.push("Verify before acting.");
  L.push("For entertainment use.");
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  assertNotABettingInstruction(text);
  return text;
}

// A short CONFIRMED / DISPROVED follow-up when a previously-flagged rumour resolves.
function reviewResolved(r) {
  const confirmed = r.status === "CONFIRMED";
  const L = [];
  L.push(confirmed ? "✅ CONFIRMED UPDATE" : "🚫 REPORT DISPROVED");
  L.push("");
  L.push(r.fight);
  L.push("");
  L.push(`${confirmed ? "Now confirmed" : "Now disproved"}: ${r.claim}`);
  if (r.forecastMoved != null) L.push(`Forecast impact: ${r.forecastMoved ? "updated (see dashboard)" : "None"}`);
  if (r.dashboard) L.push(`Details: ${r.dashboard}`);
  L.push("");
  L.push("For entertainment use.");
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  assertNotABettingInstruction(text);
  return text;
}

// ---- FIGHT INTELLIGENCE messages (§6) --------------------------------------------------------
// ONE COMBINED MESSAGE per report per run. The old flow sent an unverified-news alert and THEN a
// separate betting alert about the same report — two messages that read as two opportunities. These
// fold discovery + assessment + forecast impact + market + action into a single message, and later
// state changes into a SHORT update that says only what changed (never a full re-send of the original).

// A SPECULATIVE INTEL BET (§6A). It carries a stake and a price, so the CALLER must have already run
// lib/message-invariants and reached a BUY verdict — the price gate (ask ≤ max) and side/consistency
// checks are guaranteed before this renders, exactly like buyInstruction.
function speculativeIntelBet(b) {
  const L = [];
  L.push(`🧪 SPECULATIVE INTEL BET — $${Number(b.stake).toFixed(0)}`);
  L.push("");
  L.push(b.recommendedFirst || b.fight);
  L.push(`Buy: ${b.buyLine}`);
  L.push("");
  if (b.reportLine) L.push(`Report: ${b.reportLine}`);
  if (b.assessmentLine) L.push(`Assessment: ${b.assessmentLine}`);
  L.push(`Forecast impact: ${b.forecastImpactLine || "None"}`);
  L.push("");
  L.push(`Current: ${c(b.ask)}`);
  L.push(`Maximum: ${c(b.maximumAcceptablePrice)}`);
  L.push(`Stake: $${Number(b.stake).toFixed(0)} of $${b.bankroll}`);
  L.push("");
  if (b.whyMatters) L.push(`Why it may matter: ${b.whyMatters}`);
  if (b.mainRisk) L.push(`Main risk: ${b.mainRisk}`);
  L.push("");
  L.push(`Place only at ${c(b.maximumAcceptablePrice)} or lower.`);
  if (b.dashboard) L.push(`Full reasoning: ${b.dashboard}`);
  L.push("");
  L.push(FOOTER);
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  return text;
}

// A FIGHT INTEL — WATCH (§6B). Meaningful, but no bet qualifies. Concise; no price instruction.
function fightIntelWatch(w) {
  const L = [];
  L.push("🛰️ FIGHT INTEL — WATCH");
  L.push("");
  L.push(w.fight);
  L.push("");
  if (w.reportLine) L.push(`Report: ${w.reportLine}`);
  if (w.assessmentLine) L.push(`Assessment: ${w.assessmentLine}`);
  L.push(`Forecast impact: ${w.forecastImpactLine || "None yet"}`);
  L.push(`Market reaction: ${w.marketReactionLine || "No meaningful move"}`);
  L.push("");
  L.push(w.watchingLine || "Watching for confirmation or a price opportunity.");
  if (w.dashboard) L.push(`Details: ${w.dashboard}`);
  L.push("");
  L.push("For entertainment use.");
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  return text;
}

// A LATER STATE-CHANGE UPDATE (§6C/D). States ONLY what changed, the new assessment, the effect, and
// what to do now — never the full source explanation or the prior disclaimers again. The header and
// body depend on `kind`.
const INTEL_UPDATE_HEADERS = {
  CONFIRMED: "✅ REPORT CONFIRMED",
  DISPROVED: "❌ REPORT DISPROVED",
  MARKET_MOVED: "📉 MARKET ALREADY MOVED",
  WITHDRAWN: "❌ BET WITHDRAWN",
  PRICED_OUT: "⏸️ PRICE TOO HIGH",
  AVAILABLE_AGAIN: "🟢 PRICE AVAILABLE AGAIN",
};
function intelUpdate(u) {
  const header = INTEL_UPDATE_HEADERS[u.kind];
  if (!header) throw new Error(`unknown intel update kind "${u.kind}"`);
  const L = [];
  L.push(header);
  L.push("");
  L.push(u.fight);
  L.push("");
  if (u.detail) L.push(u.detail);
  if (u.previousStatus) L.push(`Previous status: ${u.previousStatus}`);
  if (u.systemAction) L.push(`System action: ${u.systemAction}`);
  if (u.whatToDo) L.push(u.whatToDo);
  L.push("");
  L.push("For entertainment use.");
  const text = L.join("\n");
  assertNoConfidenceScore(text);
  return text;
}

// The three placement labels, kept unmistakably separate. Short prefixes a caller prepends to context.
const PLACEMENT_LABELS = {
  PAPER_ONLY: "📝 PAPER ONLY\nResearch record. Do not place.",
  MANUAL_RECOMMENDATION: "💵 MANUAL RECOMMENDATION\nRecommended from the $100 entertainment bankroll, not yet confirmed as placed.",
  PLACEMENT_CONFIRMED: "✅ PLACEMENT CONFIRMED\nIncluded in actual bankroll P&L.",
};

module.exports = {
  TYPES: { ...TYPES, HUMAN_REVIEW: "HUMAN REVIEW" },
  experimentalPosition, priceUpdate, evidenceUpdate, positionWithdrawn,
  noBetStatusChange, dailyShadowSummary, pipelineFailure, reasonsFor, buyInstruction,
  humanReview, reviewResolved, priceTooHigh, PLACEMENT_LABELS, FOOTER,
  speculativeIntelBet, fightIntelWatch, intelUpdate, INTEL_UPDATE_HEADERS,
  assertNotABettingInstruction, BETTING_WORDS,
  assertNoConfidenceScore, BANNED, toReasons, bullets,
};
