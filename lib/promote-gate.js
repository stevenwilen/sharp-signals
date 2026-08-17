// PROMOTION GATE — which DISCOVERED (non-roster) channels have earned a permanent spot in sources.json.
// Pure + deterministic so it is unit-testable. The bar is deliberately HIGH: this system has never shown a
// predictive edge, so a channel is "proven" only with a real graded sample AND an edge over the field that
// survives its own LOWER confidence bound (edgeLcb > 0). Today not one graded channel clears that — the
// gate correctly promotes nobody. It promotes on a graded track record, NEVER on how often the coverage
// search found the channel — frequency would just promote amplifiers, the opposite of origins-not-voices.
//
// The metric is edge vs the FIELD (lib/channel-grade.js), not ROI vs the betting line: the line is gone
// with the rest of the market machinery, and ROI's fat tail let one lucky longshot buy a promotion.
function selectPromotable(graded, rosterNames, { minN = 10, minEdgeLcb = 0 } = {}) {
  const roster = rosterNames instanceof Set ? rosterNames : new Set(rosterNames || []);
  const entries = graded && !Array.isArray(graded) ? Object.values(graded) : (graded || []);
  return entries
    .filter((s) => s && s.platform === "youtube"
      && !roster.has(s.source)                    // already on the roster -> nothing to promote
      && Number(s.n || 0) >= minN                 // enough graded picks to mean anything
      && Number(s.edgeLcb) > minEdgeLcb)          // beats the field even at the lower confidence bound
    .map((s) => ({ source: s.source, handle: s.handle || null, type: s.type || "analyst", domain: s.domain || "mma", n: s.n, edge: s.edge, edgeLcb: s.edgeLcb, hitRate: s.hitRate }))
    .sort((a, b) => (Number(b.edgeLcb) - Number(a.edgeLcb)) || String(a.source).localeCompare(String(b.source)));
}

module.exports = { selectPromotable };
