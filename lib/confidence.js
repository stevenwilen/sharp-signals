// CONFIDENCE ENGINE — the heart of the re-pointed system (2026-08-09).
//
// No prices, no bet sizes, no market edge. For each fight on the card it produces a CONFIDENCE: which
// fighter the roster's ranked voices favour, HOW strongly, and HOW well-covered — a rank-weighted
// consensus of who each channel picked. The operator decides the stake; this only says who wins.
//
// INPUTS (all already produced by the existing pipeline):
//   - the card's bouts + fighter names           (data/forecast-<date>.json)
//   - the card's prediction videos               (data/card-selection-<date>.json: byVideo + include)
//   - each channel's explicit pick per fight      (data/picks/<videoId>.json)
//   - how much each channel's opinion counts      (lib/channel-weights, from the graded track record)
//   - the calibration curve share -> win prob     (lib/confidence-calibration)
//
// HONEST BY CONSTRUCTION: a rank-weighted consensus lands near the betting favourite most of the time
// (channels mostly agree with the line). That is fine — this is a "who wins" aid, not an edge. The
// calibration step keeps "74%" meaning "won ~74% of the time historically", and coverage is always
// shown so a thin 2-channel read can never masquerade as a deep one.
require("./env");
const fs = require("fs");
const path = require("path");
const N = require("./names");
const W = require("./channel-weights");
const CAL = require("./confidence-calibration");

const DATA = path.join(__dirname, "..", "data");
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };

// A pick that hedges ("could go either way") should not count like a lock. directness is the extractor's
// call; an implicit pick counts half. The channel's own stated confidence modulates lightly on top.
const DIRECTNESS = { explicit: 1.0, implicit: 0.5 };
const pickWeight = (p, chWeight) => {
  const dir = DIRECTNESS[String(p.directness || "explicit").toLowerCase()] ?? 1.0;
  const conf = Number.isFinite(p.confidence) ? p.confidence : 0.7;
  return chWeight * dir * (0.6 + 0.4 * conf);
};

// Two surnames are the same fighter's, allowing for spelling drift the roster is full of:
// "del Valle"/"Delvalle", "Da Silva"/"DaSilva", "Dos Santos"/"DosSantos" — the space-stripped last
// token of one is a substring of the other. Guarded at length >= 4 so short tokens can't collide.
function surnameEq(x, y) {
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}

// Match a pick's (pick, opponent) pair to a bout's (a, b) pair. Surname-PAIR matching: robust to
// first-name spelling ("Manuel" vs "Manoel", "Yair" vs "Yadier") AND surname spelling (surnameEq),
// and disambiguates same-surname fights on one card (Ty Miller vs Goff and Juliana Miller vs Oliveira
// coexist — the pair pins each). The pair itself is the corroboration lib/names demands before trusting
// a surname. Returns which bout fighter was picked, or null if this pick is not about this bout.
function whichSide(pick, bout) {
  const ps = N.surname(pick.pick), os = N.surname(pick.opponent);
  const as = N.surname(bout.a), bs = N.surname(bout.b);
  if (!ps || !os || !as || !bs) return null;
  if (surnameEq(ps, as) && surnameEq(os, bs)) return "a";
  if (surnameEq(ps, bs) && surnameEq(os, as)) return "b";
  return null;
}

// The card's bouts, from the sealed forecast (authoritative names + boutId).
function cardBouts(eventDate) {
  const fc = readJson(path.join(DATA, `forecast-${eventDate}.json`), null);
  if (!fc || !Array.isArray(fc.forecasts)) return [];
  return fc.forecasts.map((f) => {
    const m = String(f.fight || "").split(/\s+vs\.?\s+/i);
    return { boutId: f.boutId, fight: f.fight, a: (m[0] || "").trim(), b: (m[1] || "").trim() };
  }).filter((x) => x.a && x.b);
}

