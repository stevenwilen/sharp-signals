// EVIDENCE EVALUATOR — judges evidence, never fights.
//
// It produces NO win probability, NO method probability, NO edge, NO stake, NO ranking, NO
// recommendation. It answers a different question: how good is this evidence, how relevant is it to
// THIS fight, how fresh, how independent, and how uncertain?
//
// RULE-BASED ON PURPOSE. The brief asks for transparent component labels rather than an unexplained
// "AI confidence" number — so a model is the wrong tool here. Every judgement below is a rule you
// can read, argue with, and test. Nothing is a black box, and no new model calls are made.
//
// THE CENTRAL IDEA — INFORMATION ORIGINS, NOT VOICES:
//   Ten channels repeating one injury rumour is ONE origin with ten amplifiers, not ten
//   confirmations. Ten analysts each watching the tape and concluding the same thing IS ten
//   observations. The first is a megaphone; the second is evidence. Phase 5 counts CHANNELS
//   (independentSources); this layer counts ORIGINS, and they are very different numbers.
require("./env");

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const has = (t, ...w) => w.some((x) => t.includes(x));

// ---------------------------------------------------------------------------------------------
// 1. NORMALIZED EVIDENCE TOPICS
// Derived from the claim text + the extractor's own fields. Deliberately fine-grained: "striking
// offense" and "striking defense" are different arguments about a fighter and must never be pooled
// just because they both concern striking, or because they both favour the same man.
// ---------------------------------------------------------------------------------------------
const TOPICS = [
  ["direct_prediction", (t, c) => c.claimClass === "prediction"],
  ["injury_health", (t, c) => c.claimClass === "injury_health" || c.evidenceType === "injury" || has(t, "injury", "injured", "staph", "torn", "surgery", "concussion", "illness", "sick")],
  ["weight_cut", (t, c) => c.evidenceType === "weight_cut" || has(t, "weight cut", "missed weight", "cutting weight", "rehydrat", "drained")],
  ["short_notice", (t) => has(t, "short notice", "late replacement", "stepped in on")],
  ["inactivity_layoff", (t, c) => c.evidenceType === "layoff" || has(t, "layoff", "inactiv", "years off", "hasn t fought", "ring rust", "cage rust", "time off")],
  ["coaching_change", (t) => has(t, "new coach", "changed camp", "left camp", "switched gym", "new gym", "coaching change")],
  ["training_camp", (t, c) => c.claimClass === "training_camp" || c.evidenceType === "camp" || has(t, "camp", "sparring", "preparation", "training")],
  ["quality_of_opposition", (t, c) => c.evidenceType === "opponent_quality" || has(t, "level of competition", "quality of opposition", "beaten anyone", "who has he fought", "step up in competition")],
  ["recent_form", (t, c) => c.evidenceType === "record" || has(t, "win streak", "losing streak", "last three fights", "coming off", "recent fights", "last fight")],
  ["size_reach", (t) => has(t, "reach advantage", "reach", "taller", "height", "longer", "size advantage", "bigger")],
  ["power", (t) => has(t, "power", "knockout power", "one punch", "ko power", "heavy hands", "concussive")],
  ["speed", (t) => has(t, "speed", "faster", "quicker", "hand speed", "foot speed", "explosive")],
  ["cardio", (t, c) => c.evidenceType === "cardio" || has(t, "cardio", "gas tank", "conditioning", "tired", "fatigue", "third round", "pace fade")],
  ["durability", (t, c) => c.evidenceType === "durability" || has(t, "chin", "durab", "knocked out", "finished", "granite", "hurt", "dropped")],
  ["pressure_pace", (t) => has(t, "pressure", "pace", "volume", "forward", "output", "busier")],
  ["fight_iq", (t) => has(t, "fight iq", "ring iq", "smart", "adapt", "game plan", "reads")],
  ["takedown_defense", (t) => has(t, "takedown defense", "takedown defence", "tdd", "stuff takedowns", "defend the takedown", "sprawl")],
  ["wrestling_offense", (t, c) => c.evidenceType === "grappling" && has(t, "takedown", "wrestl", "clinch", "slam", "double leg", "single leg")],
  ["submission_defense", (t) => has(t, "submission defense", "submission defence", "escape", "survive submissions", "tapped")],
  ["submission_offense", (t) => has(t, "submission", "choke", "armbar", "guillotine", "rear naked", "jiu jitsu", "bjj", "grappling offense")],
  ["striking_defense", (t) => has(t, "striking defense", "striking defence", "hittable", "gets hit", "head movement", "chin up", "defensively", "absorbs")],
  ["striking_offense", (t, c) => c.evidenceType === "striking" || has(t, "striker", "boxing", "jab", "kick", "strikes", "combinations", "counter")],
  ["style_matchup", (t, c) => c.claimClass === "matchup_analysis" || has(t, "matchup", "styles", "neutralize", "problem for")],
  ["psychological", (t, c) => c.claimClass === "psychological" || c.evidenceType === "motivation" || has(t, "motivat", "hungry", "mentally", "confidence", "nerves", "ego")],
  ["external_circumstance", (t, c) => c.evidenceType === "travel" || has(t, "travel", "altitude", "jet lag", "outside the cage", "legal", "personal")],
  ["statistical_claim", (t, c) => c.claimClass === "statistical"],
];
function topicOf(c) {
  const t = norm(c.claim + " " + c.quote);
  for (const [name, test] of TOPICS) if (test(t, c)) return name;
  return "other";
}

