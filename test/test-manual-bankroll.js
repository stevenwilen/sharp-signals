// MANUAL BANKROLL — three distinct placement statuses, and only one is real money. The failure this
// prevents is a recommendation the system SENT quietly becoming a "position" in a real P&L the human
// never actually placed. Every test asserts that boundary. Runs on synthetic state only.
const MB = require("../lib/manual-bankroll");
const S = MB.STATUS;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const fresh = () => ({ bankroll: 100, entries: {}, meta: {} });
const rec = (o = {}) => ({ key: "explore|B1|KX-A", boutId: "B1", ticker: "KX-A", fight: "A vs B",
  lane: "exploration", classification: "CREATIVE SPECULATIVE", recommendedStakeDollars: 3,
  recommendedFraction: 0.03, maximumAcceptablePrice: 0.62, ask: 0.60, forecastHash: "h1", ...o });

console.log("A SENT RECOMMENDATION IS RECOMMENDED — NOT CONFIRMED, REAL STAKE $0");
{
  const st = fresh();
  const e = MB.recordRecommendation(st, rec());
  ok("status is RECOMMENDED_NOT_CONFIRMED", e.status === S.RECOMMENDED_NOT_CONFIRMED);
  ok("actual stake is $0", e.actualStake === 0);
  ok("execution price is null (nothing placed)", e.executionPrice === null);
  ok("it is NOT included in the real P&L", e.includedInRealPnl === false);
  ok("the recommended stake is recorded separately", e.recommendedStakeDollars === 3);
  const pnl = MB.realBankrollPnl(st);
  ok("real P&L is $0 with an unconfirmed recommendation", pnl.realPnlDollars === 0 && pnl.realDollarsDeployed === 0 && pnl.positionsManuallyPlaced === 0);
}

console.log("\nRE-SENDING THE SAME RECOMMENDATION DOES NOT DUPLICATE OR ESCALATE IT");
{
  const st = fresh();
  MB.recordRecommendation(st, rec());
  MB.recordRecommendation(st, rec({ ask: 0.58 }));
  ok("still exactly one entry", Object.keys(st.entries).length === 1);
  ok("...and still $0 actual stake", st.entries["explore|B1|KX-A"].actualStake === 0);
  ok("...recommendationCount incremented", st.entries["explore|B1|KX-A"].recommendationCount === 2);
}

console.log("\nONLY A HUMAN CONFIRMATION MOVES MONEY INTO THE REAL P&L");
{
  const st = fresh();
  MB.recordRecommendation(st, rec());
  const p = MB.confirmPlacement(st, "KX-A", { executionPrice: 0.61, actualStake: 3, actualContracts: 4 });
  ok("status becomes MANUALLY_PLACED", p.status === S.MANUALLY_PLACED);
  ok("the ACTUAL stake is recorded", p.actualStake === 3);
  ok("the ACTUAL execution price is recorded", p.executionPrice === 0.61);
  ok("it is now included in the real P&L", p.includedInRealPnl === true);
  const pnl = MB.realBankrollPnl(st);
  ok("real dollars deployed = the actual stake", pnl.realDollarsDeployed === 3 && pnl.positionsManuallyPlaced === 1);
}

console.log("\nA CONFIRMATION CANNOT BE FABRICATED OR MALFORMED");
{
  const st = fresh();
  let threw = false;
  try { MB.confirmPlacement(st, "KX-NEVER-RECOMMENDED", { executionPrice: 0.6, actualStake: 3 }); } catch { threw = true; }
  ok("cannot confirm a placement the system never recommended", threw);

  MB.recordRecommendation(st, rec());
  ok("confirm with no execution price is refused", (() => { try { MB.confirmPlacement(st, "KX-A", { actualStake: 3 }); return false; } catch { return true; } })());
  ok("confirm with a zero stake is refused", (() => { try { MB.confirmPlacement(st, "KX-A", { executionPrice: 0.6, actualStake: 0 }); return false; } catch { return true; } })());
  MB.confirmPlacement(st, "KX-A", { executionPrice: 0.6, actualStake: 3 });
  ok("double-confirming the same position is refused", (() => { try { MB.confirmPlacement(st, "KX-A", { executionPrice: 0.6, actualStake: 3 }); return false; } catch { return true; } })());
}

