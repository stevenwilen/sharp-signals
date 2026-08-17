// CHANNEL WEIGHTS — turn the graded track record into a per-channel weight for the confidence engine.
//
// The system no longer bets a price; it produces CONFIDENCE from a rank-weighted consensus of the
// roster's picks. This module is the "rank-weighted" part: how much each channel's opinion counts.
//
// HONEST BY CONSTRUCTION. We proved (data/sources_graded.json) that below a small top tier the
// edge signal is mostly noise — 0 of 50 channels survive an out-of-sample test. So the weight is NOT
// a precise talent score; it is a coarse TIER weight (A/B/C/D), shrunk by how much data backs it. A
// thin sample can never earn a high weight, and an unproven channel gets a low prior, not zero — an
// informed voice still counts a little, it just cannot dominate.
require("./env");
const fs = require("fs");
const path = require("path");

const GRADED = path.join(__dirname, "..", "data", "sources_graded.json");
const ROSTER = path.join(__dirname, "..", "sources.json");

// Tier from the graded record: sample gate first (effN >= 40, else we cannot judge at all), then where
// the channel's CONFIDENCE INTERVAL sits relative to the field it is voting alongside.
//
//   A = the whole interval is above the field   (edgeLcb > 0)  — demonstrably adds information
//   B = the interval straddles the field                       — indistinguishable, the honest default
//   C = the whole interval is below the field   (edgeUcb < 0)  — demonstrably subtracts information
//   D = effN < 40, we cannot tell
//
// WHY BOUNDS AND NOT A POINT THRESHOLD. The old rule promoted on a POINT estimate of ROI vs the betting
// line (roi >= 0.08 -> A), and ROI on a small sample is mostly variance: it handed weight 1.0 to six
// channels whose "edge" was a hot streak. Against the field, not one of those six has an interval that
// clears zero. Requiring the whole interval to clear means a tier is earned, not drawn. Today tier A is
// legitimately EMPTY — nobody in the roster has proven they beat the field — and that is the honest
// answer, not a bug to tune around.
function tierOf(g) {
  if (!g || g.effN == null || g.effN < 40) return "D";
  if (g.edgeLcb != null && g.edgeLcb > 0) return "A";
  if (g.edgeUcb != null && g.edgeUcb < 0) return "C";
  return "B";
}

// Tier base weight. A dominates, B counts solidly, C (demonstrably worse than the field it votes
// alongside) is kept low but non-zero, D/ungraded get a small prior. Deliberately coarse — the data
// does not support finer.
const TIER_BASE = { A: 1.0, B: 0.55, C: 0.25, D: 0.2 };
const UNGRADED_WEIGHT = 0.15;   // in the roster, no track record yet — a low prior, never zero

// Confidence factor: a graded channel's weight is pulled toward its tier base only as far as its
// SAMPLE earns. effN 50 -> ~0.9, effN 20 -> ~0.7 (but effN<40 is tier D anyway). Never below 0.5 so a
// real tier-A voice on a modest-but-sufficient sample is not gutted.
const confidenceFactor = (effN) => 0.5 + 0.5 * (effN / (effN + 20));

function loadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }

// name -> { weight, tier, n, effN, edge, hitRate, graded }
// Keyed by the channel's display name, which is exactly what a pick's `source` field carries.
//
// buildFrom() takes the graded record as an ARGUMENT rather than reading the file, so a caller can
// build the weights the engine WOULD have had at some past moment (run-fit-calibration walks each card
// forward using only fights that had already settled). Grading a channel on a fight and then scoring
// its vote on that same fight is in-sample, and in-sample numbers are how this project has repeatedly
// convinced itself of an edge it did not have.
function buildFrom(graded) {
  const roster = (loadJson(ROSTER, { sources: [] }).sources) || [];
  const out = {};

  for (const g of Object.values(graded || {})) {
    const tier = tierOf(g);
    const w = +(TIER_BASE[tier] * confidenceFactor(g.effN || 0)).toFixed(3);
    out[g.source] = { weight: w, tier, n: g.n || 0, effN: +(g.effN || 0).toFixed(1),
      edge: g.edge ?? null, hitRate: g.hitRate ?? null, graded: true };
  }
  // Roster channels with no graded record yet: a low prior so they contribute a little but cannot swing.
  for (const s of roster) {
    if (!out[s.name]) out[s.name] = { weight: UNGRADED_WEIGHT, tier: "UNRANKED", n: 0, effN: 0, edge: null, hitRate: null, graded: false };
  }
  return out;
}

const build = () => buildFrom(loadJson(GRADED, {}));

let _cache = null;
const all = () => (_cache = _cache || build());
// A source not in the roster at all (e.g. a searched channel) still gets the ungraded prior.
const weightFor = (source) => (all()[source] || { weight: UNGRADED_WEIGHT, tier: "UNRANKED", graded: false }).weight;
const tierFor = (source) => (all()[source] || { tier: "UNRANKED" }).tier;
const infoFor = (source) => all()[source] || { weight: UNGRADED_WEIGHT, tier: "UNRANKED", graded: false };
const reload = () => { _cache = null; return all(); };

module.exports = { build, buildFrom, all, weightFor, tierFor, infoFor, reload, tierOf, TIER_BASE, UNGRADED_WEIGHT };