// Gather every channel's pick for EVERY bout in one pass over the pick corpus. Abundance across
// channels is the whole point, so we do NOT restrict to the forecast's narrow selected-video set —
// we take every channel that picked this matchup. A TIME WINDOW around the card keeps a fighter's
// picks from an EARLIER event (a rematch, a same-surname coincidence months back) from leaking in;
// picks are made in the weeks before a card and never after it. Deduped to each channel's most recent
// pick. Returns { [boutId]: [ {source, side, confidence, directness, quote, timestamp} ] }.
const WINDOW_BEFORE_MS = 28 * 24 * 3600e3;
const WINDOW_AFTER_MS = 2 * 24 * 3600e3;
function gatherAllPicks(bouts, eventDate) {
  const cardMs = Date.parse(`${eventDate}T00:00:00Z`);
  const lo = cardMs - WINDOW_BEFORE_MS, hi = cardMs + WINDOW_AFTER_MS;
  const byBout = {};
  for (const b of bouts) byBout[b.boutId] = new Map();
  let files = [];
  try { files = fs.readdirSync(path.join(DATA, "picks")); } catch { /* no corpus */ }
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const pf = readJson(path.join(DATA, "picks", fn), null);
    if (!pf || !Array.isArray(pf.picks)) continue;
    for (const p of pf.picks) {
      const ts = Date.parse(p.timestamp || 0);
      if (Number.isFinite(ts) && (ts < lo || ts > hi)) continue;   // outside this card's window
      for (const b of bouts) {
        const side = whichSide(p, b);
        if (!side) continue;
        const m = byBout[b.boutId];
        const prev = m.get(p.source);
        if (!(prev && Date.parse(prev.timestamp || 0) >= (Number.isFinite(ts) ? ts : 0))) {
          m.set(p.source, { source: p.source, side, confidence: p.confidence,
            directness: p.directness, quote: p.quote, timestamp: p.timestamp });
        }
        break;   // a pick pair matches at most one bout on the card
      }
    }
  }
  const out = {};
  for (const b of bouts) out[b.boutId] = [...byBout[b.boutId].values()];
  return out;
}

// Label the read from the CALIBRATED confidence (so the word and the % never disagree — a thinly
// covered lopsided read is shrunk to a modest % and labelled to match), with coverage as an override:
// too few channels and we say so outright rather than dress it up.
function label(confidencePct, coverage) {
  if (coverage < 3) return "UNDER-COVERED";
  if (confidencePct >= 70) return "STRONG";
  if (confidencePct >= 62) return "LEAN";
  if (confidencePct >= 56) return "SLIGHT";
  return "TOSS-UP";
}

// Build the confidence record for one bout from its gathered per-channel picks.
function scoreBout(bout, picks) {
  const contributors = (picks || []).map((p) => {
    const info = W.infoFor(p.source);
    return { source: p.source, tier: info.tier, channelWeight: info.weight, side: p.side,
      pickConfidence: p.confidence, directness: p.directness,
      contribution: +pickWeight(p, info.weight).toFixed(3), quote: p.quote };
  });
  const wFor = (side) => contributors.filter((c) => c.side === side).reduce((s, c) => s + c.contribution, 0);
  const wa = wFor("a"), wb = wFor("b");
  const total = wa + wb;
  const coverage = contributors.length;               // distinct channels that picked this fight
  if (!total || !coverage) {
    return { boutId: bout.boutId, fight: bout.fight, a: bout.a, b: bout.b,
      pick: null, label: "NO-READ", coverage: 0, share: null, confidencePct: null, contributors: [] };
  }
  const side = wa >= wb ? "a" : "b";
  const share = (side === "a" ? wa : wb) / total;      // weighted share for the favoured fighter
  const pick = side === "a" ? bout.a : bout.b;
  const confidencePct = Math.round(100 * CAL.toProbability(share, coverage));
  return {
    boutId: bout.boutId, fight: bout.fight, a: bout.a, b: bout.b,
    pick, side, coverage,
    share: +share.toFixed(3),
    confidencePct,
    label: label(confidencePct, coverage),
    weightedFor: +(side === "a" ? wa : wb).toFixed(3),
    weightedAgainst: +(side === "a" ? wb : wa).toFixed(3),
    // who: the ranked channels behind the pick (favoured side first), best tier first
    contributors: contributors.sort((x, y) => y.contribution - x.contribution),
  };
}

// Build the whole card's confidence, sorted most-confident first.
function buildCard(eventDate) {
  const bouts = cardBouts(eventDate);
  const gathered = gatherAllPicks(bouts, eventDate);
  const fights = bouts.map((b) => scoreBout(b, gathered[b.boutId]))
    .sort((x, y) => (y.confidencePct ?? -1) - (x.confidencePct ?? -1));
  return {
    card: eventDate,
    generatedAt: null,   // stamped by the runner (deterministic core stays clock-free for tests)
    channelsWithARead: new Set(Object.values(gathered).flat().map((p) => p.source)).size,
    calibration: CAL.describe(),
    fights,
  };
}

module.exports = { buildCard, scoreBout, whichSide, surnameEq, gatherAllPicks, cardBouts, label, pickWeight };
