// FORECAST ENGINE — market prior + traceable, shrunk, mechanism-level adjustments.
//
// PRODUCES: win / method / round probabilities with an explicit uncertainty range.
// NEVER PRODUCES: a bet, a stake, a Kelly fraction, an edge claim, a BUY/SELL, or an alert.
//
// FULLY DETERMINISTIC. No language model touches a number here. The brief permits an LM to SUGGEST
// a magnitude class; the surest way to honour "the LM cannot directly set unrestricted
// probabilities" is to give it no seat at all. Same inputs + same config version -> same forecast,
// byte for byte. Every number traces to config/forecast-rules.json, which was written before any
// outcome was seen.
require("./env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const E = require("./evidence-eval");

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "forecast-rules.json"), "utf8"));

const logit = (p) => Math.log(p / (1 - p));
const sig = (z) => 1 / (1 + Math.exp(-z));
const clamp = (p, lo = 0.01, hi = 0.99) => Math.min(hi, Math.max(lo, p));

// ---- which mechanism does a Phase 6 topic belong to? (requirement 10: cluster, never stack) ----
const TOPIC_TO_MECHANISM = {};
for (const [mech, topics] of Object.entries(RULES.mechanismClusters)) {
  if (mech.startsWith("_")) continue;
  for (const t of topics) TOPIC_TO_MECHANISM[t] = mech;
}
const mechanismOf = (topic) => TOPIC_TO_MECHANISM[topic] || null;

// Read the origin count from the REAL Phase 6 shape, and treat a missing value as DISQUALIFYING.
//
// This function used to read `ev.independentOrigins`, but a Phase 6 topic carries
// `ev.origin.independentOrigins`. The value was therefore `undefined`, and `undefined < 5` is
// FALSE — so every origin threshold silently passed and a ONE-origin claim reached MAJOR, the
// largest adjustment there is. One analyst moved a line 8 points on the sparse card: the precise
// opposite of "sparse evidence produces restrained forecasts".
//
// The unit tests missed it because their fixtures were hand-built in the shape the buggy code
// expected — they validated my mistake rather than the data. Hence: read the real field, and if the
// count cannot be determined, refuse rather than assume. An unknown origin count is not a pass.
function originsOf(ev) {
  const n = ev && ev.origin ? ev.origin.independentOrigins : ev ? ev.independentOrigins : undefined;
  return Number.isFinite(n) ? n : null;
}

// ---- magnitude class from evidence properties. Deterministic; no score, no model. ----
function magnitudeClassFor(ev) {
  // narrative categories get nothing, by rule, today (requirement 6)
  if (RULES.narrativeCategories.blocked.includes(ev.topic)) {
    return { cls: "NONE", reason: `topic "${ev.topic}" is a blocked narrative category — no numerical influence without a verified fact, a stated mechanism, and a pre-existing rule` };
  }
  if (!mechanismOf(ev.topic)) return { cls: "NONE", reason: `topic "${ev.topic}" maps to no fight mechanism — a true claim with no mechanism connecting it to THIS matchup moves nothing` };

  const origins = originsOf(ev);
  if (origins === null) return { cls: "NONE", reason: "independent origin count is unavailable — an unknown count is not a pass" };

  for (const cls of ["MAJOR", "MODERATE", "MINOR"]) {
    const r = RULES.magnitudeRules[cls];
    if (origins < r.minIndependentOrigins) continue;
    if (!r.requiredStrength.includes(ev.strength)) continue;
    if (!(ev.kinds || []).some((k) => r.requiredKinds.includes(k))) continue;
    if (!(ev.relevance || []).some((x) => r.requiredRelevance.includes(x))) continue;
    if ((ev.freshness || []).every((f) => r.forbiddenFreshness.includes(f))) continue;
    return { cls, reason: `${origins} independent origin(s), strength=${ev.strength}, kinds=${(ev.kinds || []).join("/")}, relevance=${(ev.relevance || []).join("/")}` };
  }
  return { cls: "NONE", reason: `fails every magnitude rule (origins=${origins}, strength=${ev.strength})` };
}

