// LEAKAGE GUARD — nothing the future knows may reach a forecast.
//
// This project has already been fooled by hindsight twice, and both times it looked like insight:
//   - 1,145 post-fight "predictions" (9.1% of the corpus) manufactured a +52% ROI on
//     high-conviction underdogs that vanished the moment the rows were dated;
//   - a memo keyed on the YEAR let one pundit's January call legitimise another's November
//     "call" of a fight that had already happened.
// Both were invisible from the outside: the numbers simply looked good. So this layer does not
// trust discipline, it enforces a boundary — every input is checked against the forecast timestamp
// before the forecaster may see it, and anything that cannot be proven to predate first bell is
// REJECTED rather than quietly used.
require("./env");

// Field names that can only exist after a fight is over. Presence of any of these on an input is
// disqualifying regardless of value: a `result` field of 0 still proves the source knows.
const OUTCOME_FIELDS = ["result", "winner", "won", "loser", "method", "finishRound", "finishTime",
  "settlement", "settlementValue", "settled_result", "outcome", "scorecards", "decision"];

// Phrases that only appear in retrospect.
const RETRO = /\b(last night|post[- ]fight|after the fight|the winner was|won by (ko|tko|submission|decision)|defeated|knocked (him )?out in|recap|results? show|as it turned out|in hindsight|ended up (winning|losing))\b/i;

class LeakageError extends Error {
  constructor(msg, detail) { super(msg); this.leakage = true; this.detail = detail; }
}

// A claim/quote may be used only if it was SPOKEN before the seal.
function checkClaim(claim, sealTs) {
  const said = Date.parse(claim.publishedAt || claim.timestamp || "");
  if (!isFinite(said)) throw new LeakageError(`claim has no usable timestamp — cannot prove it predates the forecast`, { claim: claim.claim });
  if (said >= sealTs) throw new LeakageError(`claim was published AFTER the forecast seal`, { said: new Date(said).toISOString(), seal: new Date(sealTs).toISOString(), claim: claim.claim });
  for (const f of OUTCOME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(claim, f) && claim[f] !== null && claim[f] !== undefined) {
      throw new LeakageError(`claim carries the outcome field "${f}" — the source knows how the fight ended`, { field: f, value: claim[f] });
    }
  }
  const t = `${claim.claim || ""} ${claim.quote || ""}`;
  const m = t.match(RETRO);
  if (m) throw new LeakageError(`claim uses retrospective language ("${m[0]}") — it describes a fight that already happened`, { phrase: m[0], claim: claim.claim });
  return true;
}

// A market snapshot may be used only if it was quoted before the seal.
function checkBaseline(baseline, sealTs) {
  if (!baseline || baseline.probability == null) throw new LeakageError("no market baseline supplied");
  for (const f of OUTCOME_FIELDS) if (baseline[f] != null) throw new LeakageError(`market baseline carries "${f}"`, { field: f });

  // A price may prove it predates the forecast in one of two ways, and ONLY these two.
  //
  // 1. LOGICAL_OPEN — an opening line. It carries no wall-clock timestamp because BFO does not
  //    publish when a line opened, and an opening line is by construction the market's FIRST price
  //    for a fight that has not happened yet. Its precedence is structural, not temporal.
  //
  //    This exception is deliberately narrow, because it is exactly the shape of the hole that
  //    caused the original leak: the superseded code fabricated `sealTs - 2h` on a CLOSING line so
  //    it would slip past the check below. To use this path a baseline must declare the basis, name
  //    the opening line as its origin, and carry NO wall-clock price timestamps at all — if it has
  //    a real clock reading anywhere, it is checked as a timestamped price instead. A record cannot
  //    opt out of the timestamp rule merely by asserting a label.
  //
  // 2. WALL_CLOCK — a real observation timestamp, strictly before the seal.
  if (baseline.clockBasis === "LOGICAL_OPEN") {
    if (baseline.derivedFrom !== "opening line")
      throw new LeakageError("baseline claims LOGICAL_OPEN but does not declare the opening line as its origin");
    const stamped = (baseline.priceTimestamps || []).filter((t) => t && t.observedAt != null);
    if (stamped.length)
      throw new LeakageError("baseline claims LOGICAL_OPEN but carries wall-clock price timestamps — it must be checked as a timestamped price, not waved through",
        { stamped: stamped.map((t) => t.observedAt) });
    if (baseline.timestamp != null && Date.parse(baseline.timestamp) >= sealTs)
      throw new LeakageError("baseline claims LOGICAL_OPEN but its own timestamp is at or after the seal", { at: baseline.timestamp });
    return true;
  }

  const at = Date.parse(baseline.timestamp || "");
  if (!isFinite(at)) throw new LeakageError("market baseline has no timestamp — cannot prove it predates the forecast");
  if (at >= sealTs) throw new LeakageError(`market baseline was quoted AFTER the seal — this is a closing price the forecaster must not see`, { at: baseline.timestamp, seal: new Date(sealTs).toISOString() });
  return true;
}

// Filter a claim set to what was legitimately knowable, and REPORT what was dropped. Silent
// filtering would be its own hazard: "we used 900 claims" reads very differently from "we used 900
// and refused 98 that knew the answer".
function admissibleClaims(claims, sealTs) {
  const admitted = [], rejected = [];
  for (const c of claims) {
    try { checkClaim(c, sealTs); admitted.push(c); }
    catch (e) { if (e.leakage) rejected.push({ claim: c.claim, why: e.message, detail: e.detail }); else throw e; }
  }
  return { admitted, rejected };
}

// A whole-object sweep, for inputs that are not claims (fighter records, card files, caches).
// Deliberately paranoid: it walks the structure rather than trusting a top-level shape.
function assertNoOutcomeFields(obj, label, seen = new Set(), depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6 || seen.has(obj)) return true;
  seen.add(obj);
  if (Array.isArray(obj)) { for (const x of obj.slice(0, 500)) assertNoOutcomeFields(x, label, seen, depth + 1); return true; }
  for (const k of Object.keys(obj)) {
    if (OUTCOME_FIELDS.includes(k) && obj[k] !== null && obj[k] !== undefined)
      throw new LeakageError(`${label} contains the outcome field "${k}" — refusing to load it into a forecast`, { field: k, value: obj[k] });
    assertNoOutcomeFields(obj[k], label, seen, depth + 1);
  }
  return true;
}

module.exports = { checkClaim, checkBaseline, admissibleClaims, assertNoOutcomeFields,
  LeakageError, OUTCOME_FIELDS, RETRO };
