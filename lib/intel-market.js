// MARKET-REACTION TRACKING (§8). For each material report, capture the price BEFORE first discovery and
// a synchronized series AFTER, so we can tell whether the market has already absorbed the information —
// and refuse to chase it. Being right that a report matters pays nothing if the price already moved.
//
// Kalshi reads are read-only (lib/kalshi has no write path); this module only records numbers. It never
// recommends: the price still has to be favorable, which the message layer enforces via the invariants.
require("./env");

const MOVE_THRESH = 0.03;   // 3 cents / 3 points — a move smaller than this is noise, not absorption

// A snapshot: { kalshiAsk, sportsbook, ts } — kalshiAsk is the executable YES ask (dollars 0..1);
// sportsbook is the consensus implied probability for the SAME contract subject; ts is the receipt time
// (never fabricated — the caller passes the real snapshot time).

// Capture the BEFORE picture exactly once — the state immediately before this report was first seen.
function recordBefore(record, snap) {
  if (record.kalshiBefore != null || record.sportsbookBefore != null) return record;   // already captured
  return {
    ...record,
    kalshiBefore: snap.kalshiAsk != null ? { ask: snap.kalshiAsk, ts: snap.ts } : null,
    sportsbookBefore: snap.sportsbook != null ? { consensus: snap.sportsbook, ts: snap.ts } : null,
  };
}

// Append a later synchronized snapshot.
function recordAfter(record, snap) {
  const kalshiAfter = [...(record.kalshiAfter || [])];
  const sportsbookAfter = [...(record.sportsbookAfter || [])];
  if (snap.kalshiAsk != null) kalshiAfter.push({ ask: snap.kalshiAsk, ts: snap.ts });
  if (snap.sportsbook != null) sportsbookAfter.push({ consensus: snap.sportsbook, ts: snap.ts });
  return { ...record, kalshiAfter, sportsbookAfter };
}

// Direction and amount of movement, and WHO moved first (Kalshi walking to the sharp book is a very
// different thing from the sharp book walking to Kalshi). `reportSign` is +1 if the report should push
// the tracked contract UP (helps the contract's subject), -1 if down — used to judge absorption.
function movement(record, opts = {}) {
  const kb = record.kalshiBefore && record.kalshiBefore.ask;
  const sb = record.sportsbookBefore && record.sportsbookBefore.consensus;
  const kLast = (record.kalshiAfter || []).slice(-1)[0];
  const sLast = (record.sportsbookAfter || []).slice(-1)[0];
  const kMove = (kb != null && kLast) ? +(kLast.ask - kb).toFixed(4) : null;
  const sMove = (sb != null && sLast) ? +(sLast.consensus - sb).toFixed(4) : null;

  const kFirst = (record.kalshiAfter || []).find((x) => kb != null && Math.abs(x.ask - kb) >= MOVE_THRESH);
  const sFirst = (record.sportsbookAfter || []).find((x) => sb != null && Math.abs(x.consensus - sb) >= MOVE_THRESH);
  let movedFirst = null;
  if (kFirst && sFirst) movedFirst = new Date(kFirst.ts) <= new Date(sFirst.ts) ? "kalshi" : "sportsbook";
  else if (kFirst) movedFirst = "kalshi";
  else if (sFirst) movedFirst = "sportsbook";

  // Absorbed = the price moved in the report's direction by at least the threshold.
  const sign = opts.reportSign || 0;
  const absorbed = kMove != null && Math.abs(kMove) >= MOVE_THRESH && (sign === 0 || Math.sign(kMove) === Math.sign(sign));

  return {
    kalshiMovePoints: kMove != null ? +(kMove * 100).toFixed(1) : null,
    sportsbookMovePoints: sMove != null ? +(sMove * 100).toFixed(1) : null,
    movedFirst, absorbed,
    kalshiMoved: kMove != null && Math.abs(kMove) >= MOVE_THRESH,
    sportsbookMoved: sMove != null && Math.abs(sMove) >= MOVE_THRESH,
  };
}

// The context the action classifier and the message layer need: is the price now beyond the maximum we
// would pay (→ MARKET_ALREADY_MOVED / PRICE_TOO_HIGH, never a buy), does value remain after fees, and a
// human-readable before→after for the message.
function marketContext(record, opts = {}) {
  const kb = record.kalshiBefore && record.kalshiBefore.ask;
  const kLast = (record.kalshiAfter || []).slice(-1)[0];
  const afterAsk = kLast ? kLast.ask : (opts.currentAsk != null ? opts.currentAsk : kb);
  const max = opts.maximumAcceptablePrice;
  const moved = kb != null && afterAsk != null && Math.abs(afterAsk - kb) >= MOVE_THRESH;
  return {
    marketMovedBeyondMax: (max != null && afterAsk != null) ? afterAsk > max + 1e-9 : false,
    // the max acceptable price is already fee-adjusted, so "at or below it" is "value remains after fees"
    valueRemainsAfterFees: (max != null && afterAsk != null) ? afterAsk <= max + 1e-9 : null,
    marketReaction: { subject: opts.subject || (record.outcomeAffected && record.outcomeAffected.helps), beforeAsk: kb, afterAsk, moved },
  };
}

module.exports = { recordBefore, recordAfter, movement, marketContext, MOVE_THRESH };
