// TWO-LEDGER SEPARATION — proves the 12 verification cases the operator required. Real Entertainment
// Bankroll ($100, lib/manual-bankroll.js) and Paper Strategy Bankroll ($10,000, lib/paper-ledger.js) are
// fully separate: separate files, schemas, position IDs, P&L, and calculations. A formal system BUY
// auto-enters PAPER and touches REAL money only on manual confirmation; speculative/discretionary bets
// touch REAL only; settlements are independent; unconfirmed recommendations count in neither.
const os = require("os"), fs = require("fs"), path = require("path");
const TMP = path.join(os.tmpdir(), "ss-two-ledger-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;
const MB = require("../lib/manual-bankroll");
const PL = require("../lib/paper-ledger");
const BK = require("../lib/bankrolls");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };
const near = (a, b) => Math.abs(a - b) < 0.011;
const NOW = "2026-11-01T12:00:00Z";
const EVENT = "2026-12-01";           // pre-bell throughout
const SETTLE_TS = "2026-12-02T00:00:00Z";
const stub = (map) => async (t) => map[t] || { status: null, result: null };
// Isolate cases that persist to disk (case 10) from the loaders in later cases.
const reset = () => { for (const f of ["manual-bankroll.json", "paper-ledger.json", "bankrolls.json"]) { try { fs.rmSync(path.join(TMP, f)); } catch {} } };

// The recommendation hook, exactly as the runners will call it: a formal core BUY auto-enters paper AND
// records a real (unconfirmed) recommendation, joined by a shared recommendationId (= the ledger key).
function issueFormalBuy(mb, pl, { key, ticker, fraction, classification, edge }) {
  MB.recordRecommendation(mb, { key, boutId: "B", ticker, fight: "A vs B", lane: "core", classification, recommendedStakeDollars: fraction * 100, recommendedFraction: fraction, ask: 0.5, forecastHash: "h" });
  const r = PL.openPaper(pl, { recommendationId: key, ticker, eventDate: EVENT, fight: "A vs B", tier: classification, category: "CONFIRMED_SYSTEM_BET", kind: "single", fraction, entryPrice: 0.5, edgeAtEntry: edge }, { now: NOW });
  return r;
}

