// MARKET BASELINE — a deterministic source waterfall producing an auditable pre-fight prior.
//
// WHY THIS EXISTS. The Phase 7 baseline read `predictions.json` — the graded PICK ledger. A bout
// only had a price if some tipster happened to pick it, so coverage was a side-effect of tipster
// attention: 5/15, every one a headline fight, every prelim missing. The data was always there; the
// source was wrong. Reading BFO directly gives 15/15.
//
// AND IT LEAKED. That baseline used the de-vigged CLOSING line stamped `sealTs - 2h` — a synthetic
// timestamp, not when the price was quoted. The leakage guard passed it because it checked the
// fabricated time. Open-to-close drift on that card ran to 14.9 points, so the "prior" carried up to
// 14.9 points of information it could not have had. The close is now evaluation-only and physically
// cannot reach a forecast: it is returned by a different function, into a different field.
//
// THE ONE THING THIS MODULE WILL NOT DO is invent a number. Every tier can decline. D is a real
// outcome, not a failure — refusing to price a bout is cheaper than pricing it wrong.
require("./env");
const crypto = require("crypto");
const O = require("./odds-history");
const E = require("./evidence-eval");

const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

// ---- the waterfall ----
// Ordered, deterministic, and each tier states what it actually is. Naming a single scraped
// consensus "sharp multi-book" would be the same overstatement this phase exists to remove.
const TIERS = {
  A_MULTIBOOK_LIVE: {
    level: "A",
    what: "per-book live prices across multiple books, each with a real observation timestamp",
    reachable: "upcoming cards only — requires a live event page snapshot taken before the seal",
  },
  B_OPEN_CONSENSUS: {
    level: "B",
    what: "BFO opening consensus line, both sides, de-vigged; cross-book dispersion from the closing range",
    reachable: "any card BFO has a fight row for",
  },
  C_SINGLE_BOOK: {
    level: "C",
    what: "one approved venue's two-sided quote (Kalshi asks), de-vigged",
    reachable: "bouts with a listed Kalshi market quoted before the seal",
  },
  D_UNAVAILABLE: { level: "D", what: "no admissible price — the bout is not forecast", reachable: "always" },
};

// Staleness is only meaningful for a price that carries a real clock reading. An opening consensus
// has no timestamp: BFO does not publish when the line opened. Rather than fabricate one (the exact
// sin that produced the leak), such a price is marked LOGICAL_OPEN and its forecast is declared to
// be made "as of market open" — a logical instant, not a wall-clock one. Staleness cannot be
// enforced on it, and the record says so out loud instead of implying freshness it cannot support.
const CLOCK = { WALL: "WALL_CLOCK", LOGICAL_OPEN: "LOGICAL_OPEN" };

const DEFAULTS = {
  maxPriceAgeMs: 36 * 3600 * 1000,   // a wall-clock price older than this is stale -> rejected
  minOverround: 1.01,                 // below this the two sides do not sum like a real book
  maxOverround: 1.12,                 // above this the parse grabbed the wrong cells
  minBooksForMultibook: 2,
};

// ---- primitives ----

// De-vig by normalising the two vig-included implied probabilities to sum to 1. Stated explicitly
// on every record: a probability whose de-vig method is unknown is not auditable.
const DEVIG_METHOD = "proportional normalisation: pA/(pA+pB), both sides' vig-included implied probabilities";

function deVig(pA, pB) {
  if (!Number.isFinite(pA) || !Number.isFinite(pB)) return null;
  if (!(pA > 0 && pA < 1 && pB > 0 && pB < 1)) return null;
  const overround = pA + pB;
  if (!(overround > 0)) return null;
  return { probA: pA / overround, probB: pB / overround, overround };
}

