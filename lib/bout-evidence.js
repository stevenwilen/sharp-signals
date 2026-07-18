// PER-BOUT EVIDENCE SUMMARY — organize, downgrade, and be honest about the gaps.
//
// It never erases the source record: every evaluated topic carries its underlying claims, and every
// claim keeps its quote, segment and channel. This layer may DOWNGRADE evidence; it may never
// delete it, and it may never invent a balanced narrative to make a bout look covered.
//
// It produces no probability, no method call, no edge, no stake, no ranking, no recommendation.
require("./env");
const E = require("./evidence-eval");

const norm = E.norm;

// Group a bout's claims into (fighter, topic, direction) — the unit an argument actually lives in.
function topicsFor(claims) {
  const groups = new Map();
  for (const c of claims) {
    const topic = E.topicOf(c);
    const key = `${norm(c.about)}|${topic}|${c.direction}`;
    if (!groups.has(key)) groups.set(key, { about: c.about, topic, direction: c.direction, items: [] });
    groups.get(key).items.push(c);
  }
  return [...groups.values()].map((g) => {
    const origin = E.originAnalysis(g.items);
    const cred = g.items.map((c) => E.credibilityOf(c, g.items, origin));
    const best = cred.reduce((a, b) => (b._plus - b._minus > a._plus - a._minus ? b : a), cred[0]);
    return {
      about: g.about, topic: g.topic, direction: g.direction,
      claimCount: g.items.length,
      kinds: [...new Set(g.items.map(E.kindOf))],
      relevance: [...new Set(g.items.map(E.relevanceOf))],
      freshness: [...new Set(g.items.map(E.freshnessOf))],
      origin,
      marketAwareness: E.marketAwarenessOf(g.topic, origin, g.items),
      strength: best.strength,
      credibilityComponents: best,
      // THE SOURCE RECORD, NEVER DISCARDED — and it must be ROUND-TRIPPABLE.
      //
      // This projection used to drop `publishedAt`, and that single omission made the whole
      // claim-level leakage gate inert: run-forecast.js filtered on `c.publishedAt`, the filter
      // emptied the array, and `leakageRejected` was structurally 0 on every bout ever forecast. A
      // claim cannot be proven to predate the seal if the record of when it was said is thrown away.
      //
      // The identity fields (`about`, `direction`, `boutId`) are here for the same reason: admission
      // has to REBUILD the topics from the surviving claims, because dropping a leaked claim must also
      // drop the origin it contributed. Filtering claims while keeping the pre-computed origin count
      // would let a rejected claim go on moving the number through `independentOrigins`.
      claims: g.items.map((c) => ({ claim: c.claim, quote: c.quote, channel: c.channel,
        videoId: c.videoId, segment: c.segment, kind: E.kindOf(c), claimClass: c.claimClass,
        relevance: E.relevanceOf(c), freshness: E.freshnessOf(c),
        publishedAt: c.publishedAt || null,   // null, never borrowed from a sibling claim
        about: c.about, direction: c.direction, boutId: c.boutId, evidenceType: c.evidenceType,
        mentionCount: c.mentionCount ?? null, sources: c.sources ?? null })),
    };
  });
}

// Opposing positions on ONE (fighter, topic). Reports how they disagree — or whether they disagree
// at all: "great boxer" and "no one-punch power" are both true at once.
function contradictionsFor(topics) {
  const byFT = new Map();
  for (const t of topics) {
    if (t.direction === "neutral") continue;
    const k = `${norm(t.about)}|${t.topic}`;
    if (!byFT.has(k)) byFT.set(k, {});
    byFT.get(k)[t.direction === "favors_about" ? "favors" : "against"] = t;
  }
  const out = [];
  for (const [, v] of byFT) {
    if (!v.favors || !v.against) continue;
    const type = E.contradictionType(v.favors.claims[0], v.against.claims[0]);
    out.push({
      proposition: `${v.favors.about} — ${v.favors.topic}`,
      disagreementType: type,
      bothCanBeTrue: type === "compatible_claims" || type === "different_predicted_fight_phases",
      supporting: { position: `favors ${v.favors.about}`, claims: v.favors.claimCount,
        independentOrigins: v.favors.origin.independentOrigins, amplifiers: v.favors.origin.amplifyingChannels,
        strength: v.favors.strength, examples: v.favors.claims.slice(0, 2).map((c) => c.claim) },
      opposing: { position: `against ${v.against.about}`, claims: v.against.claimCount,
        independentOrigins: v.against.origin.independentOrigins, amplifiers: v.against.origin.amplifyingChannels,
        strength: v.against.strength, examples: v.against.claims.slice(0, 2).map((c) => c.claim) },
    });
  }
  return out.sort((a, b) => (b.supporting.independentOrigins + b.opposing.independentOrigins) -
    (a.supporting.independentOrigins + a.opposing.independentOrigins));
}

