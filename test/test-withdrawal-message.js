// BET WITHDRAWN message — must name the FIGHTER and the PRICE it was recommended at, never dump a raw
// ticker code. A stand-down that just says "a recommendation was withdrawn" (or shows KXUFCFIGHT-…-WAL)
// doesn't tell the human WHICH of their placed bets to drop. Refusal-style: assert the code never leaks.
const TM = require("../lib/telegram-messages");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

// 1. Fighter name + price (the resolved case): the message names the fighter and the cents, no ticker.
{
  const t = TM.positionWithdrawn({ recommendedFirst: "Valter Walker", price: 0.66, reason: "the position no longer qualifies (price, forecast, or listing changed)" });
  ok(t.includes("Valter Walker"), "1. names the fighter (Valter Walker)");
  ok(t.includes("66¢"), "2. shows the recommended price in cents (66¢)");
  ok(!/KXUFCFIGHT|-WAL\b/.test(t), "3. contains NO raw ticker code");
  ok(t.includes("RECOMMENDATION PULLED") && /Hold to resolution/.test(t) && !/withdraw/i.test(t), "4. reads as a pulled recommendation + hold guidance, never 'cash out'");
}

// 2. Price rounds to the nearest cent for display (0.655 -> 66¢, like the rest of the message layer).
ok(TM.positionWithdrawn({ recommendedFirst: "X", price: 0.655, reason: "r" }).includes("66¢"), "5. 0.655 -> 66¢ (round to nearest cent)");

// 3. Backward compatible: no price supplied -> just the name, no dangling "was buy at" fragment.
{
  const t = TM.positionWithdrawn({ recommendedFirst: "Alice Ace vs Bob Bruiser", reason: "conservative EV went negative" });
  ok(t.includes("Alice Ace vs Bob Bruiser"), "6. no-price call still names the bout (backward compatible)");
  ok(!/was buy at/.test(t), "7. no price -> no empty 'was buy at' line");
}

// 4. A zero/absent price is not rendered as "0¢".
ok(!/0¢/.test(TM.positionWithdrawn({ recommendedFirst: "X", price: 0, reason: "r" })), "8. price 0/absent is not shown as 0¢");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
