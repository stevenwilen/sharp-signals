// Grading engine. Scores each source on whether they BEAT THE LINE, with
// recency weighting and small-sample shrinkage. Pure logic — no external calls.
//
// A resolved prediction needs: { source, domain, pick, timestamp,
//   priceAtCall (0..1 implied prob of the PICKED side when they called it),
//   confidence (0..1, optional), result (1 win / 0 loss) }.

const DAY = 86400000;

// ROI of betting $1 on the pick at priceAtCall: win => 1/p - 1, loss => -1.
const roiOf = (result, p) => (p > 0 ? result / p - 1 : 0);

// One source repeating the same call is ONE opinion, not several.
//
// Channels post a "Preview" and a "Best Bets" video in the same fight week, so the same pick
// was landing in the data 2-5 times. Those rows are perfectly correlated, so they inflated n
// (pushing sources over the trust threshold), understated the variance, and let one lucky
// fight be counted repeatedly. Real effect: MMA EXPERTS' shrunk edge fell from 0.241 to 0.143
// once deduped, and Topside MMA fell to 0.038 — a hair above the 0.03 trust line.
//
// Keep the EARLIEST call for each (source, market): it is the one made with the least
// information, and it is the only one that could actually have been acted on.
function dedupePicks(preds) {
  const best = new Map();
  for (const p of preds) {
    const key = `${p.source}|${p.marketTicker || p.pick}`;
    const t = Date.parse(p.timestamp) || 0;
    const cur = best.get(key);
    if (!cur || t < cur.t) best.set(key, { p, t });
  }
  return Array.from(best.values()).map((x) => x.p);
}

// Weighted ROI stats for an ARBITRARY slice of picks — used both for the full record and for the
// train/test halves of the out-of-sample survival check. Same recency weighting as gradeSource.
function statsFor(picks, now, halfLife, prior) {
  const w = (p) => Math.pow(0.5, Math.max(0, (now - Date.parse(p.timestamp || 0)) / DAY) / halfLife);
  let wSum = 0, wRoi = 0;
  for (const p of picks) { const wi = w(p); wSum += wi; wRoi += wi * roiOf(p.result, p.priceAtCall); }
  if (!wSum) return { n: picks.length, effN: 0, roi: 0, shrunk: 0, roiLcb: null };
  const effN = wSum, rawRoi = wRoi / wSum, shrunk = rawRoi * (effN / (effN + prior));
  let varNum = 0;
  for (const p of picks) varNum += w(p) * Math.pow(roiOf(p.result, p.priceAtCall) - rawRoi, 2);
  const roiStd = effN > 1 ? Math.sqrt(varNum / (effN - 1)) : null;
  const roiSe = roiStd != null ? roiStd / Math.sqrt(effN) : null;
  const roiLcb = roiSe != null ? rawRoi - 1.645 * roiSe : null;
  return { n: picks.length, effN: +effN.toFixed(1), roi: +rawRoi.toFixed(3),
    shrunk: +shrunk.toFixed(3), roiLcb: roiLcb != null ? +roiLcb.toFixed(3) : null,
    roiSe: roiSe != null ? +roiSe.toFixed(4) : null };
}

