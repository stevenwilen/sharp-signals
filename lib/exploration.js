// EXPLORATION LANE — the creative speculative layer. It reads the SAME admitted evidence the core
// forecast uses (so no leaked, malformed, or mis-identified claim can enter it — the admission
// boundary already ran), generates explicit creative hypotheses, and produces a CAPPED, SEPARATELY
// STORED creative adjustment. Unlike core, it lets ONE credible origin move the number — but never far.
//
// WHAT MAKES THIS SAFE TO LOOSEN:
//   - It runs on `adm.be` (admitted evidence), so leakage / identity / malformed-timestamp protection
//     is inherited, not re-implemented and not weakened.
//   - It counts origins with the same function as core (lib/evidence-eval originAnalysis), so five
//     channels repeating one rumour are ONE origin with five amplifiers — the loosening is the origin
//     THRESHOLD (1 instead of 2), never the origin COUNT.
//   - Every adjustment is capped by config/exploration-rules.json — the lane's OWN numbers, so the
//     frozen v7.0.0 constants are never touched or tuned.
//   - It stores the market prior, core adjustment, and creative adjustment SEPARATELY, so a reader
//     always sees where a number came from.
require("./env");
const fs = require("fs");
const path = require("path");

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "exploration-rules.json"), "utf8"));

const logit = (p) => Math.log(p / (1 - p));
const sig = (x) => 1 / (1 + Math.exp(-x));
const clamp = (p) => Math.min(0.999, Math.max(0.001, p));

// The lane is enabled by the env switch OR the config default. Off by default.
function enabled() {
  return process.env.EXPLORATION_ENABLED === "1" || RULES.enabledByDefault === true;
}

// Map an evidence topic's kinds to a verification status label (from the directive's allowed set).
function verificationStatus(topic) {
  const kinds = topic.kinds || [];
  const has = (k) => kinds.includes(k);
  if (has("verified_hard_fact")) return "VERIFIED";
  if (has("rumor")) return "UNVERIFIED BUT PLAUSIBLE";
  if (has("secondhand_report") || has("current_condition_report")) return topic.origin.independentOrigins >= 2 ? "LIKELY TRUE" : "POSSIBLY TRUE";
  if (has("firsthand_statement")) return "LIKELY TRUE";
  if (has("film_study_observation") || has("matchup_inference")) return "MECHANISTICALLY RELEVANT";
  if (has("psychological_interpretation")) return "WEAKLY SUPPORTED";
  return "UNSUPPORTED NARRATIVE";
}

// The base magnitude bucket for a topic, before discounts.
function strengthBucket(topic) {
  const kinds = topic.kinds || [];
  if (kinds.every((k) => k === "unsupported_narrative")) return "unsupported_narrative";
  const origins = topic.origin.independentOrigins;
  const strong = topic.strength === "strong" || topic.strength === "moderate";
  if (origins >= 2 && strong) return "strong_multi_signal";
  // A single credible origin (a real report or an independent observation) is allowed to matter.
  const credibleKind = kinds.some((k) => ["rumor", "secondhand_report", "current_condition_report", "firsthand_statement", "film_study_observation", "matchup_inference"].includes(k));
  if (origins >= 1 && credibleKind) return "credible_single_origin";
  if (origins >= 1) return "suggestive";
  return "unsupported_narrative";
}

const isNovel = (topic) => ["newly_emerging", "niche_analytical_interpretation"].includes(topic.marketAwareness);
const isProbablyPriced = (topic) => topic.marketAwareness === "widely_public_probably_in_the_market";

// Provisional per-mechanism reliability (shrunk, from post-fight grading). Blends in at a fraction —
// it nudges the magnitude, never decides it, and is neutral (0) when we have no history.
function reliabilityFor(mechanism, reliabilityRecords) {
  const rec = (reliabilityRecords || []).find((r) => r.mechanism === mechanism);
  return rec ? (rec.provisionalMeanImprovement || 0) : 0;
}

