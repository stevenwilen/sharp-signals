// REAL LEDGER — proves the Real Entertainment Bankroll ($100, lib/manual-bankroll.js) behaves correctly
// now that the Paper Strategy book has been removed. A formal system BUY records an UNCONFIRMED
// recommendation that touches real money ONLY on manual confirmation; speculative/discretionary bets
// touch real only; settlements book real P&L from the ACTUAL stake/price; and the canonical bankrolls
// summary emits `real` with NO `paper` key.
const os = require("os"), fs = require("fs"), path = require("path");
const TMP = path.join(os.tmpdir(), "ss-real-ledger-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;
const MB = require("../lib/manual-bankroll");
const BK = require("../lib/bankrolls");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };
const near = (a, b) => Math.abs(a - b) < 0.011;

(async () => {
  // ── 1: a formal BUY records an UNCONFIRMED recommendation; real money is untouched ──
  console.log("CASE 1 — formal BUY: unconfirmed recommendation, real money untouched");
  {
    const mb = MB.load();
    MB.recordRecommendation(mb, { key: "K1", boutId: "B", ticker: "T1", fight: "A vs B", lane: "core", classification: "strong experimental", recommendedStakeDollars: 4, ask: 0.5 });
    ok("1. real ledger has only an UNCONFIRMED recommendation", mb.entries.K1.status === "RECOMMENDED_NOT_CONFIRMED");
    ok("1. real money is $0 — nothing placed", MB.summary(mb).realizedPnl === 0 && MB.summary(mb).openExposure === 0);
    ok("1. real available cash is untouched ($100)", MB.summary(mb).availableCash === 100);
  }

  // ── 2: confirming the BUY creates a real MANUALLY_PLACED position ──
  console.log("\nCASE 2 — confirming creates a real MANUALLY_PLACED position");
  {
    const mb = MB.load();
    MB.recordRecommendation(mb, { key: "K1", boutId: "B", ticker: "T1", fight: "A vs B", lane: "core", classification: "strong experimental", recommendedStakeDollars: 4, ask: 0.5 });
    MB.confirmPlacement(mb, "K1", { executionPrice: 0.5, actualStake: 4 });
    ok("2. real position now MANUALLY_PLACED", mb.entries.K1.status === "MANUALLY_PLACED");
    ok("2. real open exposure is the confirmed stake ($4)", near(MB.summary(mb).openExposure, 4), MB.summary(mb).openExposure);
  }

  // ── 3: speculative + discretionary bets touch REAL only ──
  console.log("\nCASE 3 — speculative/exploration + discretionary bets: real only");
  {
    const mb = MB.load();
    MB.recordRecommendation(mb, { key: "S1", boutId: "B2", ticker: "T2", fight: "C vs D", lane: "exploration", classification: "CREATIVE SPECULATIVE", recommendedStakeDollars: 3, ask: 0.5 });
    MB.confirmPlacement(mb, "S1", { executionPrice: 0.5, actualStake: 3 });
    ok("3. the speculative bet is in the REAL ledger", mb.entries.S1.status === "MANUALLY_PLACED" && mb.entries.S1.category === "SPECULATIVE_BET");
    const d = MB.recordDiscretionary(mb, { ticker: "T3", executionPrice: 0.4, stake: 10, note: "my own read" });
    ok("3. discretionary bet enters REAL only", d.category === "DISCRETIONARY_BET" && d.source === "DISCRETIONARY");
  }

  // ── 4: settlement books real P&L from the ACTUAL stake/price ──
  console.log("\nCASE 4 — settlement books real P&L from the actual stake/price");
  {
    const mb = MB.load();
    MB.recordRecommendation(mb, { key: "K1", boutId: "B", ticker: "T1", fight: "A vs B", lane: "core", classification: "strong experimental", recommendedStakeDollars: 4, ask: 0.5 });
    MB.confirmPlacement(mb, "K1", { executionPrice: 0.5, actualStake: 4 });
    MB.settle(mb, "K1", 1);
    ok("4. real realized P&L booked (+$4 win @0.5)", near(MB.summary(mb).realizedPnl, 4), MB.summary(mb).realizedPnl);
  }

  // ── 5: the canonical bankrolls summary emits `real`, NO `paper` key ──
  console.log("\nCASE 5 — canonical bankrolls summary: real only, no paper key");
  {
    const mb = MB.load();
    MB.recordRecommendation(mb, { key: "K1", boutId: "B", ticker: "T1", fight: "A vs B", lane: "core", classification: "strong experimental", recommendedStakeDollars: 4, ask: 0.5 });
    MB.confirmPlacement(mb, "K1", { executionPrice: 0.5, actualStake: 4 });
    MB.settle(mb, "K1", 0);
    const b = BK.build({ realState: mb });
    ok("5. bankrolls summary emits `real`", !!b.real && b.real.startingDollars === 100);
    ok("5. bankrolls summary has NO `paper` key", !("paper" in b));
    ok("5. real: accountValue = starting + realized (independent)", near(b.real.accountValue, 100 + b.real.realizedPnl), b.real.accountValue);
  }

  // ── 6: unconfirmed recs count in neither real exposure nor real P&L ──
  console.log("\nCASE 6 — unconfirmed recommendations are in neither real exposure nor P&L");
  {
    const mb = MB.load();
    MB.recordRecommendation(mb, { key: "K1", boutId: "B", ticker: "T1", fight: "A vs B", lane: "core", classification: "strong experimental", recommendedStakeDollars: 4, ask: 0.5 });
    const s = MB.summary(mb);
    ok("6. real open exposure excludes the unconfirmed rec ($0)", s.openExposure === 0);
    ok("6. real available cash is not reduced ($100)", s.availableCash === 100);
    ok("6. it is shown SEPARATELY as unconfirmed", s.unconfirmed.count === 1 && s.unconfirmed.recommendedExposure === 4);
  }

  // ── 7: safety — no Kalshi write path in the real ledger ──
  console.log("\nCASE 7 — safety: no Kalshi write path in the real ledger");
  {
    ok("7. no Kalshi write path anywhere in the real ledger (grep-clean)",
      !/createOrder|placeOrder|submitOrder|cancelOrder/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "manual-bankroll.js"), "utf8")));
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
