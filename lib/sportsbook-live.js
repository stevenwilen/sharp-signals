// PHASE 8.5 — LIVE, TIMESTAMPED MULTI-BOOK SPORTSBOOK BASELINE.
//
// This service does not predict fights and does not touch Phase 7 reasoning. It supplies one thing:
// a fresh market prior with real provenance, so that a Kalshi executable price can be compared
// against something contemporaneous instead of against a weeks-old opening line.
//
// WHY IT EXISTS. Phase 8's first shadow run proposed 7 positions with "edges" up to 13.6 points.
// All 7 forecasts had zero adjustments and sat exactly on a BFO OPENING line; the entire "edge" was
// the market's drift between the open and now. The stale-prior gate blocked them. This module is
// what eventually unblocks that gate honestly — by producing a prior that is actually current.
//
// THE VENUE CANNOT BE PART OF ITS OWN PRIOR. BFO lists Kalshi (book 29) and Polymarket (book 28) as
// columns alongside FanDuel and DraftKings. Including Kalshi in a "sportsbook consensus" and then
// comparing that consensus to the Kalshi executable price compares Kalshi to itself and
// manufactures agreement out of circularity. Polymarket is excluded for the same family of reason:
// it is a prediction market that arbitrages against Kalshi, not an independent bookmaker. Both
// exclusions are enforced in code, with reasons, not left to a reviewer's memory.
//
// TIMESTAMP HONESTY. BFO publishes no per-quote timestamp. So `sourceTimestamp` is null — truthfully
// — and the real observation is our own RECEIPT time, which bounds when WE saw the price, not when
// the book set it. That distinction is recorded on every quote rather than glossed. Fabricating a
// source timestamp here is exactly the bug that contaminated Phase 7.
require("./env");
const crypto = require("crypto");
const O = require("./odds-history");
const E = require("./evidence-eval");

const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);

// ---- approved books --------------------------------------------------------------------------
// data-b ids are BFO's own stable column ids.
const BOOKS = {
  20: { name: "BetWay", approved: true },
  21: { name: "FanDuel", approved: true },
  22: { name: "DraftKings", approved: true },
  23: { name: "BetMGM", approved: true },
  24: { name: "Caesars", approved: true },
  25: { name: "BetRivers", approved: true },
  26: { name: "BFO-book-26", approved: true, note: "column present on BFO but unnamed in the header; treated as a real book, flagged for identification" },
  27: { name: "BFO-book-27", approved: true, note: "as above" },
  28: { name: "Polymarket", approved: false,
    reason: "prediction market, not an independent sportsbook — it arbitrages against Kalshi, so it is not an independent opinion about the fight" },
  29: { name: "Kalshi", approved: false,
    reason: "this is the venue we trade. Including it in the prior we compare Kalshi against is circular and manufactures agreement" },
};

// Books that are the same underlying operation must count once. Three feeds of one risk desk is one
// opinion — the origins-vs-voices rule from the evidence layer, applied to prices.
//
// BetRivers / BFO-book-26 was established EMPIRICALLY, not assumed: across a full UFC card the two
// columns were byte-identical on 24 of 24 quotes (100%), while every other book pair agreed on only
// 0-13%. That is a mirror, not a coincidence. Counting both would have inflated the independent-book
// count AND understated dispersion, since two identical values shrink the observed range — making a
// thin consensus look both broader and more unanimous than it is.
const SAME_OPERATOR = [
  ["BetRivers", "BFO-book-26"],
];

