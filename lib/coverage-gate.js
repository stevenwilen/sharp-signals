// COVERAGE GATE — decides which bouts on a card are UNDER-COVERED enough to justify spending a
// (100-unit) YouTube search. Pure + deterministic so it is unit-testable in isolation.
//
// A bout is under-covered when its evidence-eval independentOrigins is BELOW minOrigins. Default 3 aligns
// with lib/bout-evidence.js: >= 3 origins is PARTIALLY/WELL covered; below 3 is THINLY COVERED /
// INSUFFICIENT EVIDENCE. WELL-covered bouts are deliberately SKIPPED so the search never piles amplifiers
// onto a fight the roster already covers — the origins-not-voices rule. Candidates are ordered neediest
// (fewest origins) first and capped at maxBouts so, when the per-run quota cap binds, the bouts that most
// need coverage win.
//
// This gate ONLY decides where to LOOK. It never asserts an origin: whether a searched video actually
// raises independentOrigins is decided solely by the frozen originAnalysis on the re-evaluation.
function selectUnderCovered(bouts, { minOrigins = 3, maxBouts = 4 } = {}) {
  if (!Array.isArray(bouts)) return [];
  return bouts
    .filter((b) => b && Number(b.independentOrigins || 0) < minOrigins)
    // neediest first; stable tiebreak on boutId so the selection is deterministic run to run
    .sort((a, b) => (Number(a.independentOrigins || 0) - Number(b.independentOrigins || 0))
      || String(a.boutId || "").localeCompare(String(b.boutId || "")))
    .slice(0, Math.max(0, maxBouts));
}

module.exports = { selectUnderCovered };
