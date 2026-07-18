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

// THE LIFECYCLE. A position used to have three states — open, settled, and (as of the quarantine)
// quarantined — and the permanent one, "open", was a trap: recordOpen returned null forever once a
// ticker existed, so a position admitted by a gate that was later repealed could NEVER be
// re-evaluated. It sat "open" until its fight settled and its P&L entered the summary as though the
// current rules had produced it. That is how three Chiesa positions reached the eve of settlement.
//
//   ACTIVE      the call is on, under the rules named in its provenance
//   WITHDRAWN   it no longer clears the CURRENT gate — the call is off (reversible: a call can come
//               back on, which is why WITHDRAWN is not terminal)
//   SUPERSEDED  the forecast/decision it rested on was replaced by a newer sealed one
//   QUARANTINED disowned from the P&L but preserved verbatim (a judgement, never reversed)
//   SETTLED     the fight resolved
//
// Every transition is recorded in `history`, so "why is this withdrawn?" always has an answer on the
// row itself. A rules change can no longer silently preserve an invalid position: reconcile() moves it
// to WITHDRAWN and says so.
const STATUS = Object.freeze({
  ACTIVE: "active", WITHDRAWN: "withdrawn", SUPERSEDED: "superseded",
  QUARANTINED: "quarantined", SETTLED: "settled",
});

// Every status change goes through here, so no transition is ever unrecorded. `from` is captured
// before the flip; nothing edits `status` directly except this function.
function transition(p, to, reason, extra = {}) {
  p.history = p.history || [];
  p.history.push({ from: p.status, to, reason: reason || null, at: nowIso(), ...extra });
  p.status = to;
  return p;
}

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

// The provenance every position must carry, so it can always be attributed to the rules that admitted
// it. Absent fields are recorded as null, never omitted: a missing field is a question the row cannot
// answer, and "which rules opened this?" must always have an answer, even if the answer is "unknown".
function provenanceOf(sig) {
  return {
    rulesVersion: sig.rulesVersion ?? null,       // e.g. forecast rules "7.0.0", or the gate commit
    forecastHash: sig.forecastHash ?? null,        // the sealed forecast this rested on (null for V1)
    decisionHash: sig.decisionHash ?? null,        // the sealed decision (null for V1)
    pipeline: sig.pipeline ?? null,                // "v1-signals" | "v2-entertainment" | ...
    gateResultAtOpen: sig.gateResult ?? null,      // the gate's verdict at the moment it was admitted
  };
}
function eligibilitySnapshot(sig, eligible = true) {
  return { eligible, rulesVersion: sig.rulesVersion ?? null, gateResult: sig.gateResult ?? null, checkedAt: nowIso() };
}

// Open a paper position for a qualifying signal. Entry (cost/stake/fair value) is LOCKED at the first
// sighting — you buy once, at the earliest price. Later sightings only merge in new sources
// (informational) and never move the entry.
//
// `sig` = { ticker, fighter, opponent, domain, fightDate, entryCost(0..1), fairValueCents, stakePct,
//           sources[], rulesVersion?, forecastHash?, decisionHash?, pipeline?, gateResult? }.
//
// Returns "opened" (fresh), "reactivated" (a withdrawn/superseded call is back on), or null (already
// active, or terminally locked). It is no longer a permanent lock — that was the bug.
function recordOpen(state, sig) {
  const p = state.positions[sig.ticker];
  if (p) {
    // Terminal by judgement or by outcome: never resurrected into a fresh entry.
    //   QUARANTINED — a judgement that this should not have existed; rebuilding it, or merging fresh
    //                 sources so it looks better-supported, would erase that judgement.
    //   SETTLED     — the fight is over; there is nothing to re-open.
    if (p.status === STATUS.QUARANTINED || p.status === STATUS.SETTLED) return null;

    if (p.status === STATUS.ACTIVE) {
      const have = new Set(p.sources || []);
      for (const s of sig.sources || []) have.add(s);
      p.sources = Array.from(have);
      p.lastSeen = nowIso();
      p.eligibility = eligibilitySnapshot(sig, true);   // seen and qualifying again this run
      return null;
    }

    // WITHDRAWN or SUPERSEDED and qualifying again: the call is back on. Same entry (we still track
    // "if you'd taken it at the first, softest price"), fresh provenance, transition recorded.
    p.eligibility = eligibilitySnapshot(sig, true);
    p.provenance = provenanceOf(sig);
    transition(p, STATUS.ACTIVE, "signal qualifies again under the current rules",
      { rulesVersion: sig.rulesVersion ?? null });
    return "reactivated";
  }

  state.positions[sig.ticker] = {
    ticker: sig.ticker, fighter: sig.fighter, opponent: sig.opponent || null,
    domain: sig.domain, fightDate: sig.fightDate || null,
    entryCost: sig.entryCost,               // price you'd pay, 0..1 (the ask at first signal)
    fairValueCents: sig.fairValueCents ?? null,
    stakePct: sig.stakePct ?? null,         // % of bankroll recommended at entry
    sources: Array.from(new Set(sig.sources || [])),
    status: STATUS.ACTIVE, result: null, exitPrice: null,
    provenance: provenanceOf(sig),          // which rules admitted this — never null-the-whole-object
    eligibility: eligibilitySnapshot(sig, true),
    history: [{ from: null, to: STATUS.ACTIVE, reason: "opened", at: nowIso() }],
    openedAt: nowIso(), lastSeen: nowIso(), settledAt: null, settledReason: null, pnlPct: null,
    summarizedOpen: false, summarizedSettled: false,
  };
  return "opened";
}

