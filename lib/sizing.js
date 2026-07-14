// How much of the bankroll to bet — an actual number, not "bet small".
//
// WHAT THIS USED TO DO, AND WHY IT WAS INDEFENSIBLE:
//
// It took Gemini's `confidence` score — which the prompt defines as "how strongly they back
// it", i.e. how hard the YouTuber was thumping the table — and fed it into Kelly as if it
// were a calibrated probability. Measured against 281 real graded picks:
//
//     stated confidence 0.70  ->  actually won 57% of the time
//     stated confidence 0.80  ->  actually won 74%
//     mean stated 0.777       ->  mean actual 0.669
//
// A systematic +11 point overstatement — more than DOUBLE the 5-point edge threshold. And
// because confidence is essentially never below 0.55, `edge = confidence - price` was positive
// BY CONSTRUCTION for any underdog. The gate was cleared by the bias, not by an edge. Replaying
// all 342 historical picks: 171 would have alerted, ZERO were ever skipped, and 77 of them
// (45%) hit the 5% hard cap. That is not an edge detector. It is a machine that says "bet the
// maximum" every other time a confident man speaks.
//
// WHAT IT DOES NOW:
//
// The only thing this project has ever validated is ROI vs the closing line — measured against
// settled markets, in money. So the probability is derived from THAT, and from nothing else:
//
//     a source who beats the line by f, on a contract that costs c, is implicitly saying
//     the true probability is    p = c * (1 + f)
//
// and we use the LOWER CONFIDENCE BOUND on f (grade.js `roiLcb`), not the flattering mean.
// Betting ROI is savagely high-variance — back a 30c underdog and every pick returns either
// -100% or +233% — so over 26 picks a headline "+69%" is entirely compatible with a man who
// has no edge and ran hot. Sizing off the mean of that distribution is how you go broke while
// being theoretically right. With a small sample the LCB is brutal, which is correct: the
// sample IS tiny and the stake should say so.
//
// Gemini's opinion of how excited someone sounded no longer touches the bet size.
//
// Remaining safeguards, unchanged:
//   - shrink toward the market by sample size
//   - QUARTER Kelly, to absorb estimation error
//   - HARD CAP at 5% of bankroll: no single fight can wreck you
//   - FLOOR at 0.5%: below that it isn't worth the transaction

const K_SHRINK = 60; // "picks needed before we half-trust the source's number"

// preds: [{ source, roiLcb, shrunkRoi, n }] — the trusted sources backing ONE market.
//        CALLERS MUST DEDUPE BY SOURCE FIRST. One man posting two videos in a fight week was
//        being counted as two sources, which nearly doubled the Kelly trust weight and printed
//        "2 trusted sources all like him" with his name listed twice.
// marketPrice: what you actually PAY (the ask), 0..1
function sizeBet(preds, marketPrice, { kellyFraction = 0.25, cap = 0.05, floor = 0.005 } = {}) {
  const c = marketPrice;
  if (!(c > 0 && c < 1)) return { pct: 0, skip: true, reason: "no usable market price" };
  if (!preds || !preds.length) return { pct: 0, skip: true, reason: "no sources" };

  // Multiple sources on one fight are NOT independent evidence — they watch the same tape and
  // read the same odds screen. So AVERAGE their defensible edge rather than summing it, and take
  // the single largest track record as the effective sample rather than adding them together.
  // Summing was letting a crowd of correlated pundits pose as a crowd of independent ones.
  const edges = preds.map((p) => (p.roiLcb != null ? p.roiLcb : (p.shrunkRoi || 0)));
  const f = edges.reduce((a, x) => a + x, 0) / edges.length;
  const nEff = Math.max(...preds.map((p) => p.n || 0));

  if (!(f > 0)) {
    return { pct: 0, skip: true, edgeUsed: +f.toFixed(3), nEff,
      reason: "once you account for how few picks back this, the edge could easily be zero" };
  }

  const p = Math.min(0.95, c * (1 + f)); // never claim near-certainty from a track record

  const trust = nEff / (nEff + K_SHRINK);
  const pAdj = c + (p - c) * trust;

  const fullKelly = (pAdj - c) / (1 - c);
  let pct = fullKelly * kellyFraction;

  const capped = pct > cap;
  if (capped) pct = cap;
  if (pct < floor) {
    return { pct: 0, skip: true, edgeUsed: +f.toFixed(3), nEff,
      reason: "the edge is too thin to be worth the risk" };
  }

  return {
    pct: +(pct * 100).toFixed(1),        // % of bankroll
    skip: false, capped,
    p: Math.round(pAdj * 100),           // what we think it's worth, in cents
    market: Math.round(c * 100),         // what it costs, in cents
    edgeUsed: +f.toFixed(3),             // the DEFENSIBLE edge (lower bound), not the headline
    nEff,
    trust: +trust.toFixed(2),
    fullKelly: +(fullKelly * 100).toFixed(1),
  };
}

module.exports = { sizeBet, K_SHRINK };
