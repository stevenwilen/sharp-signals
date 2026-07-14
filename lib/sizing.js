// How much of your bankroll to bet — an actual number, not "bet small".
//
// Kelly criterion. For a Kalshi contract that costs `c` and pays $1:
//     full Kelly  f* = (p - c) / (1 - c)      where p = true win probability
//
// Full Kelly is famously reckless in practice because it assumes you KNOW p.
// We don't. We have a source's opinion, backed by a modest track record. So:
//
//   1) SHRINK the source's view toward the market price, based on sample size.
//      A guy with 20 graded picks barely moves the number. A guy with 200 moves it a lot.
//      This is the single most important safeguard: tonight a source looked +75% on 9
//      picks and turned out to be -6.6% on 95. Small n must not produce big bets.
//   2) QUARTER KELLY on top, to absorb the remaining estimation error.
//   3) HARD CAP at 5% of bankroll. No single fight can wreck you.
//   4) FLOOR: below ~0.5% it isn't worth the transaction — skip it.

const K_SHRINK = 60; // "picks needed before we half-trust the source's number"

// preds: [{ sourceProb, n }] (one entry per trusted source backing this pick)
// marketProb: current Kalshi price as a probability (0..1)
function sizeBet(preds, marketProb, { kellyFraction = 0.25, cap = 0.05, floor = 0.005 } = {}) {
  const c = marketProb;
  if (!(c > 0 && c < 1) || !preds.length) return { pct: 0, skip: true, reason: "no price" };

  // combine sources: average their view, sum their evidence
  const p_raw = preds.reduce((a, x) => a + x.sourceProb, 0) / preds.length;
  const nTotal = preds.reduce((a, x) => a + (x.n || 0), 0);

  // 1) shrink toward the market by how much evidence there actually is
  const trust = nTotal / (nTotal + K_SHRINK); // 0 = ignore source, 1 = fully trust
  const p = c + (p_raw - c) * trust;

  // 2) Kelly, then take a quarter of it
  const fullKelly = (p - c) / (1 - c);
  let pct = fullKelly * kellyFraction;

  // 3) + 4) cap and floor
  const capped = pct > cap;
  if (capped) pct = cap;
  if (pct < floor) return { pct: 0, skip: true, reason: "edge too thin after shrinkage", p_raw, p, trust, fullKelly };

  return {
    pct: +(pct * 100).toFixed(1), // % of bankroll
    skip: false, capped,
    p_raw: +(p_raw * 100).toFixed(0),   // what the sources claim it's worth (cents)
    p: +(p * 100).toFixed(0),           // what we actually use, after shrinkage (cents)
    market: +(c * 100).toFixed(0),
    trust: +trust.toFixed(2),
    nTotal,
    fullKelly: +(fullKelly * 100).toFixed(1),
  };
}

module.exports = { sizeBet, K_SHRINK };
