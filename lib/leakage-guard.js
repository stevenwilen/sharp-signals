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
  const at = Date.parse(baseline.timestamp || "");
  if (!isFinite(at)) throw new LeakageError("market baseline has no timestamp — cannot prove it predates the forecast");
  if (at >= sealTs) throw new LeakageError(`market baseline was quoted AFTER the seal — this is a closing price the forecaster must not see`, { at: baseline.timestamp, seal: new Date(sealTs).toISOString() });
  for (const f of OUTCOME_FIELDS) if (baseline[f] != null) throw new LeakageError(`market baseline carries "${f}"`, { field: f });
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
