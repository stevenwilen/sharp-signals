// PHASE 8C/8D — map the sealed outcome tree onto contracts, verify coherence, and value them.
//
// COHERENCE IS ENFORCED, NOT TRUSTED. Every contract on a bout must read the SAME probability tree.
// The failure this prevents is subtle and expensive: price "Fighter wins" off one number and
// "Fighter wins by KO" off another, and the book will happily let you hold two positions that
// contradict each other, each looking +EV against its own private probability.
//
// AN EDGE IS NEVER ASSERTED. The difference between our number and the market's is labelled
// UNVERIFIED ESTIMATED EDGE, every time, without exception. The system has never demonstrated
// predictive skill: the only evaluation that ever showed one is void (BASELINE CONTAMINATED), and
// the scenario layer scored barely above chance. A number that calls itself an edge starts getting
// treated as one.
require("./env");
const C = require("./contracts");

// How far to shade the central estimate for the conservative bound. The forecast's own uncertainty
// half-width is the input; this is not a tuned parameter and is not fitted to any result.
const CONSERVATIVE = {
  method: "lower bound of the forecast's stated uncertainty range, applied against the position",
  note: "for a YES buy the conservative probability is the LOW end of the range — the side that makes the position look worse",
};

// ---- 8C: map the tree onto a contract --------------------------------------------------------
function probabilityFor(contract, forecast) {
  const fail = (reason) => ({ ok: false, classification: "UNPRICED", reason });
  if (!forecast) return fail("no forecast for this bout");
  if (forecast.status === "BASELINE UNAVAILABLE") return fail("forecast declined to price this bout (BASELINE UNAVAILABLE)");
  const tree = forecast.outcomeTree;
  if (!tree) return fail("forecast has no outcome tree");
  const f = contract.outcomeSubject;
  if (!f) return fail("contract does not name a fighter");

  const [A, B] = forecast.fight.split(" vs ");
  const E = require("./evidence-eval");
  const who = E.norm(f) === E.norm(A) ? A : E.norm(f) === E.norm(B) ? B : null;
  if (!who) return fail(`contract fighter "${f}" is not in this bout`);
  const node = tree[who];
  if (!node) return fail(`no tree node for ${who}`);

  switch (contract.outcomeType) {
    case C.OUTCOME.FIGHTER_WINS:
      return { ok: true, probability: node.win, source: "sealed outcome tree: fighter win probability", validated: true };
    case C.OUTCOME.FIGHTER_WINS_BY_KO:
      return { ok: true, probability: node.byKO, source: "sealed outcome tree: fighter KO cell", validated: false };
    case C.OUTCOME.FIGHTER_WINS_BY_SUBMISSION:
      return { ok: true, probability: node.bySubmission, source: "sealed outcome tree: fighter submission cell", validated: false };
    case C.OUTCOME.FIGHTER_WINS_BY_DECISION:
      return { ok: true, probability: node.byDecision, source: "sealed outcome tree: fighter decision cell", validated: false };
    case C.OUTCOME.FIGHTER_WINS_IN_ROUND: {
      const r = contract.round;
      if (!r || r < 1 || r > 3) return fail(`round ${r} is outside the tree's modelled rounds`);
      const ko = node.koByRound && node.koByRound[`r${r}`];
      const sub = node.submissionByRound && node.submissionByRound[`r${r}`];
      if (ko == null || sub == null) return fail(`tree has no round-${r} cells`);
      return { ok: true, probability: +(ko + sub).toFixed(4), source: `sealed outcome tree: round-${r} KO + submission cells`, validated: false };
    }
    case C.OUTCOME.FIGHT_REACHES_DECISION:
      return { ok: true, probability: +(tree[A].byDecision + tree[B].byDecision).toFixed(4), source: "sealed outcome tree: both fighters' decision cells", validated: false };
    default:
      return fail(`outcome type ${contract.outcomeType} has no defined mapping to the tree`);
  }
}

