// ONE-TIME migration for the real ledger. Additive, idempotent, and SAFE:
//   - stamps category / source / fees / payout / positionId / recommendationId onto existing REAL entries
//     (never rewrites realPnlDollars — historical real P&L is preserved exactly)
//   - writes the canonical data/bankrolls.json
// A rollback snapshot MUST already exist (data/_snapshots/…). Re-running is safe (no double-stamping).
require("./lib/env");
const MB = require("./lib/manual-bankroll");
const BK = require("./lib/bankrolls");

const at = (process.argv.find((a) => a.startsWith("--at=")) || "").split("=")[1] || new Date().toISOString();

const mb = MB.load();
const changed = MB.migrateEntries(mb);
MB.save(mb);

const b = BK.write({ now: at });

console.log(`migration complete — real entries stamped: ${changed}\n`);
console.log("REAL entries after migration:");
for (const e of Object.values(mb.entries)) {
  console.log(`  • ${e.fight}  [${e.category}] source=${e.source} paperEligible=${e.paperEligible} status=${e.status} realPnl=$${e.realPnlDollars} payout=${e.payout} fee=${e.fees ? e.fees.amount + "(" + e.fees.basis + ")" : "n/a"}`);
}
console.log("\nCANONICAL bankrolls.json:");
console.log(JSON.stringify({
  real: { starting: b.real.startingDollars, realizedPnl: b.real.realizedPnl, openExposure: b.real.openExposure, availableCash: b.real.availableCash, accountValue: b.real.accountValue },
}, null, 2));