// VERSION-AWARE RECONCILIATION — the fix for "a rules change must not silently preserve an invalid
// position forever." Called each run for an ACTIVE position with the CURRENT gate's verdict on its
// ticker. If it no longer clears the gate, it is WITHDRAWN, with the reason recorded. The entry is
// never moved; only the position's standing changes.
function reconcile(state, ticker, { eligibleNow, rulesVersion, gateResult, reason } = {}) {
  const p = state.positions[ticker];
  if (!p || p.status !== STATUS.ACTIVE) return null;
  p.eligibility = { eligible: !!eligibleNow, rulesVersion: rulesVersion ?? null, gateResult: gateResult ?? null, checkedAt: nowIso() };
  if (!eligibleNow) {
    transition(p, STATUS.WITHDRAWN, reason || "no longer clears the current gate", { rulesVersion: rulesVersion ?? null });
    return "withdrawn";
  }
  return "active";
}

// The sealed forecast/decision this position rested on was replaced by a newer one. Distinct from
// WITHDRAWN: the position may still be eligible, but it is now attributed to a stale decision, so its
// standing is SUPERSEDED until a fresh recordOpen re-attributes it to the new one.
function supersede(state, ticker, { newForecastHash, newDecisionHash, reason } = {}) {
  const p = state.positions[ticker];
  if (!p || p.status !== STATUS.ACTIVE) return null;
  transition(p, STATUS.SUPERSEDED, reason || "the sealed forecast this position rested on was superseded",
    { fromForecastHash: p.provenance ? p.provenance.forecastHash : null, newForecastHash: newForecastHash ?? null, newDecisionHash: newDecisionHash ?? null });
  return "superseded";
}

const activePositions = (state) => Object.values(state.positions).filter((p) => p.status === STATUS.ACTIVE);
const quarantinedPositions = (state) => Object.values(state.positions).filter((p) => p.status === STATUS.QUARANTINED);

// Positions an outcome may still be recorded against. A settled fight settles the row regardless of
// standing — WITHDRAWN and SUPERSEDED positions still HAPPENED, and their outcome is history. Only
// what reaches the P&L is gated (countsInPerformance), never what gets recorded.
const settleablePositions = (state) =>
  Object.values(state.positions).filter((p) => p.status !== STATUS.SETTLED);

// The one predicate every scoreboard must ask before it adds a number. A row counts toward paper
// performance only if it was ACTIVE when its fight resolved AND was not quarantined. A position that
// was withdrawn or superseded before settlement is real history, but it is not a call the system was
// standing behind at the bell, so it does not enter the P&L.
const countsInPerformance = (p) =>
  p.status !== STATUS.QUARANTINED &&
  !(p.quarantine && p.quarantine.includedInPerformance === false) &&
  (p.settledFromStatus ? p.settledFromStatus === STATUS.ACTIVE : true);

