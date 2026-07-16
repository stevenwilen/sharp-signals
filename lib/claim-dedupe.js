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

// Claims about the same fighter that point in OPPOSITE directions — analysts disagreeing. These are
// the most interesting rows in the whole system and must never be averaged away.
function conflicts(merged) {
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length; j++) {
      const a = merged[i], b = merged[j];
      if (norm(a.about) !== norm(b.about)) continue;
      if (a.direction === "neutral" || b.direction === "neutral") continue;
      if (a.direction === b.direction) continue;
      if (a.evidenceType !== b.evidenceType) continue; // same topic, opposite reads
      out.push({ about: a.about, evidenceType: a.evidenceType, a, b });
    }
  }
  return out;
}

module.exports = { dedupe, conflicts, jaccard, tokens, norm, SIM_THRESHOLD };
