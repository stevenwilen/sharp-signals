// PRE-RENDER INVARIANTS — the last gate before a betting instruction leaves for Telegram.
//
// This exists because a contradictory alert shipped: a BUY for Dricus Du Plessis at a current ask of
// 67.0¢ with a MAXIMUM acceptable price of 61.7¢ (67 > 61.7 — you were told to buy above the price the
// system itself said was the ceiling), and a probability range of 27.3–38.3% that belonged to the
// OTHER fighter (Usman), not Du Plessis. Neither can happen again: a recommendation whose fields
// contradict one another is never rendered as a BUY. It is downgraded to a PRICE-TOO-HIGH notice, or
// it fails closed to HUMAN REVIEW — but it is never a betting instruction.
//
// The check REPRODUCES the load-bearing fields from first principles and compares them. It does not
// trust that the caller assembled them consistently.
require("./env");

const EPS = 0.005;   // half a cent / half a point of numerical slack

// Reproduce and validate one recommendation. Returns:
//   { verdict: "BUY" | "PRICE_TOO_HIGH" | "FAIL_CLOSED", violations: [...], fields: {...} }
//
// verdict meanings:
//   BUY            every invariant holds AND the current ask is at or below the maximum acceptable price
//   PRICE_TOO_HIGH every invariant holds EXCEPT the ask is above the maximum — a real position priced
//                  out right now; tell the human to wait, never to buy
//   FAIL_CLOSED    the fields contradict one another (wrong side, inconsistent EV, range off the
//                  recommended fighter) — do not send a betting instruction at all
function evaluateRecommendation(r) {
  const {
    recommendedSide, fighterA, fighterB,
    centralProb, rangeLow, rangeHigh,
    ask, allInPrice, maximumAcceptablePrice,
    centralEV, conservativeEV,
  } = r;
  const violations = [];
  const num = (x) => typeof x === "number" && Number.isFinite(x);

  // Every field must be present and a real number — a missing field is a refusal, not a default.
  for (const [name, v] of Object.entries({ centralProb, rangeLow, rangeHigh, ask, maximumAcceptablePrice, centralEV, conservativeEV })) {
    if (!num(v)) violations.push(`${name} is missing or not a number (${JSON.stringify(v)})`);
  }
  if (!recommendedSide) violations.push("no recommended side named");

  if (violations.length) {
    return { verdict: "FAIL_CLOSED", violations, fields: reproduce(r) };
  }

  // (2) The probability range must refer to the RECOMMENDED side. If the central probability does not
  //     sit inside the displayed range, the range is for the wrong fighter (the Du Plessis bug: central
  //     0.67 shown against a 0.273–0.383 range).
  if (rangeLow > rangeHigh + EPS) violations.push(`range is inverted (${rangeLow} > ${rangeHigh})`);
  if (centralProb < rangeLow - EPS || centralProb > rangeHigh + EPS) {
    violations.push(`central probability ${(centralProb * 100).toFixed(1)}% is outside its own range ${(rangeLow * 100).toFixed(1)}–${(rangeHigh * 100).toFixed(1)}% — the range likely belongs to the opposite fighter`);
  }

  // (3) For a YES recommendation, the central probability must exceed the fee-adjusted break-even
  //     (the all-in price). Below break-even there is no positive-central position to recommend.
  const breakEven = num(allInPrice) ? allInPrice : maximumAcceptablePrice;
  if (centralProb <= breakEven + 1e-9) {
    violations.push(`central probability ${(centralProb * 100).toFixed(1)}% does not exceed the fee-adjusted break-even ${(breakEven * 100).toFixed(1)}%`);
  }

  // (3b) EV must be consistent with (probability − price). A displayed EV that does not follow from the
  //      displayed prob and price means the numbers came from different places.
  const impliedCentralEV = centralProb - (num(allInPrice) ? allInPrice : ask);
  if (Math.abs(impliedCentralEV - centralEV) > 0.03) {
    violations.push(`central EV ${centralEV.toFixed(4)} is inconsistent with (central prob − price) ≈ ${impliedCentralEV.toFixed(4)}`);
  }
  // Conservative EV must not exceed central EV (the conservative bound is, by definition, worse).
  if (conservativeEV > centralEV + EPS) {
    violations.push(`conservative EV ${conservativeEV.toFixed(4)} exceeds central EV ${centralEV.toFixed(4)} — the bounds are swapped`);
  }
  // The max acceptable price must be a price a YES can pay to still be worth it: below the central prob.
  if (maximumAcceptablePrice > centralProb + EPS) {
    violations.push(`maximum acceptable price ${(maximumAcceptablePrice * 100).toFixed(1)}¢ exceeds the central probability ${(centralProb * 100).toFixed(1)}% — a max above fair value is not a limit`);
  }

  const fields = reproduce(r);
  if (violations.length) return { verdict: "FAIL_CLOSED", violations, fields };

  // (1) THE PRICE GATE. A BUY may render ONLY when the current ask is at or below the maximum acceptable
  //     price. Otherwise it is a real position that is simply too expensive right now.
  if (ask > maximumAcceptablePrice + 1e-9) {
    return { verdict: "PRICE_TOO_HIGH", violations: [], fields };
  }
  return { verdict: "BUY", violations: [], fields };
}

// The reproduced fields, for the record and for a fail-closed report — so a refusal can always say
// exactly which numbers disagreed.
function reproduce(r) {
  return {
    recommendedSide: r.recommendedSide || null,
    systemCentralProbability: r.centralProb ?? null,
    probabilityRange: (r.rangeLow != null && r.rangeHigh != null) ? [r.rangeLow, r.rangeHigh] : null,
    currentAsk: r.ask ?? null,
    maximumAcceptablePrice: r.maximumAcceptablePrice ?? null,
    centralEV: r.centralEV ?? null,
    conservativeEV: r.conservativeEV ?? null,
  };
}

module.exports = { evaluateRecommendation, reproduce, EPS };