// ---------------------------------------------------------------------------------------------
// 2. EVIDENCE CLASSIFICATION — what KIND of thing is this?
// A direct pick is not evidence. It is recorded and then set aside.
// ---------------------------------------------------------------------------------------------
// THESE RUN ON NORMALISED TEXT, which strips apostrophes: "I'm hearing" arrives as "i m hearing"
// and "it's been said" as "it s been said". The first cut spelled them with apostrophes, so they
// could never match — every "I'm hearing..." rumour was silently filed as film study, which is the
// opposite of what this module is for. Written against the text as it actually is.
const FIRSTHAND = /\b(i (saw|watched|spoke|talked|asked|was there)|i ve seen|when i (was|trained)|he told me|i cornered|my sources?)\b/;
// NO BARE "per". It matched "strikes per minute" and flagged 15 STATISTICS as hearsay against 1
// genuine secondhand phrase — a 94% false-positive rate that inverted this module's whole purpose:
// verifiable numbers and independent film reads were demoted to "amplified rumour", so eleven
// analysts each concluding McGregor looks unmotivated was reported as one rumour with eleven
// megaphones. Attribution needs a named attributor ("per Helwani"), never the preposition alone.
const SECONDHAND = /(i m hearing|i am hearing|hearing that|reportedly|reports? (say|said|are)|according to|sources? (say|said|tell)|word is|rumou?r|apparently|supposedly|allegedly|it s been said|per (ariel|helwani|espn|dana|the ufc|his (coach|team|manager)))/;
function kindOf(c) {
  const t = norm(c.claim + " " + c.quote);
  if (c.claimClass === "prediction") return "direct_pick_or_prediction";
  if (c.claimClass === "rumor" || SECONDHAND.test(t)) return c.claimClass === "rumor" ? "rumor" : "secondhand_report";
  if (FIRSTHAND.test(t)) return "firsthand_statement";
  if (c.claimClass === "statistical") return "verifiable_statistical_claim";
  if (c.claimClass === "hard_fact") return "verified_hard_fact";
  if (c.claimClass === "injury_health" || c.claimClass === "training_camp") return "current_condition_report";
  if (c.claimClass === "film_study") return "film_study_observation";
  if (c.claimClass === "matchup_analysis") return "matchup_inference";
  if (c.claimClass === "psychological") return "psychological_interpretation";
  return "unsupported_narrative";
}