// ---- build adjustment objects, one per (fighter, mechanism) ----
// Correlated topics inside one mechanism produce ONE adjustment. Extra support raises the class at
// most one step; it never multiplies. "Poor cardio" + "fades after R1" + "cannot maintain pace" is
// one cardio argument, not three.
function buildAdjustments(boutEval, fighterA, fighterB) {
  const byKey = new Map();
  for (const t of boutEval.topics || []) {
    if (t.direction === "neutral") continue;
    const mech = mechanismOf(t.topic);
    // the fighter this topic HELPS
    const helps = t.direction === "favors_about" ? t.about : (E.norm(t.about) === E.norm(fighterA) ? fighterB : fighterA);
    const key = `${E.norm(helps)}|${mech || t.topic}`;
    if (!byKey.has(key)) byKey.set(key, { helps, mechanism: mech, topics: [] });
    byKey.get(key).topics.push(t);
  }

  const adjustments = [];
  for (const [key, g] of byKey) {
    // the strongest single topic decides the class; the others may lift it ONE step, never stack
    const classes = g.topics.map((t) => ({ t, ...magnitudeClassFor(t) }));
    const ORDER = ["NONE", "MINOR", "MODERATE", "MAJOR"];
    const best = classes.reduce((a, b) => (ORDER.indexOf(b.cls) > ORDER.indexOf(a.cls) ? b : a), classes[0]);
    let cls = best.cls;
    let lifted = null;
    // A lift requires genuinely INDEPENDENT support — distinct origins, not merely several topics.
    // The first version counted topics, so one analyst talking about striking, power and speed
    // "lifted" a 1-origin claim to MAJOR. Correlated topics from one origin are one argument said
    // three ways; they may not promote themselves.
    const supportOrigins = new Set(g.topics.flatMap((t) => (t.origin && t.origin.originIds) || []));
    const supporting = classes.filter((c) => c.cls !== "NONE").length;
    if (cls !== "NONE" && supporting >= 3 && supportOrigins.size >= 3 && ORDER.indexOf(cls) < 3) {
      lifted = `${supporting} supporting topics across ${supportOrigins.size} INDEPENDENT origins lifted ${cls} -> ${ORDER[ORDER.indexOf(cls) + 1]} (one step only; correlated support never multiplies)`;
      cls = ORDER[ORDER.indexOf(cls) + 1];
    }
    const raw = RULES.magnitudeClasses[cls];

    // contradiction inside the same mechanism reduces the magnitude one step (and widens the range
    // later) rather than cancelling to a falsely precise midpoint
    const opposed = (boutEval.contradictions || []).filter((c) => mechanismOf(c.topic) === g.mechanism);
    let applied = raw, capReason = null;
    if (opposed.length && cls !== "NONE") {
      const down = ORDER[Math.max(0, ORDER.indexOf(cls) - 1)];
      applied = RULES.magnitudeClasses[down];
      capReason = `contradicted within the same mechanism (${opposed.length} topic(s)) -> reduced ${cls} to ${down}`;
    }
    if (applied > RULES.caps.singleMechanismLogOdds) {
      applied = RULES.caps.singleMechanismLogOdds;
      capReason = `${capReason ? capReason + "; " : ""}hit singleMechanismLogOdds cap`;
    }

    const originIds = [...new Set(g.topics.flatMap((t) => t.origin.originIds || []))];
    adjustments.push({
      adjustmentId: crypto.createHash("sha1").update(`${boutEval.boutId}|${key}|${RULES.version}`).digest("hex").slice(0, 10),
      boutId: boutEval.boutId,
      fighterFavored: g.helps,
      outcomeAffected: "win",
      mechanism: g.mechanism || "unmapped",
      evidenceTopics: g.topics.map((t) => t.topic),
      supportingEvidenceIds: g.topics.flatMap((t) => t.claims.map((c) => `${c.videoId}#${c.segment.startChar}`)),
      contradictoryEvidenceIds: opposed.flatMap((c) => [c.proposition]),
      informationOriginCount: originIds.length,
      originIds,
      evidenceTypes: [...new Set(g.topics.flatMap((t) => t.kinds))],
      relevance: [...new Set(g.topics.flatMap((t) => t.relevance))],
      freshness: [...new Set(g.topics.flatMap((t) => t.freshness))],
      credibilityComponents: best.t.credibilityComponents,
      marketAwareness: [...new Set(g.topics.map((t) => t.marketAwareness))],
      direction: `favors ${g.helps}`,
      rawMagnitudeClass: best.cls,
      liftedTo: lifted ? cls : null,
      liftReason: lifted,
      shrunkMagnitudeLogOdds: +raw.toFixed(4),
      finalAppliedLogOdds: +applied.toFixed(4),
      capOrReductionReason: capReason,
      magnitudeReason: best.reason,
    });
  }
  return adjustments.filter((a) => a.finalAppliedLogOdds !== 0 || a.rawMagnitudeClass === "NONE");
}

