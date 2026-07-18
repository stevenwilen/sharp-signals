// PHASE 9A — the dashboard's data layer.
//
// IT READS SEALED ARTIFACTS. IT NEVER RECOMPUTES ONE. That is the whole design, and it is what the
// pass condition asks for: every displayed number must reproduce from a sealed file, and the
// dashboard must never contradict the decision record. A dashboard that recalculates is a second
// implementation of the pipeline, and the moment the two disagree the screen wins the argument
// while the sealed record is what actually happened.
//
// So: no probability is derived here, no fee is computed here, no EV is formed here. Every number
// is copied out of an artifact and carries the hash it came from. Where an artifact is missing or
// its hash does not reproduce, the view says so LOUDLY rather than rendering a plausible blank.
//
// A GREEN STATUS MEANS THE PIPELINE COMPLETED. It does not mean a bet exists, and it must never be
// possible to read it that way.
require("./env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./contracts");
const S = require("./sportsbook-live");
const INTEL = require("./intelligence");

const ROOT = path.join(__dirname, "..");
const D = (f) => path.join(ROOT, "data", f);
const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);

function readSealed(file, hashField) {
  const p = D(file);
  if (!fs.existsSync(p)) return { ok: false, file, reason: "artifact not found" };
  let j;
  try { j = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { ok: false, file, reason: `unreadable: ${e.message}` }; }
  const out = { ok: true, file, data: j, mtime: fs.statSync(p).mtime.toISOString() };
  if (hashField && j[hashField]) {
    const recomputed = sha({ ...j, [hashField]: undefined });
    out.hashField = hashField;
    out.storedHash = j[hashField];
    out.reproduces = recomputed === j[hashField];
    // A hash that does not reproduce means the file was edited after sealing. Rendering its numbers
    // anyway would put un-sealed values on a screen that claims to show the decision record.
    if (!out.reproduces) { out.ok = false; out.reason = `${hashField} does not reproduce — artifact was modified after sealing`; }
  }
  return out;
}