// Inverse standard-normal CDF (Acklam's approximation). Needed because the survival bound's
// z-score is not a constant: it depends on HOW MANY sources we auditioned (see gradeAll).
function probit(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let q, r;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - lo) { q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

function gradeSource(preds, cfg) {
  const g = cfg.grading || {};
  const halfLife = g.recencyHalfLifeDays || 365;
  const prior = g.shrinkagePriorWeight ?? 10;
  const now = Date.now();

  const resolved = dedupePicks(preds.filter(
    (p) => (p.result === 0 || p.result === 1) && p.priceAtCall > 0 && p.priceAtCall < 1
  ));
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

  // HOW SURE ARE WE, REALLY?
  //
  // Betting ROI is a brutally high-variance quantity: back a 30c underdog and each pick returns
  // either -100% or +233%. Over 26 picks the standard error on the mean is enormous, so a
  // headline "+69% ROI" is entirely compatible with a source who has no edge at all and simply
  // ran hot. Sizing a real bet off the MEAN of that distribution is how you go broke being
  // theoretically right.
  //
  // So we also compute a one-sided 95% LOWER CONFIDENCE BOUND: the edge we can defend, not the
  // edge we hope for. Bets are sized off THIS (see lib/sizing.js). With a big sample it
  // converges to the mean; with n=26 it is brutally conservative, which is correct — the whole
  // problem with this project's numbers is that the samples are tiny.
  let varNum = 0;
  for (const p of resolved) {
    const w = Math.pow(0.5, Math.max(0, (now - Date.parse(p.timestamp || 0)) / DAY) / halfLife);
    varNum += w * Math.pow(roiOf(p.result, p.priceAtCall) - rawRoi, 2);
  }
  const roiStd = effN > 1 ? Math.sqrt(varNum / (effN - 1)) : null;
  const roiSe = roiStd != null && effN > 0 ? roiStd / Math.sqrt(effN) : null;
  const roiLcb = roiSe != null ? rawRoi - 1.645 * roiSe : null; // 95% one-sided lower bound

  // Do IMPLICIT leans ("+250 is free money", "I don't see how he gets out of R2") actually
  // carry edge, or are they noise? Measure them separately and let the data answer.
  const slice = (kind) => {
    const rows = resolved.filter((p) => (p.directness || "explicit") === kind);
    if (!rows.length) return { n: 0, roi: null, hitRate: null };
    const roi = rows.reduce((a, p) => a + roiOf(p.result, p.priceAtCall), 0) / rows.length;
    const hit = rows.reduce((a, p) => a + p.result, 0) / rows.length;
    return { n: rows.length, roi: +roi.toFixed(3), hitRate: +hit.toFixed(3) };
  };

  // OUT-OF-SAMPLE stats. `trusted` below is IN-SAMPLE: it judges a source on the very fights it was
  // selected on, so across many sources some clear the bar by luck (the 24-month backfill made this
  // concrete — the trusted group did no better out of sample than picking everyone). So we also
  // hold out the most recent window and measure the edge there. The SURVIVES verdict is decided in
  // gradeAll(), which alone knows the contemporaneous baseline these numbers must beat.
  const holdoutDays = g.holdoutTestDays || 120;        // the most-recent N days are the held-out test
  const cutoffT = now - holdoutDays * DAY;
  const fdate = (p) => Date.parse(p.fightTime || 0) || 0; // split on FIGHT date, not pick date
  const trainS = statsFor(resolved.filter((p) => fdate(p) && fdate(p) < cutoffT), now, halfLife, prior);
  const testS = statsFor(resolved.filter((p) => fdate(p) && fdate(p) >= cutoffT), now, halfLife, prior);

  return {
    n: resolved.length,
    effN: +effN.toFixed(1),
    hitRate: +(wHit / wSum).toFixed(3),
    avgLinePrice: +(wLine / wSum).toFixed(3),
    roi: +rawRoi.toFixed(3),
    shrunkRoi: +shrunkRoi.toFixed(3),
    roiSe: roiSe != null ? +roiSe.toFixed(3) : null,
    roiLcb: roiLcb != null ? +roiLcb.toFixed(3) : null, // the edge we can DEFEND — sizing uses this
    brier: brierDen ? +(brierNum / brierDen).toFixed(3) : null,
    explicit: slice("explicit"),
    implicit: slice("implicit"),
    trusted: effN >= minN && shrunkRoi >= minEdge, // IN-SAMPLE (looked good historically)
    oos: { trainN: trainS.n, testN: testS.n, testRoi: testS.roi, testRoiLcb: testS.roiLcb,
      testSe: testS.roiSe },
  };
}

// Grade every source that appears in the predictions.
//
// SURVIVES is decided HERE, not in gradeSource, because it needs the CONTEMPORANEOUS BASELINE: what
// every source TOGETHER earned vs the line over the same held-out window. This is the difference
// between an honest gate and a broken one. A chalk-heavy stretch lifts everybody — in the backfill's
// July test window ALL sources averaged +12.9% ROI vs the line, and the "trusted" ones managed
// +13.0%, i.e. nothing. Gating on "test ROI > 0" would therefore light the board up green every time
// favourites run hot, which is precisely the confident-wrong-number failure this project keeps
// hitting. Beating what everyone else got in the SAME fights is the only claim worth acting on.
function gradeAll(predictions, cfg, sourceMeta = {}) {
  const g = cfg.grading || {};
  const halfLife = g.recencyHalfLifeDays || 365;
  const prior = g.shrinkagePriorWeight ?? 10;
  const holdoutDays = g.holdoutTestDays || 120;
  const minTestN = g.minTestForSurvival ?? 8;
  const now = Date.now();
  const cutoffT = now - holdoutDays * DAY;
  const fdate = (p) => Date.parse(p.fightTime || 0) || 0;
  const gradeable = (p) => (p.result === 0 || p.result === 1) && p.priceAtCall > 0 && p.priceAtCall < 1;

  const testAll = dedupePicks(predictions.filter(gradeable)).filter((p) => fdate(p) && fdate(p) >= cutoffT);
  const base = statsFor(testAll, now, halfLife, prior);
  const baselineRoi = base.n ? base.roi : 0;

  const bySource = {};
  for (const p of predictions) (bySource[p.source] = bySource[p.source] || []).push(p);
  const graded = {};
  for (const [src, preds] of Object.entries(bySource)) {
    graded[src] = { source: src, ...(sourceMeta[src] || {}), ...gradeSource(preds, cfg) };
  }

  // CORRECT FOR AUDITIONING 50 CANDIDATES. A 95% one-sided bound lets a source with NO edge clear it
  // 5% of the time; across 50 sources that is ~2.5 false winners every single run. The backfill hit
  // exactly that — 2 sources cleared, precisely the chance count — so an uncorrected bound would
  // permanently crown ~2 lucky nobodies and call them sharp. Šidák-correct the bound by the number
  // of sources actually eligible, so "SURVIVES" means "beat the field by more than luck explains".
  const eligible = Object.values(graded).filter((r) => (r.oos && r.oos.testN || 0) >= minTestN).length;
  const alpha = 1 - Math.pow(0.95, 1 / Math.max(1, eligible)); // per-source alpha for 95% family-wide
  const z = probit(1 - alpha);

  const out = {};
  for (const [src, r] of Object.entries(graded)) {
    const o = r.oos || {};
    // Survives only if, on held-out fights, its family-wise-corrected lower bound still beats the
    // baseline everyone earned there — not merely beats zero, and not merely on an uncorrected bound.
    const adjLcb = o.testRoi != null && o.testSe != null ? +(o.testRoi - z * o.testSe).toFixed(3) : null;
    r.survives = (o.testN || 0) >= minTestN && adjLcb != null && adjLcb > baselineRoi;
    r.oos = { ...o, adjLcb, z: +z.toFixed(2), eligible,
      baselineRoi: +baselineRoi.toFixed(3), baselineN: base.n };
    out[src] = r;
  }
  return out;
}

module.exports = { gradeSource, gradeAll, roiOf };