// ---- the coherent outcome tree (requirement 12) ----
// ONE tree. Win probabilities sum to 1; each fighter's KO+sub+dec sums to that fighter's win
// probability; a round's method share can never exceed that method's total.
function buildTree(pA, fighterA, fighterB) {
  const pB = 1 - pA;
  const m = RULES.methodPriors;
  const split = (p) => ({ ko: +(p * m.ko).toFixed(4), submission: +(p * m.submission).toFixed(4), decision: +(p * m.decision).toFixed(4) });
  const a = split(pA), b = split(pB);
  // rounds: finishes are spread across 3 rounds; a decision is terminal at the final round.
  const rounds = (fin) => ({ r1: +(fin * 0.45).toFixed(4), r2: +(fin * 0.32).toFixed(4), r3: +(fin * 0.23).toFixed(4) });
  const tree = {
    [fighterA]: { win: +pA.toFixed(4), byKO: a.ko, bySubmission: a.submission, byDecision: a.decision,
      koByRound: rounds(a.ko), submissionByRound: rounds(a.submission) },
    [fighterB]: { win: +pB.toFixed(4), byKO: b.ko, bySubmission: b.submission, byDecision: b.decision,
      koByRound: rounds(b.ko), submissionByRound: rounds(b.submission) },
  };
  return tree;
}

// Verify coherence rather than assume it. A tree that does not add up is worse than no tree: it
// looks like knowledge.
function verifyTree(tree, fighterA, fighterB) {
  const errs = [];
  const A = tree[fighterA], B = tree[fighterB];
  const near = (x, y, tol = 0.005) => Math.abs(x - y) <= tol;
  if (!near(A.win + B.win, 1)) errs.push(`win probabilities sum to ${(A.win + B.win).toFixed(4)}, not 1`);
  for (const [n, f] of [[fighterA, A], [fighterB, B]]) {
    const sum = f.byKO + f.bySubmission + f.byDecision;
    if (!near(sum, f.win)) errs.push(`${n}: KO+sub+dec = ${sum.toFixed(4)} but win = ${f.win}`);
    const kr = f.koByRound.r1 + f.koByRound.r2 + f.koByRound.r3;
    if (!near(kr, f.byKO)) errs.push(`${n}: KO rounds sum to ${kr.toFixed(4)} but byKO = ${f.byKO}`);
    if (f.koByRound.r1 > f.byKO + 0.005) errs.push(`${n}: round-1 KO exceeds total KO`);
    const sr = f.submissionByRound.r1 + f.submissionByRound.r2 + f.submissionByRound.r3;
    if (!near(sr, f.bySubmission)) errs.push(`${n}: submission rounds sum to ${sr.toFixed(4)} but bySubmission = ${f.bySubmission}`);
  }
  return errs;
}

// ---- uncertainty (requirement 11): contradiction WIDENS, it does not cancel ----
function uncertaintyFor(boutEval, adjustments) {
  const u = RULES.uncertainty;
  let half = u.baseHalfWidthPoints;
  const drivers = [];
  const nContra = (boutEval.contradictions || []).length;
  if (nContra) { half += nContra * u.perContradictionTopicPoints; drivers.push(`${nContra} contradicted topic(s)`); }
  const topics = boutEval.topics || [];
  if (topics.some((t) => t.topic === "injury_health" && t.kinds.some((k) => ["rumor", "secondhand_report"].includes(k))))
    { half += u.wideners.unverifiedCurrentCondition; drivers.push("unverified current-condition report"); }
  if (topics.some((t) => t.topic === "inactivity_layoff")) { half += u.wideners.longLayoff; drivers.push("long layoff"); }
  if (topics.some((t) => t.topic === "short_notice")) { half += u.wideners.shortNotice; drivers.push("short-notice replacement"); }
  if (boutEval.coverage === "INSUFFICIENT EVIDENCE") { half += u.wideners.insufficientEvidence; drivers.push("insufficient evidence"); }
  if (boutEval.channels === 1) { half += u.wideners.singleAnalystOnly; drivers.push("a single analyst is the only source"); }
  if ((boutEval.originBreakdown || {}).analysts <= 2) { half += u.wideners.limitedFootage; drivers.push("very few independent analysts"); }
  half = Math.min(u.maxHalfWidthPoints, half);
  return { halfWidthPoints: +half.toFixed(2), drivers };
}

module.exports = { RULES, mechanismOf, magnitudeClassFor, buildAdjustments, buildTree, verifyTree,
  uncertaintyFor, logit, sig, clamp };
