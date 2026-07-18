// Quarantine tests — disowning a position's numbers without deleting its history.
//
// The case this exists for: three paper positions were opened by a gate that was repealed at
// b1399bd (2026-07-16T15:01:48Z), one of them SEVEN SECONDS before the repeal commit. Their fights
// settle 2026-07-18. Nothing could re-evaluate them (recordOpen returns null forever once a ticker
// exists) and the record carried no rulesVersion, so their P&L would have entered the daily paper
// summary indistinguishable from a call the current system actually made.
//
// Every test below asserts an EXCLUSION or a PRESERVATION. The two failure directions are symmetric
// and both are dishonest: counting a disowned position, or deleting it so nobody can see it was ever
// there. Runs on synthetic state only — it never touches data/positions.json.
const P = require("../lib/positions");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const REASON = "opened under a repealed gate";
const fresh = () => {
  const st = { positions: {}, meta: {} };
  P.recordOpen(st, { ticker: "T1", fighter: "A", opponent: "B", domain: "mma", fightDate: "2026-07-18",
    entryCost: 0.4, fairValueCents: 45, stakePct: 0.8, sources: ["Michael Chiesa"] });
  P.recordOpen(st, { ticker: "T2", fighter: "C", opponent: "D", domain: "mma", fightDate: "2026-07-18",
    entryCost: 0.5, fairValueCents: 55, stakePct: 3, sources: ["A Real Source"] });
  return st;
};

console.log("QUARANTINE PRESERVES THE ORIGINAL RECORD");
{
  const st = fresh();
  const before = JSON.parse(JSON.stringify(st.positions.T1));
  P.quarantine(st, "T1", { reason: REASON, originalRulesVersion: "pre-b1399bd", quarantinedBy: "test" });
  const p = st.positions.T1;

  ok("the position still exists — it is not deleted", !!p);
  // Quarantine changes only the position's STANDING: its status flips and the transition is recorded
  // in `history`. Every field describing the call itself — entry, stake, sources, provenance — is
  // untouched. (history changes because every transition is logged; that is the audit trail, not a
  // mutation of the call.)
  ok("only status and the transition log change", (() => {
    const now = { ...p }; delete now.quarantine;
    const was = { ...before };
    const diffs = Object.keys({ ...was, ...now }).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    return diffs.sort().join(",") === "history,status";
  })(), JSON.stringify(Object.keys({ ...before, ...p }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify({ ...p, quarantine: undefined }[k]))));
  ok("a verbatim snapshot of the pre-quarantine record is kept",
    JSON.stringify(p.quarantine.originalRecord) === JSON.stringify(before));
  ok("...and the snapshot remembers it was active", p.quarantine.originalRecord.status === "active");
  ok("status is quarantined", p.status === "quarantined");
}

console.log("\nTHE QUARANTINE RECORD IS AUDITABLE");
{
  const st = fresh();
  const q = P.quarantine(st, "T1", { reason: REASON, originalRulesVersion: "pre-b1399bd", quarantinedBy: "test" });
  for (const f of ["ticker", "originalOpenedAt", "originalSources", "originalRulesVersion",
                   "quarantinedAt", "quarantinedBy", "reason"]) {
    ok(`carries ${f}`, q[f] !== undefined && q[f] !== "");
  }
  ok("includedInPerformance is false", q.includedInPerformance === false);
  ok("includedInLearning is false", q.includedInLearning === false);
  ok("includedInSourceScoring is false", q.includedInSourceScoring === false);
  ok("the original source is recorded", JSON.stringify(q.originalSources) === JSON.stringify(["Michael Chiesa"]));
  ok("quarantinedAt is a real timestamp, not invented", Number.isFinite(Date.parse(q.quarantinedAt)));

  // An unexplained exclusion is indistinguishable from a deletion.
  let threw = false;
  try { P.quarantine(fresh(), "T1", { reason: "" }); } catch { threw = true; }
  ok("quarantining with no reason throws", threw);

  // An unreconstructable rules version must be recorded as unknown, not guessed.
  const q2 = P.quarantine(fresh(), "T1", { reason: REASON, quarantinedBy: "test" });
  ok("an unreconstructable rulesVersion is null, not fabricated", q2.originalRulesVersion === null);
}

