// PRICE-SCALED STAKE — a longshot loses far more often than a favourite, so a flat tier stake on a 16c
// shot drains the bankroll. Stake scales by the price (≈ win probability): full at even money+, less below.
// This pins it so a future change can't silently revert to flat sizing (which lost 4 underdog bets in a row).
const XP = require("../lib/exploration");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const hyp = {
  adjustmentLogOdds: 0.3, causalMechanism: "power -> hurts opponent", hypothesis: "A — power: A has knockout power",
  originInformation: { independentOrigins: 1, amplifyingChannels: [] }, novelty: "NOVEL", probablyPriced: false,
  fatallyContradicted: false, magnitudeBucket: "credible_single_origin", verificationStatus: "unverified",
  falsificationCondition: "A shows no power", evidenceAgainst: "none recorded",
};
const exploration = { hypotheses: [hyp] };
const valued = (price) => ({ classification: "EXPLORATION CANDIDATE", allInPrice: price, explorationCentralEV: 0.1, explorationConservativeEV: -0.1 });

const dog = XP.classifyAndSize(valued(0.16), exploration);   // deep longshot
const mid = XP.classifyAndSize(valued(0.45), exploration);   // near-even underdog
const fav = XP.classifyAndSize(valued(0.65), exploration);   // favourite

ok(dog.stake > 0 && fav.stake > 0, "1. same read, different price -> both still size a bet");
ok(dog.stake < mid.stake && mid.stake < fav.stake, "2. stake rises with price: 16c < 45c < 65c");
ok(Math.abs(dog.stake / fav.stake - 0.32) < 0.03, `3. a 16c shot is ~0.32x a 65c bet (was 1.0x flat) — got ${(dog.stake / fav.stake).toFixed(2)}x`);
ok(fav.stake === XP.classifyAndSize(valued(0.90), exploration).stake, "4. favourites (>=50c) all get the FULL tier stake (factor capped at 1)");
ok(dog.tier === fav.tier, "5. price scales the STAKE, not the tier — conviction still picks the fight");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
