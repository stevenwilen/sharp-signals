// FIGHT INTELLIGENCE — the persistent lifecycle record for one uncertain report.
//
// This is the spine of the automated intelligence system. It replaces the old "surface an unverified
// rumour and ask the human to go verify it" flow with ONE durable record per material report that is
// discovered, assessed, priced, acted on, and later confirmed/disproved — all keyed so the SAME story
// seen again updates the SAME record instead of spawning a new one.
//
// TWO RULES THIS FILE EXISTS TO KEEP:
//
//   1. ORIGINS, NOT VOICES. Ten channels repeating one tweet are ten AMPLIFIERS of ONE origin, never
//      ten confirmations. This module NEVER counts origins itself — it reads the count that
//      evidence-eval.originAnalysis() already computed by unioning origin identities. `amplifiers` may
//      grow run over run; `independentOrigins` comes only from the counter. A repeat inflates the first
//      and must not touch the second.
//
//   2. A REPEAT IS NOT A NEW REPORT. The record id is derived from (event, fighter, topic, direction) —
//      NOT from the positional boutId (which renumbers when a bout drops off the card) and NOT from the
//      claim wording (which a re-worded transcript changes). So the same story, seen again, matches and
//      updates; it does not create record #2.
//
// It produces no probability and no stake. It reuses the frozen forecast/exploration lanes for that.
require("./env");
const crypto = require("crypto");
const E = require("./evidence-eval");
const F = require("./forecast");
const { readJson, writeJson, paths } = require("./store");
const path = require("path");

const norm = E.norm;

// ---- the five report types (§4). What KIND of information this is decides where it goes. ----
const REPORT_TYPE = {
  EVENT_STATUS: "EVENT_STATUS",             // withdrawal, cancellation, replacement, suspension, hospitalization
  CURRENT_CONDITION: "CURRENT_CONDITION",   // injury, illness, bad weight cut, staph, camp/travel disruption
  ANALYTICAL_HYPOTHESIS: "ANALYTICAL",      // "returning too soon", "looks slower", "cardio may fail" — inference
  PUBLIC_HISTORY: "PUBLIC_HISTORY",         // longstanding knee problems, a prior KO loss, a known layoff
  LOW_VALUE: "LOW_VALUE",                   // "wants it more", "looked nervous", crowd symbolism
};

// ---- the truth/quality statuses (§3). Not a VERIFIED/UNVERIFIED binary. ----
const TRUTH_STATUS = {
  CONFIRMED: "CONFIRMED", LIKELY_TRUE: "LIKELY_TRUE", PLAUSIBLE: "PLAUSIBLE", UNCERTAIN: "UNCERTAIN",
  CONFLICTING: "CONFLICTING", LIKELY_FALSE: "LIKELY_FALSE", DISPROVED: "DISPROVED", STALE: "STALE",
  WIDELY_KNOWN: "WIDELY_KNOWN", PROBABLY_ALREADY_PRICED: "PROBABLY_ALREADY_PRICED",
};

// ---- the action statuses (§5). Every material record ends in exactly one. ----
const ACTION_STATUS = {
  IGNORE: "IGNORE", DASHBOARD_ONLY: "DASHBOARD_ONLY", WATCH: "WATCH", SPECULATIVE_BET: "SPECULATIVE_BET",
  FORECAST_UPDATED: "FORECAST_UPDATED", MARKET_ALREADY_MOVED: "MARKET_ALREADY_MOVED",
  REPORT_CONFIRMED: "REPORT_CONFIRMED", REPORT_DISPROVED: "REPORT_DISPROVED",
  POSITION_WITHDRAWN: "POSITION_WITHDRAWN", HUMAN_ACTION_REQUIRED: "HUMAN_ACTION_REQUIRED",
};