// Malformed odds must fail, not coerce. Number("+abc") is NaN, but Number("") is 0 and Number(null)
// is 0 — a silent 0 becomes a 100% probability. Everything non-finite is refused.
function parseAmerican(ml) {
  if (ml === null || ml === undefined) return null;
  const s = String(ml).trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return null;
  if (Math.abs(n) < 100) return null;             // no real moneyline sits inside ±100
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

// Two books quoting the same fight are one book if they are the same book. Deduplicate by name
// before counting "multi-book" — three feeds of DraftKings is one opinion, not three. This is the
// origins-vs-voices rule from the evidence layer, applied to prices.
function dedupeBooks(quotes) {
  const seen = new Map();
  const dropped = [];
  for (const q of quotes) {
    const k = String(q.book || "").trim().toLowerCase();
    if (!k) { dropped.push({ book: q.book, why: "unnamed book" }); continue; }
    if (seen.has(k)) {
      const prev = seen.get(k);
      // same book twice: keep the fresher quote, record that we did
      const keepNew = (q.observedAt || 0) > (prev.observedAt || 0);
      dropped.push({ book: q.book, why: `duplicate book — kept the ${keepNew ? "newer" : "existing"} quote` });
      if (keepNew) seen.set(k, q);
      continue;
    }
    seen.set(k, q);
  }
  return { unique: [...seen.values()], dropped };
}

// Dispersion = spread of de-vigged opinion across books, in probability points. Reported, never
// smoothed away: books disagreeing by 8 points is information about how knowable the fight is.
function dispersionOf(probs) {
  if (!probs.length) return null;
  const lo = Math.min(...probs), hi = Math.max(...probs);
  return +((hi - lo) * 100).toFixed(2);
}

// ---- tier A: live per-book snapshot ----
function tierA(bout, snapshot, forecastTs, cfg) {
  const reasons = [];
  if (!snapshot) return { ok: false, reasons: ["A: no live multi-book snapshot supplied"] };
  const rowsRaw = (snapshot.quotes || []).filter((q) =>
    (E.norm(q.fighterA) === bout.a.norm && E.norm(q.fighterB) === bout.b.norm) ||
    (E.norm(q.fighterA) === bout.b.norm && E.norm(q.fighterB) === bout.a.norm));
  if (!rowsRaw.length) return { ok: false, reasons: ["A: no live quotes for this bout"] };

  const { unique, dropped } = dedupeBooks(rowsRaw);
  for (const d of dropped) reasons.push(`A: dropped ${d.book} — ${d.why}`);

  const usable = [];
  for (const q of unique) {
    // a price observed AFTER the forecast is information from the future. Never a warning; always a drop.
    if (!Number.isFinite(q.observedAt)) { reasons.push(`A: ${q.book} has no observation timestamp`); continue; }
    if (q.observedAt > forecastTs) { reasons.push(`A: ${q.book} quoted after the forecast timestamp — refused`); continue; }
    const age = forecastTs - q.observedAt;
    if (age > cfg.maxPriceAgeMs) { reasons.push(`A: ${q.book} price is ${(age / 3600000).toFixed(1)}h old — stale, refused`); continue; }
    const swapped = E.norm(q.fighterA) !== bout.a.norm;
    const mlA = swapped ? q.mlB : q.mlA, mlB = swapped ? q.mlA : q.mlB;
    const pA = parseAmerican(mlA), pB = parseAmerican(mlB);
    if (pA === null || pB === null) { reasons.push(`A: ${q.book} has malformed odds (${mlA}/${mlB}) — refused`); continue; }
    const dv = deVig(pA, pB);
    if (!dv) { reasons.push(`A: ${q.book} could not be de-vigged`); continue; }
    if (dv.overround < cfg.minOverround || dv.overround > cfg.maxOverround) {
      reasons.push(`A: ${q.book} overround ${dv.overround.toFixed(3)} outside [${cfg.minOverround}, ${cfg.maxOverround}] — refused`); continue;
    }
    usable.push({ book: q.book, mlA, mlB, rawProbA: +pA.toFixed(4), rawProbB: +pB.toFixed(4),
      deVigged: +dv.probA.toFixed(4), overround: +dv.overround.toFixed(4), observedAt: q.observedAt });
  }
  if (usable.length < cfg.minBooksForMultibook)
    return { ok: false, reasons: [...reasons, `A: only ${usable.length} usable book(s), need ${cfg.minBooksForMultibook}`] };

  const probs = usable.map((u) => u.deVigged);
  const consensus = probs.reduce((a, x) => a + x, 0) / probs.length;
  const oldest = Math.min(...usable.map((u) => u.observedAt));
  return {
    ok: true, tier: "A_MULTIBOOK_LIVE", clock: CLOCK.WALL,
    probability: +consensus.toFixed(4),
    sourceBooks: usable.map((u) => u.book),
    rawPrices: usable.map((u) => ({ book: u.book, [bout.a.name]: u.mlA, [bout.b.name]: u.mlB, deVigged: u.deVigged })),
    priceTimestamps: usable.map((u) => ({ book: u.book, observedAt: new Date(u.observedAt).toISOString() })),
    marketDispersion: dispersionOf(probs),
    oldestPriceAgeMs: forecastTs - oldest,
    reasons,
  };
}

// ---- tier B: opening consensus (the workhorse for historical cards) ----
// The OPEN is the honest historical prior: it is by construction the market's first price, so it
// cannot contain anything learned later. It has no publishable timestamp, so it is LOGICAL_OPEN.
function tierB(bout, hit, cfg) {
  const reasons = [];
  if (!hit) return { ok: false, reasons: ["B: no BFO fight row for this bout"] };
  const A = hit.me, B = hit.opp;
  if (!A || !B || !A.mls || !B.mls) return { ok: false, reasons: ["B: fight row missing moneyline cells"] };

  const pA = parseAmerican(A.mls[0]), pB = parseAmerican(B.mls[0]);
  if (pA === null || pB === null) return { ok: false, reasons: [`B: malformed/absent opening odds (${A.mls[0]}/${B.mls[0]})`] };
  const dv = deVig(pA, pB);
  if (!dv) return { ok: false, reasons: ["B: opening lines could not be de-vigged"] };
  if (dv.overround < cfg.minOverround || dv.overround > cfg.maxOverround)
    return { ok: false, reasons: [`B: opening overround ${dv.overround.toFixed(3)} outside sane range — bad parse, refused`] };

  // Dispersion from the CLOSING range's width. This is a measure of how much books disagreed about
  // this fight — a property of the fight, not a price. It is a width, never a level, so it cannot
  // carry directional information about who won. The level (where the close landed) is excluded.
  const cLo = parseAmerican(A.mls[1]), cHi = parseAmerican(A.mls[2]);
  const disp = (cLo !== null && cHi !== null) ? +(Math.abs(cHi - cLo) * 100).toFixed(2) : null;
  if (disp === null) reasons.push("B: no closing range — cross-book dispersion unavailable");

  return {
    ok: true, tier: "B_OPEN_CONSENSUS", clock: CLOCK.LOGICAL_OPEN,
    probability: +dv.probA.toFixed(4),
    sourceBooks: ["BestFightOdds opening consensus"],
    rawPrices: [{ book: "BestFightOdds opening consensus", [bout.a.name]: A.mls[0], [bout.b.name]: B.mls[0],
      rawProbA: +pA.toFixed(4), rawProbB: +pB.toFixed(4), overround: +dv.overround.toFixed(4) }],
    priceTimestamps: [{ book: "BestFightOdds opening consensus", observedAt: null,
      note: "BFO does not publish when the line opened; this price is the market's FIRST price and is used as a logical 'as of market open' prior, not as a wall-clock observation" }],
    marketDispersion: disp,
    dispersionBasis: disp === null ? null : "width of the closing cross-book range (a width, not a level — carries no directional information)",
    oldestPriceAgeMs: null,
    reasons,
  };
}

// ---- tier C: single approved venue ----
function tierC(bout, kalshi, forecastTs, cfg) {
  const reasons = [];
  if (!kalshi) return { ok: false, reasons: ["C: no Kalshi quotes supplied"] };
  const mk = (kalshi.markets ? Object.values(kalshi.markets) : []).filter((m) =>
    (E.norm(m.fighter) === bout.a.norm && E.norm(m.opponent) === bout.b.norm) ||
    (E.norm(m.fighter) === bout.b.norm && E.norm(m.opponent) === bout.a.norm));
  const forA = mk.find((m) => E.norm(m.fighter) === bout.a.norm);
  const forB = mk.find((m) => E.norm(m.fighter) === bout.b.norm);
  if (!forA || !forB) return { ok: false, reasons: ["C: Kalshi lacks a two-sided market for this bout"] };
  if (!forA.last || !forB.last) return { ok: false, reasons: ["C: Kalshi market has no last quote"] };

  const tA = Date.parse(forA.last.t), tB = Date.parse(forB.last.t);
  if (!Number.isFinite(tA) || !Number.isFinite(tB)) return { ok: false, reasons: ["C: Kalshi quote has no parsable timestamp"] };
  if (tA > forecastTs || tB > forecastTs) return { ok: false, reasons: ["C: Kalshi quote is dated after the forecast timestamp — refused"] };
  const oldest = Math.min(tA, tB);
  const age = forecastTs - oldest;
  if (age > cfg.maxPriceAgeMs) return { ok: false, reasons: [`C: Kalshi quote is ${(age / 3600000).toFixed(1)}h old — stale, refused`] };

  const a = forA.last.ask, b = forB.last.ask;
  if (!(Number.isFinite(a) && Number.isFinite(b) && a > 0 && a < 1 && b > 0 && b < 1))
    return { ok: false, reasons: [`C: Kalshi asks out of range (${a}/${b})`] };
  const dv = deVig(a, b);
  if (!dv) return { ok: false, reasons: ["C: Kalshi asks could not be de-vigged"] };

  return {
    ok: true, tier: "C_SINGLE_BOOK", clock: CLOCK.WALL,
    probability: +dv.probA.toFixed(4),
    sourceBooks: ["Kalshi"],
    rawPrices: [{ book: "Kalshi", [bout.a.name]: a, [bout.b.name]: b, overround: +dv.overround.toFixed(4) }],
    priceTimestamps: [{ book: "Kalshi", observedAt: new Date(oldest).toISOString() }],
    marketDispersion: null,
    dispersionBasis: null,
    oldestPriceAgeMs: age,
    reasons: [...reasons, "C: single venue — no cross-book dispersion is measurable"],
  };
}

// ---- the waterfall ----
// Deterministic: A, then B, then C, then D. The tier that produced the number is always on the
// record, and so is every reason the tiers above it declined. A fallback you cannot see is a
// fallback you will eventually mistake for a first choice.
function buildBaseline(bout, sources, forecastTs, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
  if (!Number.isFinite(forecastTs)) throw new Error("forecastTs must be a finite epoch ms");
  const missing = [];

  const attempts = [
    () => tierA(bout, sources.liveSnapshot, forecastTs, cfg),
    () => tierB(bout, sources.bfoHit, cfg),
    () => tierC(bout, sources.kalshi, forecastTs, cfg),
  ];
  for (const attempt of attempts) {
    const r = attempt();
    if (r.ok) {
      const orientation = r.probability >= 0.5
        ? { favorite: bout.a.name, underdog: bout.b.name }
        : { favorite: bout.b.name, underdog: bout.a.name };
      const rec = {
        boutId: bout.boutId,
        forecastTimestamp: new Date(forecastTs).toISOString(),
        forFighter: bout.a.name,
        probability: r.probability,
        probabilityOther: +(1 - r.probability).toFixed(4),
        orientation,
        fallbackLevel: TIERS[r.tier].level,
        tier: r.tier,
        tierMeaning: TIERS[r.tier].what,
        clockBasis: r.clock,
        staleCheckEnforceable: r.clock === CLOCK.WALL,
        sourceBooks: r.sourceBooks,
        bookCount: r.sourceBooks.length,
        rawPrices: r.rawPrices,
        priceTimestamps: r.priceTimestamps,
        deVigMethod: DEVIG_METHOD,
        deViggedProbability: r.probability,
        marketDispersion: r.marketDispersion,
        dispersionBasis: r.dispersionBasis || null,
        oldestPriceAgeMs: r.oldestPriceAgeMs,
        oldestPriceAgeHours: r.oldestPriceAgeMs === null ? null : +(r.oldestPriceAgeMs / 3600000).toFixed(2),
        missingSourceReasons: [...missing, ...r.reasons],
        provenance: { module: "market-baseline@1.0.0", deVig: DEVIG_METHOD, waterfall: ["A", "B", "C", "D"] },
      };
      rec.contentHash = sha({ ...rec, contentHash: undefined });
      return rec;
    }
    missing.push(...r.reasons);
  }
  return {
    boutId: bout.boutId,
    forecastTimestamp: new Date(forecastTs).toISOString(),
    status: "BASELINE UNAVAILABLE",
    fallbackLevel: "D",
    tier: "D_UNAVAILABLE",
    probability: null,
    missingSourceReasons: missing,
    provenance: { module: "market-baseline@1.0.0", waterfall: ["A", "B", "C", "D"] },
    contentHash: sha({ boutId: bout.boutId, forecastTs, missing }),
  };
}

// ---- closing line: EVALUATION ONLY ----
// Deliberately a separate function returning a differently-shaped object into a different field.
// It is not reachable from buildBaseline and cannot be mistaken for one: it carries no `probability`
// key and is stamped with a refusal flag the forecaster checks. The close is what we grade against,
// never what we forecast from.
function closingForEvaluation(bout, hit) {
  if (!hit) return null;
  const A = hit.me, B = hit.opp;
  const dv = deVig(A.closeProb, B.closeProb);
  if (!dv) return null;
  if (dv.overround < DEFAULTS.minOverround || dv.overround > DEFAULTS.maxOverround) return null;
  return {
    boutId: bout.boutId,
    __EVALUATION_ONLY__: true,
    __NEVER_USE_AS_PRIOR__: "this is the closing line; it contains information published after any pre-fight forecast",
    closingProbability: +dv.probA.toFixed(4),
    forFighter: bout.a.name,
    overround: +dv.overround.toFixed(4),
    deVigMethod: DEVIG_METHOD,
  };
}

module.exports = {
  buildBaseline, closingForEvaluation, tierA, tierB, tierC,
  deVig, parseAmerican, dedupeBooks, dispersionOf,
  TIERS, CLOCK, DEFAULTS, DEVIG_METHOD, sha,
};