(async () => {
  // ── 1 & 2: a formal BUY auto-creates a PAPER position; real money is untouched until confirmed ──
  console.log("CASE 1 & 2 — formal BUY: paper auto-created, real money untouched");
  {
    const mb = MB.load(), pl = PL.load();
    const r = issueFormalBuy(mb, pl, { key: "K1", ticker: "T1", fraction: 0.04, classification: "strong experimental", edge: 0.1 });
    ok("1. paper position created automatically (no confirmation)", r.created === true && r.position.status === "PAPER_OPEN");
    ok("1. sized by % scaling: 4% of $10,000 = $400", r.position.paperStake === 400, r.position.paperStake);
    ok("1. real ledger has only an UNCONFIRMED recommendation", mb.entries.K1.status === "RECOMMENDED_NOT_CONFIRMED");
    ok("2. real money is $0 — nothing placed", MB.summary(mb).realizedPnl === 0 && MB.summary(mb).openExposure === 0);
    ok("2. real available cash is untouched ($100)", MB.summary(mb).availableCash === 100);
  }

  // ── 3: confirming the BUY creates a SEPARATE linked real position ──
  console.log("\nCASE 3 — confirming creates a separate real position, linked by recommendationId");
  {
    const mb = MB.load(), pl = PL.load();
    issueFormalBuy(mb, pl, { key: "K1", ticker: "T1", fraction: 0.04, classification: "strong experimental", edge: 0.1 });
    MB.confirmPlacement(mb, "K1", { executionPrice: 0.5, actualStake: 4 });
    const realPos = mb.entries.K1, paperPos = Object.values(pl.positions).find((p) => p.recommendationId === "K1");
    ok("3. real position now MANUALLY_PLACED", realPos.status === "MANUALLY_PLACED");
    ok("3. it is a DISTINCT record from the paper position (different IDs)", realPos.positionId !== paperPos.paperPositionId);
    ok("3. the two are linked by recommendationId", realPos.recommendationId === paperPos.recommendationId && realPos.recommendationId === "K1");
    ok("3. still exactly ONE paper position (no duplicate on confirm)", Object.keys(pl.positions).length === 1);
  }

  // ── 4 & 5: a speculative bet touches REAL only and never enters paper ──
  console.log("\nCASE 4 & 5 — speculative/exploration bet: real only, never in paper");
  {
    const mb = MB.load(), pl = PL.load();
    // exploration BUY: recorded real (unconfirmed) but PAPER REFUSES it
    MB.recordRecommendation(mb, { key: "S1", boutId: "B2", ticker: "T2", fight: "C vs D", lane: "exploration", classification: "CREATIVE SPECULATIVE", recommendedStakeDollars: 3, ask: 0.5 });
    const rej = PL.openPaper(pl, { recommendationId: "S1", ticker: "T2", eventDate: EVENT, category: "SPECULATIVE_BET", kind: "single", fraction: 0.03, entryPrice: 0.5 }, { now: NOW });
    ok("5. paper REFUSES a speculative bet", rej.created === false && /not paper-eligible/.test(rej.reason));
    MB.confirmPlacement(mb, "S1", { executionPrice: 0.5, actualStake: 3 });
    ok("4. the speculative bet is in the REAL ledger", mb.entries.S1.status === "MANUALLY_PLACED" && mb.entries.S1.category === "SPECULATIVE_BET");
    ok("5. it is flagged NOT paper-eligible", mb.entries.S1.paperEligible === false);
    ok("5. paper ledger stays empty (0 positions)", Object.keys(pl.positions).length === 0);
    // discretionary bet: real only, never recommended
    const d = MB.recordDiscretionary(mb, { ticker: "T3", executionPrice: 0.4, stake: 10, note: "my own read" });
    ok("4. discretionary bet enters REAL only", d.category === "DISCRETIONARY_BET" && d.source === "DISCRETIONARY");
    ok("5. discretionary is NOT paper-eligible and made no paper position", d.paperEligible === false && Object.keys(pl.positions).length === 0);
  }

  // ── 6 & 7: settlements are independent ──
  console.log("\nCASE 6 & 7 — settlements change only their own ledger");
  {
    const mb = MB.load(), pl = PL.load();
    // one confirmed real + one paper on DIFFERENT tickers
    issueFormalBuy(mb, pl, { key: "K1", ticker: "T1", fraction: 0.04, classification: "strong experimental", edge: 0.1 });
    MB.confirmPlacement(mb, "K1", { executionPrice: 0.5, actualStake: 4 });
    // 6. settle PAPER only -> paper realized changes, real unchanged
    const realBefore = JSON.stringify(MB.summary(mb));
    await PL.settleFromMarket(pl, { settlement: stub({ T1: { status: "finalized", result: "yes" } }), now: SETTLE_TS });
    ok("6. paper realized P&L booked (+$386 on a $400 win @0.5 − $14 fee)", near(PL.summary(pl).realizedPnl, 386), PL.summary(pl).realizedPnl);
    ok("6. REAL summary is byte-identical after a paper settlement", JSON.stringify(MB.summary(mb)) === realBefore);
    // 7. settle REAL only -> real realized changes, paper unchanged
    const paperBefore = JSON.stringify(PL.summary(pl));
    MB.settle(mb, "K1", 1);
    ok("7. real realized P&L booked (+$4 win @0.5)", near(MB.summary(mb).realizedPnl, 4), MB.summary(mb).realizedPnl);
    ok("7. PAPER summary is byte-identical after a real settlement", JSON.stringify(PL.summary(pl)) === paperBefore);
  }

  // ── 8: totals reconcile independently ──
  console.log("\nCASE 8 — the two ledgers reconcile independently");
  {
    const mb = MB.load(), pl = PL.load();
    issueFormalBuy(mb, pl, { key: "K1", ticker: "T1", fraction: 0.04, classification: "strong experimental", edge: 0.1 });
    MB.confirmPlacement(mb, "K1", { executionPrice: 0.5, actualStake: 4 });
    MB.settle(mb, "K1", 0);
    await PL.settleFromMarket(pl, { settlement: stub({ T1: { status: "finalized", result: "no" } }), now: SETTLE_TS });
    const b = BK.build({ realState: mb, paperState: pl });
    ok("8. real: accountValue = starting + realized (independent)", near(b.real.accountValue, 100 + b.real.realizedPnl), b.real.accountValue);
    ok("8. paper: accountValue = starting + realized (independent)", near(b.paper.accountValue, 10000 + b.paper.realizedPnl), b.paper.accountValue);
    ok("8. real and paper realized P&L are different numbers (not shared)", b.real.realizedPnl !== b.paper.realizedPnl);
    ok("8. distinct starting balances survive in the canonical summary", b.real.startingDollars === 100 && b.paper.startingDollars === 10000);
  }

  // ── 9: unconfirmed recs count in neither real exposure nor real P&L ──
  console.log("\nCASE 9 — unconfirmed recommendations are in neither real exposure nor P&L");
  {
    const mb = MB.load(), pl = PL.load();
    issueFormalBuy(mb, pl, { key: "K1", ticker: "T1", fraction: 0.04, classification: "strong experimental", edge: 0.1 });
    const s = MB.summary(mb);
    ok("9. real open exposure excludes the unconfirmed rec ($0)", s.openExposure === 0);
    ok("9. real available cash is not reduced ($100)", s.availableCash === 100);
    ok("9. it is shown SEPARATELY as unconfirmed", s.unconfirmed.count === 1 && s.unconfirmed.recommendedExposure === 4);
    ok("9. (but the paper position for it DOES exist — paper doesn't need confirmation)", Object.keys(pl.positions).length === 1);
  }

  // ── 10: fresh-runner restart preserves both ledgers without duplication ──
  console.log("\nCASE 10 — restart on a fresh runner: no duplication");
  {
    reset();
    let mb = MB.load(), pl = PL.load();
    issueFormalBuy(mb, pl, { key: "K1", ticker: "T1", fraction: 0.04, classification: "strong experimental", edge: 0.1 });
    MB.save(mb); PL.save(pl);
    // simulate a fresh runner: reload from disk and re-issue the SAME recommendation
    mb = MB.load(); pl = PL.load();
    issueFormalBuy(mb, pl, { key: "K1", ticker: "T1", fraction: 0.04, classification: "strong experimental", edge: 0.1 });
    ok("10. real ledger still has exactly 1 entry (idempotent)", Object.keys(mb.entries).length === 1);
    ok("10. paper ledger still has exactly 1 position (idempotent)", Object.keys(pl.positions).length === 1);
    ok("10. prospective start timestamp is preserved across restart", pl.prospectiveStartAt === NOW);
  }

  // ── 11: combos follow the same rules ──
  console.log("\nCASE 11 — combos follow the same separation");
  {
    reset();
    const mb = MB.load(), pl = PL.load();
    // formal combo BUY -> paper eligible (SYSTEM_COMBO), scaled $200 cap
    const formal = PL.openPaper(pl, { recommendationId: "C1", ticker: "COMBO1", eventDate: EVENT, fight: "A+C", tier: "COMBO", category: "SYSTEM_COMBO", kind: "combo", fraction: 0.02, entryPrice: 0.4, edgeAtEntry: 0.05 }, { now: NOW });
    ok("11. formal combo enters paper (SYSTEM_COMBO), capped at $200", formal.created === true && formal.position.paperStake === 200, formal.position && formal.position.paperStake);
    // manual combo -> real only, SPECULATIVE_COMBO, never paper
    const manual = MB.recordDiscretionary(mb, { ticker: "COMBO2", executionPrice: 0.3, stake: 2, kind: "combo", note: "my parlay" });
    const rejManual = PL.openPaper(pl, { recommendationId: "C2", ticker: "COMBO2", eventDate: EVENT, category: "SPECULATIVE_COMBO", kind: "combo", fraction: 0.02, entryPrice: 0.3 }, { now: NOW });
    ok("11. manual combo is SPECULATIVE_COMBO in REAL only", manual.category === "SPECULATIVE_COMBO" && manual.paperEligible === false);
    ok("11. paper REFUSES the manual combo", rejManual.created === false);
  }

  // ── 12: safety — fight-start gate + no fabricated settlement ──
  console.log("\nCASE 12 — safety protections intact");
  {
    reset();
    const pl = PL.load();
    const afterBell = PL.openPaper(pl, { recommendationId: "L1", ticker: "TL", eventDate: "2026-11-01", category: "CONFIRMED_SYSTEM_BET", kind: "single", fraction: 0.04, entryPrice: 0.5 }, { now: "2026-11-01T23:00:00Z", nowMs: Date.parse("2026-11-01T23:00:00Z") });
    ok("12. no paper position after the bell (fight-start gate)", afterBell.created === false && /started/.test(afterBell.reason));
    const pl2 = PL.load();
    PL.openPaper(pl2, { recommendationId: "L2", ticker: "TL2", eventDate: EVENT, category: "CONFIRMED_SYSTEM_BET", kind: "single", fraction: 0.04, entryPrice: 0.5 }, { now: NOW });
    const before = JSON.stringify(pl2.positions.L2 ? true : Object.values(pl2.positions)[0]);
    const res = await PL.settleFromMarket(pl2, { settlement: async () => { throw new Error("kalshi down"); }, now: SETTLE_TS });
    ok("12. an unreadable market NEVER settles a paper position (fail closed)", res.settled.length === 0 && res.unreadable.length === 1);
    ok("12. no Kalshi write path anywhere in the ledgers (grep-clean)", !/createOrder|placeOrder|submitOrder|cancelOrder/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "paper-ledger.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "lib", "manual-bankroll.js"), "utf8")));
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