// EVENT-STATUS language — the report is about the fight EXISTING, not a fighter's condition. A withdrawal
// pays nothing to be right about once the market suspends (Kalshi resolves rescheduled >2wk to fair
// value), so this class is routed very differently from a "he might be hurt" condition report.
const EVENT_STATUS_RE = /\b(withdraw|withdrew|withdrawn|pulled out|pulls out|off the card|out of the (fight|card|bout)|cancel(l?ed|s)?|scratched|replac(e|ed|ement)|steps? in|stepping in|short.notice replacement|fight is off|bout is off|hospitali[sz]ed|suspended|suspension|flagged by usada|failed (a )?drug test|visa (issue|problem|denied))\b/i;
// CURRENT-CONDITION language — the fighter is (reportedly) impaired, but the fight is still on.
const CONDITION_RE = /\b(injur|hurt|banged up|illness|ill\b|sick|flu|staph|infection|weight cut|missed weight|missing weight|didn'?t look good on the scale|camp (fell apart|disruption|issues?)|coach(ing)? change|changed camps?|travel (issue|problem|delay)|jet ?lag|drained|depleted)\b/i;

const isEventStatusText = (t) => EVENT_STATUS_RE.test(t);
const isConditionText = (t) => CONDITION_RE.test(t);

// The joined text of a topic's claims — what the report actually SAYS, used only for language routing.
function topicText(topic) {
  return (topic.claims || []).map((c) => `${c.claim || ""} ${c.quote || ""}`).join(" ");
}

// (§4) ROUTE THE REPORT TYPE. Analytical hypotheses feed the creative forecast lane, they are NOT urgent
// breaking news; low-value narrative never becomes an alert; public history is context, not a signal.
function reportTypeOf(topic) {
  const kinds = topic.kinds || [];
  const rel = topic.relevance || [];
  const txt = norm(topicText(topic));

  // Only the loudest kinds present? Then it is narrative, whatever the topic slug says.
  const onlyNarrative = kinds.length > 0 && kinds.every((k) => ["unsupported_narrative", "psychological_interpretation", "direct_pick_or_prediction"].includes(k));
  if (onlyNarrative) return REPORT_TYPE.LOW_VALUE;

  if (isEventStatusText(txt)) return REPORT_TYPE.EVENT_STATUS;
  if (topic.topic === "injury_health" || topic.topic === "weight_cut" || topic.topic === "short_notice"
      || topic.topic === "training_camp" || (isConditionText(txt) && rel.includes("current_fighter_condition")))
    return REPORT_TYPE.CURRENT_CONDITION;

  // Inference about how the fight will go (film study / matchup reasoning) — the creative lane's food.
  if (kinds.some((k) => ["film_study_observation", "matchup_inference"].includes(k)))
    return REPORT_TYPE.ANALYTICAL_HYPOTHESIS;

  // A true but old/general fact about a fighter's career.
  if (rel.some((r) => ["stable_historical_tendency", "opponent_specific_historical", "general_career_background"].includes(r)))
    return REPORT_TYPE.PUBLIC_HISTORY;

  // A checkable current claim with no clear condition/event framing still counts as analysis.
  if (kinds.some((k) => ["verified_hard_fact", "verifiable_statistical_claim"].includes(k)))
    return REPORT_TYPE.PUBLIC_HISTORY;

  return REPORT_TYPE.ANALYTICAL_HYPOTHESIS;
}

// (§3) ACCESS RELEVANCE — does the ORIGIN plausibly have a line to the truth (the fighter/gym/insider),
// or is it a commentator with the same TV feed as everyone else? One access-relevant origin can matter
// more than five unrelated pundits, so this is tracked explicitly rather than folded into a score.
const ACCESS = { FIRSTHAND: "firsthand", INSIDER_REPORT: "insider_report", MEDIA_REPORT: "media_report", ANALYST_ONLY: "analyst_only", UNKNOWN: "unknown" };
function accessRelevanceOf(topic) {
  const kinds = topic.kinds || [];
  const o = topic.origin || {};
  if (kinds.includes("firsthand_statement") || kinds.includes("current_condition_report")) return ACCESS.FIRSTHAND;
  const named = (o.citedOrigins || []).some((c) => c && !/^anon/i.test(String(c)));
  if (kinds.includes("secondhand_report") && named) return ACCESS.INSIDER_REPORT;
  if (kinds.includes("secondhand_report") || kinds.includes("rumor") || o.originType === "external_report") return ACCESS.MEDIA_REPORT;
  if (o.originType === "independent_analysis") return ACCESS.ANALYST_ONLY;
  return ACCESS.UNKNOWN;
}

const freshBucket = (fresh = []) => {
  if (fresh.some((f) => ["current_fight_week", "current_training_camp"].includes(f))) return "fresh";
  if (fresh.includes("recent_fights")) return "recent";
  if (fresh.some((f) => ["stale_or_dated", "long_term_tendency"].includes(f))) return "dated";
  return "unknown";
};

// Mechanism strength — how directly the claim, IF TRUE, changes who wins. A withdrawal changes it
// completely; an injury plausibly; a film-study read weakly. Reuses the frozen mechanism map so an
// analytical topic with no mechanism cluster scores lower.
function mechanismStrengthOf(reportType, topic) {
  if (reportType === REPORT_TYPE.EVENT_STATUS) return "strong";
  if (reportType === REPORT_TYPE.CURRENT_CONDITION) return "moderate";
  if (reportType === REPORT_TYPE.LOW_VALUE) return "none";
  const hasMechanism = !!F.mechanismOf(topic.topic);
  if (reportType === REPORT_TYPE.ANALYTICAL_HYPOTHESIS) return hasMechanism && topic.strength === "strong" ? "moderate" : hasMechanism ? "weak" : "none";
  return "weak"; // PUBLIC_HISTORY
}

// (§3) ASSESS — a transparent factor bag AND a single status derived from it by fixed rules. Every
// factor is shown so the dashboard can explain WHY, and no factor is a black-box number.
// opts: { contradiction, confirmed, disproved } — cross-side and external evidence the topic alone
// cannot see (a factual disagreement, an official confirmation, an explicit disproof).
function assess(topic, opts = {}) {
  const reportType = reportTypeOf(topic);
  const o = topic.origin || {};
  const independentOrigins = Number.isFinite(o.independentOrigins) ? o.independentOrigins : null;
  const accessRelevance = accessRelevanceOf(topic);
  const specific = (topic.claims || []).some((c) => /\d/.test(String(c.claim) + c.quote) || String(c.claim).split(/\s+/).length >= 8);
  const recency = freshBucket(topic.freshness);
  const mechanismStrength = mechanismStrengthOf(reportType, topic);
  const marketAwareness = topic.marketAwareness || "unknown";
  const novel = ["newly_emerging", "difficult_to_verify"].includes(marketAwareness);
  const probablyPriced = marketAwareness === "widely_public_probably_in_the_market";
  const corroborated = (independentOrigins || 0) >= 2;
  const contradiction = opts.contradiction || null;

  // plausibility, from the factors — not asserted.
  let plausibility;
  if (["very_weak"].includes(topic.strength) || reportType === REPORT_TYPE.LOW_VALUE) plausibility = "low";
  else if ((accessRelevance === ACCESS.FIRSTHAND || accessRelevance === ACCESS.INSIDER_REPORT) && specific
           && ["strong", "moderate"].includes(mechanismStrength) && !contradiction) plausibility = "high";
  else plausibility = "moderate";

  const factors = {
    independentOrigins, amplifiers: o.amplifyingChannels ?? null, accessRelevance,
    specificity: specific ? "specific" : "vague", recency, plausibility, corroborated,
    marketAwareness, novel, probablyPriced, mechanismStrength, strength: topic.strength || null,
    contradiction: contradiction ? contradiction.disagreementType : null,
  };

  // STATUS — fixed precedence. External resolution first, then market state, then evidence weight.
  let status;
  if (opts.disproved) status = TRUTH_STATUS.DISPROVED;
  else if (opts.confirmed) status = TRUTH_STATUS.CONFIRMED;
  else if (contradiction && contradiction.disagreementType === "factual_disagreement") {
    // The disconfirming version is better-sourced than the claim → LIKELY_FALSE; otherwise unresolved.
    const opp = contradiction.opposingOrigins ?? 0, sup = contradiction.supportingOrigins ?? (independentOrigins || 0);
    status = opp > sup ? TRUTH_STATUS.LIKELY_FALSE : TRUTH_STATUS.CONFLICTING;
  } else if (recency === "dated" && (probablyPriced || marketAwareness === "widely_public_probably_in_the_market")) status = TRUTH_STATUS.STALE;
  else if (probablyPriced) status = TRUTH_STATUS.PROBABLY_ALREADY_PRICED;
  else if (marketAwareness === "widely_public_probably_in_the_market") status = TRUTH_STATUS.WIDELY_KNOWN;
  else if ((independentOrigins || 0) >= 3 && ["strong", "moderate"].includes(topic.strength)) status = TRUTH_STATUS.LIKELY_TRUE;
  else if ((independentOrigins || 0) >= 1 && plausibility === "high") status = TRUTH_STATUS.PLAUSIBLE;
  else status = TRUTH_STATUS.UNCERTAIN;

  return { status, reportType, factors };
}

// Which fighter's win probability moves, and the direction — reused from the claim's own `direction`.
function outcomeAffectedOf(topic, opponent) {
  const helps = topic.direction === "favors_about" ? topic.about
    : topic.direction === "against_about" ? (opponent || null) : null;
  return { fighter: topic.about, direction: topic.direction, helps };
}

// A STABLE id: same (event, fighter, topic, direction) → same record, across boutId renumbering and
// re-worded transcripts. This is the anti-duplication guarantee.
function stableId(eventId, about, topic, direction) {
  const h = crypto.createHash("sha256").update(`${eventId}|${norm(about)}|${topic}|${direction}`).digest("hex").slice(0, 12);
  return `intel_${h}`;
}

// Exact supporting quotes, deduped — the source record, never discarded.
function quotesOf(topic) {
  const seen = new Set(), out = [];
  for (const c of topic.claims || []) {
    const q = (c.quote || "").trim();
    if (q.length > 12 && !seen.has(q)) { seen.add(q); out.push({ quote: q, channel: c.channel || null, publishedAt: c.publishedAt || null }); }
  }
  return out;
}
// The amplifying channels seen for this report (the megaphones). Distinct from origins.
function channelsOf(topic) {
  return [...new Set((topic.claims || []).map((c) => c.channel).filter(Boolean))];
}

// BUILD a fresh record from an evaluated topic (§2 — every field). `ctx` carries the run's identity and
// its injected wall-clock `now` (never fabricated: the caller passes the run's real timestamp).
function recordFromTopic(topic, ctx) {
  const { eventId, boutId, fight, opponent, now, market } = ctx;
  const a = assess(topic, ctx);
  const o = topic.origin || {};
  const id = stableId(eventId, topic.about, topic.topic, topic.direction);
  return {
    intelligenceId: id,
    eventId, boutId, fighter: topic.about, fight: fight || null,
    claim: (topic.claims && topic.claims[0] && topic.claims[0].claim) || null,
    rawWording: (topic.claims && topic.claims[0] && topic.claims[0].quote) || null,
    normalizedClaim: `${norm(topic.about)} — ${topic.topic} (${topic.direction})`,
    topic: topic.topic, direction: topic.direction,
    firstSeenAt: now, lastUpdatedAt: now,
    originalOrigin: (o.originIds && o.originIds[0]) || null,
    originType: o.originType || null,
    sourceRelationship: a.factors.accessRelevance,
    firsthandClaimed: (topic.kinds || []).includes("firsthand_statement"),
    independentOrigins: o.independentOrigins ?? null,
    originIds: o.originIds || [],
    amplifiers: channelsOf(topic),
    amplifierCount: (o.amplifyingChannels ?? channelsOf(topic).length),
    quotes: quotesOf(topic),
    reportType: a.reportType,
    truthStatus: a.status,
    accessRelevance: a.factors.accessRelevance,
    specificity: a.factors.specificity,
    recency: a.factors.recency,
    plausibility: a.factors.plausibility,
    contradictions: a.factors.contradiction ? [a.factors.contradiction] : [],
    confirmations: [],
    disproofs: [],
    mechanism: F.mechanismOf(topic.topic) || null,
    mechanismStrength: a.factors.mechanismStrength,
    outcomeAffected: outcomeAffectedOf(topic, opponent),
    novel: a.factors.novel,
    probablyPriced: a.factors.probablyPriced,
    marketAwareness: a.factors.marketAwareness,
    sportsbookBefore: (market && market.sportsbook) ?? null,
    kalshiBefore: (market && market.kalshi) ?? null,
    sportsbookAfter: [],
    kalshiAfter: [],
    forecastImpact: null,
    contractImpact: null,
    actionStatus: null,       // filled by classifyAction once context (forecast/market/price) is known
    telegramLineage: [],      // { messageId, type, sentAt } — populated by the messaging layer
    forecastVersions: [],     // sealHashes this report influenced
    positionVersions: [],     // manual-bankroll keys this report influenced
    actionHistory: [{ at: now, status: a.status, action: null, note: "first seen" }],
    factors: a.factors,
  };
}

// MERGE a re-seen topic into an existing record. Origins are REFRESHED from the counter (never summed);
// amplifiers and quotes accumulate. Repetition raises `amplifierCount`, not `independentOrigins`.
function mergeTopic(record, topic, ctx) {
  const { now } = ctx;
  const a = assess(topic, ctx);
  const o = topic.origin || {};
  const amps = [...new Set([...(record.amplifiers || []), ...channelsOf(topic)])];
  const quotes = (() => {
    const seen = new Set((record.quotes || []).map((q) => q.quote)); const out = [...(record.quotes || [])];
    for (const q of quotesOf(topic)) if (!seen.has(q.quote)) { seen.add(q.quote); out.push(q); }
    return out;
  })();
  const next = {
    ...record,
    lastUpdatedAt: now,
    claim: record.claim || (topic.claims && topic.claims[0] && topic.claims[0].claim) || null,
    independentOrigins: o.independentOrigins ?? record.independentOrigins,   // from the COUNTER, not a sum
    originIds: o.originIds && o.originIds.length ? o.originIds : record.originIds,
    amplifiers: amps,
    amplifierCount: amps.length,
    quotes,
    reportType: a.reportType,
    truthStatus: a.status,
    accessRelevance: a.factors.accessRelevance,
    specificity: a.factors.specificity,
    recency: a.factors.recency,
    plausibility: a.factors.plausibility,
    contradictions: a.factors.contradiction ? [...new Set([...(record.contradictions || []), a.factors.contradiction])] : (record.contradictions || []),
    novel: a.factors.novel,
    probablyPriced: a.factors.probablyPriced,
    marketAwareness: a.factors.marketAwareness,
    mechanismStrength: a.factors.mechanismStrength,
    factors: a.factors,
  };
  if (record.truthStatus !== a.status)
    next.actionHistory = [...(record.actionHistory || []), { at: now, status: a.status, action: record.actionStatus, note: `status ${record.truthStatus} → ${a.status}` }];
  return next;
}

const MATERIAL = 0.02;   // a forecast move (probability points) below this is not "material"

// (§5) CLASSIFY THE ACTION. A pure state machine over the record + the run's context. It decides ONLY
// the status; whether to ALERT (and dedup) is the messaging layer's job. Reasons are attached so a
// refusal to bet is explained, never silent.
//   ctx: { forecastImpactPoints, marketMovedBeyondMax, priceFavorable, betQualifies,
//          priorRecommendationInvalidated, unreachable, fightStarted, marketSuspended }
function classifyAction(record, ctx = {}) {
  const S = TRUTH_STATUS, R = REPORT_TYPE, A = ACTION_STATUS;
  const material = Math.abs(ctx.forecastImpactPoints || 0) >= MATERIAL;
  const isMaterialReport = record.reportType !== R.LOW_VALUE && record.mechanismStrength !== "none";

  // HUMAN_ACTION_REQUIRED is reserved for a genuine access failure on something that matters — never a
  // stand-in for research the cloud simply did not do.
  if (ctx.unreachable && isMaterialReport) return { action: A.HUMAN_ACTION_REQUIRED, reason: "a material source could not be reached automatically" };

  if (record.truthStatus === S.DISPROVED) return { action: A.REPORT_DISPROVED, reason: "the report was disproved" };
  if (ctx.priorRecommendationInvalidated) return { action: A.POSITION_WITHDRAWN, reason: "a prior recommendation is no longer valid" };
  if (record.truthStatus === S.CONFIRMED)
    return { action: A.REPORT_CONFIRMED, reason: (record.reportType === R.EVENT_STATUS || ctx.marketSuspended) ? "confirmed — market suspended, no bet" : "confirmed" };

  // Low-value narrative is stored for the record but never interrupts the phone (§19: "remains
  // dashboard only"). Stale/repetitive/irrelevant is what actually gets IGNOREd.
  if (record.reportType === R.LOW_VALUE) return { action: A.DASHBOARD_ONLY, reason: "low-value narrative, dashboard only" };
  if (record.truthStatus === S.STALE) return { action: A.IGNORE, reason: "stale and already public" };
  if (record.truthStatus === S.LIKELY_FALSE) return { action: A.DASHBOARD_ONLY, reason: "the disconfirming version is better sourced" };
  if ([S.WIDELY_KNOWN, S.PROBABLY_ALREADY_PRICED].includes(record.truthStatus)) return { action: A.DASHBOARD_ONLY, reason: "already public / probably priced" };
  if (record.reportType === R.PUBLIC_HISTORY) return { action: A.DASHBOARD_ONLY, reason: "public history, context not signal" };

  // The market already moved past the price we'd pay — do not chase (§8).
  if (ctx.marketMovedBeyondMax) return { action: A.MARKET_ALREADY_MOVED, reason: "price already moved beyond the maximum" };

  // Analytical hypotheses feed the forecast lane, they are NOT urgent news. Alert only if they actually
  // moved the (speculative) forecast; otherwise they live on the dashboard.
  if (record.reportType === R.ANALYTICAL_HYPOTHESIS)
    return material ? { action: A.FORECAST_UPDATED, reason: "analytical hypothesis moved the speculative forecast" }
                    : { action: A.DASHBOARD_ONLY, reason: "analytical hypothesis, no material forecast move" };

  // Event-status / current-condition, credible enough to matter:
  if (ctx.betQualifies && ctx.priceFavorable) return { action: A.SPECULATIVE_BET, reason: "capped speculative position qualifies at a favorable price" };
  if (material) return { action: A.FORECAST_UPDATED, reason: "materially changed the forecast" };
  if ([S.PLAUSIBLE, S.LIKELY_TRUE, S.CONFLICTING].includes(record.truthStatus)) return { action: A.WATCH, reason: "plausible and potentially meaningful, no bet yet" };
  return { action: A.DASHBOARD_ONLY, reason: "recorded, nothing to act on" };
}

// Apply a classification to a record, appending to the lifecycle timeline when the action changes.
function applyAction(record, ctx = {}) {
  const { action, reason } = classifyAction(record, ctx);
  const changed = record.actionStatus !== action;
  const out = { ...record, actionStatus: action };
  if (changed) out.actionHistory = [...(record.actionHistory || []), { at: ctx.now || record.lastUpdatedAt, status: record.truthStatus, action, note: reason }];
  return { record: out, action, reason, changed };
}

// A record is "material" once it is anything other than IGNORE.
const isMaterial = (record) => record.actionStatus && record.actionStatus !== ACTION_STATUS.IGNORE;

// ---- persistence (§15). One store per card, git-committed via data/, atomic temp+rename. ----
function storePath(card) { return path.join(paths.data, `intelligence-${card}.json`); }
function load(card) {
  const s = readJson(storePath(card), null);
  if (s && s.records) return s;
  return { card, updatedAt: null, records: {} };
}
function save(card, store) {
  writeJson(storePath(card), { ...store, card, updatedAt: store.updatedAt || null });
  return store;
}

// INGEST one run's evaluated topics: match-or-create each, refresh assessment, classify. Returns the
// updated store plus the per-record outcome so the messaging layer can decide what to send.
//   batch: { card, eventId, now, bouts: [ { boutId, fight, opponentOf:{about->opponent}, topics[],
//            contradictionByKey:{ `${norm(about)}|${topic}` -> contradiction }, market, actionCtxByKey } ] }
function ingest(store, batch) {
  const out = { store: { ...store, records: { ...store.records }, updatedAt: batch.now }, results: [] };
  for (const bout of batch.bouts || []) {
    for (const topic of bout.topics || []) {
      const key = `${norm(topic.about)}|${topic.topic}`;
      const opponent = (bout.opponentOf && bout.opponentOf[norm(topic.about)]) || null;
      const contradiction = (bout.contradictionByKey && bout.contradictionByKey[key]) || null;
      const ctx = {
        eventId: batch.eventId, boutId: bout.boutId, fight: bout.fight, opponent, now: batch.now,
        market: bout.market, contradiction,
        confirmed: bout.confirmedKeys && bout.confirmedKeys.includes(key),
        disproved: bout.disprovedKeys && bout.disprovedKeys.includes(key),
        ...( (bout.actionCtxByKey && bout.actionCtxByKey[key]) || {} ),
      };
      const id = stableId(batch.eventId, topic.about, topic.topic, topic.direction);
      const prev = out.store.records[id];
      let record = prev ? mergeTopic(prev, topic, ctx) : recordFromTopic(topic, ctx);
      // keep the current boutId current even across renumbering
      record.boutId = bout.boutId; record.fight = bout.fight || record.fight;
      const applied = applyAction(record, ctx);
      out.store.records[id] = applied.record;
      out.results.push({ id, created: !prev, statusChanged: !prev || (prev.truthStatus !== applied.record.truthStatus),
        actionChanged: applied.changed, action: applied.action, reason: applied.reason, record: applied.record });
    }
  }
  return out;
}

// Group records for the dashboard (§16) by lifecycle stage.
function groupByAction(records) {
  const A = ACTION_STATUS;
  const bucket = {
    new: [], watching: [], influencedForecast: [], betProposed: [], marketMoved: [], confirmed: [], disproved: [], ignored: [],
  };
  for (const r of records) {
    switch (r.actionStatus) {
      case A.WATCH: bucket.watching.push(r); break;
      case A.FORECAST_UPDATED: bucket.influencedForecast.push(r); break;
      case A.SPECULATIVE_BET: bucket.betProposed.push(r); break;
      case A.MARKET_ALREADY_MOVED: bucket.marketMoved.push(r); break;
      case A.REPORT_CONFIRMED: bucket.confirmed.push(r); break;
      case A.REPORT_DISPROVED: bucket.disproved.push(r); break;
      case A.IGNORE: bucket.ignored.push(r); break;
      case A.DASHBOARD_ONLY:
        if (r.reportType === REPORT_TYPE.LOW_VALUE || r.mechanismStrength === "none") bucket.ignored.push(r);
        else (r.actionHistory && r.actionHistory.length <= 2 ? bucket.new : bucket.watching).push(r);
        break;
      default: bucket.new.push(r);
    }
  }
  return bucket;
}

module.exports = {
  REPORT_TYPE, TRUTH_STATUS, ACTION_STATUS, ACCESS, MATERIAL,
  reportTypeOf, accessRelevanceOf, assess, outcomeAffectedOf, mechanismStrengthOf,
  stableId, recordFromTopic, mergeTopic, classifyAction, applyAction, isMaterial,
  ingest, groupByAction, load, save, storePath,
};