// Verify the tree itself satisfies the identities every contract set depends on. Checked per bout,
// before any contract is valued: an incoherent tree cannot produce coherent contract prices, and a
// tree that does not add up is worse than none because it looks like knowledge.
function verifyTreeCoherence(forecast) {
  const errs = [];
  const tree = forecast && forecast.outcomeTree;
  if (!tree) return { ok: false, errors: ["no tree"] };
  const [A, B] = forecast.fight.split(" vs ");
  const near = (x, y, tol = 0.005) => Math.abs(x - y) <= tol;

  for (const f of [A, B]) {
    const n = tree[f];
    if (!n) { errs.push(`no node for ${f}`); continue; }
    // fighter method probabilities must sum to fighter win probability
    const sum = n.byKO + n.bySubmission + n.byDecision;
    if (!near(sum, n.win)) errs.push(`${f}: methods sum to ${sum.toFixed(4)} but win=${n.win}`);
    // overall KO cannot exceed the win probability
    if (n.byKO > n.win + 0.005) errs.push(`${f}: byKO ${n.byKO} exceeds win ${n.win}`);
    if (n.bySubmission > n.win + 0.005) errs.push(`${f}: bySubmission ${n.bySubmission} exceeds win ${n.win}`);
    // a round's KO share cannot exceed total KO
    if (n.koByRound) {
      const rs = Object.values(n.koByRound).reduce((a, x) => a + x, 0);
      if (rs > n.byKO + 0.005) errs.push(`${f}: KO rounds sum ${rs.toFixed(4)} exceeds byKO ${n.byKO}`);
      for (const [k, v] of Object.entries(n.koByRound))
        if (v > n.byKO + 0.005) errs.push(`${f}: koByRound.${k} ${v} exceeds byKO ${n.byKO}`);
    }
    if (n.submissionByRound) {
      const rs = Object.values(n.submissionByRound).reduce((a, x) => a + x, 0);
      if (rs > n.bySubmission + 0.005) errs.push(`${f}: submission rounds sum ${rs.toFixed(4)} exceeds bySubmission ${n.bySubmission}`);
    }
  }
  // mutually exclusive outcomes must sum correctly
  if (tree[A] && tree[B] && !near(tree[A].win + tree[B].win, 1))
    errs.push(`win probabilities sum to ${(tree[A].win + tree[B].win).toFixed(4)}, not 1`);
  return { ok: errs.length === 0, errors: errs };
}