// ---- 1. SYSTEM STATUS ------------------------------------------------------------------------
function systemStatus(opts = {}) {
  const now = opts.nowTs || Date.now();
  const stages = [];
  const fail = (stage, why) => stages.push({ stage, ok: false, why });

  const shadowFiles = fs.readdirSync(D(".")).filter((f) => /^phase8-shadow-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const cards = [];
  for (const f of shadowFiles) {
    const r = readSealed(f, "decisionHash");
    if (!r.ok) { fail(`shadow decision ${f}`, r.reason); continue; }
    cards.push(r);
  }

  const fees = readSealed("fee-verification.json");
  const baselines = readSealed("baselines.json");

  // counts come from the sealed decisions, never from a re-derivation
  let actionable = 0, watch = 0, noBet = 0, analysisOnly = 0, unpriced = 0, review = 0;
  for (const c of cards) for (const d of c.data.decisions || []) {
    if (d.classification === "ACTIONABLE EXPERIMENTAL") actionable++;
    else if (d.classification === "WATCH") watch++;
    else if (d.classification === "NO BET") noBet++;
    else if (d.classification === "ANALYSIS ONLY") analysisOnly++;
    else if (d.classification === "UNPRICED") unpriced++;
    else if (d.classification === "HUMAN REVIEW REQUIRED") review++;
  }

  const lastRun = cards.length ? cards.map((c) => c.data.decisionTimestamp).sort().pop() : null;
  const ageMs = lastRun ? now - Date.parse(lastRun) : null;

  // Freshness is REPORTED, never assumed. A stale run is a pipeline state, not a rendering detail.
  const freshness = {
    lastSuccessfulRun: lastRun,
    ageMinutes: ageMs === null ? null : +(ageMs / 60000).toFixed(1),
    stale: ageMs === null ? true : ageMs > (opts.maxRunAgeMs ?? 6 * 3600 * 1000),
  };
  if (freshness.stale) stages.push({ stage: "pipeline freshness", ok: false, why: lastRun ? `last successful run was ${freshness.ageMinutes} min ago` : "no successful run found" });

  const sb = opts.sportsbookSnapshot || null;
  const kal = opts.kalshiSnapshot || null;

  const s = {
    // These three are first, and they are the point. A dashboard for a system that cannot trade
    // must say so before it says anything else.
    alerts: "DISARMED",
    tradingCapability: "NONE",
    orderPlacementPath: "does not exist in this build",

    pipelineVersion: {
      rules: (cards[0] && cards[0].data.versions && cards[0].data.versions.rules) || null,
      contracts: "contracts@1.0.0", value: "contract-value@1.0.0",
      portfolio: "portfolio@1.0.0", sportsbook: "sportsbook-live@1.0.0", dashboard: "dashboard-data@1.0.0",
    },
    freshness,
    sportsbookSnapshot: sb ? {
      status: sb.ok ? "OK" : "UNAVAILABLE",
      takenAt: sb.snapshotTimestamp || null,
      ageMinutes: sb.oldestQuoteAgeMinutes ?? null,
      books: sb.booksIncluded ?? 0,
      reason: sb.ok ? null : sb.reason,
    } : { status: "NOT COLLECTED", reason: "no sportsbook snapshot supplied to this render" },
    kalshiSnapshot: kal ? {
      status: "OK", takenAt: new Date(kal).toISOString(),
      ageMinutes: +((now - kal) / 60000).toFixed(1),
    } : { status: "NOT COLLECTED" },

    feeVerification: {
      status: C.FEES.verifiedScope && C.FEES.verifiedScope.verified ? "VERIFIED (scoped)" : "UNVERIFIED",
      asOf: C.FEES.verifiedScope ? C.FEES.verifiedScope.asOf : null,
      scope: C.FEES.verifiedScope ? {
        series: C.FEES.verifiedScope.series, side: C.FEES.verifiedScope.side,
        priceRange: C.FEES.verifiedScope.priceRange, sizeRange: C.FEES.verifiedScope.sizeRange,
        fills: C.FEES.verifiedScope.fills,
      } : null,
      // The scope is shown WITH what it excludes. A "VERIFIED" badge with no boundary is how a
      // reader ends up believing maker fees were checked.
      doesNotEstablish: C.FEES.verifiedScope ? C.FEES.verifiedScope.doesNotEstablish : [],
      reviewProvenance: "2 of 3 independent adversarial lenses completed; the third failed on a retry cap and its small-size claims were manually reproduced, NOT independently reviewed. See docs/fee-verification-provenance.md.",
      artifact: fees.ok ? "data/fee-verification.json" : `MISSING: ${fees.reason}`,
    },

    activeCards: cards.length,
    counts: { actionableExperimental: actionable, watch, noBet, analysisOnly, unpriced, humanReviewRequired: review },
    failedStages: stages,

    // GREEN MEANS THE PIPELINE RAN. Stated on the object itself so no consumer can quietly redefine
    // it as "there is a bet".
    indicator: stages.length === 0 ? "GREEN" : "RED",
    indicatorMeaning: "GREEN = the pipeline completed and every artifact reproduces. It does NOT mean a bet exists, and it is unrelated to whether any position is proposed.",
  };
  if (!baselines.ok) s.failedStages.push({ stage: "market baselines", ok: false, why: baselines.reason });
  s.indicator = s.failedStages.length === 0 ? "GREEN" : "RED";
  return s;
}

// ---- 2. UPCOMING CARD ------------------------------------------------------------------------
// EVERY bout appears. A bout the system declined to price is the most important row on the page:
// omitting it turns "we have no opinion on 10 of 15 fights" into a screen that looks like 5 fights.
function upcomingCard(cardDate, opts = {}) {
  const fcR = readSealed(`forecast-${cardDate}.json`, "sealHash");
  const shR = readSealed(`phase8-shadow-${cardDate}.json`, "decisionHash");
  if (!fcR.ok) return { ok: false, reason: `forecast artifact unusable: ${fcR.reason}` };
  const fc = fcR.data;
  const decisions = shR.ok ? shR.data.decisions : [];

  const rows = fc.forecasts.map((f) => {
    const [A, B] = f.fight.split(" vs ");
    const mine = decisions.filter((d) => d.bout === f.fight || d.boutId === f.boutId);
    // "highest-ranked eligible" means eligible — a NO BET is not a position.
    const eligible = mine.filter((d) => d.classification === "ACTIONABLE EXPERIMENTAL")
      .sort((x, y) => (y.leverageScore ?? -1) - (x.leverageScore ?? -1))[0] || null;
    const best = mine.sort((x, y) => (x.rank || 99) - (y.rank || 99))[0] || null;
    return {
      boutId: f.boutId, fight: f.fight, fighterA: A, fighterB: B,
      marketBaseline: f.marketBaseline ? {
        probability: f.marketBaseline.probability, forFighter: f.marketBaseline.forFighter,
        tier: f.marketBaseline.fallbackLevel, clockBasis: f.marketBaseline.clockBasis,
        source: f.marketBaseline.sportsbooks,
      } : null,
      systemProbability: f.systemCentral ? f.systemCentral[A] : null,
      systemRange: f.systemRange || null,
      kalshiExecutablePrice: best ? best.allInPrice : null,
      kalshiAsk: best ? best.askPrice : null,
      forecastStatus: f.status,
      evidenceCoverage: f.evidenceCoverage || null,
      capLimited: !!f.capNote,
      capNote: f.capNote || null,
      contractClassification: best ? best.classification : "NO CONTRACT MAPPED",
      highestRankedEligible: eligible ? { ticker: eligible.ticker, subject: eligible.outcomeSubject, stake: eligible.proposedStake } : null,
      noBetReason: best && best.classification !== "ACTIONABLE EXPERIMENTAL" ? best.reason : null,
      lastUpdate: shR.ok ? shR.data.decisionTimestamp : fc.sealedAt,
      // provenance travels with the row
      provenance: { forecastHash: fc.sealHash, decisionHash: shR.ok ? shR.data.decisionHash : null },
    };
  });

  return {
    ok: true, card: fc.card.eventId, eventDate: fc.card.eventDate,
    sealedAt: fc.sealedAt, rulesVersion: fc.rulesVersion,
    forecastHash: fc.sealHash,
    decisionHash: shR.ok ? shR.data.decisionHash : null,
    decisionArtifact: shR.ok ? null : `no sealed decision record: ${shR.reason}`,
    totalBouts: rows.length,
    boutsWithoutBaseline: rows.filter((r) => !r.marketBaseline).length,
    rows,
  };
}

// ---- 3. FIGHT DETAIL -------------------------------------------------------------------------
// The four things below are DIFFERENT KINDS OF NUMBER and are labelled as such. Blur them and the
// reader concludes the system found value when the market simply moved.
const NUMBER_KINDS = {
  MARKET_MOVEMENT: "the market changing its own mind. NOT ours, NOT value, NOT edge.",
  SYSTEM_ADJUSTMENT: "our evidence moving us off the market baseline. This is the only thing that is our opinion.",
  EVIDENCE_UNCERTAINTY: "how little we know — the width of the range, not its direction.",
  PRICING_FRICTION: "fees, spread and slippage. Cost, not opinion, and it always works against us.",
};

function fightDetail(cardDate, boutId, opts = {}) {
  const fcR = readSealed(`forecast-${cardDate}.json`, "sealHash");
  if (!fcR.ok) return { ok: false, reason: fcR.reason };
  const fc = fcR.data;
  const f = fc.forecasts.find((x) => x.boutId === boutId);
  if (!f) return { ok: false, reason: `bout ${boutId} not in the sealed forecast` };
  const [A, B] = f.fight.split(" vs ");

  const scR = readSealed(`scenarios-ranked-${cardDate}.json`, "scenarioSetHash");
  const shR = readSealed(`phase8-shadow-${cardDate}.json`, "decisionHash");
  const scenarios = scR.ok && scR.data.scenarios[boutId] ? scR.data.scenarios[boutId].scenarios : [];
  const decisions = shR.ok ? shR.data.decisions.filter((d) => d.bout === f.fight) : [];
  const consensus = opts.consensus || null;

  const kal = decisions[0] || null;
  return {
    ok: true, boutId, fight: f.fight,
    marketMovement: {
      kind: "MARKET_MOVEMENT", meaning: NUMBER_KINDS.MARKET_MOVEMENT,
      openingLine: opts.openingProbability ?? null,
      currentSportsbookConsensus: consensus && consensus.ok ? consensus.probability : null,
      consensusBooks: consensus && consensus.ok ? consensus.sourceBooks : [],
      consensusDispersion: consensus && consensus.ok ? consensus.marketDispersion : null,
      movementPoints: (opts.openingProbability != null && consensus && consensus.ok)
        ? +((consensus.probability - opts.openingProbability) * 100).toFixed(2) : null,
      WARNING: "Opening-to-current movement is the market updating itself. It is NOT system edge and must never be presented as one.",
    },
    kalshi: kal ? {
      kind: "PRICING_FRICTION",
      bid: kal.askPrice != null ? null : null,
      ask: kal.askPrice, executablePrice: kal.executablePrice,
      allInPrice: kal.allInPrice, fee: kal.fees, slippage: kal.slippage,
      liquidity: kal.availableLiquidity, fullyFillable: kal.fullyFillable,
      meaning: NUMBER_KINDS.PRICING_FRICTION,
    } : null,
    systemForecast: {
      kind: "SYSTEM_ADJUSTMENT", meaning: NUMBER_KINDS.SYSTEM_ADJUSTMENT,
      baseline: f.marketBaseline ? f.marketBaseline.probability : null,
      baselineTier: f.marketBaseline ? f.marketBaseline.fallbackLevel : null,
      baselineClock: f.marketBaseline ? f.marketBaseline.clockBasis : null,
      central: f.systemCentral ? f.systemCentral[A] : null,
      forFighter: A,
      marketDisagreementPoints: f.marketDisagreementPoints,
      status: f.status,
      capLimited: !!f.capNote, capNote: f.capNote || null,
    },
    uncertainty: {
      kind: "EVIDENCE_UNCERTAINTY", meaning: NUMBER_KINDS.EVIDENCE_UNCERTAINTY,
      range: f.systemRange, evidenceCoverage: f.evidenceCoverage,
    },
    scenarios: scenarios.map((s) => ({
      rank: s.rank, role: s.role, winner: s.winner, method: s.expectedMethod,
      roundRange: s.expectedRoundRange, share: s.sharePercent, supported: s.supported,
      decisiveMechanisms: s.decisiveMechanisms, whyRankedHere: s.whyRankedHere,
      falsifiedBy: s.falsifiedBy, evidenceLimitations: s.evidenceLimitations,
      modelStatus: "method/round shares come from v7.0.0's FIXED, UNVALIDATED method priors",
    })),
    appliedAdjustments: (f.appliedAdjustments || []).filter((a) => a.finalAppliedLogOdds > 0).map((a) => ({
      mechanism: a.mechanism, favours: a.fighterFavored,
      magnitudeClass: a.rawMagnitudeClass, liftedTo: a.liftedTo,
      appliedLogOdds: a.finalAppliedLogOdds,
      independentOrigins: a.informationOriginCount,
      evidenceTopics: a.evidenceTopics,
      capOrReduction: a.capOrReductionReason,
      reason: a.magnitudeReason,
    })),
    consideredButZero: f.consideredButZero ?? null,
    evidenceLimitations: [
      ...(f.evidenceCoverage && f.evidenceCoverage !== "WELL COVERED" ? [`evidence is ${f.evidenceCoverage}`] : []),
      ...(f.capNote ? [`forecast is CAP LIMITED: ${f.capNote}`] : []),
      ...(f.marketBaseline && f.marketBaseline.clockBasis === "LOGICAL_OPEN"
        ? ["baseline is an OPENING line: it cannot be compared to a live price without measuring elapsed time as edge"] : []),
    ],
    missingInformation: f.status === "BASELINE UNAVAILABLE" ? [f.reason]
      : f.status === "INSUFFICIENT EVIDENCE" ? ["no admissible evidence cleared the magnitude rules for this bout"] : [],
    lineage: {
      forecastHash: fc.sealHash, sealedAt: f.sealedAt, rulesVersion: fc.rulesVersion,
      scenarioSetHash: scR.ok ? scR.data.scenarioSetHash : null,
      decisionHash: shR.ok ? shR.data.decisionHash : null,
      supersedes: fc.supersedes || null,
      dataHashes: f.dataHashes || null,
    },
  };
}

// ---- 4. CONTRACT COMPARISON ------------------------------------------------------------------
function contractComparison(cardDate) {
  const shR = readSealed(`phase8-shadow-${cardDate}.json`, "decisionHash");
  if (!shR.ok) return { ok: false, reason: shR.reason };
  return {
    ok: true, decisionHash: shR.data.decisionHash,
    snapshotTimestamp: shR.data.snapshotTimestamp,
    contracts: shR.data.decisions.map((d) => ({
      ticker: d.ticker, bout: d.bout,
      contractWording: d.contractWording,
      settlementRule: d.settlementRules,
      outcomeType: d.outcomeType, subject: d.outcomeSubject,
      executablePrice: d.executablePrice, allInPrice: d.allInPrice,
      systemProbability: d.systemProbability,
      conservativeProbability: d.conservativeProbability,
      fee: d.fees, slippage: d.slippage,
      estimatedValueAfterCosts: d.netExpectedValueConservative,
      estimatedValueLabel: d.unverifiedEstimatedEdge ? d.unverifiedEstimatedEdge.label : null,
      maximumAcceptablePrice: d.maximumAcceptablePrice,
      liquidity: d.availableLiquidity, fullyFillable: d.fullyFillable,
      // an out-of-envelope fee is never hidden behind a green tick
      verificationEnvelope: d.feeEnvelope || null,
      modelStatus: d.probabilityModelStatus,
      rankingStatus: d.classification, rank: d.rank,
      rejectionReason: d.classification === "ACTIONABLE EXPERIMENTAL" ? null : d.reason,
      analysisOnly: d.probabilityModelStatus === "UNVALIDATED METHOD MODEL",
    })),
  };
}

// ---- 5. PORTFOLIO ----------------------------------------------------------------------------
function portfolioView(cardDate) {
  const shR = readSealed(`phase8-shadow-${cardDate}.json`, "decisionHash");
  if (!shR.ok) return { ok: false, reason: shR.reason };
  const d = shR.data;
  const proposed = d.decisions.filter((x) => x.proposedStake > 0);
  const pe = d.portfolioExposure || {};
  return {
    ok: true, decisionHash: d.decisionHash, bankroll: d.bankroll, caps: d.caps,
    proposedPositions: proposed.map((p) => ({
      ticker: p.ticker, bout: p.bout, subject: p.outcomeSubject,
      stake: p.proposedStake, contracts: p.proposedContracts,
      maximumAcceptablePrice: p.maximumAcceptablePrice,
      flatStakeComparison: p.flatStakeComparison,
      expiresIf: [
        `ask rises above ${p.maximumAcceptablePrice != null ? (p.maximumAcceptablePrice * 100).toFixed(1) + "c" : "n/a"}`,
        "a fresh sportsbook consensus moves materially",
        "new evidence changes the sealed forecast",
        "the snapshot goes stale",
      ],
    })),
    exposureByFight: (pe.perBout || []).map((b) => ({
      fight: b.fight, positions: b.positions, totalExposure: b.totalExposure,
      maxLoss: b.maxLoss, maxGain: b.maxGain,
      payoffByTerminalOutcome: b.payoffByTerminalState,
      nested: b.nestedPositions, opposing: b.opposingPositions,
      mechanismConcentration: b.mechanismConcentration,
      correlatedExposure: b.correlatedExposure,
      diversificationNote: b.diversificationNote,
    })),
    cardTotalExposure: pe.cardTotalExposure ?? 0,
    cardMaxLoss: pe.cardMaxLoss ?? 0,
    cardMaxGain: pe.cardMaxGain ?? 0,
    concentrationByFighter: pe.concentrationByFighter || {},
    independenceAssumption: pe.note || null,
    diversificationWarning: "Overlapping positions on one fight are CONCENTRATION, never diversification. A nested contract is one bet at two sizes.",
  };
}

// ---- 6. FORWARD RECORD -----------------------------------------------------------------------
// No-bets are part of the record. A ledger of only the bets cannot be evaluated: "how often did it
// decline?" is exactly as informative as "how often did it win?", and a record that drops the
// declines will always look like a strategy that never says no.
function forwardRecord() {
  const files = fs.readdirSync(D(".")).filter((f) => /^phase8-shadow-/.test(f) && f.endsWith(".json"));
  const runs = [];
  for (const f of files) {
    const r = readSealed(f, "decisionHash");
    const superseded = /\.v[0-9a-f]+\.json$/.test(f);
    if (!r.ok) { runs.push({ file: f, ok: false, reason: r.reason, superseded }); continue; }
    runs.push({
      file: f, ok: true, superseded,
      card: r.data.card, decidedAt: r.data.decisionTimestamp,
      decisionHash: r.data.decisionHash,
      supersededBy: r.data.supersedes ? null : undefined,
      supersedes: r.data.supersedes || null,
      armed: r.data.armed, alertsSent: r.data.alertsSent, ordersPlaced: r.data.ordersPlaced,
      decisions: (r.data.decisions || []).map((d) => ({
        ticker: d.ticker, classification: d.classification,
        stake: d.proposedStake, allInPrice: d.allInPrice,
        systemProbability: d.systemProbability,
        outcomeTracking: r.data.outcomeTracking || null,
      })),
    });
  }
  const all = runs.filter((r) => r.ok).flatMap((r) => r.decisions);
  const byClass = {};
  for (const d of all) byClass[d.classification] = (byClass[d.classification] || 0) + 1;
  const total = all.length || 1;
  return {
    runs: runs.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt))),
    summary: {
      totalDecisions: all.length,
      byClassification: byClass,
      // the headline metric is NOT ROI
      noBetFrequency: `${(((byClass["NO BET"] || 0) / total) * 100).toFixed(1)}%`,
      actionableFrequency: `${(((byClass["ACTIONABLE EXPERIMENTAL"] || 0) / total) * 100).toFixed(1)}%`,
      settledPositions: 0,
      netPaperResultAfterVerifiedCosts: null,
      calibration: "not computable yet — no shadow position has settled",
      note: "Performance is reported as no-bet frequency and calibration first. ROI on an unsettled, never-armed shadow book would be a number about nothing.",
    },
  };
}

