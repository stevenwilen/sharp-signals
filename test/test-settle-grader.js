// AUTO-SETTLE FROM MARKET — books real P&L from the PUBLIC Kalshi resolution, and REFUSES to fabricate.
// Asserts the refusals as hard as the happy path: an unreadable or unfinalized market is left placed
// (never settled to a guessed outcome), only MANUALLY_PLACED positions grade, and re-running is idempotent.
const os = require("os"), fs = require("fs"), pathm = require("path");
const TMP = pathm.join(os.tmpdir(), "ss-settle-grader-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;
const MB = require("../lib/manual-bankroll");
const G = require("../lib/settle-grader");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };
const near = (a, b) => Math.abs(a - b) < 0.01;

// Build a state with two placed YES positions + one still-recommended (must be ignored).
function freshState() {
  const s = { bankroll: 100, entries: {} };
  MB.recordRecommendation(s, { key: "MON", ticker: "T-MON", fight: "Montes vs McMillen", classification: "strong experimental", recommendedStakeDollars: 4, maximumAcceptablePrice: 0.41 });
  MB.confirmPlacement(s, "MON", { executionPrice: 0.35, actualStake: 4 });
  MB.recordRecommendation(s, { key: "DU", ticker: "T-DU", fight: "Usman vs Du Plessis", classification: "CREATIVE SPECULATIVE", recommendedStakeDollars: 3, maximumAcceptablePrice: 0.62 });
  MB.confirmPlacement(s, "DU", { executionPrice: 0.66, actualStake: 3 });
  MB.recordRecommendation(s, { key: "REC", ticker: "T-REC", fight: "A vs B", classification: "strong experimental", recommendedStakeDollars: 2, maximumAcceptablePrice: 0.5 });
  return s;
}
const stub = (map) => async (ticker) => map[ticker] || { status: null, result: null };

(async () => {
  console.log("positionResult MAPS A YES CONTRACT CORRECTLY (and refuses the ambiguous)");
  {
    ok("resolved YES -> win (1)", G.positionResult({ status: "finalized", result: "yes" }) === 1);
    ok("resolved NO -> loss (0)", G.positionResult({ status: "finalized", result: "no" }) === 0);
    ok("finalized void ('') -> null", G.positionResult({ status: "settled", result: "" }) === null);
    ok("open market -> undefined (do not settle)", G.positionResult({ status: "active", result: null }) === undefined);
    ok("unreadable -> undefined", G.positionResult({}) === undefined);
    ok("a '' result on a NON-final market is NOT a void", G.positionResult({ status: "active", result: "" }) === undefined);
  }

  console.log("\nONLY FINALIZED MARKETS SETTLE; the rest stay placed");
  {
    const s = freshState();
    const r = await G.gradeFromMarket(s, { settlement: stub({ "T-MON": { status: "finalized", result: "yes" }, "T-DU": { status: "active", result: null } }) });
    ok("Montes settled (market finalized YES)", r.settled.length === 1 && r.settled[0].key === "MON");
    ok("Du Plessis left pending (market still open)", r.pending.includes("DU"));
    ok("the recommended-but-unplaced entry is never graded", !r.settled.some((x) => x.key === "REC") && !r.pending.includes("REC"));
    ok("Montes booked a WIN: $4 @ 35c -> +$7.43", near(s.entries.MON.realPnlDollars, 7.43), s.entries.MON.realPnlDollars);
    ok("Montes is now SETTLED", s.entries.MON.status === "SETTLED");
    ok("Du Plessis is still MANUALLY_PLACED", s.entries.DU.status === "MANUALLY_PLACED");
  }

  console.log("\nA LOSS AND A VOID BOOK THE RIGHT P&L");
  {
    const s = freshState();
    await G.gradeFromMarket(s, { settlement: stub({ "T-MON": { status: "finalized", result: "no" }, "T-DU": { status: "finalized", result: "" } }) });
    ok("Montes LOSS: -$4 (whole stake)", near(s.entries.MON.realPnlDollars, -4), s.entries.MON.realPnlDollars);
    ok("Du Plessis VOID: $0 (stake returned)", s.entries.DU.realPnlDollars === 0 && s.entries.DU.status === "SETTLED");
  }

  console.log("\nFAIL CLOSED — an unreadable market NEVER settles to a fabricated outcome");
  {
    const s = freshState();
    const r1 = await G.gradeFromMarket(s, { settlement: async () => { throw new Error("kalshi down"); } });
    ok("a thrown settlement is treated as unreadable", r1.unreadable.length === 2 && r1.settled.length === 0);
    const r2 = await G.gradeFromMarket(s, { settlement: stub({}) }); // all return {null,null}
    ok("all-null settlement -> unreadable, nothing settled", r2.unreadable.length === 2 && r2.settled.length === 0);
    ok("both positions remain MANUALLY_PLACED (no guessed result)", s.entries.MON.status === "MANUALLY_PLACED" && s.entries.DU.status === "MANUALLY_PLACED");
  }

  console.log("\nIDEMPOTENT — re-running never double-settles");
  {
    const s = freshState();
    const first = await G.gradeFromMarket(s, { settlement: stub({ "T-MON": { status: "finalized", result: "yes" }, "T-DU": { status: "finalized", result: "no" } }) });
    ok("first pass settles both", first.settled.length === 2);
    const pnl = { MON: s.entries.MON.realPnlDollars, DU: s.entries.DU.realPnlDollars };
    const second = await G.gradeFromMarket(s, { settlement: stub({ "T-MON": { status: "finalized", result: "yes" }, "T-DU": { status: "finalized", result: "no" } }) });
    ok("second pass settles NOTHING new", second.settled.length === 0);
    ok("P&L is unchanged by the re-run", s.entries.MON.realPnlDollars === pnl.MON && s.entries.DU.realPnlDollars === pnl.DU);
  }

  console.log("\nGUARD — a missing settlement function is refused, not silently ignored");
  {
    let threw = false;
    try { await G.gradeFromMarket(freshState(), {}); } catch { threw = true; }
    ok("no settlement fn -> throws (never a silent no-op that looks like 'all pending')", threw);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
