// CLAIM DEDUPLICATION — merge restatements, never merge distinct claims, and never confuse
// repetition with corroboration.
//
// Two sources of duplication:
//   1. CHUNK OVERLAP. Windows overlap ~2k chars on purpose so a claim spoken across a boundary is
//      seen whole by at least one of them. That deliberately produces doubles; this undoes them.
//   2. REPEATED DISCUSSION. An analyst circles back to the same point three times in a podcast.
//
// THE DISTINCTION THAT MATTERS: one analyst saying a thing five times is ONE opinion said loudly.
// Five analysts saying it independently is corroboration. Collapsing those two into a single
// "mentions: 5" would manufacture agreement out of a monologue — and this project has already been
// burned once by counting correlated repeats as independent evidence (the same Preview and Best-Bets
// video, counted twice, inflated n and pushed sources over the trust threshold). So occurrences are
// kept per source, and `independentSources` counts CHANNELS, never mentions.
//
// `corroborated` is computed HERE, from what every source said — never by the model, which can only
// see one transcript and would happily vouch for itself.

const STOP = new Set(["the", "and", "his", "her", "has", "have", "had", "was", "were", "are", "is",
  "for", "with", "that", "this", "not", "but", "can", "will", "would", "should", "get", "gets",
  "got", "him", "she", "they", "them", "their", "from", "into", "than", "then", "when", "who",
  "which", "what", "very", "much", "more", "most", "just", "only", "also", "been", "being"]);

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Two claims are the SAME claim only if they are about the same fighter AND say substantially the
// same thing. Same fighter alone is nowhere near enough: "his chin is suspect" and "his wrestling is
// elite" are both about one man and are not remotely the same claim.
const SIM_THRESHOLD = 0.55;

function sameClaim(a, b) {
  if (norm(a.about) !== norm(b.about)) return false;
  return jaccard(a._tok, b._tok) >= SIM_THRESHOLD;
}

// dedupe(claims) -> merged claims, each carrying every occurrence that produced it.
function dedupe(claims) {
  const groups = [];
  for (const c of claims) {
    const withTok = { ...c, _tok: tokens(c.claim) };
    const g = groups.find((grp) => sameClaim(grp.rep, withTok));
    if (g) g.members.push(withTok);
    else groups.push({ rep: withTok, members: [withTok] });
  }

  return groups.map((g) => {
    // The representative is the member with the strongest claim class, then the longest quote —
    // prefer the statement of the claim that is most checkable.
    const RANK = { hard_fact: 0, statistical: 1, injury_health: 2, film_study: 3, matchup_analysis: 4,
      training_camp: 5, rumor: 6, prediction: 7, psychological: 8, unsupported_narrative: 9 };
    const rep = g.members.slice().sort((a, b) =>
      (RANK[a.claimClass] ?? 9) - (RANK[b.claimClass] ?? 9) || String(b.quote).length - String(a.quote).length)[0];

    const byChannel = {};
    for (const m of g.members) byChannel[m.channel] = (byChannel[m.channel] || 0) + 1;
    const channels = Object.keys(byChannel);

    const { _tok, ...clean } = rep;
    return {
      ...clean,
      // EVERY occurrence is preserved — quote, timestamp, chunk and segment all stay traceable.
      occurrences: g.members.map((m) => ({
        channel: m.channel, videoId: m.videoId, url: m.url, publishedAt: m.publishedAt,
        chunkId: m.chunkId, segment: m.segment, quote: m.quote,
        claimClass: m.claimClass, direction: m.direction, confidence: m.confidence,
      })),
      mentionCount: g.members.length,             // how often it was SAID (repetition)
      independentSources: channels.length,        // how many ANALYSTS said it (corroboration)
      sources: channels,
      mentionsPerSource: byChannel,               // repetition, broken out per analyst
      // Computed here, from the full set — never asserted by the model.
      corroborated: channels.length >= 2,
      // A claim can disagree with itself across sources; flag rather than silently pick a winner.
      directionConflict: new Set(g.members.map((m) => m.direction)).size > 1,
      classSpread: [...new Set(g.members.map((m) => m.claimClass))],
    };
  });
}

// CONFLICT TOPICS — not conflict pairs.
//
// The first version compared every claim to every other and emitted a row per opposing PAIR. On one
// card that produced "1,911 conflicts", which is not 1,911 disagreements: McGregor alone had 50 for
// x 112 against, so the count was an O(n^2) explosion that scales with how much a fighter is
// discussed, not with how much analysts disagree. Worse, it printed FOR/AGAINST by pair position
// (a then b) without checking direction, so the labels were frequently inverted — the report
// literally lied about who thought what.
//
// A conflict is a TOPIC on which analysts take opposing positions: one row per
// (bout, fighter, topic). FOR and AGAINST are always relative to the named proposition — the
// fighter — and are derived from each claim's own `direction`, never from its position in a list.
function conflictTopics(claims) {
  const groups = new Map();
  for (const c of claims) {
    if (c.direction !== "favors_about" && c.direction !== "against_about") continue; // neutral: no position
    const key = `${c.boutId || "-"}|${norm(c.about)}|${c.evidenceType}`;
    if (!groups.has(key)) groups.set(key, { boutId: c.boutId || null, about: c.about, topic: c.evidenceType, favors: [], against: [] });
    groups.get(key)[c.direction === "favors_about" ? "favors" : "against"].push(c);
  }
  const srcOf = (list) => [...new Set(list.flatMap((c) => c.sources || [c.channel]).filter(Boolean))];
  return [...groups.values()]
    .filter((g) => g.favors.length > 0 && g.against.length > 0)
    .map((g) => {
      const fs_ = srcOf(g.favors), as_ = srcOf(g.against);
      return {
        boutId: g.boutId,
        // the labels are meaningless without the reference side, so it is carried explicitly
        proposition: `${g.about} — ${g.topic}`,
        about: g.about, topic: g.topic,
        favorPosition: { claims: g.favors.length, sources: fs_, independentSources: fs_.length,
          examples: g.favors.slice(0, 2).map((c) => c.claim) },
        againstPosition: { claims: g.against.length, sources: as_, independentSources: as_.length,
          examples: g.against.slice(0, 2).map((c) => c.claim) },
        // a disagreement WITHIN one analyst is not the same thing as two analysts disagreeing
        crossSource: fs_.some((s) => !as_.includes(s)) && as_.some((s) => !fs_.includes(s)),
      };
    })
    .sort((a, b) => (b.favorPosition.independentSources + b.againstPosition.independentSources) -
      (a.favorPosition.independentSources + a.againstPosition.independentSources));
}

module.exports = { dedupe, conflictTopics, jaccard, tokens, norm, SIM_THRESHOLD };
