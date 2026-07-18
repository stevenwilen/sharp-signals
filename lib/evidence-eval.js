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

// WHAT KIND OF THING IS THE ORIGIN? The three answers are genuinely different and the whole rule
// turns on telling them apart:
//
//   REPORTED   — a fact about the world somebody else established. Injuries, camp news, withdrawals,
//                rumours. The origin is whoever KNOWS it; every channel carrying it is an amplifier.
//                Nobody independently observes a staph infection from a preview desk.
//   RECORDED   — a public record. Stats, ages, results-to-date. The origin is the record; ten
//                channels reading the same stat sheet is not ten confirmations.
//   OBSERVED   — an independent read of shared material. Film study, matchup inference, a
//                psychological call. Each analyst watched the tape and reached it themselves, so each
//                genuinely is an origin. (They are not independent of the FOOTAGE — see the note in
//                originAnalysis — but they are independent JUDGEMENTS, which is what the rules count.)
//   FIRSTHAND  — the speaker was there. A cornerman, a training partner, the fighter. An origin of one.
//
// `current_condition_report` sat in neither list and fell to the default, which minted one origin PER
// CHANNEL. That is the exact inversion of the cardinal rule, in the counter the rule is made of: five
// channels each saying "Holland has a staph infection" — phrased plainly, so no secondhand cue fired —
// returned FIVE origins, and five is MAJOR. One reporter's story could move the forecast the maximum
// the engine can emit, and the printed origin count would have read "5" to anyone checking.
const REPORTED_KINDS = new Set(["rumor", "secondhand_report", "current_condition_report"]);
const RECORDED_KINDS = new Set(["verified_hard_fact", "verifiable_statistical_claim"]);
const OBSERVED_KINDS = new Set(["film_study_observation", "matchup_inference", "psychological_interpretation"]);

// Words that carry no identity. Two channels wording one rumour differently must fingerprint the same,
// or "amplifier" collapses back into "origin" through paraphrase.
const STOP = new Set(("a an the is are was were be been being he she it they him her his hers its their them" +
  " and or but if then than that this these those to of in on at by for with from as into over about" +
  " has have had do does did will would can could may might must should i you we s t re ve ll not no" +
  " very really just also too more most much many some any all both each other another so such").split(" "));

// The content fingerprint of a claim: its meaning-bearing words, order-independent.
//
// This replaces `norm(c.claim).slice(0, 28)`, which keyed identity on the first 28 characters of the
// raw text. That collapsed only VERBATIM repeats, so two paraphrases of one stat minted two origins
// (over-count) while two unrelated claims sharing an opening clause minted one (under-count). Identity
// has to survive rewording, because rewording is exactly what amplification looks like.
// Numbers are extracted from the RAW text, before norm() sees them. norm strips punctuation, so it
// turns "4.2" into "4 2" — two one-character tokens that the length filter then drops entirely. The
// figure is the whole identity of a statistic ("4.2 significant strikes per minute" IS the number),
// and it was silently falling out of the fingerprint, so two channels citing one stat sheet looked
// like two independent records.
function numericTokens(text) {
  return (String(text || "").match(/\d+(?:\.\d+)?%?/g) || []).map((n) => `n:${n}`);
}
function contentTokens(text) {
  const words = norm(String(text || "")).split(" ").filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  return new Set([...words, ...numericTokens(text)]);
}
function claimFingerprint(text) {
  const t = [...contentTokens(text)].sort();
  return t.join(".").slice(0, 80) || "empty";
}