// Don't rely on this list staying complete. Any two books agreeing on essentially every quote are
// one book, whether or not anyone has registered them here. This runs on live data and flags the
// pair rather than silently counting it twice.
function detectMirrors(perBookQuotes, opts = {}) {
  const threshold = opts.threshold ?? 0.98;
  const minSamples = opts.minSamples ?? 8;
  const books = [...new Set(perBookQuotes.map((q) => q.sportsbook))];
  const found = [];
  for (let i = 0; i < books.length; i++) for (let j = i + 1; j < books.length; j++) {
    const x = books[i], y = books[j];
    let same = 0, tot = 0;
    for (const q of perBookQuotes.filter((q) => q.sportsbook === x)) {
      const m = perBookQuotes.find((r) => r.sportsbook === y && r.matchupId === q.matchupId && r.side === q.side);
      if (!m) continue;
      tot++; if (m.rawOdds === q.rawOdds) same++;
    }
    if (tot >= minSamples && same / tot >= threshold) {
      const registered = SAME_OPERATOR.some((g) => g.includes(x) && g.includes(y));
      found.push({ books: [x, y], identical: same, compared: tot, rate: +(same / tot).toFixed(3), registered,
        note: registered ? "already registered as one operator" : "UNREGISTERED MIRROR — these count as one book but are not in SAME_OPERATOR; register them" });
    }
  }
  return found;
}

const DEFAULTS = {
  minBooks: 2,                       // hard floor
  preferBooks: 3,                    // below this the consensus is flagged thin
  maxQuoteAgeMs: 20 * 60 * 1000,     // a receipt older than this is stale
  maxSnapshotSkewMs: 5 * 60 * 1000,  // sportsbook vs Kalshi snapshot separation
  minOverround: 1.005,
  maxOverround: 1.25,
  maxDispersionPoints: 12,           // books this far apart are not a consensus
};

// An event path is a SITE path, and it must survive the shell that typed it. Git Bash rewrites any
// argument starting with "/" into a Windows path, so `--live-event=/events/ufc-oklahoma-4195`
// arrives as "C:/Program Files/Git/events/ufc-oklahoma-4195" and the fetcher politely requests a
// nonsense URL, gets a 404, and reports "event collection failed" — a shell quoting artifact wearing
// the costume of a data outage. Recover the real path rather than trusting the caller's shell.
function normaliseEventPath(p) {
  if (!p) return null;
  const s = String(p).replace(/\\/g, "/");
  const m = s.match(/\/events\/[a-z0-9-]+/i);
  return m ? m[0] : (s.startsWith("/") ? s : `/${s}`);
}

