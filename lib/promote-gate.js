// PROMOTION GATE — which DISCOVERED (non-roster) channels have earned a permanent spot in sources.json.
// Pure + deterministic so it is unit-testable. The bar is deliberately HIGH: this system has never shown a
// predictive edge, so a channel is "proven" only with a real graded sample AND a positive ROI even at the
// LOWER confidence bound (roiLcb > 0). Most channels have roiLcb < 0 (e.g. a roster fighter at -0.174) and
// are correctly rejected. It promotes on a graded track record, NEVER on how often the coverage search
// found the channel — frequency would just promote amplifiers, the opposite of origins-not-voices.
function selectPromotable(graded, rosterNames, { minN = 10, minRoiLcb = 0 } = {}) {
  const roster = rosterNames instanceof Set ? rosterNames : new Set(rosterNames || []);
  const entries = graded && !Array.isArray(graded) ? Object.values(graded) : (graded || []);
  return entries
    .filter((s) => s && s.platform === "youtube"
      && !roster.has(s.source)                    // already on the roster -> nothing to promote
      && Number(s.n || 0) >= minN                 // enough graded picks to mean anything
      && Number(s.roiLcb) > minRoiLcb)            // positive ROI even at the lower confidence bound
    .map((s) => ({ source: s.source, handle: s.handle || null, type: s.type || "analyst", domain: s.domain || "mma", n: s.n, roi: s.roi, roiLcb: s.roiLcb, hitRate: s.hitRate, survives: !!s.survives }))
    .sort((a, b) => (Number(b.roiLcb) - Number(a.roiLcb)) || String(a.source).localeCompare(String(b.source)));
}

module.exports = { selectPromotable };