// Build ONE hypothesis from a creative-eligible topic. Returns the full record the directive requires,
// or null if the topic is not creative-eligible.
function hypothesisFromTopic(topic, contradictions, reliabilityRecords) {
  if (!RULES.creativeEligibleTopics.includes(topic.topic)) return null;
  const bucket = strengthBucket(topic);
  const base = RULES.magnitudeByStrength[bucket] || 0;

  // Contradiction against this exact (fighter, topic)?
  const contra = (contradictions || []).find((c) => c.proposition && c.proposition.includes(topic.about) && c.proposition.includes(topic.topic));
  const fatallyContradicted = !!(contra && contra.disagreementType === "factual_disagreement");

  const priced = isProbablyPriced(topic);
  const rel = reliabilityFor(topic.topic, reliabilityRecords);

  // Magnitude: base, discounted for priced / contradiction, nudged by provisional reliability, capped.
  let mag = base;
  if (priced) mag *= RULES.discounts.probablyPricedMultiplier;
  if (fatallyContradicted) mag *= RULES.discounts.contradictedMultiplier;
  // Reliability blend: shift the magnitude by a fraction of the mechanism's shrunk historical
  // improvement, but only in the direction that keeps it small and never flips its sign.
  mag = mag * (1 + RULES.discounts.reliabilityBlend * Math.max(-0.5, Math.min(0.5, rel)));
  mag = Math.max(0, Math.min(RULES.caps.perHypothesisLogOdds, mag));

  // The adjustment favours a fighter. against_about lowers the SUBJECT's win prob; favors_about raises it.
  const towardSubject = topic.direction === "favors_about";
  const claim = (topic.claims && topic.claims[0]) || {};

  return {
    hypothesis: `${topic.about} — ${topic.topic}: ${claim.claim || topic.topic} (${topic.direction})`,
    fighter: topic.about,
    boutTopic: topic.topic,
    supportingFacts: (topic.claims || []).slice(0, 2).map((c) => c.quote || c.claim).filter(Boolean),
    supportingInferences: bucket === "strong_multi_signal" || bucket === "credible_single_origin" ? [`${topic.origin.independentOrigins} independent origin(s), ${topic.origin.amplifyingChannels} channel(s)`] : [],
    verificationStatus: verificationStatus(topic),
    causalMechanism: `${topic.topic} → ${topic.direction === "favors_about" ? "helps" : "hurts"} ${topic.about}`,
    outcomeAffected: "fighter win probability",
    originInformation: {
      independentOrigins: topic.origin.independentOrigins,   // SAME count as core — 5 channels = 1 origin
      amplifyingChannels: topic.origin.amplifyingChannels,
      composition: topic.origin.composition || null,
      citedOrigins: topic.origin.citedOrigins || [],
    },
    evidenceAgainst: contra ? `${contra.disagreementType}: ${contra.detail || contra.proposition}` : "none recorded",
    alternativeExplanation: priced ? "the market has likely already priced this" : "the signal may be noise or already reflected in the line",
    novelty: isNovel(topic) ? "NOVEL" : "not novel",
    probablyPriced: priced,
    falsificationCondition: `${topic.about} shows no ${topic.topic} effect at the weigh-in / in-fight, or a credible source disconfirms it before first bell`,
    directionTowardSubject: towardSubject,
    adjustmentLogOdds: +mag.toFixed(4),
    magnitudeBucket: bucket,
    fatallyContradicted,
    version: RULES.version,
    timestamp: new Date().toISOString(),
    label: "EXPLORATION — creative speculative hypothesis, capped, prospectively graded, unproven",
  };
}

// The creative adjustment for one bout. Sums the per-hypothesis adjustments (as signed log-odds toward
// fighter A), caps the total, and returns the breakdown. `A` is the bout's fighter A (the fighter the
// core probability systemCentral[A] is expressed for).
function creativeAdjustment(admBoutEval, A, B, opts = {}) {
  const reliabilityRecords = opts.reliabilityRecords || [];
  const topics = (admBoutEval && admBoutEval.topics) || [];
  const contradictions = (admBoutEval && admBoutEval.contradictions) || [];

  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const hypotheses = [];
  let netTowardA = 0;
  for (const t of topics) {
    const h = hypothesisFromTopic(t, contradictions, reliabilityRecords);
    if (!h || h.adjustmentLogOdds === 0) { if (h) hypotheses.push(h); continue; }
    // Which fighter does this help? favors_about helps the subject; against_about helps the opponent.
    const subjectIsA = norm(h.fighter) === norm(A);
    const helpsA = h.directionTowardSubject ? subjectIsA : !subjectIsA;
    netTowardA += helpsA ? h.adjustmentLogOdds : -h.adjustmentLogOdds;
    hypotheses.push(h);
  }

  const cap = RULES.caps.perBoutLogOdds;
  let capped = false;
  if (Math.abs(netTowardA) > cap) { netTowardA = Math.sign(netTowardA) * cap; capped = true; }

  return {
    version: RULES.version,
    hypotheses,
    activeHypotheses: hypotheses.filter((h) => h.adjustmentLogOdds > 0).length,
    creativeLogOddsTowardA: +netTowardA.toFixed(4),
    capped,
    cap,
  };
}

// Apply a creative adjustment to a core probability, capped by the max points move. Returns the
// creative central probability for fighter A, kept SEPARATE from the core systemCentral.
function creativeCentral(coreProbA, creativeLogOddsTowardA) {
  const raw = sig(logit(clamp(coreProbA)) + creativeLogOddsTowardA);
  const maxMove = RULES.caps.maxProbabilityMovePoints / 100;
  let p = raw;
  if (Math.abs(p - coreProbA) > maxMove) p = coreProbA + Math.sign(p - coreProbA) * maxMove;
  return +clamp(p).toFixed(4);
}

// (removed: classifyAndSize + applyExposureCaps — the $3/$4/$5 entertainment stakes and the per-fight /
//  per-card dollar exposure caps, plus the bankroll `scale`. The operator sizes their own bets now; the
//  forecast only ever consumed creativeAdjustment/creativeCentral from this file. The read-synthesis
//  above is untouched — that is what feeds the forecast's creative read.)

module.exports = { enabled, creativeAdjustment, creativeCentral, hypothesisFromTopic, verificationStatus, strengthBucket, RULES };
