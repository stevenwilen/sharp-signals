// MONEY CONSTANTS HAVE ONE HOME. The $100 bankroll, the $3/$4/$5 stake tiers, and the $5/$10 per-fight
// and per-card caps used to be defined twice — hardcoded in lib/entertainment.js and again in
// config/exploration-rules.json — so the two betting lanes could silently drift. They now derive from
// ONE canonical file, config/bankroll.json. This test fails the moment either lane disagrees with it.
const assert = require("assert");
const MONEY = require("../config/bankroll.json");
const EN = require("../lib/entertainment");
const XR = require("../config/exploration-rules.json");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

console.log("THE CANONICAL FILE HOLDS THE EXPECTED (FROZEN) VALUES");
{
  ok("bankroll is $100", MONEY.bankrollDollars === 100);
  ok("tiers are $3 / $4 / $5", MONEY.tiers.tier1.dollars === 3 && MONEY.tiers.tier2.dollars === 4 && MONEY.tiers.tier3.dollars === 5);
  ok("fractions are 3% / 4% / 5%", MONEY.tiers.tier1.fraction === 0.03 && MONEY.tiers.tier2.fraction === 0.04 && MONEY.tiers.tier3.fraction === 0.05);
  ok("caps are $5 per fight / $10 per card", MONEY.maxPerFightDollars === 5 && MONEY.maxPerCardDollars === 10);
}

console.log("\nTHE CORE ENTERTAINMENT LANE READS THE CANONICAL VALUES");
{
  ok("bankroll amount", EN.BANKROLL.amount === MONEY.bankrollDollars, EN.BANKROLL.amount);
  ok("STANDARD tier = tier1", EN.TIERS.STANDARD.dollars === MONEY.tiers.tier1.dollars && EN.TIERS.STANDARD.fraction === MONEY.tiers.tier1.fraction);
  ok("STRONG tier = tier2", EN.TIERS.STRONG.dollars === MONEY.tiers.tier2.dollars && EN.TIERS.STRONG.fraction === MONEY.tiers.tier2.fraction);
  ok("MAXIMUM tier = tier3", EN.TIERS.MAXIMUM.dollars === MONEY.tiers.tier3.dollars && EN.TIERS.MAXIMUM.fraction === MONEY.tiers.tier3.fraction);
  ok("per-fight cap fraction = $5/$100", EN.CAPS.maxFractionPerFight === MONEY.maxFractionPerFight);
  ok("per-card cap fraction = $10/$100", EN.CAPS.maxFractionPerCard === MONEY.maxFractionPerCard);
}

console.log("\nTHE EXPLORATION LANE IS LOCKED TO THE SAME VALUES (no drift)");
{
  const tiers = XR.tiers;
  const c = XR.caps_exposure;
  ok("exploration CREATIVE = tier1 ($3 / 3%)", tiers["CREATIVE SPECULATIVE"].stake === MONEY.tiers.tier1.dollars && tiers["CREATIVE SPECULATIVE"].fraction === MONEY.tiers.tier1.fraction);
  ok("exploration STRONG = tier2 ($4 / 4%)", tiers["STRONG SPECULATIVE"].stake === MONEY.tiers.tier2.dollars && tiers["STRONG SPECULATIVE"].fraction === MONEY.tiers.tier2.fraction);
  ok("exploration BEST = tier3 ($5 / 5%)", tiers["BEST EXPERIMENTAL"].stake === MONEY.tiers.tier3.dollars && tiers["BEST EXPERIMENTAL"].fraction === MONEY.tiers.tier3.fraction);
  ok("exploration bankroll = $100", c.bankrollDollars === MONEY.bankrollDollars);
  ok("exploration per-fight cap = $5", c.maxPerFightDollars === MONEY.maxPerFightDollars);
  ok("exploration per-card cap = $10", c.maxPerCardDollars === MONEY.maxPerCardDollars);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
