// POSITION LIFECYCLE + PROVENANCE — the fix for a rules change silently preserving an invalid
// position forever.
//
// recordOpen used to return null the moment a ticker existed, so a position admitted by a gate that
// was later repealed could never be re-evaluated: it stayed "open" until its fight settled and its
// P&L entered the summary as though the current rules had produced it. And the row carried no
// provenance, so nothing downstream could even tell which rules had admitted it. Three Chiesa
// positions reached the eve of settlement exactly this way.
//
// Every test asserts one of: provenance is carried; a repealed position is WITHDRAWN not preserved;
// transitions are recorded; there is never more than one ACTIVE row per ticker.
const P = require("../lib/positions");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const S = P.STATUS;
const sig = (o = {}) => ({
  ticker: "T1", fighter: "A", opponent: "B", domain: "mma", fightDate: "2026-07-18",
  entryCost: 0.4, fairValueCents: 45, stakePct: 3, sources: ["Src"],
  rulesVersion: "7.0.0", forecastHash: "fc-abc", decisionHash: "dc-def",
  pipeline: "v2-entertainment", gateResult: { classification: "ACTIONABLE EXPERIMENTAL" }, ...o,
});
const fresh = () => ({ positions: {}, meta: {} });

console.log("EVERY NEW POSITION CARRIES ITS PROVENANCE");
{
  const st = fresh();
  ok("first recordOpen returns 'opened'", P.recordOpen(st, sig()) === "opened");
  const p = st.positions.T1;
  ok("status is ACTIVE", p.status === S.ACTIVE);
  for (const f of ["rulesVersion", "forecastHash", "decisionHash", "pipeline", "gateResultAtOpen"]) {
    ok(`provenance carries ${f}`, p.provenance && p.provenance[f] !== undefined);
  }
  ok("rulesVersion is recorded", p.provenance.rulesVersion === "7.0.0");
  ok("forecastHash is recorded", p.provenance.forecastHash === "fc-abc");
  ok("decisionHash is recorded", p.provenance.decisionHash === "dc-def");
  ok("the source pipeline is recorded", p.provenance.pipeline === "v2-entertainment");
  ok("the gate result at open is recorded", !!p.provenance.gateResultAtOpen);
  ok("an eligibility snapshot is stored", p.eligibility && p.eligibility.eligible === true);
  ok("the open is the first history entry", p.history.length === 1 && p.history[0].to === S.ACTIVE);

  // Absent provenance is recorded as null, not omitted — a missing field is a question the row cannot
  // answer, and "which rules opened this?" must always have an answer.
  const st2 = fresh();
  P.recordOpen(st2, { ticker: "T9", fighter: "X", opponent: "Y", domain: "mma", entryCost: 0.5, stakePct: 1, sources: ["Z"] });
  ok("a position opened with no provenance still has the fields, set to null",
    st2.positions.T9.provenance.rulesVersion === null && st2.positions.T9.provenance.forecastHash === null);
}

console.log("\nNO DUPLICATE ACTIVE POSITION ON A TICKER");
{
  const st = fresh();
  P.recordOpen(st, sig());
  const second = P.recordOpen(st, sig({ entryCost: 0.9, sources: ["Src2"] }));
  ok("a second recordOpen on an ACTIVE ticker returns null", second === null);
  ok("...the entry price is NOT moved", st.positions.T1.entryCost === 0.4);
  ok("...but the new source IS merged (informational)", st.positions.T1.sources.includes("Src2"));
  ok("...there is exactly one row for the ticker", Object.keys(st.positions).length === 1);
  ok("...and exactly one ACTIVE row", P.activePositions(st).length === 1);
}

console.log("\nA RULES CHANGE WITHDRAWS AN INVALID POSITION — IT DOES NOT PRESERVE IT");
{
  const st = fresh();
  P.recordOpen(st, sig());

  // The signal no longer clears the current gate.
  const r = P.reconcile(st, "T1", { eligibleNow: false, rulesVersion: "7.1.0", reason: "source is now isFighter under the new gate" });
  ok("reconcile returns 'withdrawn'", r === "withdrawn");
  ok("status is WITHDRAWN", st.positions.T1.status === S.WITHDRAWN);
  ok("...the reason is recorded", /isFighter/.test(st.positions.T1.history.at(-1).reason));
  ok("...the eligibility snapshot shows ineligible under the new rules",
    st.positions.T1.eligibility.eligible === false && st.positions.T1.eligibility.rulesVersion === "7.1.0");
  ok("a withdrawn position is NOT active", P.activePositions(st).length === 0);

  // Still eligible -> stays active, but the check is recorded.
  const st2 = fresh();
  P.recordOpen(st2, sig());
  ok("reconcile with eligibleNow:true keeps it active", P.reconcile(st2, "T1", { eligibleNow: true, rulesVersion: "7.0.0" }) === "active");
  ok("...and stamps the check time", !!st2.positions.T1.eligibility.checkedAt);
}

