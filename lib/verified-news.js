// VERIFIED NEWS — the manual bridge from a verification chat back into the pipeline.
//
// The chat is a separate conversation with no access to anything here, so the bridge is a human
// pasting a structured block. That is fine. What is NOT fine is letting the paste assert its own
// weight.
//
// THE ONE RULE: VERIFICATION MAY ADD ORIGINS, IT MAY NOT ASSERT THEM. The magnitude rules key on
// independent origin count — 2 for MINOR, 3 for MODERATE, 5 for MAJOR. So a block that could simply
// declare "origins: 5" would be a machine for manufacturing MAJOR adjustments, and every gate
// downstream becomes decoration. Origins are therefore COUNTED here, from sources that each carry a
// real URL, a real quote and a real date. Type a number and it is ignored.
//
// AND TEN OUTLETS CITING ONE REPORTER IS ONE ORIGIN. This is the same rule the evidence layer
// already applies to YouTube channels, and it is the rule most likely to be quietly violated by a
// verification chat, because a search naturally returns the same story ten times. Each source must
// name WHO ACTUALLY KNEW IT (`origin`), not who published it. MMA Junkie, ESPN and Sherdog all
// citing Helwani are one origin called "helwani", not three.
require("./env");
const crypto = require("crypto");

const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

// A source is only evidence if it can be checked. Every field here exists so a human can go and
// look at the thing themselves.
function validateSource(s, i) {
  const errs = [];
  const where = `source[${i}]`;
  if (!s || typeof s !== "object") return [`${where} is not an object`];
  if (!s.outlet) errs.push(`${where}: no outlet`);
  if (!s.url || !/^https?:\/\//i.test(String(s.url))) errs.push(`${where}: no real URL (got ${JSON.stringify(s.url)})`);
  if (!s.quote || String(s.quote).trim().length < 12) errs.push(`${where}: no quote, or too short to be one`);
  if (!s.publishedAt || !Number.isFinite(Date.parse(s.publishedAt))) errs.push(`${where}: no parsable publishedAt`);
  // `origin` is who KNEW it, not who printed it. Without it we cannot tell amplifiers from origins.
  if (!s.origin) errs.push(`${where}: no origin — name who actually knew this, not who republished it`);
  return errs;
}

// Count ORIGINS, not sources. This is the whole point of the bridge.
function countOrigins(sources) {
  const byOrigin = {};
  for (const s of sources) {
    const k = String(s.origin).trim().toLowerCase();
    (byOrigin[k] = byOrigin[k] || []).push(s.outlet);
  }
  const origins = Object.keys(byOrigin);
  const amplified = Object.entries(byOrigin).filter(([, outs]) => outs.length > 1)
    .map(([o, outs]) => ({ origin: o, outlets: outs, note: `${outs.length} outlets carried this, but they are ONE origin` }));
  return { originIds: origins, count: origins.length, byOrigin, amplified };
}

// Turn a verified block into evidence the normal pipeline can price.
//
// sealTs is required: a source published AFTER the forecast seal is information from the future, and
// the same rule that governs transcripts governs this.
function toEvidence(block, sealTs, opts = {}) {
  const errs = [];
  if (!block || typeof block !== "object") return { ok: false, errors: ["not an object"] };
  for (const f of ["boutId", "about", "claim", "topic", "verdict"]) if (!block[f]) errs.push(`missing ${f}`);
  if (!Array.isArray(block.sources) || !block.sources.length) errs.push("no sources — a verification with no sources is not a verification");
  if (!Number.isFinite(sealTs)) errs.push("no seal timestamp to check sources against");
  if (errs.length) return { ok: false, errors: errs };

  const VERDICTS = ["CONFIRMED", "LIKELY TRUE", "CONTRADICTED", "STALE", "UNVERIFIABLE"];
  if (!VERDICTS.includes(block.verdict)) errs.push(`verdict "${block.verdict}" is not one of ${VERDICTS.join(", ")}`);
  // Only these two carry evidence. The others are useful to a human and worth nothing to the engine.
  if (["CONTRADICTED", "STALE", "UNVERIFIABLE"].includes(block.verdict))
    return { ok: true, admissible: false, verdict: block.verdict,
      reason: `verdict ${block.verdict} carries no evidence for the forecast — it is information for you, not an input`, origins: 0 };

  for (let i = 0; i < block.sources.length; i++) errs.push(...validateSource(block.sources[i], i));
  if (errs.length) return { ok: false, errors: errs };

  // leakage: every source must predate the seal
  const future = block.sources.filter((s) => Date.parse(s.publishedAt) >= sealTs);
  if (future.length)
    return { ok: false, errors: future.map((s) => `${s.outlet} published ${s.publishedAt}, at or after the seal — a source from the future is not evidence`) };

  const o = countOrigins(block.sources);
  // A declared origin count is ignored, loudly, so nobody thinks it did something.
  const declared = block.origins ?? block.originCount ?? null;
  const notes = [];
  if (declared != null && Number(declared) !== o.count)
    notes.push(`the block declared ${declared} origins; that field is IGNORED. Counted ${o.count} from the sources actually supplied.`);
  for (const a of o.amplified) notes.push(a.note + `: ${a.outlets.join(", ")} -> "${a.origin}"`);

  const claim = {
    claim: block.claim, about: block.about,
    opponent: block.opponent || null,
    direction: block.direction || "against_about",
    evidenceType: block.topic,
    claimClass: "verified_hard_fact",
    // provenance says plainly that a human typed this
    channel: `HUMAN-VERIFIED (${o.count} independent origin${o.count === 1 ? "" : "s"})`,
    humanSupplied: true,
    verifiedBy: opts.verifiedBy || "verification chat, pasted by the operator",
    verdict: block.verdict,
    sources: block.sources.map((s) => ({ outlet: s.outlet, origin: s.origin, url: s.url, quote: s.quote, publishedAt: s.publishedAt })),
    origin: { independentOrigins: o.count, originIds: o.originIds },
    publishedAt: block.sources.map((s) => s.publishedAt).sort()[0],
  };
  claim.contentHash = sha(claim);

  return {
    ok: true, admissible: true, verdict: block.verdict,
    boutId: block.boutId,
    origins: o.count, originIds: o.originIds, amplified: o.amplified,
    claim, notes,
    // what the count means, stated here so the caller does not have to know the rules
    wouldClear: o.count >= 5 ? "MAJOR (5+ origins)" : o.count >= 3 ? "MODERATE (3+ origins)"
      : o.count >= 2 ? "MINOR (2+ origins)" : "NOTHING — a single origin cannot clear even MINOR, so this moves the forecast by zero",
  };
}

module.exports = { toEvidence, countOrigins, validateSource, sha };