console.log("\nA RE-SENT RECOMMENDATION NEVER DOWNGRADES A CONFIRMED PLACEMENT");
{
  const st = fresh();
  MB.recordRecommendation(st, rec());
  MB.confirmPlacement(st, "KX-A", { executionPrice: 0.6, actualStake: 3 });
  MB.recordRecommendation(st, rec({ ask: 0.55 }));   // the system re-sends the buy instruction
  ok("the entry stays MANUALLY_PLACED", st.entries["explore|B1|KX-A"].status === S.MANUALLY_PLACED);
  ok("...its real stake is untouched", st.entries["explore|B1|KX-A"].actualStake === 3);
}

console.log("\nDECLINE KEEPS THE AUDIT TRAIL BUT CONTRIBUTES $0");
{
  const st = fresh();
  MB.recordRecommendation(st, rec());
  const p = MB.declinePlacement(st, "KX-A", "line moved");
  ok("status becomes DECLINED", p.status === S.DECLINED);
  ok("...excluded from real P&L", p.includedInRealPnl === false);
  ok("real P&L stays $0", MB.realBankrollPnl(st).positionsManuallyPlaced === 0);
}

console.log("\nREAL P&L SETTLES FROM THE ACTUAL STAKE AND PRICE, NOT THE RECOMMENDED ONES");
{
  const st = fresh();
  MB.recordRecommendation(st, rec({ recommendedStakeDollars: 3 }));
  MB.confirmPlacement(st, "KX-A", { executionPrice: 0.50, actualStake: 5 });   // human bet MORE, at a different price
  const won = MB.settle(st, "KX-A", 1);
  // YES at 0.50 pays $1: profit = stake * (1-0.50)/0.50 = 5 * 1 = $5
  ok("a win books P&L from the ACTUAL stake and price", won.realPnlDollars === 5);
  const st2 = fresh();
  MB.recordRecommendation(st2, rec());
  MB.confirmPlacement(st2, "KX-A", { executionPrice: 0.6, actualStake: 3 });
  const lost = MB.settle(st2, "KX-A", 0);
  ok("a loss books minus the actual stake", lost.realPnlDollars === -3);
  ok("...and it counts in the real P&L", MB.realBankrollPnl(st2).realPnlDollars === -3);
}

console.log("\nPAPER POSITIONS ARE PAPER ONLY AND NEVER ENTER THE REAL P&L");
{
  const st = fresh();
  const paper = [{ ticker: "KX-PAPER", fighter: "P", opponent: "Q", stakePct: 0.7, status: "quarantined" }];
  const g = MB.byStatus(st, paper);
  ok("paper positions surface as PAPER_ONLY", g.PAPER_ONLY.length === 1 && g.PAPER_ONLY[0].status === S.PAPER_ONLY);
  ok("...with $0 actual stake and excluded", g.PAPER_ONLY[0].actualStake === 0 && g.PAPER_ONLY[0].includedInRealPnl === false);
  ok("...labelled DO NOT PLACE", /DO NOT PLACE/.test(g.PAPER_ONLY[0].note));
  // Even with paper positions present, the real P&L (which ignores them) is $0.
  ok("paper positions never touch the real P&L", MB.realBankrollPnl(st).positionsManuallyPlaced === 0);
}

console.log("\nEVERY STATUS TRANSITION IS RECORDED (audit trail)");
{
  const st = fresh();
  MB.recordRecommendation(st, rec());
  MB.confirmPlacement(st, "KX-A", { executionPrice: 0.6, actualStake: 3 });
  MB.settle(st, "KX-A", 1);
  const h = st.entries["explore|B1|KX-A"].history.map((x) => x.to);
  ok("history records recommended -> placed -> settled",
    h.join(",") === `${S.RECOMMENDED_NOT_CONFIRMED},${S.MANUALLY_PLACED},${S.SETTLED}`, h.join(","));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
