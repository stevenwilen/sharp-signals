// PHASE 8E/8F/8G — terminal-state risk, correlation, leverage ranking, and sizing.
//
// EVERY POSITION IS EXPRESSED AS A SET OF TERMINAL FIGHT OUTCOMES. That is the whole trick. Once
// "Holloway wins" and "Holloway wins by KO" are both just sets of terminal states, their overlap is
// arithmetic rather than judgement, and the portfolio's payoff in every possible world can be
// enumerated instead of estimated.
//
// OVERLAPPING BETS ARE NOT DIVERSIFICATION. "Fighter wins" and "fighter wins by KO" are the same
// wager at two sizes: the KO position is a strict subset. Holding both and calling it two positions
// is one position with extra fees. This module names that as concentration, never as spread risk.
require("./env");
const E = require("./evidence-eval");
const C = require("./contracts");

// The terminal states of a three-round fight, as this system models them. A terminal state is a
// complete description of how the fight ended: who won, by what, in which round.
const METHODS = ["KO/TKO", "Submission", "Decision"];
function terminalStates(A, B) {
  const out = [];
  for (const w of [A, B]) {
    for (const m of METHODS) {
      if (m === "Decision") out.push({ winner: w, method: m, round: null, id: `${w}|${m}` });
      else for (const r of [1, 2, 3]) out.push({ winner: w, method: m, round: r, id: `${w}|${m}|R${r}` });
    }
  }
  return out;
}

// Does a contract pay out in this terminal state? Driven by the canonical outcome type — i.e. by
// the settlement rules that produced it, not by the ticker.
function paysIn(contract, st) {
  const same = (x, y) => E.norm(x) === E.norm(y);
  switch (contract.outcomeType) {
    case C.OUTCOME.FIGHTER_WINS: return same(contract.outcomeSubject, st.winner);
    case C.OUTCOME.FIGHTER_WINS_BY_KO: return same(contract.outcomeSubject, st.winner) && st.method === "KO/TKO";
    case C.OUTCOME.FIGHTER_WINS_BY_SUBMISSION: return same(contract.outcomeSubject, st.winner) && st.method === "Submission";
    case C.OUTCOME.FIGHTER_WINS_BY_DECISION: return same(contract.outcomeSubject, st.winner) && st.method === "Decision";
    case C.OUTCOME.FIGHTER_WINS_IN_ROUND: return same(contract.outcomeSubject, st.winner) && st.round === contract.round;
    case C.OUTCOME.FIGHT_REACHES_DECISION: return st.method === "Decision";
    default: return false;
  }
}

// ---- 8E: portfolio payoff across every terminal state ----------------------------------------
function analysePortfolio(positions, forecasts) {
  const byBout = {};
  for (const p of positions) (byBout[p.boutId] = byBout[p.boutId] || []).push(p);

  const bouts = [];
  for (const [boutId, ps] of Object.entries(byBout)) {
    const fc = forecasts.find((f) => f.boutId === boutId);
    if (!fc) { bouts.push({ boutId, error: "no forecast — exposure cannot be evaluated" }); continue; }
    const [A, B] = fc.fight.split(" vs ");
    const states = terminalStates(A, B);

    const payoffs = states.map((st) => {
      let pnl = 0;
      for (const p of ps) {
        const cost = p.totalCost;                    // already includes fees + slippage
        pnl += paysIn(p.contract, st) ? (p.contracts * 1 - cost) : -cost;
      }
      return { state: st.id, winner: st.winner, method: st.method, round: st.round, pnl: +pnl.toFixed(2) };
    });

    const staked = ps.reduce((s, p) => s + p.totalCost, 0);
    const maxLoss = Math.min(...payoffs.map((x) => x.pnl));
    const maxGain = Math.max(...payoffs.map((x) => x.pnl));

    // NESTING: does one position's winning set sit inside another's? Computed from the terminal
    // states themselves, so it cannot be fooled by naming.
    const nested = [];
    for (const p of ps) for (const q of ps) {
      if (p === q) continue;
      const sp = new Set(states.filter((s) => paysIn(p.contract, s)).map((s) => s.id));
      const sq = new Set(states.filter((s) => paysIn(q.contract, s)).map((s) => s.id));
      if (sp.size && sp.size < sq.size && [...sp].every((x) => sq.has(x)))
        nested.push({ inner: p.contract.ticker, outer: q.contract.ticker,
          note: `${p.contract.ticker} wins only in states where ${q.contract.ticker} also wins — a strict subset. This is ONE bet at two sizes, not two bets.` });
    }
    // OPPOSING: two positions that can never both pay.
    const opposing = [];
    for (const p of ps) for (const q of ps) {
      if (p === q || p.contract.ticker >= q.contract.ticker) continue;
      const overlap = states.some((s) => paysIn(p.contract, s) && paysIn(q.contract, s));
      if (!overlap) opposing.push({ a: p.contract.ticker, b: q.contract.ticker, note: "mutually exclusive — these cannot both settle YES" });
    }
    // MECHANISM concentration: several positions leaning on the same matchup mechanism.
    const mechs = {};
    for (const p of ps) for (const m of (p.mechanisms || [])) (mechs[m] = mechs[m] || []).push(p.contract.ticker);
    const mechConc = Object.entries(mechs).filter(([, v]) => v.length > 1)
      .map(([m, v]) => ({ mechanism: m, tickers: v, note: `${v.length} positions depend on the same "${m}" read — if that read is wrong they fail together` }));

    bouts.push({
      boutId, fight: fc.fight, positions: ps.length,
      totalExposure: +staked.toFixed(2), maxLoss: +maxLoss.toFixed(2), maxGain: +maxGain.toFixed(2),
      payoffByTerminalState: payoffs,
      nestedPositions: nested, opposingPositions: opposing, mechanismConcentration: mechConc,
      correlatedExposure: nested.length || mechConc.length
        ? +staked.toFixed(2) : 0,
      diversificationNote: nested.length
        ? "NOT diversified: these positions overlap. Overlapping bets on one fight are concentration."
        : ps.length > 1 ? "multiple positions on one fight — correlated by construction, since one result settles them all" : null,
    });
  }

  const cardExposure = bouts.reduce((s, b) => s + (b.totalExposure || 0), 0);
  const byFighter = {};
  for (const p of positions) {
    const f = p.contract.outcomeSubject;
    if (f) byFighter[f] = +((byFighter[f] || 0) + p.totalCost).toFixed(2);
  }
  return {
    perBout: bouts,
    cardTotalExposure: +cardExposure.toFixed(2),
    cardMaxLoss: +bouts.reduce((s, b) => s + (b.maxLoss || 0), 0).toFixed(2),
    cardMaxGain: +bouts.reduce((s, b) => s + (b.maxGain || 0), 0).toFixed(2),
    concentrationByFighter: byFighter,
    note: "Fights on one card are assumed independent for exposure totals. That is an ASSUMPTION: a common cause (a card-wide judging tendency, an altitude effect) would correlate them and is not modelled.",
  };
}

