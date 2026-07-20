// SPECULATIVE RESEARCH LEDGER — a $10,000 SIMULATED, FULLY ISOLATED research portfolio that paper-trades
// the speculative signals the production system produces but deliberately does NOT bet on (exploration,
// creative/strong speculation, directional intel WATCH, price-too-high candidates, experimental combos),
// alongside a copy of the formal CORE BUYs so the INCREMENTAL value of the loose bets can be measured.
//
// ISOLATION INVARIANT: production never imports this module (grep-enforced by test-research-isolation).
// The relationship is one-way: sealed production artifacts + read-only production CALC flow IN; nothing
// here flows back into forecasts, alerts, Telegram, the real ledger, the normal paper ledger, learning,
// grading, or bankrolls.json. This file NEVER writes those; it owns only data/research-ledger.json.
//
// This module is a PURE LEDGER: it takes already-normalized observation objects (the runner does the
// artifact-specific extraction and live/sealed price sourcing) and applies deterministic gates, contract
// math, consolidation, settlement and metrics. Everything is reproducible from a stored research-profile
// version + the observation it came from.
//
// MODES (see run-research.js): DISABLED (never runs) / OBSERVE (build observations + eligibility, create
// NO funded positions, change NO balance) / PAPER (create + settle funded positions). PAPER stamps the
// official prospectiveStartAt once; only positions opened at/after that instant count in official metrics.
require("./env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { paths } = require("./store");
const C = require("./contracts");
const FR = require("./freshness");
const names = require("./names");

const FILE = path.join(paths.data, "research-ledger.json");
const CONFIG_DIR = path.join(paths.root, "config");
const STARTING_DOLLARS = 10000;

const MODES = Object.freeze({ DISABLED: "DISABLED", OBSERVE: "OBSERVE", PAPER: "PAPER" });
const STATUS = Object.freeze({ OPEN: "RESEARCH_OPEN", SETTLED: "RESEARCH_SETTLED" });
// Per-observation disposition for THIS run. FUNDED / WOULD_FUND (OBSERVE mode) mean "eligible + chosen";
// OBSERVED_NO_ENTRY means seen but not entered (with a reason). No silent drops.
const DISPOSITION = Object.freeze({ FUNDED: "FUNDED", WOULD_FUND: "WOULD_FUND", OBSERVED_NO_ENTRY: "OBSERVED_NO_ENTRY" });
const FEE_BASIS = Object.freeze({ VERIFIED: "VERIFIED", ESTIMATED: "ESTIMATED_OUT_OF_SCOPE" });
const CUTOFF = Object.freeze({ BOUT: "AUTHORITATIVE_BOUT_TIME", CARD: "PRODUCTION_CARD_CUTOFF" });

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const r4 = (x) => Math.round((x + Number.EPSILON) * 10000) / 10000;
const nowIso = () => new Date().toISOString();
const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

// ---- profile ---------------------------------------------------------------------------------
// Load a versioned research profile. FAILS CLOSED: a missing or malformed profile throws, so the runner
// records a PROFILE_UNREADABLE health error and does nothing — it never silently falls back to defaults.
function loadProfile(version = "research-profile-v1") {
  const file = path.join(CONFIG_DIR, `${version}.json`);
  const raw = fs.readFileSync(file, "utf8");          // throws if absent — intentional
  const p = JSON.parse(raw);                          // throws if malformed — intentional
  if (!p || p.version !== version) throw new Error(`profile ${file} missing/mismatched version field`);
  if (!Array.isArray(p.allowedCategories) || !p.gates || !p.sizing || !p.caps || !p.simulation)
    throw new Error(`profile ${version} is missing required sections`);
  // The discipline block is READ and ENFORCED here (not dead config): borrowing is forbidden, so a profile
  // that permits a negative cash balance is refused outright. minFreshnessMinutes is consumed by
  // processObservations; the frozen thresholds are never touched.
  if (!p.discipline || p.discipline.allowNegativeCash !== false)
    throw new Error(`profile ${version}: discipline.allowNegativeCash must be present and false (no borrowing)`);
  if (!Number.isFinite(Number(p.gates.minFreshnessMinutes)))
    throw new Error(`profile ${version}: gates.minFreshnessMinutes must be a number`);
  return p;
}

// ---- persistence -----------------------------------------------------------------------------
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    j.positions = j.positions || {};
    j.observations = j.observations || {};
    if (j.startingDollars == null) j.startingDollars = STARTING_DOLLARS;
    return j;
  } catch {
    return {
      startingDollars: STARTING_DOLLARS,
      paperModeActivatedAt: null,        // stamped on the FIRST successful PAPER run — even with 0 positions
      firstFundedPositionAt: null,       // stamped when the FIRST position ever funds (separate from activation)
      prospectiveStartAt: null,          // mirrors paperModeActivatedAt — the official prospective window start
      rulesetVersion: null,
      positions: {},
      observations: {},
      lastRun: null,
      meta: {},
    };
  }
}
function save(state) {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

// Stamp the OFFICIAL experiment start the FIRST time PAPER mode runs successfully — even if that run funds
// ZERO positions. Idempotent (never rewritten). prospectiveStartAt mirrors it, so the official prospective
// window begins immediately and everything observed before it is excluded from official performance. OBSERVE
// never calls this, so nothing observed pre-activation is ever counted.
function activatePaper(state, at = nowIso(), rulesetVersion) {
  if (!state.paperModeActivatedAt) { state.paperModeActivatedAt = at; state.prospectiveStartAt = at; }
  if (!state.rulesetVersion) state.rulesetVersion = rulesetVersion || null;
  if (state.startingDollars == null) state.startingDollars = STARTING_DOLLARS;
  return state;
}
// Stamp the moment the FIRST funded position is ever created — separate from activation, idempotent.
function markFirstFunded(state, at = nowIso()) {
  if (!state.firstFundedPositionAt) state.firstFundedPositionAt = at;
  return state;
}

// ---- direction -> Kalshi side ----------------------------------------------------------------
// Map an intelligence signal's direction (relative to the SUBJECT fighter `about`) onto the Kalshi side to
// buy, given the contract's two fighters. FAILS CLOSED: neutral, an unmatched subject, or a subject that
// scores on BOTH sides returns { side:null } with a reason, so the runner records OBSERVED_NO_ENTRY rather
// than guessing a side — a backwards side costs real money (see lib/match.js).
function mapDirectionToSide({ about, direction, contractYesFighter, contractNoFighter, minNameScore = 2 }) {
  if (direction === "neutral" || !direction) return { side: null, reason: "neutral/absent direction — no directional side" };
  const sY = contractYesFighter ? names.nameScore(about, contractYesFighter) : 0;
  const sN = contractNoFighter ? names.nameScore(about, contractNoFighter) : 0;
  const subjectIsYes = sY >= minNameScore && sY > sN;
  const subjectIsNo = sN >= minNameScore && sN > sY;
  if (!subjectIsYes && !subjectIsNo) return { side: null, reason: `subject "${about}" not unambiguously mapped to either fighter (yes=${sY}, no=${sN})` };
  // subject is the YES fighter: favours it -> buy YES; against it -> buy NO. Mirror when subject is the NO fighter.
  if (subjectIsYes) return { side: direction === "favors_about" ? "YES" : "NO", reason: null };
  return { side: direction === "favors_about" ? "NO" : "YES", reason: null };
}

// ---- fee context -----------------------------------------------------------------------------
// The production fee model, with the verified-envelope basis attached. tradingFee computes the 0.07 ceil
// formula for any price in (0,1); withinVerifiedEnvelope says whether THIS order is inside the band the
// seven Kalshi tickets actually verified. Outside it the fee is honest-but-estimated, never presented as
// exact, and a pessimistic sensitivity fee is produced.
function feeContext(profile, { ticker, side, contracts, price }) {
  const fee = C.tradingFee(contracts, price);          // null iff outside the modelled domain
  if (fee == null) return { ok: false, reason: "fee not computable by the production model at this price/size" };
  const env = C.withinVerifiedEnvelope({ ticker, side: String(side || "").toLowerCase(), contracts, price, treatment: "taker", fillCount: 1 });
  const basis = env.inside ? FEE_BASIS.VERIFIED : FEE_BASIS.ESTIMATED;
  const mult = num(profile.simulation.pessimisticFeeMultiplier) || 1.5;
  const pessimistic = basis === FEE_BASIS.VERIFIED ? fee : r2(fee * mult);
  return {
    ok: true, fee: r2(fee), pessimisticFee: r2(pessimistic), feeBasis: basis,
    feeEnvelopeReasons: env.inside ? [] : env.reasons,
    feeModelVersion: (C.FEES && C.FEES.verifiedScope && C.FEES.verifiedScope.asOf) || "unknown",
    estimationReason: env.inside ? null : "outside the verified fee envelope; 0.07 ceil formula applied and flagged, pessimistic sensitivity computed",
  };
}

// ---- contract math ---------------------------------------------------------------------------
// Compute the FULL, correct cost breakdown. Target allocation is NOT the cost: contracts are floored to
// what the all-in per-contract price affords, and the stored exposure is the ACTUAL total simulated cost.
// Returns { reject, reason } when the entry cannot be funded.
function sizePosition(profile, { ticker, side, observedAsk, allowedDollars }) {
  const slippage = (num(profile.simulation.slippageCents) || 0) / 100;
  const effectiveEntryPrice = r4(observedAsk + slippage);
  if (!(effectiveEntryPrice > 0 && effectiveEntryPrice < 1)) return { reject: true, reason: `effective entry ${effectiveEntryPrice} not in (0,1)` };
  if (!(allowedDollars > 0)) return { reject: true, reason: "no allocation room under caps" };

  const feeRate = num(profile.simulation.feeRate) || 0.07;
  const estimatedFeePerContract = r4(feeRate * effectiveEntryPrice * (1 - effectiveEntryPrice));   // marginal, sizing only
  const allInCostPerContract = r4(effectiveEntryPrice + estimatedFeePerContract);
  const contracts = Math.floor(allowedDollars / allInCostPerContract);
  if (contracts < 1) return { reject: true, reason: "allocation buys fewer than 1 contract" };

  const fc = feeContext(profile, { ticker, side, contracts, price: effectiveEntryPrice });
  if (!fc.ok) return { reject: true, reason: fc.reason };                                          // fee not bounded -> no entry

  const principalCost = r2(contracts * effectiveEntryPrice);
  const simulatedFees = fc.fee;
  const totalCost = r2(principalCost + simulatedFees);
  const maximumPayout = contracts;                          // each contract resolves to $1
  const maximumProfit = r2(maximumPayout - totalCost);
  const pessimisticTotalCost = r2(principalCost + fc.pessimisticFee);
  const pessimisticMaxProfit = r2(maximumPayout - pessimisticTotalCost);

  return {
    reject: false,
    observedAsk: r4(observedAsk), slippageCents: num(profile.simulation.slippageCents) || 0, effectiveEntryPrice,
    estimatedFeePerContract, allInCostPerContract, contracts,
    principalCost, simulatedFees, feeBasis: fc.feeBasis, feeModelVersion: fc.feeModelVersion,
    estimationReason: fc.estimationReason, feeEnvelopeReasons: fc.feeEnvelopeReasons,
    totalCost, maximumPayout, maximumProfit,
    pessimisticFee: fc.pessimisticFee, pessimisticTotalCost, pessimisticMaxProfit,
  };
}

// ---- eligibility gate ------------------------------------------------------------------------
// Compute the research entry gate for one observation against the profile. Returns the enriched decision
// fields plus { eligible, reason }. FAILS CLOSED everywhere: any missing/insufficient input is a refusal.
function evaluate(profile, obs) {
  const g = profile.gates;
  const slippage = (num(profile.simulation.slippageCents) || 0) / 100;
  const out = {
    category: obs.category, side: obs.side || null,
    researchEstimatedProbability: num(obs.estProbability),
    observedAsk: num(obs.observedAsk),
    effectiveEntryPrice: num(obs.observedAsk) != null ? r4(num(obs.observedAsk) + slippage) : null,
    researchMaximumEntryPrice: null,
    estimatedEdgeAfterHaircut: null,
    eligible: false, reason: null,
  };
  const prob = out.researchEstimatedProbability;
  const eff = out.effectiveEntryPrice;
  if (prob != null && eff != null) {
    const haircutProb = prob * (1 - (num(g.uncertaintyHaircut) || 0));
    out.estimatedEdgeAfterHaircut = r4(haircutProb - eff);
  }

  if (!profile.allowedCategories.includes(obs.category)) return fail(out, `category ${obs.category} not allowed by ${profile.version}`);
  if (obs.side !== "YES" && obs.side !== "NO") return fail(out, obs.sideReason || "side not unambiguously mapped to a Kalshi contract");
  if (!(out.observedAsk > 0 && out.observedAsk < 1)) return fail(out, "no usable contemporaneous ask");
  // FAIL CLOSED (the repo has shipped "gate that failed open" twice): an undeterminable fight start, a
  // postBell that is not explicitly false, or any status other than CURRENT is a REFUSAL, never a skip.
  if (!Number.isFinite(Date.parse(obs.fightStartTimestamp))) return fail(out, "fight-start time undeterminable — refusing");
  if (obs.postBell !== false) return fail(out, `at/after fight-start cutoff (${obs.cutoffSource || CUTOFF.CARD})`);
  if (obs.marketPriceStatus !== FR.S.CURRENT) return fail(out, `ask is ${obs.marketPriceStatus || "MISSING"}, not CURRENT`);
  if (!(eff > 0 && eff < 1)) return fail(out, `effective entry ${eff} not in (0,1)`);
  if (prob == null || prob < num(g.minEstProbability)) return fail(out, `estimated probability ${prob} below floor ${g.minEstProbability}`);
  if (eff > num(g.maxMarketPrice)) return fail(out, `effective entry ${eff} above research max ${g.maxMarketPrice}`);

  if (obs.category === "UNCONFIRMED_CANDIDATE") {
    const prodMax = num(obs.productionMaximumAcceptablePrice);
    if (prodMax == null) return fail(out, "no production maximum-acceptable price to loosen from");
    out.researchMaximumEntryPrice = r4(Math.min(num(g.maxMarketPrice), prodMax + (num(profile.priceTooHigh && profile.priceTooHigh.priceToleranceCents) || 0) / 100));
    if (out.observedAsk > out.researchMaximumEntryPrice) return fail(out, `ask ${out.observedAsk} above research tolerance ${out.researchMaximumEntryPrice}`);
  }

  if (out.estimatedEdgeAfterHaircut == null || out.estimatedEdgeAfterHaircut < num(g.minEstEdge))
    return fail(out, `post-haircut edge ${out.estimatedEdgeAfterHaircut} below floor ${g.minEstEdge}`);

  out.eligible = true;
  return out;
}
function fail(out, reason) { out.eligible = false; out.reason = reason; return out; }

// The % of the current research bankroll to stake for a category. CORE_BUY preserves the frozen tier
// fraction the runner supplies verbatim; everything else comes from the profile.
function stakePctFor(profile, category, coreFraction) {
  if (category === "CORE_BUY") return num(coreFraction);
  return num(profile.sizing[category]);
}

// ---- the main run: observations -> (proposals | funded positions) ----------------------------
// rawObs: normalized observation objects from the runner (see run-research.js). Deterministic and
// idempotent: funded positions are keyed by (event|market|side|profileVersion) and never re-opened;
// immutable observation snapshots are keyed by (…|forecastHash) and never rewritten.
function processObservations(state, rawObs, { profile, mode, now = nowIso() }) {
  state.positions = state.positions || {};
  state.observations = state.observations || {};
  // A successful PAPER run activates the official experiment window on the FIRST run, even if it funds zero
  // positions. OBSERVE never activates. (The runner saves state only on success, so this reflects a
  // successful run.)
  if (mode === MODES.PAPER) activatePaper(state, now, profile.version);
  const bankroll = summary(state).accountValue;                 // % of CURRENT bankroll
  const caps = profile.caps;
  const counts = { observations: 0, eligible: 0, proposed: 0, funded: 0, observedNoEntry: 0 };
  const decisions = [];

  // minFreshnessMinutes is CONSUMED here (not dead config): an ask's freshness is decided against the
  // profile's own window using the ask timestamp and the run clock, not a producer-supplied label.
  const minFresh = Number(profile.gates.minFreshnessMinutes);
  const runMs = Date.parse(now);
  const freshStatus = (ts) => {
    if (!ts || !Number.isFinite(Date.parse(ts))) return FR.S.WAITING;
    return (runMs - Date.parse(ts)) / 60000 <= minFresh ? FR.S.CURRENT : FR.S.STALE;
  };

  // Enrich + record immutable first-sight observations.
  const enriched = rawObs.map((raw) => {
    const o = { ...raw, marketPriceStatus: raw.observedAsk != null ? freshStatus(raw.marketPriceTimestamp) : (raw.marketPriceStatus || null) };
    const ev = evaluate(profile, o);
    const rec = { ...o, ...ev };
    const obsKey = sha(`${o.event}|${o.market}|${o.side}|${o.category}|${profile.version}|${o.forecastHash || ""}`);
    rec.observationId = `obs_${obsKey}`;
    if (!state.observations[rec.observationId]) {
      state.observations[rec.observationId] = Object.freeze({
        observationId: rec.observationId, signalId: o.signalId || null, sourceArtifact: o.sourceArtifact,
        event: o.event, market: o.market, ticker: o.ticker, side: o.side || "UNMAPPED",
        fighter: o.fighter || null, opponent: o.opponent || null, direction: o.direction || "n/a",
        qualification: o.category, researchEstimatedProbability: ev.researchEstimatedProbability,
        observedAsk: ev.observedAsk, effectiveEntryPrice: ev.effectiveEntryPrice,
        researchMaximumEntryPrice: ev.researchMaximumEntryPrice, estimatedEdgeAfterHaircut: ev.estimatedEdgeAfterHaircut,
        signalTimestamp: o.signalTimestamp || null, marketPriceTimestamp: o.marketPriceTimestamp || null,
        marketPriceStatus: o.marketPriceStatus || null, askSource: o.askSource || null,
        decisionTimestamp: now, fightStartTimestamp: o.fightStartTimestamp || null, cutoffSource: o.cutoffSource || CUTOFF.CARD,
        reasonProductionRejected: o.reasonProductionRejected || null,
        firstSightEligible: ev.eligible, firstSightReason: ev.reason,
        rulesetVersion: profile.version, forecastHash: o.forecastHash || null, sealedForecastVersion: o.sealedForecastVersion || null,
      });
      counts.observations++;
    }
    return rec;
  });

  // Group ELIGIBLE observations by the funded dedup key; one funded position per group.
  const groups = new Map();
  for (const rec of enriched) {
    if (!rec.eligible) { counts.observedNoEntry++; decisions.push(decision(rec, DISPOSITION.OBSERVED_NO_ENTRY, rec.reason, null)); continue; }
    counts.eligible++;
    const key = `${rec.event}|${rec.market}|${rec.side}|${profile.version}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(rec);
  }

  // Running exposure (existing OPEN positions + any funded this run) enforces the caps live.
  let totalOpen = openExposureTotal(state);
  const cardOpen = openExposureByCard(state);
  const fightOpen = openExposureByFight(state);

  const sortedKeys = [...groups.keys()].sort();               // deterministic order for cap allocation
  for (const key of sortedKeys) {
    const members = groups.get(key);
    const [event, market, side] = key.split("|");
    const eventDate = members[0].eventDate || null;
    // primary = the member category with the highest eligible stake %.
    const ranked = members
      .map((m) => ({ m, pct: stakePctFor(profile, m.category, m.coreFraction) }))
      .filter((x) => Number.isFinite(x.pct) && x.pct > 0)
      .sort((a, b) => b.pct - a.pct);
    if (!ranked.length) { for (const m of members) decisions.push(decision(m, DISPOSITION.OBSERVED_NO_ENTRY, "no positive stake % for any qualifying category", null)); counts.observedNoEntry++; continue; }
    const primary = ranked[0];
    const contributing = [...new Set(members.map((m) => m.category))];
    const contributingSignalIds = members.map((m) => m.observationId);
    const stakePct = primary.pct;

    // one funded position per group, ever (idempotent)
    const positionId = `research|${key}`;
    if (state.positions[positionId]) {
      for (const m of members) decisions.push(decision(m, DISPOSITION.FUNDED, "already funded (idempotent)", positionId));
      continue;
    }

    // caps: the per-fight cap is enforced against a RUNNING per-fight exposure (every market/side of one
    // bout shares it), exactly like per-card and total-open — so two positions on the same fight cannot
    // each draw the full per-fight budget.
    const fightKey = `${event}|${members[0].fight || market}`;
    const perFightRemaining = r2(caps.perFightPct * bankroll - (fightOpen[fightKey] || 0));
    const perCardRemaining = r2(caps.perCardPct * bankroll - (cardOpen[eventDate] || 0));
    const totalOpenRemaining = r2(caps.totalOpenPct * bankroll - totalOpen);
    const allowedDollars = r2(Math.min(stakePct * bankroll, Math.max(0, perFightRemaining), Math.max(0, perCardRemaining), Math.max(0, totalOpenRemaining)));

    const sized = sizePosition(profile, { ticker: primary.m.ticker, side, observedAsk: primary.m.observedAsk, allowedDollars });
    if (sized.reject) { for (const m of members) decisions.push(decision(m, DISPOSITION.OBSERVED_NO_ENTRY, sized.reason, null)); counts.observedNoEntry++; continue; }

    const targetAllocationDollars = r2(stakePct * bankroll);
    const posCore = {
      researchPositionId: positionId, recommendationId: primary.m.recommendationId || null,
      event, market, ticker: primary.m.ticker, side,
      fighter: primary.m.fighter || null, opponent: primary.m.opponent || null, fight: primary.m.fight || null, eventDate,
      primaryQualification: primary.m.category, contributingQualifications: contributing, contributingSignalIds,
      strongestEligibleStakePct: stakePct, combinedQualificationReason: primary.m.qualifiedReason || null,
      rulesetVersion: profile.version, forecastHash: primary.m.forecastHash || null, sealedForecastVersion: primary.m.sealedForecastVersion || null,
      researchEstimatedProbability: primary.m.researchEstimatedProbability, estimatedEdgeAfterHaircut: primary.m.estimatedEdgeAfterHaircut,
      targetAllocationDollars,
      observedAsk: sized.observedAsk, slippageCents: sized.slippageCents, effectiveEntryPrice: sized.effectiveEntryPrice,
      estimatedFeePerContract: sized.estimatedFeePerContract, allInCostPerContract: sized.allInCostPerContract,
      contracts: sized.contracts, principalCost: sized.principalCost, simulatedFees: sized.simulatedFees,
      feeBasis: sized.feeBasis, feeModelVersion: sized.feeModelVersion, estimationReason: sized.estimationReason, feeEnvelopeReasons: sized.feeEnvelopeReasons,
      totalCost: sized.totalCost, maximumPayout: sized.maximumPayout, maximumProfit: sized.maximumProfit,
      pessimisticFee: sized.pessimisticFee, pessimisticTotalCost: sized.pessimisticTotalCost, pessimisticMaxProfit: sized.pessimisticMaxProfit,
      signalTimestamp: primary.m.signalTimestamp || null, marketPriceTimestamp: primary.m.marketPriceTimestamp || null,
      decisionTimestamp: now, fightStartTimestamp: primary.m.fightStartTimestamp || null, cutoffSource: primary.m.cutoffSource || CUTOFF.CARD,
    };

    // Reserve the sized cost against ALL running caps in BOTH modes, so multi-group allocation within a
    // single run (and OBSERVE proposals) respect the per-fight / per-card / total-open ceilings.
    totalOpen = r2(totalOpen + sized.totalCost);
    cardOpen[eventDate] = r2((cardOpen[eventDate] || 0) + sized.totalCost);
    fightOpen[fightKey] = r2((fightOpen[fightKey] || 0) + sized.totalCost);

    if (mode === MODES.PAPER) {
      markFirstFunded(state, now);
      state.positions[positionId] = {
        ...posCore,
        status: STATUS.OPEN, result: null, payout: null, pnl: null, pessimisticPnl: null, settledAt: null, closingLine: null,
        openedAt: now,
        history: [{ from: null, to: STATUS.OPEN, reason: `funded (${contributing.join("+")})`, at: now }],
      };
      counts.funded++;
      for (const m of members) decisions.push(decision(m, DISPOSITION.FUNDED, "funded", positionId));
    } else {
      // OBSERVE: report what WOULD fund; create no position and change no balance.
      counts.proposed++;
      for (const m of members) decisions.push(decision(m, DISPOSITION.WOULD_FUND, "would fund in PAPER mode", positionId));
      decisions.push({ proposal: true, ...proposalView(posCore) });
    }
  }

  state.lastRun = {
    at: now, mode, rulesetVersion: profile.version,
    counts, bankrollAtRun: bankroll,
    proposals: decisions.filter((d) => d.proposal).map((d) => { const { proposal, ...rest } = d; return rest; }),
  };
  return { counts, decisions };
}

function decision(rec, disposition, reason, linkedResearchPositionId) {
  return {
    observationId: rec.observationId, market: rec.market, side: rec.side, qualification: rec.category,
    disposition, reason, linkedResearchPositionId,
  };
}
function proposalView(p) {
  return {
    market: p.market, side: p.side, primaryQualification: p.primaryQualification, contributingQualifications: p.contributingQualifications,
    effectiveEntryPrice: p.effectiveEntryPrice, contracts: p.contracts, totalCost: p.totalCost, maximumPayout: p.maximumPayout,
    maximumProfit: p.maximumProfit, feeBasis: p.feeBasis,
  };
}

function openExposureTotal(state) {
  return r2(Object.values(state.positions || {}).filter((p) => p.status === STATUS.OPEN).reduce((s, p) => s + (p.totalCost || 0), 0));
}
function openExposureByCard(state) {
  const m = {};
  for (const p of Object.values(state.positions || {})) if (p.status === STATUS.OPEN) m[p.eventDate] = r2((m[p.eventDate] || 0) + (p.totalCost || 0));
  return m;
}
// Open exposure grouped by FIGHT (every market/side of one bout shares a per-fight budget). Keyed the
// same way the fund loop keys it: event | fight-or-market.
function openExposureByFight(state) {
  const m = {};
  for (const p of Object.values(state.positions || {})) if (p.status === STATUS.OPEN) { const k = `${p.event}|${p.fight || p.market}`; m[k] = r2((m[k] || 0) + (p.totalCost || 0)); }
  return m;
}

// ---- settlement ------------------------------------------------------------------------------
// Read-only from the PUBLIC settlement. Honours the position side (YES wins on 'yes', NO wins on 'no').
// Fails closed: an unreadable or not-yet-finalized market is left OPEN, never settled to a guess. Losses
// are booked and NEVER pruned. `settlement` is async (ticker) -> { status, result }.
async function settleFromMarket(state, opts = {}) {
  const settlement = opts.settlement;
  if (typeof settlement !== "function") throw new Error("settleFromMarket needs a read-only settlement(ticker) function");
  const now = opts.now || nowIso();
  const open = Object.values(state.positions).filter((p) => p.status === STATUS.OPEN);
  const settled = [], pending = [], unreadable = [];
  for (const p of open) {
    let s = null;
    try { s = await settlement(p.ticker); } catch { s = null; }
    if (!s || (s.result == null && s.status == null)) { unreadable.push(p.researchPositionId); continue; }
    const won = (p.side === "YES" && s.result === "yes") || (p.side === "NO" && s.result === "no");
    const lost = (p.side === "YES" && s.result === "no") || (p.side === "NO" && s.result === "yes");
    const voided = (s.result === "" || s.result === "void") && /settl|final|determ/i.test(String(s.status || ""));
    const result = won ? 1 : lost ? 0 : voided ? null : undefined;
    if (result === undefined) { pending.push(p.researchPositionId); continue; }
    bookSettlement(p, result, now);
    settled.push({ id: p.researchPositionId, market: p.market, side: p.side, result, pnl: p.pnl });
  }
  return { settled, pending, unreadable };
}
function bookSettlement(p, result, at) {
  p.result = result;
  if (result === 1) { p.payout = p.contracts; p.pnl = r2(p.maximumPayout - p.totalCost); p.pessimisticPnl = r2(p.maximumPayout - p.pessimisticTotalCost); }
  else if (result === 0) { p.payout = 0; p.pnl = r2(-p.totalCost); p.pessimisticPnl = r2(-p.pessimisticTotalCost); }
  else { p.payout = p.totalCost; p.pnl = 0; p.pessimisticPnl = 0; }             // void: full refund => break-even (payout - totalCost = 0)
  p.status = STATUS.SETTLED;
  p.settledAt = at;
  p.history.push({ from: STATUS.OPEN, to: STATUS.SETTLED, reason: `settled: ${result === 1 ? "won" : result === 0 ? "lost" : "void"}`, at });
  return p;
}

// ---- metrics ---------------------------------------------------------------------------------
function blankBucket() { return { n: 0, wins: 0, losses: 0, voids: 0, risked: 0, pnl: 0, pessimisticPnl: 0, entrySum: 0, edgeSum: 0, coQualified: 0 }; }
function accumulate(b, p) {
  b.n++; if (p.result === 1) b.wins++; else if (p.result === 0) b.losses++; else if (p.result === null) b.voids++;
  b.risked = r2(b.risked + (p.totalCost || 0)); b.pnl = r2(b.pnl + (p.pnl || 0)); b.pessimisticPnl = r2(b.pessimisticPnl + (p.pessimisticPnl || 0));
  b.entrySum += p.effectiveEntryPrice || 0; b.edgeSum += p.estimatedEdgeAfterHaircut || 0;
}
function finalizeBucket(b) {
  const decided = b.wins + b.losses;
  return {
    n: b.n, wins: b.wins, losses: b.losses, voids: b.voids,
    winRate: decided ? r4(b.wins / decided) : null,
    risked: r2(b.risked), netPnl: r2(b.pnl), pessimisticNetPnl: r2(b.pessimisticPnl),
    roi: b.risked ? r4(b.pnl / b.risked) : null,
    avgEntryPrice: b.n ? r4(b.entrySum / b.n) : null, avgEdgeAtEntry: b.n ? r4(b.edgeSum / b.n) : null,
    coQualified: b.coQualified,
  };
}
// Max drawdown over the realized-P&L equity curve, in dollars (peak-to-trough of cumulative realized P&L).
function maxDrawdown(settledSorted) {
  let peak = 0, cum = 0, mdd = 0;
  for (const p of settledSorted) { cum = r2(cum + (p.pnl || 0)); if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = r2(peak - cum); }
  return mdd;
}

// The CANONICAL research summary the Research Lab reads. Never fed into bankrolls.json. Optionally takes a
// paper summary for the side-by-side comparison. Provides BLENDED (all categories) and INCREMENTAL
// (excluding CORE_BUY) slices so the value of the loose bets alone is measurable.
function summary(state, opts = {}) {
  const s = state || load();
  const positions = Object.values(s.positions || {});
  const observations = Object.values(s.observations || {});
  const open = positions.filter((p) => p.status === STATUS.OPEN);
  const settled = positions.filter((p) => p.status === STATUS.SETTLED);
  const starting = s.startingDollars ?? STARTING_DOLLARS;

  // OFFICIAL performance counts only positions created at/after paperModeActivatedAt (rule 4). In normal
  // operation every position is post-activation (activation is stamped before any fund), so this is a
  // guaranteed no-op; it defensively excludes any pre-activation position from official performance.
  const activatedAt = s.paperModeActivatedAt || null;
  const isOfficial = (p) => activatedAt != null && String(p.openedAt || "") >= activatedAt;
  const openO = open.filter(isOfficial);
  const settledO = settled.filter(isOfficial);

  const realizedPnl = r2(settledO.reduce((a, p) => a + (p.pnl || 0), 0));
  const pessimisticRealizedPnl = r2(settledO.reduce((a, p) => a + (p.pessimisticPnl || 0), 0));
  const openExposure = r2(openO.reduce((a, p) => a + (p.totalCost || 0), 0));
  const availableCash = r2(starting + realizedPnl - openExposure);
  const accountValue = r2(availableCash + openExposure);        // open marked at cost -> starting + realizedPnl
  const riskedSettled = r2(settledO.reduce((a, p) => a + (p.totalCost || 0), 0));
  const settledSorted = [...settledO].sort((a, b) => String(a.settledAt || "").localeCompare(String(b.settledAt || "")));

  const byCategory = {};
  for (const p of settledO) { const k = p.primaryQualification || "UNCATEGORIZED"; (byCategory[k] = byCategory[k] || blankBucket()); accumulate(byCategory[k], p); }
  // co-qualification frequency (not P&L) so one outcome is never counted as multiple bets
  for (const p of settledO) for (const c of (p.contributingQualifications || [])) if (c !== p.primaryQualification && byCategory[c]) byCategory[c].coQualified++;
  const perCategory = Object.fromEntries(Object.entries(byCategory).map(([k, b]) => [k, finalizeBucket(b)]));

  const wins = settledO.filter((p) => p.result === 1).length;
  const losses = settledO.filter((p) => p.result === 0).length;
  const decided = wins + losses;

  const blended = slice(settledO, starting);
  const incremental = slice(settledO.filter((p) => p.primaryQualification !== "CORE_BUY"), starting);

  const n = settledO.length;
  const sampleWarning = n < 30 ? "FEWER THAN 30 SETTLED POSITIONS - VERY EARLY"
    : n < 100 ? "FEWER THAN 100 SETTLED POSITIONS - INCONCLUSIVE"
      : "SUFFICIENT SAMPLE FOR PRELIMINARY REVIEW";

  const result = {
    label: "Speculative Research Portfolio",
    experimental: true,
    startingDollars: starting,
    prospectiveStartAt: s.prospectiveStartAt || null,
    paperModeActivatedAt: s.paperModeActivatedAt || null,
    firstFundedPositionAt: s.firstFundedPositionAt || null,
    rulesetVersion: s.rulesetVersion || null,
    feeModelVersion: (C.FEES && C.FEES.verifiedScope && C.FEES.verifiedScope.asOf) || "unknown",
    availableCash, openExposure, accountValue, realizedPnl, pessimisticRealizedPnl,
    totalReturn: starting ? r4(realizedPnl / starting) : null,
    maxDrawdownDollars: maxDrawdown(settledSorted),
    returnOnRisked: riskedSettled ? r4(realizedPnl / riskedSettled) : null,
    counts: { total: positions.length, open: openO.length, settled: n, wins, losses, voids: n - decided, observations: observations.length, preActivationExcluded: (settled.length - settledO.length) + (open.length - openO.length) },
    sampleWarning,
    perCategory,
    blendedAggressive: blended,
    incrementalExCoreBuy: incremental,
    positions: positions.map(normalizePosition),
    // Pre-activation observations are labeled EXCLUDED (rule 5): anything seen before the official window,
    // or while there is no activation at all (OBSERVE mode), never counts toward official performance.
    observations: observations.map((o) => {
      const excluded = !activatedAt || String(o.decisionTimestamp || "") < activatedAt;
      return { ...o, officialPerformanceExcluded: excluded, exclusionLabel: excluded ? "OBSERVE MODE - EXCLUDED FROM OFFICIAL PERFORMANCE" : null };
    }),
    lastRun: s.lastRun || null,
  };
  if (opts.paperSummary) result.comparisonVsPaper = compare(result, opts.paperSummary);
  return result;
}
function slice(settledSubset, starting) {
  const risked = r2(settledSubset.reduce((a, p) => a + (p.totalCost || 0), 0));
  const pnl = r2(settledSubset.reduce((a, p) => a + (p.pnl || 0), 0));
  const pessimisticPnl = r2(settledSubset.reduce((a, p) => a + (p.pessimisticPnl || 0), 0));
  const wins = settledSubset.filter((p) => p.result === 1).length;
  const losses = settledSubset.filter((p) => p.result === 0).length;
  const decided = wins + losses;
  const edges = settledSubset.map((p) => p.estimatedEdgeAfterHaircut).filter((e) => Number.isFinite(e));
  const sorted = [...settledSubset].sort((a, b) => String(a.settledAt || "").localeCompare(String(b.settledAt || "")));
  return {
    numBets: settledSubset.length, wins, losses,
    winRate: decided ? r4(wins / decided) : null,
    risked, netPnl: pnl, pessimisticNetPnl: pessimisticPnl, totalReturn: starting ? r4(pnl / starting) : null,
    returnOnRisked: risked ? r4(pnl / risked) : null,
    profitPerBet: settledSubset.length ? r2(pnl / settledSubset.length) : null,
    avgEdgeAtEntry: edges.length ? r4(edges.reduce((a, e) => a + e, 0) / edges.length) : null,
    maxDrawdownDollars: maxDrawdown(sorted),
  };
}
function compare(research, paper) {
  const p = paper || {};
  const pm = p.metrics || {};
  return {
    research: { totalReturn: research.totalReturn, returnOnRisked: research.returnOnRisked, maxDrawdownDollars: research.maxDrawdownDollars, winRate: research.blendedAggressive.winRate, avgEdgeAtEntry: research.blendedAggressive.avgEdgeAtEntry, numBets: research.blendedAggressive.numBets, profitPerBet: research.blendedAggressive.profitPerBet },
    paperStrategy: { totalReturn: pm.returnOnCapital ?? null, returnOnRisked: pm.returnOnRisked ?? null, winRate: pm.winRate ?? null, avgEdgeAtEntry: pm.avgEdgeAtEntry ?? null, numBets: (p.counts && p.counts.settled) ?? null },
    note: "Paper Strategy is the disciplined control group; Research is the aggressive experimental group. Compare incrementalExCoreBuy to isolate the value of the loose bets themselves.",
  };
}
function normalizePosition(p) {
  return {
    researchPositionId: p.researchPositionId, recommendationId: p.recommendationId, market: p.market, ticker: p.ticker, side: p.side,
    fight: p.fight, fighter: p.fighter, opponent: p.opponent, primaryQualification: p.primaryQualification,
    contributingQualifications: p.contributingQualifications, status: p.status,
    entryPrice: p.effectiveEntryPrice, stake: p.totalCost, contracts: p.contracts, feeBasis: p.feeBasis,
    fee: p.simulatedFees, pessimisticFee: p.pessimisticFee, result: p.result, pnl: p.pnl, pessimisticPnl: p.pessimisticPnl,
    edgeAtEntry: p.estimatedEdgeAfterHaircut, reasonProductionRejected: p.reasonProductionRejected || null,
    openedAt: p.openedAt, settledAt: p.settledAt, rulesetVersion: p.rulesetVersion,
  };
}

module.exports = {
  FILE, STARTING_DOLLARS, MODES, STATUS, DISPOSITION, FEE_BASIS, CUTOFF,
  loadProfile, load, save, activatePaper, markFirstFunded,
  mapDirectionToSide, feeContext, sizePosition, evaluate, stakePctFor,
  processObservations, settleFromMarket, bookSettlement, summary,
};
