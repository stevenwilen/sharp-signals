// ENTERTAINMENT BANKROLL — manual, Telegram-only, $100.
//
// SEPARATE FROM THE RESEARCH STAKE, DELIBERATELY AND PHYSICALLY. lib/portfolio.js sizes the research
// book with conservative fractional Kelly off the CONSERVATIVE probability bound. The numbers below
// are not that. They are not Kelly, they are not derived from any measured edge, and they are not a
// validated staking plan — they are entertainment stakes the human chose. Mixing them into the
// research sizing would let a number picked for fun contaminate a book that exists to measure
// whether this system can predict anything.
//
// A BIGGER STAKE CANNOT BUY A BET. This is the whole safety property. Entertainment sizing runs
// ONLY on something already ruled ACTIONABLE EXPERIMENTAL by the research gates. It has no power to
// promote a WATCH, a NO BET, a stale price, an unverified fee, insufficient evidence, or an
// unvalidated contract type. If the pipeline says no, a 5% appetite still says no — it just says no
// about a larger number that never gets used.
require("./env");
const C = require("./contracts");

const BANKROLL = {
  amount: 100,
  currency: "USD",
  label: "ENTERTAINMENT",
  note: "money the human is content to lose for entertainment. Not a research stake, not a validated edge, not Kelly.",
};

// Chosen by the human, not fitted to anything. Recorded as such so no future reader mistakes them
// for an optimisation result.
//
// The $3 floor (raised from $2) has a useful side effect worth recording, because it was not the
// reason for the change and should not be mistaken for one: at $2 an order fell OUT of the verified
// fee envelope at higher prices (2.22 contracts at 0.89, under the 3.28 floor), so its fee was an
// extrapolation. At $3 every tier lands inside across the whole 0.59-0.89 band — $3 at 0.89 is 3.33
// contracts, above the floor by 0.05. Every entertainment order now has a fee that was actually
// verified rather than inferred.
const TIERS = {
  STANDARD: { fraction: 0.03, dollars: 3, label: "standard experimental" },
  STRONG: { fraction: 0.04, dollars: 4, label: "strong experimental" },
  MAXIMUM: { fraction: 0.05, dollars: 5, label: "rare maximum" },
};
const CAPS = {
  maxFractionPerFight: 0.05,   // 5% = $5
  maxFractionPerCard: 0.10,    // 10% = $10
  provenance: "chosen by the human as entertainment limits; NOT derived from Kelly, NOT fitted to any result, NOT evidence of edge",
};

// The classifications entertainment money may touch. Everything else is untouchable, by
// construction rather than by discipline.
const ELIGIBLE = new Set(["ACTIONABLE EXPERIMENTAL"]);
const NEVER_PROMOTABLE = [
  "WATCH", "NO BET", "UNPRICED", "ANALYSIS ONLY", "HUMAN REVIEW REQUIRED",
];

// Which tier does a qualifying position get? Driven by the CONSERVATIVE margin after all costs —
// the same number the research book sizes on — never by how exciting the payout looks. A 3c
// contract paying 33:1 does not become a MAXIMUM because the multiple is large.
function tierFor(valued) {
  const m = valued.expectedValueConservative;   // in probability units, after fees + slippage
  if (!Number.isFinite(m) || m <= 0) return null;
  if (m >= 0.06) return "MAXIMUM";
  if (m >= 0.03) return "STRONG";
  return "STANDARD";
}