// HOW SIMILAR MUST TWO CLAIMS BE TO BE ONE STORY?
//
// Exact fingerprint matching is not enough, and assuming otherwise is how this bug survives its own
// fix. Amplification does not repeat verbatim — it REWORDS. "Holland has a staph infection", "a staph
// infection is affecting Holland" and "Holland is dealing with staph, infection confirmed" are one
// story told three ways, and keying identity on the exact token set makes them three origins: the
// per-channel bug walking back in through paraphrase.
//
// So cluster on overlap. Measured on the case above: the paraphrases score 0.6-0.75 against each
// other, while an unrelated rumour about the same fighter ("Holland has visa problems") scores 0.2.
// 0.4 sits in that gap with room on both sides.
//
// Single-linkage, which errs toward MERGING: two stories that might be one become one origin. That
// under-counts, and under-counting is the safe direction — the failure this module exists to prevent
// is a megaphone reading as a consensus, never a chorus reading as a single voice.
const SAME_STORY = 0.4;
const jaccard = (a, b) => {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// Group claims into stories by content overlap. Returns an array of cluster indices, one per claim.
// Two claims are the same story if their wording overlaps enough, OR if they cite the same FIGURE and
// agree on at least one content word. The second rule exists because prose paraphrase defeats raw
// token overlap on exactly the claims where identity is least ambiguous: "he lands 4.2 significant
// strikes per minute" and "he is landing 4.2 sig strikes a minute" score 0.29 against each other —
// lands/landing and significant/sig are the same words to a reader and different strings to a set —
// while the "4.2" they share is the stat itself. Requiring a shared content word as well keeps "he's
// 37" and "37 fights" apart.
//
// Both rules merge. Neither splits. Every path here errs toward FEWER origins.
const numerics = (s) => new Set([...s].filter((t) => t.startsWith("n:")));
const words = (s) => new Set([...s].filter((t) => !t.startsWith("n:")));
function sameStory(a, b) {
  if (jaccard(a, b) >= SAME_STORY) return true;
  const na = numerics(a), nb = numerics(b);
  if (!na.size || !nb.size) return false;
  const sharedNumber = [...na].some((n) => nb.has(n));
  const sharedWord = [...words(a)].some((w) => words(b).has(w));
  return sharedNumber && sharedWord;
}

function clusterByStory(tokenSets) {
  const parent = tokenSets.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      if (sameStory(tokenSets[i], tokenSets[j])) parent[find(i)] = find(j);
    }
  }
  return tokenSets.map((_, i) => find(i));
}

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
  const amplifiersById = new Map();          // originId -> the channels carrying it
  const roles = new Map();                   // originId -> what KIND of knowing it is (breakdown only, never identity)
  const addAmp = (id, chans) => {
    if (!amplifiersById.has(id)) amplifiersById.set(id, new Set());
    for (const ch of chans) if (ch) amplifiersById.get(id).add(ch);
  };

  // PASS 1 — cluster the claims whose identity is the STORY, not the speaker. Unnamed reports and
  // public records both have this shape: many channels, one underlying thing. Named reports skip
  // clustering because the attributor already IS the identity.
  const storyIdx = new Map();   // group index -> cluster id, for unnamed reports and records
  {
    const idxs = [], toks = [];
    group.forEach((c, i) => {
      const k = kindOf(c);
      const named = REPORTED_KINDS.has(k) && (String(c.quote || "").match(CITES) || String(c.claim || "").match(CITES));
      if ((REPORTED_KINDS.has(k) && !named) || RECORDED_KINDS.has(k)) { idxs.push(i); toks.push(contentTokens(c.claim)); }
    });
    const clusters = clusterByStory(toks);
    // Name each cluster by its lexicographically smallest fingerprint, so the id is stable regardless
    // of the order the claims arrived in — an origin id that depends on array order is not an identity.
    const repr = new Map();
    clusters.forEach((cl, n) => {
      const fp = claimFingerprint(group[idxs[n]].claim);
      if (!repr.has(cl) || fp < repr.get(cl)) repr.set(cl, fp);
    });
    clusters.forEach((cl, n) => storyIdx.set(idxs[n], repr.get(cl)));
  }

  for (let gi = 0; gi < group.length; gi++) {
    const c = group[gi];
    const k = kindOf(c);
    const chans = c.sources || [c.channel];

    if (REPORTED_KINDS.has(k)) {
      // The origin is whoever established the fact. If they are NAMED, that name is the identity: ten
      // outlets "per Helwani" are one origin called helwani with ten amplifiers.
      const m = String(c.quote || "").match(CITES) || String(c.claim || "").match(CITES);
      if (m) cited.push(m[0].trim());
      // If they are NOT named, the STORY is the identity — not the literal string "unnamed". Keying
      // every anonymous rumour to `report:unnamed` collapsed genuinely different stories into one
      // origin (a staph rumour and a visa problem became one), which under-counts as badly as the
      // per-channel bug over-counts. Two different unnamed rumours are two origins; ONE unnamed rumour
      // repeated by five channels — however they word it — is one origin with five amplifiers.
      const id = m ? `report:${norm(m[0])}` : `report:anon:${storyIdx.get(gi)}`;
      ids.add(id);
      addAmp(id, chans);

    } else if (RECORDED_KINDS.has(k)) {
      // A RECORD IS IDENTIFIED BY ITS SUBJECT AND ITS FIGURE, not by the sentence around it.
      //
      // originAnalysis runs PER TOPIC GROUP, so story clustering can only ever merge claims filed
      // under the same (fighter, topic, direction) — and a public record does not respect that
      // boundary. "Usman is 39" and "Usman is 39, a significant age disadvantage against Du Plessis"
      // are the same fact about the same man, filed under `other` and `recent_form`, and no
      // within-group clustering can ever see them together. The bout-level union then counts them
      // twice.
      //
      // The old code got this right BY ACCIDENT: keying on norm(claim).slice(0,28) made both claims
      // the literal string "kamaru usman is 39 years old", so they collapsed. That accident was doing
      // real work, and a "fix" that made the fingerprint more precise broke it — measured on the real
      // card, this bout went from 2 origins to 4 on evidence from a SINGLE channel.
      //
      // So key on what a record actually IS: who it is about, and the number. Stable across topics,
      // stable across rewording, and it cannot be inflated by adding commentary to the sentence.
      const nums = [...numericTokens(c.claim)].sort();
      const id = nums.length
        ? `record:${norm(c.about || "")}:${nums.join(",")}`
        : `record:${storyIdx.get(gi)}`;                       // no figure — fall back to the story
      ids.add(id);
      addAmp(id, chans);

    } else {
      // A PERSON IS ONE ORIGIN, whatever kinds of claim they make.
      //
      // The rest — film reads, matchup inference, psychological calls, firsthand accounts, direct
      // picks, unsupported narrative — are all things this channel arrived at itself, so the channel
      // is the identity. It is tempting to namespace by kind (`analyst:` / `firsthand:` / `opinion:`)
      // to make the composition legible, and that is exactly wrong: one channel that both reads the
      // tape AND makes a pick would mint TWO ids and count as two independent people. Measured on the
      // real card, doing that took Usman's bout from 2 origins to 5 — straight through MAJOR, in the
      // module whose entire job is to stop one voice reading as a consensus.
      //
      // The kind is recorded in `roles` for the breakdown. The IDENTITY is the person.
      for (const ch of chans) {
        const id = `analyst:${norm(ch)}`;
        ids.add(id); addAmp(id, [ch]);
        if (!roles.has(id)) roles.set(id, new Set());
        roles.get(id).add(OBSERVED_KINDS.has(k) ? "analytical" : k === "firsthand_statement" ? "firsthand" : "opinion");
      }
    }
  }
  const originIds = [...ids];
  const independentOrigins = originIds.length;
  const analyticalChannels = [...new Set(group.filter((c) => OBSERVED_KINDS.has(kindOf(c)))
    .flatMap((c) => c.sources || [c.channel]))];
  const reportIds = originIds.filter((i) => i.startsWith("report:"));
  const recordIds = originIds.filter((i) => i.startsWith("record:"));
  const originType = reportIds.length && reportIds.length === originIds.length ? "external_report"
    : recordIds.length && recordIds.length === originIds.length ? "public_record"
    : analyticalChannels.length ? "independent_analysis" : "commentary";

  // THE BREAKDOWN, NOT JUST THE NUMBER. "5 origins" invites the reader to hear "five people checked".
  // Separating the kinds is what makes the count auditable: a reader can see that four of them are one
  // reporter's story carried by four channels, which no single integer can say.
  const maxAmplifiersOnOneOrigin = Math.max(0, ...[...amplifiersById.values()].map((s) => s.size));
  // Each ORIGIN is counted exactly once, under its strongest role. A channel that both reads the tape
  // and makes a pick is one person with one origin — the role describes them, it does not multiply them.
  const roleOf = (id) => {
    const r = roles.get(id);
    if (!r) return null;
    return r.has("firsthand") ? "firsthand" : r.has("analytical") ? "analytical" : "opinion";
  };
  const personIds = originIds.filter((i) => i.startsWith("analyst:"));
  const composition = {
    reported: originIds.filter((i) => i.startsWith("report:")).length,
    recorded: recordIds.length,
    analytical: personIds.filter((i) => roleOf(i) === "analytical").length,
    firsthand: personIds.filter((i) => roleOf(i) === "firsthand").length,
    opinion: personIds.filter((i) => roleOf(i) === "opinion").length,
  };

  return {
    originType,
    independentOrigins,                       // how many people actually KNOW this independently
    originIds,                                // WHO they are — union these across topics, never add
    amplifyingChannels: channels.length,      // how many repeated it
    totalMentions: mentions,                  // how often it was said in total
    independentObservations: analyticalChannels.length,
    citedOrigins: cited,
    // What the count is MADE OF. Requested explicitly so a reader can tell a megaphone from a chorus.
    composition,
    // Per-origin amplification: originId -> the channels carrying it. This is the receipt for
    // "one origin, five amplifiers".
    amplifiersByOrigin: Object.fromEntries([...amplifiersById].map(([k, v]) => [k, [...v].sort()])),
    maxAmplifiersOnOneOrigin,
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
