// The PAPER-TRADE ledger — the honest scoreboard for this system's live calls.
//
// This bot ALERTS; it does not trade. It never knows whether the human actually bought, or at
// what price. So everything here is PAPER: "if you had taken each alert exactly as it was given
// — at the price and stake it recommended — this is what would have happened." Every number that
// leaves this module must be labelled paper, never presented as real money booked. Printing a
// confident "+$47" for a bet nobody placed is the exact silent-failure sin this project exists to
// avoid.
//
// It matters most WHILE alerts are disarmed and no edge is proven: it accumulates an out-of-sample
// record of what arming this thing would have done, which is the evidence for whether to ever arm
// it. Each qualifying signal is recorded ONCE at its first sighting (entry locked at the earliest,
// softest price — the "get in at the open" price we could actually have taken), then settled from
// Kalshi when its fight resolves.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "positions.json");
const DAY = 86400000;
const SETTLED_KEEP_DAYS = 365; // keep settled positions ~a year — they ARE the track record

const nowMs = () => Date.now();
const nowIso = () => new Date(nowMs()).toISOString();

// A MISSING file is a legit first run -> empty. A PRESENT-but-corrupt file must NOT be silently
// treated as empty and overwritten — throw so run()'s failure handler alerts (same rule as the
// pick-ledger). Only ENOENT returns {}.
function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return { positions: {}, meta: {} }; throw e; }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { throw new Error(`positions.json is corrupt (${e.message}); refusing to rebuild over it`); }
  if (!j || typeof j !== "object") return { positions: {}, meta: {} };
  return { positions: j.positions || {}, meta: j.meta || {} };
}
// Atomic write (temp + rename), like lib/store.js and the pick-ledger.
function save(state) {
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (_) {}
}

// Open a paper position for a qualifying signal. Entry (cost/stake/fair value) is LOCKED at the
// first sighting — you buy once, at the earliest price. Later sightings only merge in new sources
// (informational) and never move the entry. Returns "opened" the first time, null thereafter.
// `sig` = { ticker, fighter, opponent, domain, fightDate, entryCost(0..1), fairValueCents,
//           stakePct, sources[] }.
function recordOpen(state, sig) {
  const p = state.positions[sig.ticker];
  if (p) {
    if (p.status === "open") {
      const have = new Set(p.sources || []);
      for (const s of sig.sources || []) have.add(s);
      p.sources = Array.from(have);
      p.lastSeen = nowIso();
    }
    return null;
  }
  state.positions[sig.ticker] = {
    ticker: sig.ticker, fighter: sig.fighter, opponent: sig.opponent || null,
    domain: sig.domain, fightDate: sig.fightDate || null,
    entryCost: sig.entryCost,               // price you'd pay, 0..1 (the ask at first signal)
    fairValueCents: sig.fairValueCents ?? null,
    stakePct: sig.stakePct ?? null,         // % of bankroll recommended at entry
    sources: Array.from(new Set(sig.sources || [])),
    status: "open", result: null, exitPrice: null,
    openedAt: nowIso(), lastSeen: nowIso(), settledAt: null, settledReason: null, pnlPct: null,
    summarizedOpen: false, summarizedSettled: false,
  };
  return "opened";
}

const openPositions = (state) => Object.values(state.positions).filter((p) => p.status === "open");

// Settle a paper position. result: 1 win / 0 loss / null void (cancelled). pnlPct is ROI on the
// staked dollars: win -> (1-cost)/cost, loss -> -1, void -> 0.
function settle(state, ticker, result, exitPrice, reason) {
  const p = state.positions[ticker];
  if (!p || p.status === "settled") return;
  p.status = "settled";
  p.result = result;
  p.exitPrice = exitPrice ?? (result === 1 ? 1 : result === 0 ? 0 : null);
  p.settledAt = nowIso();
  p.settledReason = reason || "settled";
  const c = p.entryCost;
  if (result === 1 && c > 0) p.pnlPct = +(((1 - c) / c) * 100).toFixed(1);
  else if (result === 0) p.pnlPct = -100;
  else p.pnlPct = 0; // void / cancelled
}

// Paper P&L in dollars for a settled position, given the bankroll it would have been staked from.
function pnlDollars(p, bankroll) {
  if (!bankroll || p.stakePct == null || p.pnlPct == null) return null;
  const stake = bankroll * (p.stakePct / 100);
  return +(stake * (p.pnlPct / 100)).toFixed(2);
}

const newlyOpened = (state) => openPositions(state).filter((p) => !p.summarizedOpen);
const newlySettled = (state) =>
  Object.values(state.positions).filter((p) => p.status === "settled" && !p.summarizedSettled);

function markSummarized(state, tickers, which) {
  const field = which === "open" ? "summarizedOpen" : "summarizedSettled";
  for (const t of tickers) if (state.positions[t]) state.positions[t][field] = true;
}

// Housekeeping: drop very old settled positions so the file cannot grow without bound.
function prune(state) {
  const t = nowMs();
  for (const [k, p] of Object.entries(state.positions)) {
    if (p.status === "settled" && t - Date.parse(p.settledAt || p.lastSeen || 0) > SETTLED_KEEP_DAYS * DAY)
      delete state.positions[k];
  }
}

const counts = (state) => {
  const c = { open: 0, settled: 0 };
  for (const p of Object.values(state.positions)) c[p.status] = (c[p.status] || 0) + 1;
  return c;
};

module.exports = {
  FILE, load, save, recordOpen, openPositions, settle, pnlDollars,
  newlyOpened, newlySettled, markSummarized, prune, counts,
};
