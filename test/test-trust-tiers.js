// TRUST TIERS — the one ladder every book bets from, extracted from the sealed forecast. Refusal-first:
// a bout that can't be read cleanly returns null (never a guessed probability), and Paper never sees the
// speculative tier. Numbers are pinned to a real sealed bout so the extractor can't silently drift.
const { boutTiers, centralAtTier, tiersForBook, BOOK_TIERS } = require("../lib/trust-tiers");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

// Real sealed bout (2026-07-25 B03): Hussein favored, confirmed 0.8518 (conservative 0.7658), speculative 0.868.
const HUS = {
  boutId: "UFC-2026-07-25-B03", fight: "Abdul Hussein vs Cody Gibson",
  systemCentral: { "Abdul Hussein": 0.8518, "Cody Gibson": 0.1482 },
  systemRange: { forFighter: "Abdul Hussein", low: 0.7658, high: 0.9378 },
  exploration: { marketPriorA: 0.7907, creativeCentralA: 0.868, activeHypotheses: 8, capped: false },
};

{
  const t = boutTiers(HUS);
  ok(t.favored === "Abdul Hussein" && t.opponent === "Cody Gibson", "1. favored/opponent read from the range + systemCentral");
  ok(t.confirmed.central === 0.8518 && t.confirmed.conservative === 0.7658, "2. CONFIRMED tier = systemCentral (0.8518) + range-low conservative (0.7658)");
  ok(t.speculative.central === 0.868 && t.speculative.available === true, "3. SPECULATIVE tier = creativeCentralA (0.868), available (8 live hypotheses)");
  ok(t.speculative.conservative === 0.7658, "4. speculative reuses the SAME conservative bound — a tier only moves the central, not the gate");
}

// Favored is the SECOND-named fighter, so creativeCentralA (fighter A = the underdog) must be complemented.
{
  const flipped = { fight: "Cody Gibson vs Abdul Hussein",
    systemCentral: { "Cody Gibson": 0.1482, "Abdul Hussein": 0.8518 },
    systemRange: { forFighter: "Abdul Hussein", low: 0.7658, high: 0.9378 },
    exploration: { creativeCentralA: 0.132, activeHypotheses: 3 } };   // A = Gibson (underdog), 0.132 creative
  const t = boutTiers(flipped);
  ok(t.favored === "Abdul Hussein" && t.speculative.central === 0.868, "5. favored underdog-first -> speculative central is the COMPLEMENT (1 - 0.132 = 0.868)");
}

// Refusals: missing/garbled bouts return null, never a guessed number.
ok(boutTiers({ fight: "A vs B" }) === null, "6. no systemCentral -> null (refusal, not a guess)");
ok(boutTiers({ systemCentral: { A: 0.5, B: 0.3, C: 0.2 } }) === null, "7. not exactly two fighters -> null");
ok(boutTiers(null) === null, "8. null bout -> null");

// A bout with no live creative view: speculative tier is unavailable (Research/Entertainment get nothing extra).
{
  const noView = { fight: "A vs B", systemCentral: { A: 0.6, B: 0.4 }, systemRange: { forFighter: "A", low: 0.55, high: 0.66 }, exploration: { activeHypotheses: 0 } };
  const t = boutTiers(noView);
  ok(t.speculative.available === false, "9. zero active hypotheses -> speculative tier NOT available (no creative view)");
  ok(centralAtTier(noView, "speculative") === null, "9b. centralAtTier speculative returns null when unavailable");
}

// Book -> tier mapping: Paper is confirmed-only; the lower-trust books also act on speculative.
ok(JSON.stringify(tiersForBook("paper")) === '["confirmed"]', "10. Paper acts on the CONFIRMED tier only");
ok(tiersForBook("entertainment").includes("speculative") && tiersForBook("research").includes("speculative"), "11. Entertainment + Research also act on SPECULATIVE");
ok(!tiersForBook("paper").includes("speculative"), "12. Paper NEVER acts on the speculative tier (the disciplined line)");
ok(centralAtTier(HUS, "confirmed") === 0.8518 && centralAtTier(HUS, "speculative") === 0.868, "13. centralAtTier returns the right probability per tier");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