// QUARANTINE — the honest way to disown a position without pretending it never happened.
//
// This exists because three positions were opened by a gate that has since been repealed (one of them
// EIGHT SECONDS before the commit that repealed it — b1399bd, 2026-07-16T15:01:48Z). Their fights
// settle 2026-07-18. `settlePositions` would have settled them and their P&L would have entered the
// daily paper summary as though the current system produced them — and because the record carried no
// rulesVersion, nothing downstream could have told.
//
// Deleting them would be the worse sin: this repo's own rule is "recompute tallies, never edit them by
// hand", and a scoreboard you quietly delete rows from is not a scoreboard. So the row stays, verbatim,
// and carries the reason it does not count. `originalRecord` is a byte-level snapshot taken BEFORE any
// field is touched, so the pre-quarantine state is always recoverable from the file itself.
function quarantine(state, ticker, { reason, originalRulesVersion, quarantinedBy }) {
  const p = state.positions[ticker];
  if (!p) return null;
  if (p.quarantine) return null;                       // already quarantined — never re-stamp
  if (!reason) throw new Error("quarantine requires a reason — an unexplained exclusion is indistinguishable from a deletion");
  p.quarantine = {
    ticker,
    originalOpenedAt: p.openedAt,
    originalSources: Array.from(p.sources || []),
    originalRulesVersion: originalRulesVersion || null,   // null when genuinely unreconstructable
    quarantinedAt: nowIso(),
    quarantinedBy: quarantinedBy || "unspecified",
    reason,
    includedInPerformance: false,
    includedInSourceScoring: false,
    includedInLearning: false,
    settlementMayBeRecorded: true,   // for historical reference only; never reaches pnl
    originalRecord: JSON.parse(JSON.stringify(p)),        // verbatim, taken before status changes
  };
  transition(p, STATUS.QUARANTINED, reason, { quarantinedBy: quarantinedBy || "unspecified" });
  return p.quarantine;
}

// Settle a paper position. result: 1 win / 0 loss / null void (cancelled). pnlPct is ROI on the
// staked dollars: win -> (1-cost)/cost, loss -> -1, void -> 0.
function settle(state, ticker, result, exitPrice, reason) {
  const p = state.positions[ticker];
  if (!p || p.status === STATUS.SETTLED) return;

  // A quarantined position records its outcome and stops. It does NOT become SETTLED: `settled` is the
  // status the scoreboard reads, so flipping it there is precisely how a disowned row walks back into
  // the P&L. The outcome lives inside the quarantine block, legible as history, unreachable by
  // newlySettled().
  if (p.status === STATUS.QUARANTINED) {
    p.quarantine.historicalSettlement = {
      result, exitPrice: exitPrice ?? (result === 1 ? 1 : result === 0 ? 0 : null),
      settledAt: nowIso(), reason: reason || "settled",
      note: "recorded for historical reference only — excluded from paper P&L, learning and source scoring",
    };
    return;
  }

  // Remember the standing at the bell. A WITHDRAWN or SUPERSEDED position still settles — its outcome
  // is a fact — but `settledFromStatus` lets countsInPerformance keep it out of the P&L, because the
  // system was not standing behind that call when the fight happened.
  p.settledFromStatus = p.status;
  transition(p, STATUS.SETTLED, reason || "settled", { result });
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

// Both feed the daily paper summary, which is the only place a P&L number is published. Both must
// therefore refuse quarantined rows — openPositions already excludes them by status, and the explicit
// countsInPerformance check on newlySettled is belt-and-braces against a future status flip.
const newlyOpened = (state) => activePositions(state).filter((p) => !p.summarizedOpen);
const newlySettled = (state) =>
  Object.values(state.positions).filter((p) => p.status === STATUS.SETTLED && !p.summarizedSettled && countsInPerformance(p));

function markSummarized(state, tickers, which) {
  const field = which === "open" ? "summarizedOpen" : "summarizedSettled";
  for (const t of tickers) if (state.positions[t]) state.positions[t][field] = true;
}

// Housekeeping: drop very old settled positions so the file cannot grow without bound.
function prune(state) {
  const t = nowMs();
  for (const [k, p] of Object.entries(state.positions)) {
    // A quarantined row is never pruned. It is the evidence for a judgement about this system's own
    // history, and the whole point of not deleting it is that it stays inspectable. Ageing it out
    // after a year would complete the deletion this design refused to do on day one.
    if (p.status === STATUS.QUARANTINED) continue;
    if (p.status === STATUS.SETTLED && t - Date.parse(p.settledAt || p.lastSeen || 0) > SETTLED_KEEP_DAYS * DAY)
      delete state.positions[k];
  }
}

const counts = (state) => {
  const c = { active: 0, withdrawn: 0, superseded: 0, quarantined: 0, settled: 0 };
  for (const p of Object.values(state.positions)) c[p.status] = (c[p.status] || 0) + 1;
  return c;
};

module.exports = {
  FILE, load, save, recordOpen, reconcile, supersede, settle, pnlDollars,
  activePositions, quarantinedPositions, settleablePositions, countsInPerformance,
  newlyOpened, newlySettled, markSummarized, prune, counts,
  quarantine, transition, STATUS,
  openPositions: activePositions,   // back-compat alias: old callers meant "active"
};
