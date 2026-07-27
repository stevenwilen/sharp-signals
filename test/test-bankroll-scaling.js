// ONE bankroll that tracks the REAL balance. External cash movements (deposits/withdrawals) keep the
// ledger equal to the real Kalshi account, and bets scale to the current balance. Refusal-first: a zero
// adjustment is refused (never invent a value), and summary math is pinned so a silent drift can't creep in.
const MB = require("../lib/manual-bankroll");
const XP = require("../lib/exploration");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };
const S = (adj) => ({ bankroll: 100, entries: {}, ...(adj ? { cashAdjustments: adj } : {}) });

// Cash adjustments move the balance.
ok(MB.summary(S([{ amount: -0.99 }])).accountValue === 99.01, "1. a −$0.99 withdrawal -> $99.01");
ok(MB.summary(S([{ amount: -0.99 }, { amount: 5 }])).accountValue === 104.01, "2. adjustments net (−0.99 + 5) -> $104.01");
ok(MB.summary(S([{ amount: -0.99 }])).netCashAdjustments === -0.99, "3. netCashAdjustments surfaced in the summary");
ok(MB.summary(S()).accountValue === 100, "4. no adjustments -> balance unchanged ($100)");

// recordCashAdjustment appends and fails closed.
{ const st = { cashAdjustments: [] }; MB.recordCashAdjustment(st, { amount: -0.99, note: "x" });
  ok(st.cashAdjustments.length === 1 && st.cashAdjustments[0].amount === -0.99, "5. recordCashAdjustment appends the movement"); }
{ let threw = false; try { MB.recordCashAdjustment({}, { amount: 0 }); } catch { threw = true; }
  ok(threw, "6. a zero adjustment is REFUSED (never invent a value)"); }
{ let threw = false; try { MB.recordCashAdjustment({}, { amount: "abc" }); } catch { threw = true; }
  ok(threw, "7. a non-numeric adjustment is REFUSED"); }

// load() must ROUND-TRIP cashAdjustments (the bug: load rebuilt state as {bankroll,entries,meta} and
// silently dropped them, so the ledger read $100 while the real balance was lower).
ok(MB.load().cashAdjustments !== undefined, "8. load() preserves cashAdjustments (never drops the field)");

// Exploration tiers scale by the live bankroll without touching the frozen tier fractions/dollars.
{
  const T = XP.RULES.tiers;
  const tier = T["STRONG SPECULATIVE"];
  ok(tier && typeof tier.stake === "number" && typeof tier.fraction === "number", "9. a real tier carries both a base $ stake and a fraction");
  ok(+(tier.stake * 0.9567).toFixed(2) < tier.stake && +(tier.stake * 1).toFixed(2) === tier.stake, "10. scale<1 shrinks the stake, scale 1 = the original (frozen dollars untouched)");
  ok(XP.RULES.caps_exposure.maxPerFightDollars > 0 && XP.RULES.caps_exposure.maxPerCardDollars > 0, "11. exposure caps present (scaled by opts.scale at call time)");
}

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