console.log("\nA QUARANTINED POSITION IS EXCLUDED FROM EVERY SCOREBOARD");
{
  const st = fresh();
  P.quarantine(st, "T1", { reason: REASON, quarantinedBy: "test" });

  ok("openPositions excludes it", P.openPositions(st).map((p) => p.ticker).join() === "T2");
  ok("newlyOpened excludes it (never reaches the daily summary)", P.newlyOpened(st).map((p) => p.ticker).join() === "T2");
  ok("counts reports it separately", P.counts(st).quarantined === 1 && P.counts(st).active === 1);
  ok("countsInPerformance is false", P.countsInPerformance(st.positions.T1) === false);
  ok("...and true for the untouched position", P.countsInPerformance(st.positions.T2) === true);
  ok("settleablePositions INCLUDES it — history is still recorded", P.settleablePositions(st).length === 2);
}

console.log("\nSETTLEMENT IS RECORDED FOR HISTORY BUT NEVER REACHES P&L");
{
  const st = fresh();
  P.quarantine(st, "T1", { reason: REASON, quarantinedBy: "test" });

  // The decisive test. T1 would have WON — the most tempting number to count.
  P.settle(st, "T1", 1, 1, "kalshi finalized");
  const p = st.positions.T1;

  ok("the outcome IS recorded", p.quarantine.historicalSettlement.result === 1);
  ok("...with a reason and a timestamp",
    !!p.quarantine.historicalSettlement.reason && Number.isFinite(Date.parse(p.quarantine.historicalSettlement.settledAt)));
  ok("...and says plainly that it is excluded", /historical reference only/.test(p.quarantine.historicalSettlement.note));

  // The failure mode: `settled` is the status every scoreboard reads.
  ok("status does NOT become settled", p.status === "quarantined");
  ok("top-level result stays null", p.result === null);
  ok("pnlPct is never computed", p.pnlPct === null);
  ok("newlySettled does not surface it", P.newlySettled(st).length === 0);
  ok("pnlDollars yields nothing to add", P.pnlDollars(p, 100) === null);

  // A won position at 40c on a $100 bankroll would have printed +$1.20 paper. Prove the summary path
  // sees zero settled rows, not a row worth zero.
  P.settle(st, "T2", 1, 1, "kalshi finalized");
  ok("a NON-quarantined winner still settles normally", st.positions.T2.status === "settled");
  ok("...and still reports its P&L", P.pnlDollars(st.positions.T2, 100) === 3);
  ok("newlySettled surfaces only the legitimate one", P.newlySettled(st).map((p) => p.ticker).join() === "T2");
}

console.log("\nNO REPLACEMENT POSITION CAN BE CREATED FOR A QUARANTINED TICKER");
{
  const st = fresh();
  P.quarantine(st, "T1", { reason: REASON, quarantinedBy: "test" });

  const r = P.recordOpen(st, { ticker: "T1", fighter: "A", opponent: "B", domain: "mma",
    fightDate: "2026-07-18", entryCost: 0.4, stakePct: 5, sources: ["Somebody Else"] });
  ok("recordOpen refuses to re-open it", r === null);
  ok("...and does not resurrect its status", st.positions.T1.status === "quarantined");
  ok("...and does NOT merge fresh sources into it",
    JSON.stringify(st.positions.T1.sources) === JSON.stringify(["Michael Chiesa"]));
  ok("...and does not move the stake", st.positions.T1.stakePct === 0.8);
  ok("there is exactly one row for the ticker", Object.keys(st.positions).filter((k) => k === "T1").length === 1);
}

console.log("\nQUARANTINE IS IDEMPOTENT AND NEVER PRUNED");
{
  const st = fresh();
  const first = P.quarantine(st, "T1", { reason: REASON, quarantinedBy: "test" });
  const second = P.quarantine(st, "T1", { reason: "a different reason", quarantinedBy: "test" });
  ok("re-quarantining returns null rather than re-stamping", second === null);
  ok("...and the original reason survives", st.positions.T1.quarantine.reason === first.reason);

  // prune deletes settled rows after a year. The quarantine record is the evidence for a judgement
  // about this system's own history; ageing it out would complete the deletion we refused to do.
  st.positions.T1.quarantine.historicalSettlement = { settledAt: new Date(Date.now() - 400 * 86400000).toISOString() };
  st.positions.T1.settledAt = new Date(Date.now() - 400 * 86400000).toISOString();
  st.positions.T2.status = "settled";
  st.positions.T2.settledAt = new Date(Date.now() - 400 * 86400000).toISOString();
  P.prune(st);
  ok("a year-old quarantined row is NOT pruned", !!st.positions.T1);
  ok("...while an ordinary year-old settled row still is", !st.positions.T2);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