// ---- 8F: leverage ranking --------------------------------------------------------------------
const STATUSES = ["ACTIONABLE EXPERIMENTAL", "WATCH", "ANALYSIS ONLY", "NO BET", "UNPRICED", "HUMAN REVIEW REQUIRED"];

// Rank by RISK-ADJUSTED value, never payout size. A 3c contract paying 33:1 is not "high leverage"
// because the payout is large; it is high leverage only if the conservative estimate says so after
// costs, and the book can actually fill it.
function rankContracts(valued, opts = {}) {
  const ranked = valued.map((v) => {
    const reasons = [];
    let score = null;

    if (v.classification === "ACTIONABLE EXPERIMENTAL") {
      // conservative EV per dollar risked — the honest unit of leverage
      const evPerDollar = v.expectedValueConservative / Math.max(v.allInPrice, 1e-6);
      // uncertainty penalty: a wide stated range means the central number is doing less work
      const width = v.systemCentralProbability - v.conservativeProbability;
      const uncertaintyPenalty = 1 / (1 + 4 * Math.max(0, width));
      // liquidity: a position the book cannot fill twice over is fragile
      const liq = Math.min(1, (v.maxFillable || 0) / Math.max(1, (opts.contracts || 100) * 2));
      // settlement clarity + coverage
      const clarity = v.settlementRules && v.settlementRules.length > 40 ? 1 : 0.5;
      const coverage = { "WELL COVERED": 1, "PARTIALLY COVERED": 0.7, "THINLY COVERED": 0.5 }[v.evidenceCoverage] || 0.4;
      // price sensitivity: how much room before the edge dies
      const room = Math.max(0, v.maximumAcceptablePrice - v.allInPrice);
      const sensitivity = Math.min(1, room / 0.05);
      score = evPerDollar * uncertaintyPenalty * liq * clarity * coverage * (0.5 + 0.5 * sensitivity);
      reasons.push(`conservative EV/$ ${evPerDollar.toFixed(4)}`, `uncertainty x${uncertaintyPenalty.toFixed(2)}`,
        `liquidity x${liq.toFixed(2)}`, `clarity x${clarity}`, `coverage x${coverage}`, `price room ${(room * 100).toFixed(1)}c`);
    } else {
      reasons.push(v.reason || v.classification);
    }
    return { ...v, leverageScore: score === null ? null : +score.toFixed(5), rankingReasons: reasons };
  });

  // Only outright winner contracts may hold ACTIONABLE EXPERIMENTAL. Enforced here as well as at
  // valuation: a second, independent check on the rule that matters most.
  for (const r of ranked) {
    if (r.classification === "ACTIONABLE EXPERIMENTAL" && r.outcomeType !== C.OUTCOME.FIGHTER_WINS) {
      r.classification = "ANALYSIS ONLY";
      r.reason = "only outright winner contracts may be ACTIONABLE EXPERIMENTAL at this stage";
      r.leverageScore = null;
    }
  }
  const order = (r) => STATUSES.indexOf(r.classification);
  ranked.sort((a, b) => (order(a) - order(b)) || ((b.leverageScore ?? -1) - (a.leverageScore ?? -1)));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
}