// ---- 8D: value one contract ------------------------------------------------------------------
function valueContract(contract, forecast, orderbook, opts = {}) {
  const proposedContracts = opts.contracts || 100;
  const out = {
    ticker: contract.ticker, bout: contract.bout, boutId: contract.boutId,
    contractWording: contract.contractWording,
    settlementRules: contract.settlementRules,
    outcomeType: contract.outcomeType, outcomeSubject: contract.outcomeSubject,
    snapshotTimestamp: contract.snapshotTimestamp,
  };

  // settlement/mapping problems stop everything before a number is produced
  if (!contract.mappable) {
    out.classification = contract.outcomeType === C.OUTCOME.UNMAPPABLE ? "UNPRICED" : "HUMAN REVIEW REQUIRED";
    out.reason = `contract wording could not be mapped confidently: ${contract.flags.join("; ")}`;
    return out;
  }
  const coh = verifyTreeCoherence(forecast);
  if (!coh.ok) { out.classification = "UNPRICED"; out.reason = `incoherent outcome tree: ${coh.errors.join("; ")}`; return out; }
  out.treeCoherent = true;

  const pm = probabilityFor(contract, forecast);
  if (!pm.ok) { out.classification = pm.classification; out.reason = pm.reason; return out; }
  out.systemCentralProbability = pm.probability;
  out.probabilitySource = pm.source;

  // Method/round contracts are mapped and displayed, and stop here. They rest on v7.0.0's fixed
  // method priors, which are unvalidated by their own blind evaluation (1/5 methods correct, and
  // Decision is the primary path by construction). They receive no stake, no alert, and may not be
  // called highest leverage until a replacement model is pre-registered and prospectively tested.
  if (contract.unvalidatedModel || !pm.validated) {
    out.probabilityModelStatus = "UNVALIDATED METHOD MODEL";
    out.classification = "ANALYSIS ONLY";
    out.reason = "method/round probability rests on v7.0.0's fixed, unvalidated method priors — mapped and displayed only";
    out.blockedFrom = ["actionable ranking", "position sizing", "alerts", "highest-leverage labelling"];
    return out;
  }
  out.probabilityModelStatus = "outright winner — priced from the fighter win probability";

  // ---- THE STALE-PRIOR GATE --------------------------------------------------------------------
  // A LOGICAL_OPEN baseline is an OPENING line: correct as a prior for a retrospective evaluation
  // whose forecast timestamp is market open, and invalid as a prior for a decision made now.
  //
  // This gate exists because the first shadow run proposed 7 positions with "edges" up to 13.6
  // points, and every one was fake. The forecasts had ZERO adjustments — the system held no opinion
  // at all and had simply echoed the BFO opening line. `system - kalshi` was therefore 100% the
  // market's move between the open and now. It is the exact mirror of the Phase 7 leak: that used a
  // price that was too fresh, this uses one that is too stale, and both manufacture edge out of a
  // timing mismatch.
  //
  // An ACTIONABLE position requires a prior that is contemporaneous with the price it is traded
  // against. Until a wall-clock snapshot (tier A/C) exists, the honest answer is that we cannot
  // value this contract against a live market at all.
  const base = forecast.marketBaseline;
  if (base && base.clockBasis === "LOGICAL_OPEN") {
    out.staleBaselineBlocked = true;
    out.classification = "NO BET";
    out.reason = "the forecast's prior is an OPENING line (LOGICAL_OPEN) but this contract trades at a CURRENT price. " +
      "Any difference between them is the market's move since the open, not an edge. A live position requires a " +
      "wall-clock baseline (tier A/C) contemporaneous with the traded price.";
    out.staleBaselineDetail = {
      baselineTier: base.fallbackLevel || null,
      baselineClock: base.clockBasis,
      staleCheckEnforceable: base.staleCheckEnforceable ?? null,
      whyThisMatters: "comparing a weeks-old prior to a live price measures elapsed time, not skill",
    };
    return out;
  }

  // Second, independent gate: a forecast that applied NO adjustments has no opinion — it is the
  // baseline wearing a system's name. Any gap to the market is drift in the price, not a view.
  const opinions = (forecast.appliedAdjustments || []).filter((a) => a.finalAppliedLogOdds > 0);
  if (!opinions.length) {
    out.noOpinion = true;
    out.classification = "NO BET";
    out.reason = "the forecast applied zero adjustments: the system holds no view on this fight and merely restates its baseline. " +
      "A gap to the market here is price movement, not a disagreement worth betting.";
    return out;
  }

  // Conservative bound: the end of the stated range that makes THIS position look worse.
  const range = forecast.systemRange;
  let conservative = pm.probability;
  if (range && range.forFighter) {
    const isRangeFighter = require("./evidence-eval").norm(range.forFighter) === require("./evidence-eval").norm(contract.outcomeSubject);
    conservative = isRangeFighter ? range.low : +(1 - range.high).toFixed(4);
  }
  out.conservativeProbability = conservative;
  out.conservativeMethod = CONSERVATIVE.method;

  const ex = C.priceOrder(contract, orderbook, proposedContracts, opts);
  out.execution = ex;
  if (!ex.ok) { out.classification = "NO BET"; out.reason = `not executable: ${ex.reasons.join("; ")}`; return out; }

  const price = ex.allInPricePerContract;   // includes fees + slippage
  out.executablePrice = ex.avgExecutionPrice;
  out.topOfBookPrice = ex.topOfBookPrice;
  out.slippage = ex.slippage;
  out.fees = ex.fees;
  out.allInPrice = price;
  out.availableLiquidity = ex.maxFillable;
  out.maxFillable = ex.maxFillable;
  out.fullyFillable = ex.fullyFilled;

  // A YES contract pays $1 on settlement. EV per contract = p*1 - allInPrice.
  out.expectedValueCentral = +(pm.probability - price).toFixed(4);
  out.expectedValueConservative = +(conservative - price).toFixed(4);
  out.breakEvenProbability = price;
  // The highest price at which the CONSERVATIVE estimate still breaks even. Derived from the
  // conservative bound on purpose: a max price set off the central estimate is not a limit.
  out.maximumAcceptablePrice = +conservative.toFixed(4);

  out.forecastStatus = forecast.status;
  out.evidenceCoverage = forecast.evidenceCoverage;
  out.mainUncertainty = describeUncertainty(forecast);

  // The label is mandatory and attaches to the number itself.
  out.unverifiedEstimatedEdge = {
    label: "UNVERIFIED ESTIMATED EDGE",
    centralPoints: +((pm.probability - price) * 100).toFixed(2),
    conservativePoints: +((conservative - price) * 100).toFixed(2),
    caveat: "This system has never demonstrated predictive skill. The only evaluation that showed one is void (BASELINE CONTAMINATED). This is a difference between two numbers, not a proven advantage.",
  };
  // A position qualifies ONLY if the conservative estimate survives every cost.
  out.qualifies = out.expectedValueConservative > 0 && ex.fullyFilled;
  out.classification = out.qualifies ? "ACTIONABLE EXPERIMENTAL" : "NO BET";
  if (!out.qualifies) {
    out.reason = out.expectedValueConservative <= 0
      ? `conservative EV ${out.expectedValueConservative} is not favourable after fees and slippage`
      : `book cannot fill the proposed size (${ex.filled}/${proposedContracts})`;
  }
  if (forecast.status === "HUMAN REVIEW REQUIRED") {
    out.classification = "HUMAN REVIEW REQUIRED";
    out.reason = "the underlying forecast is flagged HUMAN REVIEW REQUIRED";
  }
  return out;
}

function describeUncertainty(forecast) {
  const bits = [];
  if (forecast.systemRange) bits.push(`stated range ${(forecast.systemRange.low * 100).toFixed(1)}-${(forecast.systemRange.high * 100).toFixed(1)}% for ${forecast.systemRange.forFighter}`);
  if (forecast.evidenceCoverage) bits.push(`evidence ${forecast.evidenceCoverage}`);
  if (forecast.capNote) bits.push(`cap applied: ${forecast.capNote}`);
  if (forecast.marketBaseline && forecast.marketBaseline.clockBasis === "LOGICAL_OPEN")
    bits.push("baseline is an opening line (LOGICAL_OPEN): the market has since moved and that move is not in this number");
  return bits.length ? bits.join("; ") : "not characterised";
}

module.exports = { valueContract, probabilityFor, verifyTreeCoherence, describeUncertainty, CONSERVATIVE };