console.log("\nA WITHDRAWN CALL CAN COME BACK ON — WITHOUT MOVING THE ENTRY");
{
  const st = fresh();
  P.recordOpen(st, sig());
  P.reconcile(st, "T1", { eligibleNow: false, reason: "priced out" });
  ok("it is withdrawn", st.positions.T1.status === S.WITHDRAWN);

  const back = P.recordOpen(st, sig({ entryCost: 0.6, rulesVersion: "7.1.0" }));
  ok("recordOpen on a withdrawn ticker returns 'reactivated'", back === "reactivated");
  ok("...status is ACTIVE again", st.positions.T1.status === S.ACTIVE);
  ok("...the ENTRY is preserved, not moved to the new price", st.positions.T1.entryCost === 0.4);
  ok("...provenance is refreshed to the current rules", st.positions.T1.provenance.rulesVersion === "7.1.0");
  ok("...and the round-trip is in the history", st.positions.T1.history.map((h) => h.to).join(",") === "active,withdrawn,active");
}

console.log("\nSUPERSEDED IS DISTINCT FROM WITHDRAWN");
{
  const st = fresh();
  P.recordOpen(st, sig());
  const r = P.supersede(st, "T1", { newForecastHash: "fc-new", reason: "resealed on fresh evidence" });
  ok("supersede returns 'superseded'", r === "superseded");
  ok("status is SUPERSEDED", st.positions.T1.status === S.SUPERSEDED);
  ok("...it records the old and new forecast hashes",
    st.positions.T1.history.at(-1).fromForecastHash === "fc-abc" && st.positions.T1.history.at(-1).newForecastHash === "fc-new");
  ok("a superseded position is not active", P.activePositions(st).length === 0);
  ok("...but can be re-attributed to the new decision via recordOpen", P.recordOpen(st, sig({ forecastHash: "fc-new" })) === "reactivated");
}

console.log("\nTERMINAL STATES ARE NOT RESURRECTED");
{
  // SETTLED: the fight is over.
  const st = fresh();
  P.recordOpen(st, sig());
  P.settle(st, "T1", 1, 1, "kalshi finalized");
  ok("a settled ticker records its pre-settlement standing", st.positions.T1.settledFromStatus === S.ACTIVE);
  ok("recordOpen on a settled ticker returns null", P.recordOpen(st, sig()) === null);
  ok("...it stays settled", st.positions.T1.status === S.SETTLED);

  // QUARANTINED: a judgement, never reversed.
  const st2 = fresh();
  P.recordOpen(st2, sig());
  P.quarantine(st2, "T1", { reason: "repealed gate", quarantinedBy: "test" });
  ok("recordOpen on a quarantined ticker returns null", P.recordOpen(st2, sig()) === null);
  ok("...it stays quarantined", st2.positions.T1.status === S.QUARANTINED);
  ok("...reconcile leaves a quarantined position alone", P.reconcile(st2, "T1", { eligibleNow: true }) === null);
  ok("...supersede leaves it alone too", P.supersede(st2, "T1", {}) === null);
}

console.log("\nA WITHDRAWN POSITION THAT SETTLES IS HISTORY, NOT P&L");
{
  const st = fresh();
  P.recordOpen(st, sig());
  P.reconcile(st, "T1", { eligibleNow: false, reason: "withdrawn before the bell" });

  // It still settles — the outcome is a fact — but it must not enter the paper P&L, because the system
  // was not standing behind the call when the fight happened.
  P.settle(st, "T1", 1, 1, "kalshi finalized");
  ok("a withdrawn position still settles (the outcome is recorded)", st.positions.T1.status === S.SETTLED);
  ok("...it remembers it was withdrawn at the bell", st.positions.T1.settledFromStatus === S.WITHDRAWN);
  ok("...countsInPerformance is FALSE", P.countsInPerformance(st.positions.T1) === false);
  ok("...so it never reaches the summary", P.newlySettled(st).length === 0);

  // Contrast: a position ACTIVE at the bell does count.
  const st2 = fresh();
  P.recordOpen(st2, sig({ ticker: "T2" }));
  P.settle(st2, "T2", 1, 1, "kalshi finalized");
  ok("a position active at the bell DOES count", P.countsInPerformance(st2.positions.T2) === true && P.newlySettled(st2).length === 1);
}

console.log("\nCOUNTS COVER EVERY LIFECYCLE STATE");
{
  const st = fresh();
  P.recordOpen(st, sig({ ticker: "A" }));
  P.recordOpen(st, sig({ ticker: "B" })); P.reconcile(st, "B", { eligibleNow: false, reason: "x" });
  P.recordOpen(st, sig({ ticker: "C" })); P.supersede(st, "C", {});
  P.recordOpen(st, sig({ ticker: "D" })); P.quarantine(st, "D", { reason: "x", quarantinedBy: "t" });
  P.recordOpen(st, sig({ ticker: "E" })); P.settle(st, "E", 0, 0, "lost");
  const c = P.counts(st);
  ok("counts report active/withdrawn/superseded/quarantined/settled",
    c.active === 1 && c.withdrawn === 1 && c.superseded === 1 && c.quarantined === 1 && c.settled === 1,
    JSON.stringify(c));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
