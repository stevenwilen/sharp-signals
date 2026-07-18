// ADMISSION — the boundary between "every claim we collected" and "the claims the forecaster is
// allowed to see". Nothing crosses it without proving it predates the seal.
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE RUNNER.
//
// The gate it replaces was decorative in four separate ways at once, and every one of them looked
// like working code:
//
//   1. run-forecast.js filtered `claims.filter(c => c.publishedAt)` — but lib/bout-evidence.js never
//      emitted publishedAt, so the filter emptied the array, admissibleClaims() was handed [], and
//      `leakageRejected` was structurally 0 on every bout ever forecast. The number 0 was reported as
//      a measurement. It was an artifact of the field being absent.
//   2. `adm.admitted` was computed and NEVER READ. The next line forecast from the raw evidence. A
//      claim detected as post-seal was counted in a rejection tally and then used anyway.
//   3. The runner substituted `be.topics[0].claims[0].publishedAt` for any claim missing one — a
//      fabricated timestamp attributed to a different claim, the same family as the `sealTs - 2h` bug
//      that voided this project's only positive evaluation. It was harmless ONLY because the borrowed
//      value was also undefined. Plumbing publishedAt through would have ACTIVATED it.
//   4. Filtering claims post-hoc would still have leaked, because a topic's `independentOrigins` was
//      computed over ALL its claims. Drop the claim, keep the origin, and the leak still moves the
//      number — through the very count the magnitude rules key on.
//
// So admission does not filter a list. It rebuilds the evidence from the surviving claims, which is
// the only way the origin count can honestly reflect what was admitted.
require("./env");
const L = require("./leakage-guard");
const BE = require("./bout-evidence");

// A claim the forecaster may see must be a claim we can CHECK. These are the fields the admission
// decision itself depends on; absence of any of them is a refusal, never a skip.
const REQUIRED = ["claim", "publishedAt"];

class AdmissionError extends Error {
  constructor(msg, detail) { super(msg); this.admission = true; this.detail = detail; }
}

// Rebuild the flat claim list from an evaluated bout. The evaluator groups claims into topics and
// projects them; this reverses the projection so the claims can be re-checked and re-evaluated.
// Topic-level `about`/`direction` are authoritative — a claim is only in this topic because it had
// them — so they are restored from the topic when the projection predates the round-trip fields.
function claimsOf(be) {
  const out = [];
  for (const t of be.topics || []) {
    for (const c of t.claims || []) {
      out.push({
        ...c,
        about: c.about ?? t.about,
        direction: c.direction ?? t.direction,
        boutId: c.boutId ?? be.boutId,
      });
    }
  }
  return out;
}

// The admission decision for ONE claim. Returns {ok, why}. Never throws on a leak — leaks are data,
// and the caller must be able to record every one of them.
function admitClaim(claim, sealTs) {
  for (const f of REQUIRED) {
    const v = claim[f];
    if (v === undefined || v === null || v === "") {
      return { ok: false, why: `claim is missing "${f}" — a claim that cannot be checked cannot be admitted`, kind: "malformed" };
    }
  }
  if (typeof claim.publishedAt !== "string" || !Number.isFinite(Date.parse(claim.publishedAt))) {
    return { ok: false, why: `claim has an unreadable publishedAt (${JSON.stringify(claim.publishedAt)}) — refusing rather than reasoning about a timestamp we cannot parse`, kind: "malformed" };
  }
  try { L.checkClaim(claim, sealTs); return { ok: true }; }
  catch (e) {
    if (!e.leakage) throw e;
    return { ok: false, why: e.message, kind: "leakage", detail: e.detail };
  }
}

// THE BOUNDARY. Takes an evaluated bout and returns a bout evaluated ONLY from admitted claims.
//
// `bout` is the card's bout record (needed by evaluateBout for names/ids). `be` is the Phase 6
// evaluation. `sealTs` is the moment the forecast is sealed.
//
// Returns { be, admitted, rejected, allRejected } where `be` is a FRESH evaluation — topics,
// origins, coverage, contradictions all recomputed from the admitted claims. If everything is
// rejected, `be` is an INSUFFICIENT EVIDENCE evaluation, which is the truthful description of a bout
// whose entire evidential basis failed the boundary.
function admissibleEvidence(bout, be, sealTs) {
  if (!Number.isFinite(sealTs)) throw new AdmissionError("admission requires a real seal timestamp");
  if (!be) throw new AdmissionError("admission was handed no evidence to admit");
  if (!bout || !bout.boutId) throw new AdmissionError("admission requires the bout record to re-evaluate against");

  const claims = claimsOf(be);
  const admitted = [], rejected = [];
  for (const c of claims) {
    const v = admitClaim(c, sealTs);
    if (v.ok) admitted.push(c);
    else rejected.push({ claim: c.claim, channel: c.channel, publishedAt: c.publishedAt ?? null, why: v.why, kind: v.kind });
  }

  // Re-evaluate. Not filter — re-evaluate. topicsFor() recomputes origin identities from the claims
  // it is given (lib/bout-evidence.js:23), so an admitted-only evaluation is the only one whose
  // independentOrigins describes evidence the forecaster is actually allowed to use.
  const fresh = admitted.length
    ? BE.evaluateBout(bout, admitted)
    : BE.evaluateBout(bout, []);   // -> INSUFFICIENT EVIDENCE, with its own honest reason

  return {
    be: fresh,
    admitted,
    rejected,
    allRejected: claims.length > 0 && admitted.length === 0,
    considered: claims.length,
  };
}

// A record for the sealed artifact. The forecast must be able to say what it refused and why —
// a rejection nobody can read is indistinguishable from a claim that never existed.
function admissionRecord(r) {
  return {
    claimsConsidered: r.considered,
    claimsAdmitted: r.admitted.length,
    claimsRejected: r.rejected.length,
    rejectedForLeakage: r.rejected.filter((x) => x.kind === "leakage").length,
    rejectedAsMalformed: r.rejected.filter((x) => x.kind === "malformed").length,
    rejections: r.rejected.map((x) => ({ why: x.why, channel: x.channel ?? null, publishedAt: x.publishedAt })),
    allRejected: r.allRejected,
  };
}

module.exports = { admissibleEvidence, admitClaim, claimsOf, admissionRecord, AdmissionError, REQUIRED };