// ---- 1. collection ---------------------------------------------------------------------------
// Fetch a BFO event page and extract every per-book moneyline with full provenance.
async function collectEvent(rawPath, opts = {}) {
  const eventPath = normaliseEventPath(rawPath);
  const requestStart = Date.now();
  let html = null, err = null;
  if (!eventPath) err = `unusable event path: ${JSON.stringify(rawPath)}`;
  else try { html = await O.fetchText(`https://www.bestfightodds.com${eventPath}`); }
  catch (e) { err = e.message; }
  const requestComplete = Date.now();
  const receiptTs = requestComplete;

  if (err || !html) {
    return { ok: false, eventPath, requestStart, requestComplete,
      collectionStatus: "FAILED", failureReason: err || "empty response",
      quotes: [], rejected: [], responseHash: null };
  }
  const responseHash = sha(html);

  // matchup name rows live in the responsive-header table; odds cells in the second odds-table.
  // Both are keyed by matchup id, which is what ties a price to a bout.
  const names = {};
  for (const m of html.matchAll(/<tr id="mu-(\d+)"[\s\S]{0,400}?\/fighters\/[^"]+"><span class="t-b-fcc">([^<]+)<\/span>/gi))
    names[m[1]] = { a: m[2].trim() };
  // the second fighter is the next fighter row after the mu- row
  for (const mu of Object.keys(names)) {
    const i = html.indexOf(`id="mu-${mu}"`);
    if (i < 0) continue;
    const after = html.slice(i, i + 1400);
    const fs = [...after.matchAll(/\/fighters\/[^"]+"><span class="t-b-fcc">([^<]+)<\/span>/gi)].map((x) => x[1].trim());
    if (fs.length >= 2) names[mu].b = fs[1];
  }

  const quotes = [], rejected = [];
  // data-li="[bookId, side, matchupId]"  side: 1 = fighter A, 2 = fighter B
  for (const m of html.matchAll(/data-li="\[(\d+),(\d),(\d+)\]"><span id="[^"]*"[^>]*>([^<]+)<\/span>/gi)) {
    const [, bookId, side, mu, raw] = m;
    const book = BOOKS[bookId];
    const nm = names[mu];
    const fighter = nm ? (side === "1" ? nm.a : nm.b) : null;
    const base = {
      bookId: Number(bookId), sportsbook: book ? book.name : `unknown-book-${bookId}`,
      matchupId: mu, fighter, side: side === "1" ? "a" : "b",
      rawOdds: String(raw).trim(),
      sourceTimestamp: null,
      sourceTimestampNote: "BFO publishes no per-quote timestamp; this field is null rather than invented",
      receiptTimestamp: new Date(receiptTs).toISOString(),
      requestStart: new Date(requestStart).toISOString(),
      requestComplete: new Date(requestComplete).toISOString(),
      observationBasis: "scrape receipt — bounds when WE observed the displayed price, NOT when the book set it",
      providerResponseId: `${eventPath}@${responseHash}`,
      responseHash,
    };
    if (!book) { rejected.push({ ...base, rejectReason: `unknown book id ${bookId} — not in the approved registry` }); continue; }
    if (!book.approved) { rejected.push({ ...base, rejectReason: `${book.name} excluded: ${book.reason}` }); continue; }
    if (!fighter) { rejected.push({ ...base, rejectReason: `could not map matchup ${mu} side ${side} to a fighter` }); continue; }
    const p = parseAmerican(raw);
    if (p === null) { rejected.push({ ...base, rejectReason: `malformed or suspended odds: "${raw}"` }); continue; }
    quotes.push({ ...base, impliedProbabilityRaw: +p.toFixed(6) });
  }

  return {
    ok: true, eventPath, requestStart, requestComplete, receiptTs,
    collectionStatus: "OK", failureReason: null,
    responseHash, responseBytes: html.length,
    matchups: names, quotes, rejected,
  };
}

// Malformed must fail, never coerce: Number("") is 0, which would imply a 100% favourite.
function parseAmerican(ml) {
  if (ml === null || ml === undefined) return null;
  const s = String(ml).trim().replace(/[▲▼\s]/g, "");
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) < 100) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

// ---- 3. de-vig EACH BOOK SEPARATELY, then combine --------------------------------------------
// Combining raw (vig-included) probabilities first and de-vigging the average is not the same
// operation and is wrong: each book's vig differs, so the average carries a blended vig that
// belongs to no book. Vig is removed per book, then the fair probabilities are combined.
function deVigBook(pA, pB) {
  if (!Number.isFinite(pA) || !Number.isFinite(pB)) return null;
  const overround = pA + pB;
  if (!(overround > 0)) return null;
  return { probA: pA / overround, probB: pB / overround, overround };
}

const DEVIG_METHOD = "per-book proportional normalisation: fair_A = raw_A / (raw_A + raw_B), applied to EACH book before any combination";
const CONSENSUS_METHOD = "unweighted mean of the per-book de-vigged probabilities";

// ---- 2 + 8. eligibility and consensus --------------------------------------------------------
function consensusFor(collection, bout, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
  const nowTs = opts.nowTs ?? Date.now();
  const reasons = [], rejectedHere = [];

  if (!collection.ok)
    return refuse("collection failed: " + collection.failureReason, { collectionStatus: collection.collectionStatus });

  // find the matchup whose two fighters are this bout's, unambiguously
  const hits = Object.entries(collection.matchups || {}).filter(([, n]) =>
    n.a && n.b && ((E.norm(n.a) === bout.a.norm && E.norm(n.b) === bout.b.norm) ||
                   (E.norm(n.a) === bout.b.norm && E.norm(n.b) === bout.a.norm)));
  if (!hits.length) return refuse("no BFO matchup maps to this bout");
  if (hits.length > 1) return refuse(`bout maps to ${hits.length} BFO matchups — ambiguous, refusing to choose`);
  const [muId, mu] = hits[0];
  const swapped = E.norm(mu.a) !== bout.a.norm;

  const mine = collection.quotes.filter((q) => q.matchupId === muId);
  if (!mine.length) return refuse("matchup found but no approved-book quotes on it");

  // pair each book's two sides
  const byBook = {};
  for (const q of mine) (byBook[q.sportsbook] = byBook[q.sportsbook] || {})[q.side] = q;

  const usable = [];
  for (const [name, sides] of Object.entries(byBook)) {
    if (!sides.a || !sides.b) { rejectedHere.push({ sportsbook: name, rejectReason: "only one side quoted — cannot de-vig a one-sided market" }); continue; }
    for (const q of [sides.a, sides.b]) {
      const age = nowTs - Date.parse(q.receiptTimestamp);
      if (age > cfg.maxQuoteAgeMs) { rejectedHere.push({ sportsbook: name, rejectReason: `quote receipt is ${(age / 60000).toFixed(1)} min old — stale` }); sides.stale = true; }
    }
    if (sides.stale) continue;
    const dv = deVigBook(sides.a.impliedProbabilityRaw, sides.b.impliedProbabilityRaw);
    if (!dv) { rejectedHere.push({ sportsbook: name, rejectReason: "could not de-vig" }); continue; }
    if (dv.overround < cfg.minOverround || dv.overround > cfg.maxOverround) {
      rejectedHere.push({ sportsbook: name, rejectReason: `overround ${dv.overround.toFixed(4)} outside [${cfg.minOverround}, ${cfg.maxOverround}] — suspended or misparsed` }); continue;
    }
    // orient to bout fighter A
    const forA = swapped ? dv.probB : dv.probA;
    usable.push({
      sportsbook: name,
      rawOdds: { [bout.a.name]: (swapped ? sides.b : sides.a).rawOdds, [bout.b.name]: (swapped ? sides.a : sides.b).rawOdds },
      rawImplied: { [bout.a.name]: +(swapped ? sides.b : sides.a).impliedProbabilityRaw.toFixed(6), [bout.b.name]: +(swapped ? sides.a : sides.b).impliedProbabilityRaw.toFixed(6) },
      overround: +dv.overround.toFixed(6),
      deViggedForA: +forA.toFixed(6),
      receiptTimestamp: sides.a.receiptTimestamp,
      sourceTimestamp: null,
    });
  }

  // de-duplicate same-operator books BEFORE counting independence
  const seen = new Set(); const deduped = [];
  for (const u of usable) {
    const group = SAME_OPERATOR.find((g) => g.includes(u.sportsbook));
    const key = group ? group.join("+") : u.sportsbook;
    if (seen.has(key)) { rejectedHere.push({ sportsbook: u.sportsbook, rejectReason: `same operator as an already-counted book (${key}) — not an independent source` }); continue; }
    seen.add(key); deduped.push(u);
  }

  if (deduped.length < cfg.minBooks)
    return refuse(`only ${deduped.length} independent book(s), need ${cfg.minBooks}`, { books: deduped.length });

  const probs = deduped.map((u) => u.deViggedForA);
  const consensus = probs.reduce((a, x) => a + x, 0) / probs.length;
  const dispersion = +((Math.max(...probs) - Math.min(...probs)) * 100).toFixed(2);
  if (dispersion > cfg.maxDispersionPoints)
    return refuse(`book dispersion ${dispersion} pts exceeds ${cfg.maxDispersionPoints} — the books do not agree enough to call this a consensus`, { dispersion });

  if (deduped.length < cfg.preferBooks) reasons.push(`thin consensus: ${deduped.length} books (prefer >= ${cfg.preferBooks})`);
  const oldest = Math.min(...deduped.map((u) => Date.parse(u.receiptTimestamp)));

  const rec = {
    ok: true,
    boutId: bout.boutId, bout: `${bout.a.name} vs ${bout.b.name}`,
    matchupId: muId,
    forFighter: bout.a.name,
    probability: +consensus.toFixed(4),
    probabilityOther: +(1 - consensus).toFixed(4),
    clockBasis: "WALL_CLOCK",
    staleCheckEnforceable: true,
    derivedFrom: "live multi-book consensus",
    fallbackLevel: "A",
    tier: "A_MULTIBOOK_LIVE",
    booksIncluded: deduped.length,
    sourceBooks: deduped.map((u) => u.sportsbook),
    perBook: deduped,
    deVigMethod: DEVIG_METHOD,
    consensusMethod: CONSENSUS_METHOD,
    marketDispersion: dispersion,
    snapshotTimestamp: new Date(collection.receiptTs).toISOString(),
    oldestQuoteAgeMs: nowTs - oldest,
    oldestQuoteAgeMinutes: +((nowTs - oldest) / 60000).toFixed(2),
    priceTimestamps: deduped.map((u) => ({ book: u.sportsbook, observedAt: u.receiptTimestamp, sourceProvided: null })),
    provenance: {
      module: "sportsbook-live@1.0.0",
      responseHash: collection.responseHash,
      providerResponseId: `${collection.eventPath}@${collection.responseHash}`,
      requestStart: new Date(collection.requestStart).toISOString(),
      requestComplete: new Date(collection.requestComplete).toISOString(),
      excludedVenues: Object.values(BOOKS).filter((b) => !b.approved).map((b) => `${b.name}: ${b.reason}`),
    },
    notes: reasons,
    rejectedQuotes: rejectedHere,
  };
  rec.contentHash = sha({ ...rec, contentHash: undefined });
  return rec;

  function refuse(reason, extra = {}) {
    return { ok: false, boutId: bout.boutId, bout: `${bout.a.name} vs ${bout.b.name}`,
      status: "NO CONSENSUS", probability: null, reason, ...extra,
      rejectedQuotes: rejectedHere,
      snapshotTimestamp: collection.receiptTs ? new Date(collection.receiptTs).toISOString() : null };
  }
}

// ---- 4. snapshot synchronisation -------------------------------------------------------------
// Two prices may only be compared if they were observed close enough together. Otherwise the
// difference measures elapsed time, not disagreement — the precise error that produced Phase 8's
// seven phantom edges.
function checkSynchronisation(consensus, kalshiSnapshotTs, cfg = DEFAULTS) {
  if (!consensus || !consensus.ok) return { ok: false, reason: "no sportsbook consensus to synchronise" };
  if (!Number.isFinite(kalshiSnapshotTs)) return { ok: false, reason: "kalshi snapshot has no timestamp" };
  const sbTs = Date.parse(consensus.snapshotTimestamp);
  const skew = Math.abs(kalshiSnapshotTs - sbTs);
  const ok = skew <= cfg.maxSnapshotSkewMs;
  return {
    ok,
    skewMs: skew, skewMinutes: +(skew / 60000).toFixed(2),
    maxAllowedMs: cfg.maxSnapshotSkewMs,
    sportsbookSnapshot: consensus.snapshotTimestamp,
    kalshiSnapshot: new Date(kalshiSnapshotTs).toISOString(),
    classification: ok ? null : "NO BET: ASYNCHRONOUS PRICES",
    reason: ok ? null : `sportsbook and Kalshi snapshots are ${(skew / 60000).toFixed(1)} min apart, limit ${(cfg.maxSnapshotSkewMs / 60000).toFixed(1)} min — the gap between them would be read as edge`,
  };
}

// ---- 5. market movement (CONTEXT ONLY) -------------------------------------------------------
// The opening line is reported so a human can see what moved. It is never value: opening-to-current
// movement is the market updating, and claiming it as system-generated edge is exactly the bug this
// phase exists to eliminate.
function movementContext(openingProbability, consensus, kalshiPrice) {
  if (!consensus || !consensus.ok) return null;
  const cur = consensus.probability;
  const move = openingProbability == null ? null : +((cur - openingProbability) * 100).toFixed(2);
  let followed = null;
  if (openingProbability != null && kalshiPrice != null) {
    const sbDir = Math.sign(cur - openingProbability);
    const kDir = Math.sign(kalshiPrice - openingProbability);
    followed = sbDir === 0 ? null : sbDir === kDir;
  }
  return {
    openingConsensus: openingProbability,
    currentConsensus: cur,
    movementPoints: move,
    currentKalshiPrice: kalshiPrice,
    kalshiFollowedTheMarket: followed,
    WARNING: "CONTEXT ONLY. Opening-to-current movement is the market updating itself. It must never be counted as system-generated value.",
  };
}

// Find the BFO event page whose matchups are THIS card's. Matching is by fighter names, never by
// event title: "UFC Oklahoma" and "UFC-2026-07-18" share no string, and guessing from a title is
// how a card gets priced off the wrong event's board.
async function findEventFor(card, opts = {}) {
  const O = require("./odds-history");
  let root;
  try { root = await O.fetchText("https://www.bestfightodds.com/"); }
  catch (e) { return { ok: false, reason: `could not load the BFO index: ${e.message}` }; }
  const links = [...new Set([...root.matchAll(/href="(\/events\/[a-z0-9-]+)"/gi)].map((m) => m[1]))];
  const want = new Set(card.bouts.flatMap((b) => [b.a.norm, b.b.norm]));
  const tried = [];
  for (const link of links.slice(0, opts.maxEvents ?? 12)) {
    const col = await collectEvent(link).catch(() => null);
    if (!col || !col.ok) { tried.push({ link, why: "collection failed" }); continue; }
    const names = new Set(Object.values(col.matchups).flatMap((m) => [m.a, m.b]).filter(Boolean).map((n) => E.norm(n)));
    const hits = [...want].filter((n) => names.has(n)).length;
    tried.push({ link, matched: hits, of: want.size });
    // require a real majority, not one coincidental name
    if (hits >= Math.max(4, Math.ceil(want.size * 0.5))) return { ok: true, eventPath: link, collection: col, matched: hits, of: want.size, tried };
  }
  return { ok: false, reason: "no BFO event page matched a majority of this card's fighters", tried };
}

// Build a per-bout live consensus for a whole card. Returns { boutId: consensusRecord }.
async function consensusForCard(card, opts = {}) {
  const found = opts.eventPath
    ? { ok: true, eventPath: opts.eventPath, collection: await collectEvent(opts.eventPath) }
    : await findEventFor(card, opts);
  if (!found.ok || !found.collection || !found.collection.ok)
    return { ok: false, reason: found.reason || "event collection failed", byBout: {} };
  const nowTs = opts.nowTs ?? Date.now();
  const byBout = {};
  let ok = 0;
  for (const b of card.bouts) {
    const c = consensusFor(found.collection, b, { nowTs, cfg: opts.cfg });
    byBout[b.boutId] = c;
    if (c.ok) ok++;
  }
  return { ok: true, eventPath: found.eventPath, collection: found.collection, byBout, withConsensus: ok, of: card.bouts.length };
}

module.exports = {
  collectEvent, consensusFor, consensusForCard, findEventFor, normaliseEventPath, checkSynchronisation, movementContext, detectMirrors,
  deVigBook, parseAmerican, BOOKS, SAME_OPERATOR, DEFAULTS, DEVIG_METHOD, CONSENSUS_METHOD, sha,
};