// The topics we would expect any competent preview to touch. What is MISSING is information too —
// and a report that hides its blind spots is worse than one that has none.
const EXPECTED = ["striking_offense", "striking_defense", "wrestling_offense", "takedown_defense", "cardio", "durability", "recent_form"];

function evaluateBout(bout, claims) {
  const mine = claims.filter((c) => c.boutId === bout.boutId);
  if (!mine.length) {
    return { boutId: bout.boutId, fight: `${bout.a.name} vs ${bout.b.name}`,
      coverage: "INSUFFICIENT EVIDENCE", relevantClaims: 0, independentOrigins: 0,
      reason: "no card-relevant claims were extracted for this bout",
      topics: [], contradictions: [], reviewItems: [],
      missingInformation: EXPECTED, limitations: ["no coverage at all — nothing can be said about this fight"] };
  }
  const topics = topicsFor(mine);
  const contradictions = contradictionsFor(topics);

  // UNION the origin identities across topics; never SUM the counts. Summing turned one analyst
  // covering twelve topics into "12 independent origins" — a single voice reported as a consensus,
  // which is the precise failure this module was written to catch. A bout's evidence rests on the
  // number of distinct people who independently know something, not on how many subjects one of
  // them talked about.
  const originIdSet = new Set();
  for (const t of topics) for (const id of t.origin.originIds || []) originIdSet.add(id);
  const origins = originIdSet.size;
  // BREAK THE NUMBER DOWN. "128 origins, 37 channels" invites the reader to hear "128 people".
  // It is really 37 analysts plus ~91 distinct public facts — different things, and only the
  // analysts are independent *judgements*. A number that flatters without explaining is the kind
  // this whole layer exists to refuse.
  const originBreakdown = {
    analysts: [...originIdSet].filter((i) => i.startsWith("analyst:")).length,
    publicRecords: [...originIdSet].filter((i) => i.startsWith("record:")).length,
    externalReports: [...originIdSet].filter((i) => i.startsWith("report:")).length,
    commentary: [...originIdSet].filter((i) => i.startsWith("commentary:")).length,
  };
  const strong = topics.filter((t) => t.strength === "strong");
  const factual = topics.filter((t) => t.kinds.some((k) => ["verified_hard_fact", "verifiable_statistical_claim"].includes(k)));
  const filmish = topics.filter((t) => t.kinds.some((k) => ["film_study_observation", "matchup_inference"].includes(k)));
  const condition = topics.filter((t) => t.relevance.includes("current_fighter_condition"));
  const rumors = topics.filter((t) => t.kinds.includes("rumor") || t.kinds.includes("secondhand_report"));
  const picksOnly = topics.filter((t) => t.kinds.length === 1 && t.kinds[0] === "direct_pick_or_prediction");

  // COVERAGE, stated honestly. Volume is not knowledge: a bout can have 20 claims that are all one
  // analyst's vibes, and that is not coverage.
  const analytical = topics.filter((t) => !t.kinds.every((k) => ["direct_pick_or_prediction", "unsupported_narrative", "psychological_interpretation"].includes(k)));
  let coverage;
  if (!analytical.length) coverage = "INSUFFICIENT EVIDENCE";
  else if (origins >= 8 && strong.length >= 2) coverage = "WELL COVERED";
  else if (origins >= 3) coverage = "PARTIALLY COVERED";
  else coverage = "THINLY COVERED";

  const present = new Set(topics.map((t) => t.topic));
  const missing = EXPECTED.filter((t) => !present.has(t));

  const limitations = [];
  const singleOrigin = topics.filter((t) => t.origin.amplifyingChannels >= 3 && t.origin.independentOrigins === 1);
  if (singleOrigin.length) limitations.push(`${singleOrigin.length} topic(s) look widely agreed but trace to ONE origin (amplification, not confirmation)`);
  if (picksOnly.length) limitations.push(`${picksOnly.length} topic(s) are picks with no supporting reasoning — recorded, not counted as evidence`);
  const stale = topics.filter((t) => t.freshness.includes("stale_or_dated"));
  if (stale.length) limitations.push(`${stale.length} topic(s) rest on dated information`);
  const unk = topics.filter((t) => t.freshness.every((f) => f === "unknown_timeframe"));
  if (unk.length) limitations.push(`${unk.length} topic(s) have no determinable timeframe`);
  if (new Set(mine.map((c) => c.channel)).size === 1) limitations.push("every claim comes from a single analyst — no independent check is possible");

  // 11. REVIEW QUEUE — material only. No formatting nits.
  const reviewItems = [];
  for (const t of topics) {
    if (t.topic === "injury_health" && t.kinds.some((k) => ["rumor", "secondhand_report"].includes(k)))
      reviewItems.push({ why: "high-impact injury rumor", topic: t.topic, about: t.about, origins: t.origin.independentOrigins, example: t.claims[0].claim });
    if (t.origin.independentOrigins === 1 && t.marketAwareness === "newly_emerging" && t.strength !== "very_weak")
      // Carry the real origin count. Omitting it here is why the shipped alert rendered "Independent
      // origins: unknown" on a claim whose whole classification is "a single origin" — the one number
      // the reader most needs, dropped from the exact branch that is about that number.
      reviewItems.push({ why: "potentially new information with a single origin", topic: t.topic, about: t.about, origins: t.origin.independentOrigins, example: t.claims[0].claim });
    // Resolve the fighter the claim is ABOUT — not the first word of the claim text. The first
    // version passed claim.split(" ")[0], so "A long layoff..." resolved the token "A" and every
    // topic on the card was flagged "ambiguous fighter identity". That is precisely the queue of
    // harmless noise a review queue must never become: 26 items, almost all of them meaningless,
    // which is how a human learns to ignore the queue entirely.
    const ent = E.resolveEntity(t.about, bout);
    if (ent.needsHumanReview || ent.confidence === "low")
      reviewItems.push({ why: "ambiguous fighter identity", topic: t.topic, about: t.about, origins: t.origin.independentOrigins, resolution: ent });
  }
  for (const c of contradictions) {
    if (c.disagreementType === "factual_disagreement")
      reviewItems.push({ why: "conflicting factual reports", topic: c.proposition, detail: `${c.supporting.claims} vs ${c.opposing.claims} claims` });
  }

  return {
    boutId: bout.boutId, fight: `${bout.a.name} vs ${bout.b.name}`,
    coverage, relevantClaims: mine.length, topicCount: topics.length,
    independentOrigins: origins,
    originBreakdown,          // analysts vs public records vs reports — never one flattering total
    originIdentities: [...originIdSet],
    channels: new Set(mine.map((c) => c.channel)).size,
    strongestFactual: factual.sort((a, b) => b.origin.independentOrigins - a.origin.independentOrigins).slice(0, 3)
      .map((t) => ({ topic: t.topic, about: t.about, direction: t.direction, strength: t.strength,
        origins: t.origin.independentOrigins, amplifiers: t.origin.amplifyingChannels, claim: t.claims[0].claim, quote: t.claims[0].quote })),
    strongestMatchupObservations: filmish.sort((a, b) => b.origin.independentObservations - a.origin.independentObservations).slice(0, 3)
      .map((t) => ({ topic: t.topic, about: t.about, direction: t.direction,
        independentObservations: t.origin.independentObservations, claim: t.claims[0].claim })),
    currentCondition: condition.map((t) => ({ topic: t.topic, about: t.about, freshness: t.freshness,
      origins: t.origin.independentOrigins, chain: t.origin.reportingChain, claim: t.claims[0].claim })),
    rumorsAndUnresolved: rumors.map((t) => ({ topic: t.topic, about: t.about, origins: t.origin.independentOrigins,
      amplifiers: t.origin.amplifyingChannels, chain: t.origin.reportingChain, note: t.origin.note, claim: t.claims[0].claim })),
    widelyKnown: topics.filter((t) => t.marketAwareness === "widely_public_probably_in_the_market").map((t) => `${t.about}: ${t.topic}`),
    potentiallyNovel: topics.filter((t) => ["niche_analytical_interpretation", "newly_emerging"].includes(t.marketAwareness))
      .map((t) => ({ topic: t.topic, about: t.about, marketAwareness: t.marketAwareness, origins: t.origin.independentOrigins })),
    contradictions,
    missingInformation: missing,
    limitations,
    reviewItems,
    topics,   // the full source record stays attached
  };
}

module.exports = { evaluateBout, topicsFor, contradictionsFor, EXPECTED };