// ---------------------------------------------------------------------------------------------
// 3. SOURCE INDEPENDENCE — origins vs amplifiers.
//
// This is the heart of the layer. Phase 5 tells us how many CHANNELS said a thing. That is not the
// same as how many people independently KNOW it:
//   - a reported rumour ("he has staph")      -> ONE origin, N amplifiers. Whoever broke it knows;
//                                                everyone else is repeating.
//   - a public record ("86% TDD", "he's 37")  -> ONE origin (the stat sheet). Ten channels reading
//                                                the same number is not ten confirmations.
//   - a film read ("his chin rises")          -> N independent observations. Each analyst watched
//                                                the tape and reached it themselves.
// Collapsing these would let a megaphone masquerade as consensus.
// ---------------------------------------------------------------------------------------------
// A NAMED attributor only. A bare "per" matched "strikes per minute" and flagged 15 statistics as
// hearsay against 1 real secondhand phrase — a 94% false-positive rate.
const CITES = /\b(ariel helwani|helwani|dana white|espn|mma junkie|mma fighting|according to \w+|reported by \w+|his (coach|team|manager) (said|told)|the ufc said|broke the (story|news))\b/i;

function originAnalysis(group) {
  const channels = [...new Set(group.flatMap((c) => c.sources || [c.channel]).filter(Boolean))];
  const mentions = group.reduce((a, c) => a + (c.mentionCount || 1), 0);

  // UNION THE ORIGINS PER CLAIM — never let one claim's kind decide the whole group.
  //
  // The first version cascaded: if ANY claim in the group was secondhand, the entire group became
  // "external_report" with ONE origin. So eleven analysts independently observing that McGregor
  // looks unmotivated were reported as one rumour with eleven megaphones — the exact inversion this
  // module exists to prevent, committed by the module itself. A group can legitimately contain a
  // reported reason AND ten independent film reads; the honest count is the union of who actually
  // knows something, claim by claim.
  const ids = new Set();
  const cited = [];
  for (const c of group) {
    const k = kindOf(c);
    const chans = c.sources || [c.channel];
    if (k === "rumor" || k === "secondhand_report") {
      const m = String(c.quote).match(CITES);
      if (m) cited.push(m[0].trim());
      ids.add(`report:${norm(m ? m[0] : "unnamed")}`);        // the reporter is the origin, not the repeaters
    } else if (k === "verified_hard_fact" || k === "verifiable_statistical_claim") {
      ids.add(`record:${norm(c.claim).slice(0, 28)}`);        // the record is the origin; readers are not confirmations
    } else {
      for (const ch of chans) ids.add(`analyst:${norm(ch)}`); // each analyst reached this themselves
    }
  }
  const originIds = [...ids];
  const independentOrigins = originIds.length;
  const analyticalChannels = [...new Set(group.filter((c) => ["film_study_observation", "matchup_inference", "psychological_interpretation"].includes(kindOf(c)))
    .flatMap((c) => c.sources || [c.channel]))];
  const reportIds = originIds.filter((i) => i.startsWith("report:"));
  const recordIds = originIds.filter((i) => i.startsWith("record:"));
  const originType = reportIds.length && reportIds.length === originIds.length ? "external_report"
    : recordIds.length && recordIds.length === originIds.length ? "public_record"
    : analyticalChannels.length ? "independent_analysis" : "commentary";

  return {
    originType,
    independentOrigins,                       // how many people actually KNOW this independently
    originIds,                                // WHO they are — union these across topics, never add
    amplifyingChannels: channels.length,      // how many repeated it
    totalMentions: mentions,                  // how often it was said in total
    independentObservations: analyticalChannels.length,
    citedOrigins: cited,
    reportingChain: originType === "external_report"
      ? `${cited.length ? cited.join(", ") : "unnamed original report"} -> ${channels.length} channel(s)`
      : originType === "public_record" ? `public record -> ${channels.length} channel(s)`
      : `${analyticalChannels.length} independent analyst(s)`,
    // the sentence that stops a megaphone reading as consensus
    note: originType === "external_report" && channels.length > 2
      ? `${channels.length} channels repeat this, but it traces to ${independentOrigins} origin(s) — amplification, not confirmation`
      : originType === "public_record" && channels.length > 2
      ? `${channels.length} channels cite the same public record — one origin, not ${channels.length} confirmations`
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// 4. RELEVANCE — a true fact can still be weak evidence for THIS fight.
// An old submission loss is not current submission vulnerability without supporting context.
// ---------------------------------------------------------------------------------------------
function relevanceOf(c) {
  const t = norm(c.claim + " " + c.quote);
  if (c.cardEvidence === "off_card") return "irrelevant_to_current_matchup";
  if (c.claimClass === "prediction") return "weakly_relevant";           // a pick is not evidence
  if (["injury_health", "training_camp"].includes(c.claimClass) || has(t, "this camp", "fight week", "weigh in", "short notice")) return "current_fighter_condition";
  if (c.cardEvidence === "current_matchup" || c.claimClass === "matchup_analysis") return "direct_current_matchup";
  if (c.cardEvidence === "historical_performance") {
    return has(t, "always", "never", "tends to", "every time", "career") ? "stable_historical_tendency" : "opponent_specific_historical";
  }
  if (["film_study", "statistical"].includes(c.claimClass)) return "stable_historical_tendency";
  if (c.claimClass === "unsupported_narrative") return "weakly_relevant";
  return "general_career_background";
}

// ---------------------------------------------------------------------------------------------
// 5. FRESHNESS — when does the INFORMATION apply, not when was the video posted?
// A recent video must never make an old observation look current.
// ---------------------------------------------------------------------------------------------
function freshnessOf(c) {
  const t = norm(c.claim + " " + c.quote);
  if (has(t, "fight week", "weigh in", "weighed in", "face off", "open workout", "yesterday", "today")) return "current_fight_week";
  if (has(t, "this camp", "in camp", "training for this", "sparring for", "short notice", "new coach", "changed camp")) return "current_training_camp";
  if (has(t, "last fight", "coming off", "last time out", "his last", "recent fights", "last three")) return "recent_fights";
  if (has(t, "always", "never been", "career", "tends to", "historically", "every time", "throughout")) return "long_term_tendency";
  if (/\b(20(0|1|2)[0-9])\b/.test(t) || has(t, "years ago", "back then", "used to", "in his prime", "at the time")) return "stale_or_dated";
  return "unknown_timeframe";
}

// ---------------------------------------------------------------------------------------------
// 6. CREDIBILITY — component labels, never one opaque number.
// ---------------------------------------------------------------------------------------------
function credibilityOf(c, group, origin) {
  const t = norm(c.claim + " " + c.quote);
  const kind = kindOf(c);
  const comp = {
    hasExactQuote: !!(c.quote && c.quote.length > 12),
    firsthand: kind === "firsthand_statement",
    secondhand: kind === "secondhand_report" || kind === "rumor",
    verifiable: ["verified_hard_fact", "verifiable_statistical_claim"].includes(kind),
    checkableAgainstFootageOrRecord: ["verified_hard_fact", "verifiable_statistical_claim", "film_study_observation"].includes(kind),
    specific: /\d/.test(t) || t.split(" ").length >= 8,
    givesSupportingExample: has(t, "for example", "when he", "against ", "in the ", "you saw", "watch the"),
    independentlyCorroborated: origin.independentOrigins >= 2,
    amplifiedOnly: origin.amplifyingChannels >= 3 && origin.independentOrigins === 1,
    contradicted: false,   // filled in by the topic pass, which alone sees both sides
    recency: freshnessOf(c),
  };
  // a transparent tally, shown WITH its parts — never a bare score
  const plus = [comp.hasExactQuote, comp.firsthand, comp.verifiable, comp.checkableAgainstFootageOrRecord,
    comp.specific, comp.givesSupportingExample, comp.independentlyCorroborated].filter(Boolean).length;
  const minus = [comp.secondhand, comp.amplifiedOnly, comp.recency === "stale_or_dated",
    comp.recency === "unknown_timeframe", kind === "unsupported_narrative", kind === "psychological_interpretation"].filter(Boolean).length;
  comp.strength = plus >= 5 && minus === 0 ? "strong" : plus >= 3 && minus <= 1 ? "moderate" : plus >= 2 ? "weak" : "very_weak";
  comp._plus = plus; comp._minus = minus;
  return comp;
}

// ---------------------------------------------------------------------------------------------
// 7. MARKET-AWARENESS — descriptive only. Public is not automatically useless; obscure is not
// automatically valuable. No edge is estimated here, and none may be inferred from these labels.
// ---------------------------------------------------------------------------------------------
function marketAwarenessOf(topic, origin, items) {
  const kinds = items.map(kindOf);
  if (kinds.some((k) => k === "rumor")) return "difficult_to_verify";
  if (topic === "injury_health" || topic === "short_notice" || topic === "coaching_change") return "newly_emerging";
  if (["statistical_claim", "recent_form", "size_reach", "inactivity_layoff"].includes(topic)) return "widely_public_probably_in_the_market";
  if (origin.amplifyingChannels >= 5) return "widely_public_probably_in_the_market";
  if (origin.originType === "independent_analysis" && origin.independentObservations <= 2) return "niche_analytical_interpretation";
  if (origin.originType === "independent_analysis") return "public_but_possibly_underweighted";
  return "unknown";
}

// ---------------------------------------------------------------------------------------------
// 8. CONTRADICTIONS — two claims are not contradictory just because they point different ways.
// ---------------------------------------------------------------------------------------------
const PHASE = /\b(round (one|two|three|1|2|3)|early|late|first round|championship rounds|deep water|if it goes long|opening)\b/;
function contradictionType(a, b) {
  const ta = norm(a.claim + " " + a.quote), tb = norm(b.claim + " " + b.quote);
  const ka = kindOf(a), kb = kindOf(b);
  // both talk about different parts of the fight -> both can be true
  if (PHASE.test(ta) && PHASE.test(tb)) return "different_predicted_fight_phases";
  // one asserts a fact, the other interprets it
  if (["verified_hard_fact", "verifiable_statistical_claim"].includes(ka) !== ["verified_hard_fact", "verifiable_statistical_claim"].includes(kb))
    return "different_interpretations_of_the_same_fact";
  // two checkable facts that disagree
  if (["verified_hard_fact", "verifiable_statistical_claim"].includes(ka) && ["verified_hard_fact", "verifiable_statistical_claim"].includes(kb))
    return "factual_disagreement";
  // opinions that can coexist ("great boxer" / "no one-punch power")
  return "compatible_claims";
}

// ---------------------------------------------------------------------------------------------
// 9. ENTITY RESOLUTION — auto-captions garble names ("Kong Wang" for "Cong Wang"). Resolve
// conservatively, record HOW, and never silently rewrite: the raw caption name is always kept.
// ---------------------------------------------------------------------------------------------
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function resolveEntity(rawName, bout, opts = {}) {
  const raw = String(rawName || "");
  const n = norm(raw);
  const cands = bout ? [bout.a, bout.b] : (opts.roster || []);
  const out = { rawCaptionName: raw, resolvedFighter: null, method: null, confidence: "unresolved", needsHumanReview: false };
  for (const f of cands) {
    if (n === f.norm) { out.resolvedFighter = f.name; out.method = "exact"; out.confidence = "high"; return out; }
    if ((f.aliases || []).some((a) => norm(a) === n)) { out.resolvedFighter = f.name; out.method = "known_alias"; out.confidence = "high"; return out; }
  }
  for (const f of cands) {
    const sn = f.surname, ln = n.split(" ").pop();
    if (sn && ln && sn === ln && !f.ambiguous) { out.resolvedFighter = f.name; out.method = "unambiguous_surname"; out.confidence = "high"; return out; }
    // conservative fuzzy: only inside the bout, only a near-miss, and only with the opponent as context
    if (sn && ln && lev(sn, ln) <= 2 && Math.abs(sn.length - ln.length) <= 2 && sn.length >= 4) {
      out.resolvedFighter = f.name; out.method = `fuzzy_in_bout_context(edit_distance=${lev(sn, ln)})`;
      out.confidence = "low"; out.needsHumanReview = true;  // low confidence must NEVER become strong evidence
      return out;
    }
  }
  out.needsHumanReview = !!opts.material;
  return out;
}

module.exports = { topicOf, kindOf, originAnalysis, relevanceOf, freshnessOf, credibilityOf,
  marketAwarenessOf, contradictionType, resolveEntity, norm, TOPICS };
