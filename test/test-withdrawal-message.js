// SELL ALERT — the ONE stand-down that reaches the phone. A bet is OFF because its contract left the board
// (fight cancelled / a fighter is out). Mere drift never gets here (it stays silent, the bet rides). The
// message must name the FIGHTER and the price it was bought at, never dump a raw ticker code, and never read
// as "you must panic-sell" (Kalshi settles a genuine void at a fair price).
const TM = require("../lib/telegram-messages");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

// 1. Fighter name + price: the message names the fighter and the cents, no ticker.
{
  const t = TM.sellAlert({ recommendedFirst: "Valter Walker", price: 0.66, reason: "the contract is no longer listed — the fight is off" });
  ok(t.includes("Valter Walker"), "1. names the fighter (Valter Walker)");
  ok(t.includes("66¢"), "2. shows the price it was bought at (66¢)");
  ok(!/KXUFCFIGHT|-WAL\b/.test(t), "3. contains NO raw ticker code");
  ok(/🔴 SELL/.test(t) && /Sell on Kalshi/.test(t), "4. reads as a SELL with a clear action, not a panic");
  ok(/fair price/.test(t), "5. reassures: a genuine void settles at a fair price");
}
// 6. Price rounds to the nearest cent (0.655 -> 66¢).
ok(TM.sellAlert({ recommendedFirst: "X", price: 0.655, reason: "r" }).includes("66¢"), "6. 0.655 -> 66¢ (round to nearest cent)");
// 7. Backward compatible: no price -> just the name, no dangling "bought at" fragment.
{
  const t = TM.sellAlert({ recommendedFirst: "Alice Ace vs Bob Bruiser", reason: "the fight is off" });
  ok(t.includes("Alice Ace vs Bob Bruiser") && !/bought at/.test(t), "7. no-price call names the bout, no empty 'bought at' line");
}
// 8. A zero/absent price is not rendered as "0¢".
ok(!/0¢/.test(TM.sellAlert({ recommendedFirst: "X", price: 0, reason: "r" })), "8. price 0/absent is not shown as 0¢");
// 9. positionWithdrawn is kept as an alias (run-phase9-shadow still calls it).
ok(TM.positionWithdrawn === TM.sellAlert, "9. positionWithdrawn aliases sellAlert (no dangling reference)");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