// ---- 7. UNIFIED DASHBOARD --------------------------------------------------------------------
// One object assembled from the sealed artifacts, for a single read-only page. It COPIES; it does
// not compute. No probability, adjustment, stake, fee or edge is derived here — every number is
// lifted from a sealed file and travels with the hash it came from. Where an artifact is absent it
// is reported as "not yet available", never blanked and never faked: a missing learning ledger is a
// fact about the pipeline, not a rendering gap to paper over.
//
// The one thing this function DOES check is cross-artifact agreement: the forecast seal hash, the
// decision record's forecastHash and the attestation's forecastSealHash must all name the same
// sealed forecast. A dashboard that shows a decision next to a forecast it was not made against is
// exactly the "screen wins the argument" failure the whole layer exists to prevent.
const { ARMING, productionEnabled } = require("./arming");
const MB = require("./manual-bankroll");
const POS = require("./positions");

function latestForecastCard() {
  return fs.readdirSync(D("."))
    .map((f) => (f.match(/^forecast-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1])
    .filter(Boolean).sort().reverse()[0] || null;
}

// A plain read for artifacts that carry NO self-hash (their embedded hashes point at OTHER files).
// Verifying entertainment-alerts.forecastHash as if it were a self-hash would always fail — it is the
// forecast's seal hash copied in, not a digest of the alerts file.
function readPlain(file) {
  const p = D(file);
  if (!fs.existsSync(p)) return { ok: false, file, reason: "not yet available" };
  try {
    return { ok: true, file, data: JSON.parse(fs.readFileSync(p, "utf8")), mtime: fs.statSync(p).mtime.toISOString() };
  } catch (e) { return { ok: false, file, reason: `unreadable: ${e.message}` }; }
}

function evidenceForBout(evalData, boutId) {
  if (!evalData) return null;
  const b = (evalData.bouts || []).find((x) => x.boutId === boutId);
  if (!b) return null;
  const supporting = [
    ...(b.strongestFactual || []).map((s) => ({
      kind: "factual", topic: s.topic, about: s.about, direction: s.direction,
      strength: s.strength || null, origins: s.origins ?? null, amplifiers: s.amplifiers ?? null,
      claim: s.claim, quote: s.quote || null,
    })),
    ...(b.strongestMatchupObservations || []).map((s) => ({
      kind: "matchup", topic: s.topic, about: s.about, direction: s.direction,
      origins: s.independentObservations ?? null, claim: s.claim,
    })),
  ];
  return {
    coverage: b.coverage || null,
    independentOrigins: b.independentOrigins ?? null,
    originBreakdown: b.originBreakdown || null,
    channels: b.channels || null,
    supporting,
    // No contradictions were present in this card's eval; the array is passed through faithfully so a
    // future contradiction renders rather than being swallowed by an assumption that there are none.
    contradictory: (b.contradictions || []).map((c) => ({
      topic: c.topic, about: c.about, claim: c.claim, note: c.note || null, chain: c.chain || null,
    })),
    currentCondition: (b.currentCondition || []).map((c) => ({
      topic: c.topic, about: c.about, origins: c.origins ?? null, chain: c.chain || null, claim: c.claim,
    })),
    rumorsAndUnresolved: (b.rumorsAndUnresolved || []).map((r) => ({
      topic: r.topic, about: r.about, origins: r.origins ?? null, chain: r.chain || null, claim: r.claim,
    })),
    missingInformation: b.missingInformation || [],
    limitations: b.limitations || [],
  };
}

// FIGHT INTELLIGENCE VIEW (§16). READS the persisted intelligence store and PARTITIONS it by lifecycle
// stage for display. It recomputes NOTHING — every field is copied from the record the pipeline sealed,
// and the movement delta is plain arithmetic over persisted before/after prices, not a re-decision.
function intelDisplay(rec) {
  const before = rec.kalshiBefore && rec.kalshiBefore.ask;
  const after = (rec.kalshiAfter || []).slice(-1)[0];
  return {
    intelligenceId: rec.intelligenceId, proposition: rec.proposition,
    status: rec.truthStatus, action: rec.actionStatus, reportType: rec.reportType,
    report: rec.claim, fighter: rec.fighter, fight: rec.fight,
    firstSeen: rec.firstSeenAt, lastUpdated: rec.lastUpdatedAt,
    originalSource: rec.originalOrigin, originType: rec.originType,
    independentOrigins: rec.independentOrigins, amplifiers: rec.amplifierCount,
    accessRelevance: rec.accessRelevance, specificity: rec.specificity, recency: rec.recency, plausibility: rec.plausibility,
    quotes: rec.quotes || [], confirmations: rec.confirmations || [], contradictions: rec.contradictions || [],
    marketBefore: rec.kalshiBefore || null, marketAfter: rec.kalshiAfter || [],
    marketMovementPoints: (before != null && after) ? +((after.ask - before) * 100).toFixed(1) : null,
    forecastImpact: rec.forecastImpact || null, positionImpact: rec.positionVersions || [],
    mechanism: rec.mechanism, novel: rec.novel, probablyPriced: rec.probablyPriced,
    telegramHistory: rec.telegramLineage || [], timeline: rec.actionHistory || [],
  };
}
function fightIntelligenceView(card) {
  const r = readPlain(`intelligence-${card}.json`);
  const empty = { new: [], watching: [], influencedForecast: [], betProposed: [], marketMoved: [], confirmed: [], disproved: [], ignored: [] };
  if (!r.ok || !r.data || !r.data.records) {
    return { present: false, note: "No fight intelligence recorded for this card yet.", total: 0, counts: {}, groups: empty, updatedAt: null };
  }
  const records = Object.values(r.data.records);
  const grouped = INTEL.groupByAction(records);   // a pure partition by the persisted actionStatus
  const groups = {}, counts = {};
  for (const [k, list] of Object.entries(grouped)) { groups[k] = list.map(intelDisplay); counts[k] = list.length; }
  return { present: true, total: records.length, counts, groups, updatedAt: r.data.updatedAt || null };
}

function buildUnifiedDashboard(cardDate) {
  const header = {
    readsSealedArtifactsOnly: "Reads sealed artifacts only — does not recalculate decisions.",
    dashboardVersion: "unified-dashboard@1.0.0",
    generatedAt: new Date().toISOString(),
  };
  // Safety block is first and unconditional. It is stated even on the error path: a page for a system
  // that cannot trade must say so before it says anything else, including "no card".
  const safety = {
    alertsArmed: ARMING.ALERTS_ARMED,
    alerts: ARMING.ALERTS_ARMED ? "ARMED" : "DISARMED",
    alertsMeaning: "ARMED = Telegram may send a human a manual instruction to type themselves. It has never meant an order is placed.",
    productionEnabled: productionEnabled(),
    productionMeaning: "SHARP_PRODUCTION=1 in the runtime, set by a human after review — the separate gate for actually sending money instructions to a phone.",
    tradingCapability: "ABSENT (no Kalshi write path)",
    tradingEnabledFlag: ARMING.TRADING_ENABLED,
    orderPlacementPath: "does not exist in this build",
    standingWarning: ARMING.standingWarning,
  };

  const card = cardDate || latestForecastCard();
  if (!card) return { ok: false, reason: "no sealed forecast exists in data/", ...header, safety };

  const fcR = readSealed(`forecast-${card}.json`, "sealHash");
  if (!fcR.ok) return { ok: false, reason: `forecast artifact unusable: ${fcR.reason}`, card, ...header, safety };
  const fc = fcR.data;

  const alR = readPlain(`entertainment-alerts-${card}.json`);
  const alerts = alR.ok ? alR.data : null;
  const atR = readPlain("attestation.json");
  const att = atR.ok ? atR.data : null;
  const dispR = readPlain("dispatch-receipts.json");
  const disp = dispR.ok ? dispR.data : null;
  const evalR = readPlain(`evidence-eval-${card}.json`);
  const evalData = evalR.ok ? evalR.data : null;

  // ---- cross-artifact hash agreement (the only thing computed here, and it is a comparison, not a
  // forecast) ----
  const forecastSealHash = fc.sealHash || null;
  const hashes = {
    forecastSealHash,
    forecastReproduces: fcR.reproduces !== false,
    forecastContentHash: fc.contentHash || null,
    decisionForecastHash: alerts ? alerts.forecastHash || null : null,
    attestationForecastHash: att ? att.forecastSealHash || null : null,
    decisionMatchesForecast: alerts ? alerts.forecastHash === forecastSealHash : null,
    attestationMatchesForecast: att ? att.forecastSealHash === forecastSealHash : null,
    supersedes: fc.supersedes || null,
  };
  hashes.allAgree =
    hashes.forecastReproduces &&
    (alerts ? hashes.decisionMatchesForecast : true) &&
    (att ? hashes.attestationMatchesForecast : true);

  // ---- cloud workflow health (from dispatch-receipts; grade is expected to be absent until a card
  // settles, and is reported as such rather than invented) ----
  const stageNames = ["collect", "forecast", "alerts", "grade"];
  const workflowStages = stageNames.map((name) => {
    const s = disp && disp[name];
    return s && s.ranAt
      ? { stage: name, ranAt: s.ranAt, card: s.card || null, seal: s.seal || null, present: true }
      : { stage: name, ranAt: null, card: null, present: false, note: "not yet available" };
  });
  const ranTimes = workflowStages.filter((s) => s.present).map((s) => s.ranAt).sort();
  const cloudWorkflow = {
    available: !!disp,
    reason: disp ? null : dispR.reason,
    stages: workflowStages,
    lastSuccessfulRun: ranTimes.length ? ranTimes[ranTimes.length - 1] : null,
  };

  // ---- attestation ----
  const attestation = att ? {
    available: true,
    card: att.card, forecastSealHash: att.forecastSealHash, passed: !!att.passed,
    ranAt: att.ranAt, expiresAt: att.expiresAt, ttlHours: att.ttlHours ?? null,
    expired: att.expiresAt ? Date.now() > Date.parse(att.expiresAt) : null,
    boundToThisForecast: att.forecastSealHash === forecastSealHash,
    failures: att.failures || [],
    stages: (att.stages || []).map((s) => ({ stage: s.stage, ok: !!s.ok, detail: s.detail || null })),
  } : { available: false, reason: atR.reason };

  // ---- decision + exposure summary (copied from the sealed alerts record) ----
  const buyInstructions = alerts ? alerts.buyInstructions || [] : [];
  const stakeOf = (b) => Number(b.stake ?? b.dollars ?? b.proposedStake ?? 0) || 0;
  const decisionSummary = alerts ? {
    available: true,
    classificationCounts: alerts.classificationCounts || {},
    contractsListed: alerts.contractsListed || {},
    totalContracts: (alerts.decisions || []).length,
    onlyOutrightMarketsListed: alerts.onlyOutrightMarketsListed ?? null,
    buyInstructionsCount: buyInstructions.length,
    humanReviewCount: (alerts.humanReviewAlerts || []).length,
    delivery: alerts.delivery || null,
    ranAt: alerts.ranAt || null,
    snapshotTimestamp: alerts.snapshotTimestamp || null,
  } : { available: false, reason: alR.reason };

  const exposure = alerts ? {
    bankroll: alerts.bankroll || null,
    tiers: alerts.tiers || null,
    caps: alerts.caps || null,
    activePositions: buyInstructions,
    currentExposure: buyInstructions.reduce((a, b) => a + stakeOf(b), 0),
    note: buyInstructions.length ? null : "no active manual positions — every contract classified NO BET",
  } : { available: false, reason: alR.reason };

  // ---- per-bout assembly ----
  const decisionsByBout = {};
  if (alerts) for (const d of alerts.decisions || []) (decisionsByBout[d.bout] = decisionsByBout[d.bout] || []).push(d);
  const buysByBout = {};
  for (const b of buyInstructions) (buysByBout[b.bout] = buysByBout[b.bout] || []).push(b);
  const reviewsByBout = {};
  if (alerts) for (const h of alerts.humanReviewAlerts || []) (reviewsByBout[h.boutId] = reviewsByBout[h.boutId] || []).push(h);

  const bouts = (fc.forecasts || []).map((f) => {
    const [A, B] = String(f.fight).split(" vs ");
    const mb = f.marketBaseline || null;
    const exp = f.exploration || null; // may not exist yet — handled as "none"
    const decs = decisionsByBout[f.fight] || [];
    const reviews = reviewsByBout[f.boutId] || [];

    return {
      boutId: f.boutId, fight: f.fight, fighterA: A, fighterB: B || null, status: f.status,

      marketPrior: mb ? {
        probability: mb.probability, forFighter: mb.forFighter,
        sportsbooks: mb.sportsbooks || [], tier: mb.fallbackLevel || null,
        clockBasis: mb.clockBasis || null, dispersion: mb.dispersion ?? null,
        baselineHash: mb.baselineHash || null,
      } : null,

      coreAdjustment: {
        applied: (f.appliedAdjustments || []).length > 0,
        marketDisagreementPoints: f.marketDisagreementPoints ?? null,
        netLogOdds: f.netLogOdds ?? null,
        consideredButZero: f.consideredButZero ?? null,
        capNote: f.capNote || null,
        adjustments: (f.appliedAdjustments || []).map((a) => ({
          mechanism: a.mechanism, favours: a.fighterFavored,
          magnitudeClass: a.rawMagnitudeClass, liftedTo: a.liftedTo,
          appliedLogOdds: a.finalAppliedLogOdds, independentOrigins: a.informationOriginCount,
          evidenceTopics: a.evidenceTopics || [], capOrReduction: a.capOrReductionReason,
          reason: a.magnitudeReason,
        })),
      },

      // Absent in this build's forecasts; rendered as an explicit "none" rather than a blank.
      creativeAdjustment: exp ? {
        present: true,
        creativeCentral: exp.creativeCentral || null,
        adjustment: exp.creativeAdjustment ?? exp.adjustment ?? null,
        note: exp.note || null,
      } : { present: false, note: "none — this sealed forecast carries no exploration block" },

      creativeHypotheses: exp ? (exp.hypotheses || []).map((h) => ({
        text: h.text, verificationStatus: h.verificationStatus || null, mechanism: h.mechanism || null,
        evidenceAgainst: h.evidenceAgainst || null, novelty: h.novelty ?? null,
        probablyPriced: h.probablyPriced ?? null, falsification: h.falsification || null,
        adjustment: h.adjustment ?? null,
      })) : [],

      finalProbability: {
        central: f.systemCentral || null,
        range: f.systemRange || null,
        creativeCentral: exp ? exp.creativeCentral || null : null,
      },

      uncertainty: f.uncertainty || null,
      evidenceCoverage: f.evidenceCoverage || null,
      independentOrigins: f.independentOrigins ?? null,
      originBreakdown: f.originBreakdown || null,
      admission: f.admission || null,
      evidenceDetail: evidenceForBout(evalData, f.boutId),

      // Verification status: unverified news items surfaced for this bout, plus contradiction count.
      verification: {
        unverifiedItems: reviews.length,
        hasUnverifiedNews: reviews.length > 0,
        contradictions: f.contradictions ?? null,
      },
      humanReview: reviews.map((h) => ({
        about: h.about, topic: h.topic, origins: h.origins, why: h.why, text: h.text,
      })),

      kalshi: {
        contracts: decs.map((d) => ({
          ticker: d.ticker, classification: d.classification, rank: d.rank,
          entertainmentEligible: d.entertainmentEligible ?? null, blockedBy: d.blockedBy || null,
          reason: d.reason || null,
        })),
        noBetReasons: [...new Set(decs.filter((d) => d.classification !== "ACTIONABLE EXPERIMENTAL").map((d) => d.reason).filter(Boolean))],
        suggestedPosition: (buysByBout[f.fight] || [])[0] || null,
        maximumAcceptablePrice: (() => {
          const bi = (buysByBout[f.fight] || [])[0];
          return bi ? (bi.maximumAcceptablePrice ?? null) : null;
        })(),
      },

      provenance: {
        forecastSealHash, boutStatus: f.status,
        dataHashes: f.dataHashes || null,
      },
    };
  });

  // ---- prospective / provisional learning artifacts (all optional; absence is reported honestly) ----
  const llR = readPlain("learning-ledger.json");
  const learning = llR.ok ? { available: true, ...llR.data } : {
    available: false, reason: "not yet available — no post-fight grades have been sealed",
  };

  const mrR = readPlain("mechanism-reliability.json");
  const mechanismReliability = mrR.ok ? { available: true, label: "PROVISIONAL", ...mrR.data } : {
    available: false, label: "PROVISIONAL", reason: "not yet available — no provisional mechanism reliability sealed",
  };

  const cvR = readPlain("convergence-eval.json");
  const convergence = cvR.ok ? {
    available: true,
    n: cvR.data.n ?? null,
    verdict: cvR.data.verdict || "NOT READY",
    ...cvR.data,
  } : { available: false, verdict: "NOT READY", reason: "not yet available — convergence has not been evaluated" };

  return {
    ok: true,
    ...header,
    safety,
    card: fc.card && fc.card.eventId ? fc.card.eventId : card,
    eventDate: (fc.card && fc.card.eventDate) || card,
    sealedAt: fc.sealedAt || null,
    rulesVersion: fc.rulesVersion || null,
    marketSource: fc.marketSource || null,
    hashes,
    attestation,
    cloudWorkflow,
    decisionSummary,
    exposure,
    // THE THREE PLACEMENT STATUSES, structurally separated. Read-only, from the sealed ledgers.
    manualBankroll: (() => {
      let mb, paper;
      try { mb = MB.load(); } catch { mb = { entries: {}, bankroll: 100 }; }
      try { paper = POS.load(); } catch { paper = { positions: {} }; }
      const grouped = MB.byStatus(mb, Object.values(paper.positions || {}));
      return {
        legend: "Three distinct statuses. Only MANUALLY PLACED is real money.",
        realBankrollPnl: MB.realBankrollPnl(mb),
        paperOnly: {
          meaning: "Research tracking only. Actual stake $0. Never a buy recommendation. Excluded from real P&L.",
          count: grouped.PAPER_ONLY.length, positions: grouped.PAPER_ONLY,
        },
        recommendedNotConfirmed: {
          meaning: "Telegram told you what to buy. You have NOT confirmed you placed it. Real stake $0, excluded from real P&L until you confirm.",
          count: grouped.RECOMMENDED_NOT_CONFIRMED.length,
          positions: grouped.RECOMMENDED_NOT_CONFIRMED.map((r) => ({
            fight: r.fight, ticker: r.ticker, classification: r.classification, lane: r.lane,
            recommendedStakeDollars: r.recommendedStakeDollars, maximumAcceptablePrice: r.maximumAcceptablePrice,
            actualStake: 0, includedInRealPnl: false, status: r.status,
            confirmWith: `node run-confirm-placement.js confirm ${r.ticker} --price=<fill> --stake=<$>`,
          })),
        },
        manuallyPlaced: {
          meaning: "You confirmed you bought it. Actual stake + execution price recorded. Included in your real $100 bankroll P&L.",
          count: grouped.MANUALLY_PLACED.length,
          positions: grouped.MANUALLY_PLACED.map((p) => ({
            fight: p.fight, ticker: p.ticker, status: p.status, actualStake: p.actualStake,
            executionPrice: p.executionPrice, realPnlDollars: p.realPnlDollars ?? null, includedInRealPnl: true,
          })),
        },
      };
    })(),
    totalBouts: bouts.length,
    boutsWithoutBaseline: bouts.filter((b) => !b.marketPrior).length,
    bouts,
    fightIntelligence: fightIntelligenceView(card),
    humanReviewAlerts: alerts ? (alerts.humanReviewAlerts || []).map((h) => ({
      boutId: h.boutId, about: h.about, topic: h.topic, origins: h.origins, why: h.why, text: h.text,
    })) : [],
    learning,
    mechanismReliability,
    convergence,
    artifactStatus: [
      { name: "forecast", file: `forecast-${card}.json`, present: fcR.ok, reproduces: fcR.reproduces !== false },
      { name: "entertainment-alerts", file: `entertainment-alerts-${card}.json`, present: alR.ok },
      { name: "attestation", file: "attestation.json", present: atR.ok },
      { name: "dispatch-receipts", file: "dispatch-receipts.json", present: dispR.ok },
      { name: "evidence-eval", file: `evidence-eval-${card}.json`, present: evalR.ok },
      { name: "learning-ledger", file: "learning-ledger.json", present: llR.ok },
      { name: "mechanism-reliability", file: "mechanism-reliability.json", present: mrR.ok },
      { name: "convergence-eval", file: "convergence-eval.json", present: cvR.ok },
    ],
  };
}

module.exports = {
  systemStatus, upcomingCard, fightDetail, contractComparison, portfolioView, forwardRecord,
  buildUnifiedDashboard, latestForecastCard, fightIntelligenceView, intelDisplay,
  readSealed, NUMBER_KINDS, sha,
};
