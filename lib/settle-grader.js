// AUTO-SETTLE FROM THE MARKET (read-only). For every MANUALLY_PLACED position, read the Kalshi market's
// settlement — a PUBLIC fact on the read API (lib/kalshi.settlement), no account access and no write path —
// and book its real win/loss. This is how the system "knows" a manual bet resolved without you telling it:
// the OUTCOME is public, and your PARTICIPATION was already recorded when you confirmed the placement.
//
// IT NEVER FABRICATES. A market that cannot be read, or that has not finalized, is left MANUALLY_PLACED
// (absence is the truthful value — the same rule that governs the rest of this repo). Every current
// position is a YES contract (the only side the system recommends), so a "yes" resolution WINS the
// position, "no" LOSES it, and an explicit void ("") returns the stake.
require("./env");
const MB = require("./manual-bankroll");

// Map a Kalshi settlement {status, result} to a POSITION result for a YES contract:
//   1 = win · 0 = loss · null = void · undefined = not finalized / unreadable (do NOT settle).
function positionResult({ status, result } = {}) {
  if (result === "yes") return 1;   // YES contract, market resolved YES -> win
  if (result === "no") return 0;    // market resolved NO -> the YES position loses
  const finalized = /settl|final|determ/i.test(String(status || ""));
  if (finalized && result === "") return null;   // explicit void -> stake returned
  return undefined;                  // not finalized / unreadable -> leave it placed
}

// Grade every MANUALLY_PLACED entry against the market. `settlement` is async (ticker) -> {status,result}.
// Applies MB.settle for each newly-resolved position (idempotent: a SETTLED entry is never re-graded, and
// MB.settle itself refuses anything not MANUALLY_PLACED). Returns a summary; does NOT persist (caller saves).
async function gradeFromMarket(state, { settlement } = {}) {
  if (typeof settlement !== "function") throw new Error("gradeFromMarket needs a read-only settlement(ticker) function");
  const placed = Object.values(state.entries || {}).filter((e) => e.status === MB.STATUS.MANUALLY_PLACED);
  const settled = [], pending = [], unreadable = [];
  for (const e of placed) {
    let s = null;
    try { s = await settlement(e.ticker); } catch { s = null; }
    // Unreadable: no object, or neither field present. Fail closed — never settle on a guess.
    if (!s || (s.result == null && s.status == null)) { unreadable.push(e.key); continue; }
    const r = positionResult(s);
    if (r === undefined) { pending.push(e.key); continue; }
    const done = MB.settle(state, e.key, r);
    if (done) settled.push({ key: e.key, ticker: e.ticker, fight: e.fight, result: r, realPnlDollars: done.realPnlDollars });
    else pending.push(e.key);   // settle refused (e.g. already settled) — treat as nothing new
  }
  return { settled, pending, unreadable };
}

module.exports = { gradeFromMarket, positionResult };
