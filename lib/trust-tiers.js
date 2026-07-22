// TRUST TIERS — the ONE ladder every book bets from, EXTRACTED (never recomputed) from the sealed v7
// forecast. v7 already produces a win probability at two evidence strengths for each bout:
//   CONFIRMED   — core, systemCentral, origins-strict (the frozen v7.0.0 model)
//   SPECULATIVE — creative, exploration.creativeCentralA, a deliberately looser bar
// This module only NAMES those and maps each book to the tiers it acts on, so the three books can never
// diverge from the frozen forecast and "how much we trust the information" becomes the ONLY thing that
// separates them. NO new math: every probability here comes verbatim from the sealed forecast.
//
// NESTED BY TRUST: a CONFIRMED edge is taken by every book; a SPECULATIVE-only edge is taken by the
// lower-trust books but NOT disciplined Paper. So as a bet gains confirmation it climbs the ladder
// Research -> Entertainment -> Paper. The conservative bound (the worse end of v7's stated range) is the
// max-acceptable-price input, exactly as lib/contract-value already uses it — a tier only changes WHICH
// probability feeds the same gate, never the gate itself.

const round4 = (n) => (n == null ? null : Math.round(n * 1e4) / 1e4);

// Which tiers each book acts on. A book takes a bet if an edge exists at ANY tier it lists.
const BOOK_TIERS = {
  paper: ["confirmed"],                        // disciplined $10k — confirmed core edge ONLY
  entertainment: ["confirmed", "speculative"], // real $100 — also acts on the speculative tier
  research: ["confirmed", "speculative"],      // paper $10k — the speculative tier, no separate haircut model
};
const tiersForBook = (book) => BOOK_TIERS[book] || [];

// Extract the two probability tiers for a bout's FAVORED side, straight from the sealed forecast.
// Returns null when the bout can't be read (exactly two named fighters + a systemCentral are required) —
// a refusal, never a guess. The exploration fields are keyed to "fighter A" (the first name in `fight`),
// so a favored underdog gets the complement.
function boutTiers(fbout) {
  const sc = fbout && fbout.systemCentral;
  if (!sc || typeof sc !== "object") return null;
  const fighters = Object.keys(sc);
  if (fighters.length !== 2) return null;

  const A = String(fbout.fight || "").split(" vs ")[0].trim();
  const range = fbout.systemRange || {};
  const favored = range.forFighter && sc[range.forFighter] != null
    ? range.forFighter
    : (sc[fighters[0]] >= sc[fighters[1]] ? fighters[0] : fighters[1]);
  const opponent = fighters.find((f) => f !== favored);

  // Conservative bound = the end of v7's range that makes the FAVORED position look worse. If the range
  // is stated for the favored fighter it's the low end; otherwise it's 1 - the opponent's high end.
  const conservative = range.forFighter === favored
    ? (range.low ?? null)
    : (range.high != null ? round4(1 - range.high) : null);

  const ex = fbout.exploration || {};
  const cA = ex.creativeCentralA;                       // creative win prob for fighter A
  const specCentral = cA == null ? null : (favored === A ? cA : round4(1 - cA));

  return {
    boutId: fbout.boutId || null,
    fight: fbout.fight || null,
    favored,
    opponent,
    confirmed: { central: sc[favored] ?? null, conservative },                 // Paper tier
    speculative: {                                                             // Entertainment/Research tier
      central: specCentral,
      conservative,                                                           // same range bound; only the central moves
      activeHypotheses: ex.activeHypotheses || 0,
      capped: !!ex.capped,
      available: specCentral != null && (ex.activeHypotheses || 0) > 0,        // v7 held a creative view here
    },
  };
}

// The favored-side central probability AT a given tier (or null if that tier has no view here).
function centralAtTier(fbout, tier) {
  const t = boutTiers(fbout);
  if (!t) return null;
  if (tier === "confirmed") return t.confirmed.central;
  if (tier === "speculative") return t.speculative.available ? t.speculative.central : null;
  return null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const lastName = (s) => norm(s).split(" ").filter(Boolean).pop() || "";

// The central win probability for a SPECIFIC fighter at a tier — favored side gets it directly, the
// underdog gets the complement. Returns null (fail closed) if the fighter can't be matched unambiguously
// to one side or that tier has no view. This is how a book values a bet on EITHER side at its tier.
function centralForSide(fbout, fighter, tier) {
  const t = boutTiers(fbout);
  if (!t || !fighter) return null;
  const favCentral = tier === "confirmed" ? t.confirmed.central : (t.speculative.available ? t.speculative.central : null);
  if (favCentral == null) return null;
  const matchesFav = norm(fighter) === norm(t.favored) || lastName(fighter) === lastName(t.favored);
  const matchesOpp = norm(fighter) === norm(t.opponent) || lastName(fighter) === lastName(t.opponent);
  if (matchesFav && !matchesOpp) return favCentral;
  if (matchesOpp && !matchesFav) return round4(1 - favCentral);
  return null;   // ambiguous / unmatched -> no valuation
}

module.exports = { boutTiers, centralAtTier, centralForSide, tiersForBook, BOOK_TIERS };
