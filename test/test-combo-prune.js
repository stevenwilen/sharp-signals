// COMBO RECORD PRUNING — a combo is only live for an UPCOMING card. Once its card starts, gatherLegs
// stops rebuilding it, so without pruning the record lingers and the dashboard shows a stale "old combo
// bet" from a finished card. This pins the prune: started-card records go, upcoming-card records stay.
const { pruneStaleRecords } = require("../lib/combo-pipeline");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const NOW = Date.parse("2026-07-27T12:00:00Z");   // two days after the 07-25 card
const rec = (eventDate, at) => ({ at: at || "2026-07-25T15:00:44Z", decision: "COMBO_UNAVAILABLE",
  audit: { legs: eventDate ? [{ ticker: `KXUFCFIGHT-x`, eventDate }, { ticker: `KXUFCFIGHT-y`, eventDate }] : [] } });

// 1. A finished-card combo (the real bug: a 07-25 combo still showing on 07-27) is pruned.
{
  const audit = { records: { "combo|old": rec("2026-07-25") } };
  const n = pruneStaleRecords(audit, NOW);
  ok(n === 1 && !audit.records["combo|old"], "1. a started-card (07-25) combo is pruned");
}
// 2. An upcoming-card combo (08-01) is KEPT — never prune a live combo.
{
  const audit = { records: { "combo|next": rec("2026-08-01") } };
  const n = pruneStaleRecords(audit, NOW);
  ok(n === 0 && audit.records["combo|next"], "2. an upcoming-card (08-01) combo is kept");
}
// 3. Mixed: prune only the stale one.
{
  const audit = { records: { "combo|old": rec("2026-07-25"), "combo|next": rec("2026-08-01") } };
  const n = pruneStaleRecords(audit, NOW);
  ok(n === 1 && !audit.records["combo|old"] && audit.records["combo|next"], "3. mixed set -> only the started-card combo is removed");
}
// 4. Fallback: no leg eventDate, but the record is >36h stale -> pruned.
ok((() => { const a = { records: { x: rec(null, "2026-07-24T00:00:00Z") } }; return pruneStaleRecords(a, NOW) === 1 && !a.records.x; })(),
  "4. no eventDate + not refreshed in 36h -> pruned (fallback)");
// 5. Fallback: no leg eventDate, recently refreshed -> KEPT (don't prune a fresh unknown).
ok((() => { const a = { records: { x: rec(null, "2026-07-27T06:00:00Z") } }; return pruneStaleRecords(a, NOW) === 0 && a.records.x; })(),
  "5. no eventDate but refreshed <36h ago -> kept (no blind guess)");
// 6. Empty / malformed audit -> no throw, nothing pruned.
ok(pruneStaleRecords({ records: {} }, NOW) === 0 && pruneStaleRecords({}, NOW) === 0, "6. empty/malformed audit -> 0 pruned, no throw");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
