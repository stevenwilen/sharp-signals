// Grading engine. Scores each source on whether they BEAT THE LINE, with
// recency weighting and small-sample shrinkage. Pure logic — no external calls.
//
// A resolved prediction needs: { source, domain, pick, timestamp,
//   priceAtCall (0..1 implied prob of the PICKED side when they called it),
//   confidence (0..1, optional), result (1 win / 0 loss) }.

const DAY = 86400000;

// ROI of betting $1 on the pick at priceAtCall: win => 1/p - 1, loss => -1.
const roiOf = (result, p) => (p > 0 ? result / p - 1 : 0);

function gradeSource(preds, cfg) {
  const g = cfg.grading || {};
  const halfLife = g.recencyHalfLifeDays || 365;
  const prior = g.shrinkagePriorWeight ?? 10;
  const now = Date.now();

  const resolved = preds.filter(
    (p) => (p.result === 0 || p.result === 1) && p.priceAtCall > 0 && p.priceAtCall < 1
  );
  if (!resolved.length) return { n: 0, effN: 0, trusted: false };

  let wSum = 0, wRoi = 0, wHit = 0, wLine = 0, brierNum = 0, brierDen = 0;
  for (const p of resolved) {
    const ageDays = Math.max(0, (now - Date.parse(p.timestamp || 0)) / DAY);
    const w = Math.pow(0.5, ageDays / halfLife);
    wSum += w;
    wRoi += w * roiOf(p.result, p.priceAtCall);
    wHit += w * p.result;
    wLine += w * p.priceAtCall;
    if (p.confidence >= 0 && p.confidence <= 1) {
      brierNum += w * Math.pow(p.confidence - p.result, 2);
      brierDen += w;
    }
  }
  const effN = wSum;
  const rawRoi = wRoi / wSum;                       // recency-weighted ROI vs line
  const shrunkRoi = rawRoi * (effN / (effN + prior)); // pull small samples toward 0
  const minN = g.minSampleForTrust ?? 15;
  const minEdge = g.minEdgeVsLine ?? 0.03;

  // Do IMPLICIT leans ("+250 is free money", "I don't see how he gets out of R2") actually
  // carry edge, or are they noise? Measure them separately and let the data answer.
  const slice = (kind) => {
    const rows = resolved.filter((p) => (p.directness || "explicit") === kind);
    if (!rows.length) return { n: 0, roi: null, hitRate: null };
    const roi = rows.reduce((a, p) => a + roiOf(p.result, p.priceAtCall), 0) / rows.length;
    const hit = rows.reduce((a, p) => a + p.result, 0) / rows.length;
    return { n: rows.length, roi: +roi.toFixed(3), hitRate: +hit.toFixed(3) };
  };

  return {
    n: resolved.length,
    effN: +effN.toFixed(1),
    hitRate: +(wHit / wSum).toFixed(3),
    avgLinePrice: +(wLine / wSum).toFixed(3),
    roi: +rawRoi.toFixed(3),
    shrunkRoi: +shrunkRoi.toFixed(3),
    brier: brierDen ? +(brierNum / brierDen).toFixed(3) : null,
    explicit: slice("explicit"),
    implicit: slice("implicit"),
    trusted: effN >= minN && shrunkRoi >= minEdge,
  };
}

// Grade every source that appears in the predictions.
function gradeAll(predictions, cfg, sourceMeta = {}) {
  const bySource = {};
  for (const p of predictions) (bySource[p.source] = bySource[p.source] || []).push(p);
  const out = {};
  for (const [src, preds] of Object.entries(bySource)) {
    out[src] = { source: src, ...(sourceMeta[src] || {}), ...gradeSource(preds, cfg) };
  }
  return out;
}

module.exports = { gradeSource, gradeAll, roiOf };
