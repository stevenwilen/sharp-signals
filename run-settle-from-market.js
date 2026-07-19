// AUTO-SETTLE MANUAL POSITIONS FROM THE MARKET (read-only).
//
//   node run-settle-from-market.js [--send]
//
// Books real P&L for every MANUALLY_PLACED position whose Kalshi market has finalized, deriving win/loss
// from the PUBLIC market resolution (lib/kalshi.settlement) — no account access, no write path, no manual
// win/loss entry. A market that can't be read or hasn't finalized is left placed. `--send` fires one
// compact "⚪ result settled → open dashboard" ping when anything newly settles (the dashboard carries the
// P&L detail). Idempotent: re-running never double-settles.
require("./lib/env");
const MB = require("./lib/manual-bankroll");
const K = require("./lib/kalshi");
const N = require("./lib/notification");
const G = require("./lib/settle-grader");

(async () => {
  const state = MB.load();
  const placedBefore = Object.values(state.entries || {}).filter((e) => e.status === MB.STATUS.MANUALLY_PLACED).length;
  const { settled, pending, unreadable } = await G.gradeFromMarket(state, { settlement: (t) => K.settlement(t) });
  if (settled.length) MB.save(state);

  console.log(`settle-from-market: ${placedBefore} placed · ${settled.length} newly settled · ${pending.length} pending · ${unreadable.length} unreadable`);
  for (const s of settled) {
    const label = s.result === 1 ? "WON " : s.result === 0 ? "LOST" : "VOID";
    console.log(`  ${label}  ${s.fight}  real P&L $${s.realPnlDollars}`);
  }
  if (unreadable.length) console.log(`  (${unreadable.length} market(s) could not be read — left placed, not settled)`);

  // One ping total: "something settled, open the dashboard." The compact channel never carries the numbers.
  if (process.argv.includes("--send") && settled.length) {
    try { await require("./lib/notify").notify(N.compact("SETTLED")); }
    catch (e) { console.log(`  ⚠ settle ping failed: ${e.message}`); }
  }
  process.exit(0);
})().catch((e) => { console.error("settle-from-market error:", e.message); process.exit(1); });
