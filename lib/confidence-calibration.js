// CONFIDENCE CALIBRATION — turn a rank-weighted consensus SHARE into an honest win PROBABILITY.
//
// A weighted agreement of 0.83 does NOT mean an 83% chance of winning — expert consensus tracks the
// favourite, and favourites win ~65-70%, not 83%. So we SHRINK the share toward 50%, harder when the
// fight is thinly covered. The shrink strength (`slope`) is fitted to real outcomes when we have enough
// of them (fit()); until then a deliberately CONSERVATIVE default is used and labelled as such, so a
// "%" is never more certain than the evidence earns. We also cap the output: a YouTube consensus never
// asserts near-certainty.
require("./env");
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "..", "data", "confidence-calibration.json");

// Conservative default (NOT fitted). slope 0.65 = consensus is informative but far from gospel.
const DEFAULT = { method: "conservative-default", slope: 0.65, coverageK: 3, cap: 0.85, floor: 0.50,
  fittedFrom: 0, reliability: "provisional — not yet fitted to fight outcomes" };

function params() {
  try { const p = JSON.parse(fs.readFileSync(FILE, "utf8")); return { ...DEFAULT, ...p }; }
  catch { return DEFAULT; }
}

// coverage ramps certainty in: 3 channels -> 0.50, 6 -> 0.67, 12 -> 0.80, 20 -> 0.87.
const coverageFactor = (coverage, K) => coverage / (coverage + K);

// share (>=0.5, for the favoured fighter) + coverage -> calibrated probability in [floor, cap].
function toProbability(share, coverage) {
  const P = params();
  if (share == null) return null;
  const cf = coverageFactor(Math.max(0, coverage || 0), P.coverageK);
  let prob = 0.5 + (share - 0.5) * P.slope * cf;
  if (prob < P.floor) prob = P.floor;
  if (prob > P.cap) prob = P.cap;
  return prob;
}

// Fit the shrink slope to history. samples: [{ share, coverage, won }] where share is the weighted
// share for the fighter the consensus FAVOURED and won is 1/0. Least-squares of (won-0.5) on the
// shrink basis x = (share-0.5)*coverageFactor, i.e. slope = Σ x·(won-0.5) / Σ x². Clamped to [0,1].
// Below MIN_SAMPLES we KEEP the conservative default rather than overfit a handful of fights.
const MIN_SAMPLES = 40;
function fit(samples, { coverageK = DEFAULT.coverageK } = {}) {
  const pts = (samples || []).filter((s) => s && s.share != null && (s.won === 0 || s.won === 1));
  if (pts.length < MIN_SAMPLES) {
    return { ...DEFAULT, fittedFrom: pts.length,
      reliability: `too few graded fights (${pts.length} < ${MIN_SAMPLES}) — keeping the conservative default` };
  }
  let num = 0, den = 0;
  for (const s of pts) {
    const x = (s.share - 0.5) * coverageFactor(s.coverage || 0, coverageK);
    num += x * (s.won - 0.5);
    den += x * x;
  }
  let slope = den > 0 ? num / den : DEFAULT.slope;
  slope = Math.max(0, Math.min(1, +slope.toFixed(3)));
  // Brier of the fitted map vs a coin flip, as a plain reliability read.
  const brier = pts.reduce((a, s) => {
    const p = Math.max(0.5, Math.min(0.85, 0.5 + (s.share - 0.5) * slope * coverageFactor(s.coverage || 0, coverageK)));
    return a + (p - s.won) ** 2;
  }, 0) / pts.length;
  return { method: "fitted-least-squares", slope, coverageK, cap: DEFAULT.cap, floor: DEFAULT.floor,
    fittedFrom: pts.length, brier: +brier.toFixed(4),
    reliability: `fitted to ${pts.length} graded fights (Brier ${brier.toFixed(3)})` };
}

function save(fitted) {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...fitted, fittedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, FILE);
  return fitted;
}

const describe = () => { const p = params(); return { method: p.method, slope: p.slope, cap: p.cap, coverageK: p.coverageK, fittedFrom: p.fittedFrom, reliability: p.reliability }; };

module.exports = { toProbability, fit, save, describe, params, coverageFactor, DEFAULT, MIN_SAMPLES, FILE };
