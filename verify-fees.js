// PHASE 8.5 §9 — KALSHI FEE VERIFICATION.
//
//   node verify-fees.js data/fee-examples.json
//
// The fee formula in lib/contracts.js is TRANSCRIBED from Kalshi's published schedule, not read from
// the API — the market objects carry no fee field. Every EV number in Phase 8 sits on top of it. An
// unverified fee is not a rounding detail: at 50c it is ~1.75% of notional, which is larger than any
// edge this system has ever claimed to find. A formula that is wrong makes every "+EV" position a
// coin flip with a rake.
//
// I CANNOT VERIFY THIS ALONE. It requires reading the fee Kalshi's authenticated UFC trade interface
// displays for a real order ticket. That is behind a login I do not have. This script reproduces
// examples the USER supplies and fails loudly on any mismatch, including rounding.
//
// Example file shape (data/fee-examples.json):
//   [ { "dateVerified":"2026-07-16", "market":"KXUFCFIGHT-26JUL18DUUSM-DUU", "side":"yes",
//       "price":0.67, "contracts":100, "interfaceFee":1.55, "treatment":"taker" } ]
require("./lib/env");
const fs = require("fs");
const C = require("./lib/contracts");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

function main() {
  const p = process.argv[2] || "data/fee-examples.json";
  say(`[stage 1] fee configuration under test`);
  say(`    source   : ${C.FEES.source}`);
  say(`    formula  : ${C.FEES.formula}`);
  say(`    rate     : ${C.FEES.rate}   makerRate: ${C.FEES.makerRate}`);
  say(`    verified : ${C.FEES.verified}`);

  if (!fs.existsSync(p)) {
    say(`\n[stage 2] NO EXAMPLE FILE at ${p}`);
    say(`\n  PHASE 8.5 FEE VERIFICATION: CANNOT PASS`);
    say(`  This gate requires fees read from the AUTHENTICATED Kalshi UFC trade interface, which`);
    say(`  sits behind a login this process does not have. It cannot be satisfied by inspection,`);
    say(`  by the public API, or by asserting that the formula looks right.`);
    say(`\n  To complete it, open a UFC market in the Kalshi UI, build (do NOT submit) an order`);
    say(`  ticket, and record what the interface says the fee will be. Several examples, ideally`);
    say(`  spanning cheap/mid/expensive prices, since the fee is quadratic and a wrong rate hides`);
    say(`  at the wings. Then write ${p}:`);
    say(`\n  [ { "dateVerified": "2026-07-16",`);
    say(`      "market": "KXUFCFIGHT-26JUL18DUUSM-DUU",`);
    say(`      "side": "yes", "price": 0.67, "contracts": 100,`);
    say(`      "interfaceFee": 1.55, "treatment": "taker" } ]`);
    say(`\n  Until then Phase 8 keeps every fee flagged UNVERIFIED on every order, which is why no`);
    say(`  position may be armed on it.`);
    return 3;
  }

  const examples = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(examples) || !examples.length) fail("example file is empty");
  say(`\n[stage 2] reproducing ${examples.length} interface example(s) ...`);
  say(`\n  market                              side price  qty   interface   computed   diff   treatment`);

  const results = [];
  let mismatches = 0;
  for (const e of examples) {
    const computed = C.tradingFee(e.contracts, e.price);
    const diff = computed === null ? null : +(computed - e.interfaceFee).toFixed(4);
    const match = diff !== null && Math.abs(diff) < 1e-9;   // EXACT, including rounding
    if (!match) mismatches++;
    results.push({ ...e, computedFee: computed, difference: diff, match });
    say(`  ${String(e.market).slice(0, 34).padEnd(34)} ${String(e.side).padEnd(4)} ${String(e.price).padStart(5)} ${String(e.contracts).padStart(4)}   ${String(e.interfaceFee).padStart(8)}   ${String(computed).padStart(8)}  ${String(diff).padStart(6)}   ${e.treatment || "?"}  ${match ? "" : "<<< MISMATCH"}`);
    if (e.treatment === "maker" && C.FEES.makerRate !== 0)
      say(`      note: this example is MAKER but the config maker rate is ${C.FEES.makerRate}`);
  }

  const out = {
    verifiedAt: new Date().toISOString(),
    feeConfigUnderTest: C.FEES,
    examples: results,
    exactMatches: results.filter((r) => r.match).length,
    mismatches,
    verdict: mismatches === 0 ? "FEE CONFIG VERIFIED" : "FEE CONFIG REJECTED",
  };
  fs.writeFileSync("data/fee-verification.json", JSON.stringify(out, null, 2));

  say(`\n  exact matches: ${out.exactMatches}/${results.length}`);
  if (mismatches) {
    say(`\n  PHASE 8.5 FEE VERIFICATION: FAIL — ${mismatches} example(s) do not reproduce exactly.`);
    say(`  The configured calculation does not describe what Kalshi actually charges. Every Phase 8`);
    say(`  EV built on it is wrong by the difference. Correct lib/contracts.js FEES and re-run;`);
    say(`  do NOT flip \`verified\` by hand to make this pass.`);
    return 1;
  }
  say(`\n  PHASE 8.5 FEE VERIFICATION: PASS — the config reproduces every interface example exactly.`);
  say(`  Set FEES.verified = true in lib/contracts.js and record data/fee-verification.json.`);
  return 0;
}
const code = main();
if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); }
process.exit(code);