// ---- 8G: sizing ------------------------------------------------------------------------------
// Initial SAFETY caps. Not optimised, not derived from any result, and not to be raised because a
// few bets won. A winning streak of n<30 is indistinguishable from luck and is the single most
// common reason a staking plan quietly becomes reckless.
const CAPS = {
  maxFractionPerPosition: 0.005,   // 0.5% of bankroll
  maxFractionPerFight: 0.01,       // 1%
  maxFractionPerCard: 0.03,        // 3%
  kellyFraction: 0.25,             // quarter Kelly
  rationale: "initial safety caps, deliberately conservative; never widen them on a winning streak",
};

// Fractional Kelly on the CONSERVATIVE probability. Kelly on the central estimate would size to a
// belief the system has not earned.
function sizePosition(valued, bankroll, opts = {}) {
  const caps = { ...CAPS, ...(opts.caps || {}) };
  if (valued.classification !== "ACTIONABLE EXPERIMENTAL")
    return { sized: false, reason: `not eligible for sizing (${valued.classification})`, proposedStake: 0, contracts: 0 };

  const p = valued.conservativeProbability;
  const price = valued.allInPrice;
  if (!(p > 0 && p < 1) || !(price > 0 && price < 1))
    return { sized: false, reason: "probability or price out of range", proposedStake: 0, contracts: 0 };

  // A binary at price c paying 1: b = (1-c)/c, q = 1-p.  f* = (b*p - q) / b
  const b = (1 - price) / price;
  const kelly = (b * p - (1 - p)) / b;
  const fractional = Math.max(0, kelly) * caps.kellyFraction;

  const capPos = caps.maxFractionPerPosition;
  const applied = Math.min(fractional, capPos);
  const capBinding = applied < fractional;

  const stake = +(bankroll * applied).toFixed(2);
  const contracts = Math.floor(stake / price);
  // flat-stake comparison so Kelly can be AUDITED rather than trusted
  const flatStake = +(bankroll * caps.maxFractionPerPosition).toFixed(2);

  return {
    sized: true,
    fullKellyFraction: +kelly.toFixed(5),
    fractionalKelly: +fractional.toFixed(5),
    kellyMultiplier: caps.kellyFraction,
    appliedFraction: +applied.toFixed(5),
    capBinding, cap: capPos,
    proposedStake: stake,
    contracts,
    basedOn: "CONSERVATIVE probability, not the central estimate",
    conservativeProbability: p,
    flatStakeComparison: { stake: flatStake, contracts: Math.floor(flatStake / price),
      note: "flat 0.5% stake for audit: if Kelly and flat diverge sharply, Kelly is reacting to a probability the system has not earned" },
    caps,
  };
}

// Enforce fight- and card-level caps AFTER individual sizing. Per-position caps alone do not bound
// a card: six positions each inside the per-position cap can still blow through the card cap.
function applyPortfolioCaps(sized, bankroll, opts = {}) {
  const caps = { ...CAPS, ...(opts.caps || {}) };
  const out = sized.map((s) => ({ ...s }));
  const byFight = {};
  for (const s of out) {
    if (!s.sizing || !s.sizing.sized) continue;
    const k = s.boutId;
    byFight[k] = (byFight[k] || 0) + s.sizing.proposedStake;
  }
  const fightCap = bankroll * caps.maxFractionPerFight;
  for (const [boutId, total] of Object.entries(byFight)) {
    if (total <= fightCap) continue;
    const scale = fightCap / total;
    for (const s of out) {
      if (s.boutId !== boutId || !s.sizing || !s.sizing.sized) continue;
      s.sizing.proposedStake = +(s.sizing.proposedStake * scale).toFixed(2);
      s.sizing.contracts = Math.floor(s.sizing.proposedStake / s.allInPrice);
      s.sizing.scaledBy = `per-fight cap (${(caps.maxFractionPerFight * 100).toFixed(1)}% of bankroll)`;
    }
  }
  const cardTotal = out.reduce((a, s) => a + (s.sizing && s.sizing.sized ? s.sizing.proposedStake : 0), 0);
  const cardCap = bankroll * caps.maxFractionPerCard;
  if (cardTotal > cardCap) {
    const scale = cardCap / cardTotal;
    for (const s of out) {
      if (!s.sizing || !s.sizing.sized) continue;
      s.sizing.proposedStake = +(s.sizing.proposedStake * scale).toFixed(2);
      s.sizing.contracts = Math.floor(s.sizing.proposedStake / s.allInPrice);
      s.sizing.scaledBy = `${s.sizing.scaledBy ? s.sizing.scaledBy + "; " : ""}per-card cap (${(caps.maxFractionPerCard * 100).toFixed(1)}% of bankroll)`;
    }
  }
  return { positions: out, cardTotalBefore: +cardTotal.toFixed(2), cardCap: +cardCap.toFixed(2), fightCap: +fightCap.toFixed(2) };
}

module.exports = { terminalStates, paysIn, analysePortfolio, rankContracts, sizePosition, applyPortfolioCaps, STATUSES, CAPS, METHODS };