// Size an entertainment position. Returns { eligible:false, reason } for anything the research gates
// have not already cleared — and the reason names the gate, so a refusal is never mysterious.
function sizeEntertainment(valued, opts = {}) {
  const bankroll = opts.bankroll ?? BANKROLL.amount;

  if (!ELIGIBLE.has(valued.classification))
    return { eligible: false, reason: `classification is ${valued.classification} — entertainment money cannot promote it`,
      blockedBy: "research classification", stake: 0, contracts: 0 };
  if (valued.probabilityModelStatus === "UNVALIDATED METHOD MODEL")
    return { eligible: false, reason: "the probability model for this outcome type is unvalidated — no stake of any size", blockedBy: "model validation", stake: 0, contracts: 0 };
  if (valued.staleBaselineBlocked)
    return { eligible: false, reason: "the prior is stale relative to the traded price", blockedBy: "stale data", stake: 0, contracts: 0 };
  if (valued.noOpinion)
    return { eligible: false, reason: "the forecast applied zero adjustments — the system holds no view on this fight", blockedBy: "no opinion", stake: 0, contracts: 0 };
  if (valued.execution && valued.execution.snapshotAgeMs != null && opts.maxSnapshotAgeMs &&
      valued.execution.snapshotAgeMs > opts.maxSnapshotAgeMs)
    return { eligible: false, reason: "the price snapshot is stale", blockedBy: "stale data", stake: 0, contracts: 0 };

  const tier = tierFor(valued);
  if (!tier) return { eligible: false, reason: "conservative value after costs is not positive", blockedBy: "conservative EV", stake: 0, contracts: 0 };

  const t = TIERS[tier];
  const stake = +(bankroll * t.fraction).toFixed(2);
  const price = valued.allInPrice;
  const contracts = price > 0 ? Math.floor(stake / price) : 0;

  // THE SMALL-ORDER FEE GATE. A $2-$5 order is a handful of contracts, far below the 82.37-contract
  // floor the fee schedule was actually verified at, and small orders are the WORST fee regime
  // because ceil() rounds every one up to a whole cent. Until authenticated Quick Order tickets
  // exist AT THESE SIZES, the fee on this position is an extrapolation and the position may not be
  // alerted in production.
  const env = C.withinVerifiedEnvelope({
    ticker: valued.ticker, side: "yes", contracts, price, treatment: "taker",
    fillCount: valued.execution && valued.execution.fills ? valued.execution.fills.length : 1,
  });
  const feeGate = {
    withinVerifiedEnvelope: env.inside,
    exceptions: env.reasons,
    productionAlertAllowed: env.inside,
    why: env.inside ? null
      : "this order sits outside the verified fee envelope, so its fee is EXTRAPOLATED. Production alerts require authenticated unsubmitted Quick Order fee examples at $2-$5 sizes that reproduce exactly. Until then this position is TEST MODE only.",
  };

  return {
    eligible: true, tier, tierLabel: t.label,
    fraction: t.fraction, percentOfBankroll: +(t.fraction * 100).toFixed(2),
    stake, contracts, bankroll,
    allInPrice: price,
    conservativeMarginPoints: +(valued.expectedValueConservative * 100).toFixed(2),
    feeGate,
    basis: "ENTERTAINMENT stake chosen by the human. NOT Kelly, NOT sized from a measured edge, NOT evidence this system can predict anything.",
    caps: CAPS,
  };
}

// Fight- and card-level ceilings, applied AFTER individual sizing. Per-position limits alone do not
// bound a card: three $5 positions each inside the per-position cap still breach a $10 card cap.
function applyEntertainmentCaps(sized, opts = {}) {
  const bankroll = opts.bankroll ?? BANKROLL.amount;
  const out = sized.map((s) => ({ ...s }));
  const fightCap = bankroll * CAPS.maxFractionPerFight;
  const cardCap = bankroll * CAPS.maxFractionPerCard;

  const byFight = {};
  for (const s of out) {
    if (!s.entertainment || !s.entertainment.eligible) continue;
    byFight[s.boutId] = (byFight[s.boutId] || 0) + s.entertainment.stake;
  }
  for (const [boutId, total] of Object.entries(byFight)) {
    if (total <= fightCap) continue;
    const scale = fightCap / total;
    for (const s of out) {
      if (s.boutId !== boutId || !s.entertainment || !s.entertainment.eligible) continue;
      s.entertainment.stake = +(s.entertainment.stake * scale).toFixed(2);
      s.entertainment.contracts = Math.floor(s.entertainment.stake / s.entertainment.allInPrice);
      s.entertainment.scaledBy = `per-fight entertainment cap ($${fightCap.toFixed(2)})`;
    }
  }
  const cardTotal = out.reduce((a, s) => a + (s.entertainment && s.entertainment.eligible ? s.entertainment.stake : 0), 0);
  if (cardTotal > cardCap) {
    const scale = cardCap / cardTotal;
    for (const s of out) {
      if (!s.entertainment || !s.entertainment.eligible) continue;
      s.entertainment.stake = +(s.entertainment.stake * scale).toFixed(2);
      s.entertainment.contracts = Math.floor(s.entertainment.stake / s.entertainment.allInPrice);
      s.entertainment.scaledBy = `${s.entertainment.scaledBy ? s.entertainment.scaledBy + "; " : ""}per-card entertainment cap ($${cardCap.toFixed(2)})`;
    }
  }
  return { positions: out, cardTotalBefore: +cardTotal.toFixed(2), fightCap, cardCap };
}

module.exports = { BANKROLL, TIERS, CAPS, ELIGIBLE, NEVER_PROMOTABLE, tierFor, sizeEntertainment, applyEntertainmentCaps };
