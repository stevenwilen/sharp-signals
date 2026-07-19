// CONFIRM A MANUAL PLACEMENT — the ONLY way a recommendation enters your real $100 bankroll P&L.
//
//   node run-confirm-placement.js list
//   node run-confirm-placement.js confirm <ticker|key> --price=0.61 --stake=3 [--contracts=5] [--fees=0.10]
//   node run-confirm-placement.js decline <ticker|key> [--reason="didn't like the line"]
//   node run-confirm-placement.js settle  <ticker|key> --result=win|loss|void
//   node run-confirm-placement.js discretionary --market=<ticker> --price=0.5 --stake=20 [--side=YES]
//                                 [--contracts=N] [--fees=0.10] [--kind=combo] [--note="my own read"]
//
// The system has NO order path and cannot know whether you placed a bet. A recommendation stays
// RECOMMENDED_NOT_CONFIRMED (real stake $0, excluded from real P&L) until YOU run `confirm` with the
// actual stake and the price you actually got. `discretionary` records a real bet the system NEVER
// recommended — it enters the REAL Entertainment ledger only, always NOT PAPER ELIGIBLE. Every mutation
// updates ONLY the real ledger and refreshes the canonical data/bankrolls.json both dashboards read.
require("./lib/env");
const MB = require("./lib/manual-bankroll");
const BK = require("./lib/bankrolls");

const say = (s) => process.stdout.write(s + "\n");
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

function main() {
  const cmd = process.argv[2];
  const target = process.argv[3];
  const state = MB.load();

  if (!cmd || cmd === "list") {
    const grouped = MB.byStatus(state);
    say(`REAL $${state.bankroll} MANUAL BANKROLL — placement statuses\n`);
    say(`RECOMMENDED — NOT CONFIRMED (real stake $0, excluded from P&L until you confirm):`);
    const recs = grouped.RECOMMENDED_NOT_CONFIRMED;
    if (!recs.length) say(`   (none)`);
    for (const r of recs) say(`   ${r.classification}  ${r.fight || r.ticker}  ·  ${r.ticker}  ·  recommended $${r.recommendedStakeDollars} @ max ${(r.maximumAcceptablePrice * 100).toFixed(1)}c  ·  key: ${r.key}`);
    say(`\nMANUALLY PLACED (in your real P&L):`);
    const placed = grouped.MANUALLY_PLACED;
    if (!placed.length) say(`   (none)`);
    for (const p of placed) say(`   ${p.status}  ${p.fight || p.ticker}  ·  $${p.actualStake} @ ${(p.executionPrice * 100).toFixed(1)}c${p.realPnlDollars != null ? `  ·  P&L $${p.realPnlDollars}` : ""}`);
    const pnl = MB.realBankrollPnl(state);
    say(`\nREAL P&L: ${pnl.positionsManuallyPlaced} placed, $${pnl.realDollarsDeployed} deployed, $${pnl.realPnlDollars} booked. ${pnl.note}`);
    return 0;
  }

  if (cmd === "discretionary") {
    const market = arg("market"); if (!market) fail("discretionary needs --market=<ticker>");
    const price = Number(arg("price"));
    const stake = arg("stake") != null ? Number(arg("stake")) : undefined;
    const contracts = arg("contracts") != null ? Number(arg("contracts")) : undefined;
    const fees = arg("fees") != null ? Number(arg("fees")) : undefined;
    let p;
    try {
      p = MB.recordDiscretionary(state, {
        ticker: market, side: arg("side") || "YES", executionPrice: price, stake, contracts, fees,
        kind: arg("kind") === "combo" ? "combo" : "single", note: arg("note"), fight: arg("fight"),
      });
    } catch (e) { fail(e.message); }
    MB.save(state); BK.write();
    say(`✅ DISCRETIONARY placed (Real Entertainment Bankroll ONLY): ${p.fight || p.ticker}  [${p.category}]`);
    say(`   $${p.actualStake} @ ${(p.executionPrice * 100).toFixed(1)}c (${p.actualContracts} contracts)  ·  fee ${p.fees.amount != null ? "$" + p.fees.amount : "?"} (${p.fees.basis})  ·  NOT PAPER ELIGIBLE.`);
    return 0;
  }

  if (!target) fail(`usage: node run-confirm-placement.js ${cmd} <ticker|key> ...`);

  if (cmd === "confirm") {
    const price = Number(arg("price")), stake = Number(arg("stake")), contracts = arg("contracts") ? Number(arg("contracts")) : null;
    const fees = arg("fees") != null ? Number(arg("fees")) : undefined;
    let p;
    try { p = MB.confirmPlacement(state, target, { executionPrice: price, actualStake: stake, actualContracts: contracts, fees }); }
    catch (e) { fail(e.message); }
    MB.save(state); BK.write();
    say(`✅ MANUALLY PLACED (Real Entertainment Bankroll): ${p.fight || p.ticker}  [${p.category}]`);
    say(`   actual stake $${p.actualStake} @ ${(p.executionPrice * 100).toFixed(1)}c${p.actualContracts ? ` (${p.actualContracts} contracts)` : ""}  ·  fee ${p.fees.amount != null ? "$" + p.fees.amount : "?"} (${p.fees.basis}) — now included in your real $${state.bankroll} bankroll P&L.`);
    return 0;
  }

  if (cmd === "decline") {
    let p; try { p = MB.declinePlacement(state, target, arg("reason")); } catch (e) { fail(e.message); }
    MB.save(state); BK.write();
    say(`recorded DECLINED: ${p.fight || p.ticker} — excluded from real P&L (kept for the audit trail).`);
    return 0;
  }

  if (cmd === "settle") {
    const r = arg("result");
    const result = r === "win" ? 1 : r === "loss" ? 0 : r === "void" ? null : undefined;
    if (result === undefined) fail("--result must be win | loss | void");
    const p = MB.settle(state, target, result);
    if (!p) fail(`no MANUALLY_PLACED position for "${target}" to settle`);
    MB.save(state); BK.write();
    say(`settled ${p.fight || p.ticker}: ${r} — real P&L $${p.realPnlDollars} on a $${p.actualStake} stake.`);
    return 0;
  }

  fail(`unknown command "${cmd}" — use list | confirm | decline | settle | discretionary`);
}

const c = main();
process.exit(c || 0);
