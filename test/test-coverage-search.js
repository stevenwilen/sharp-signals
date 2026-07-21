// COVERAGE GATE — refusal-first. The origins-not-voices guarantee lives here: a WELL-covered fight must be
// REFUSED a search (no amplifiers), only UNDER-covered bouts are searched, neediest-first, capped.
const { selectUnderCovered } = require("../lib/coverage-gate");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };
const B = (boutId, independentOrigins) => ({ boutId, independentOrigins });

// 1. Covered bouts (>= minOrigins) are REFUSED; under-covered are selected.
{
  const sel = selectUnderCovered([B("A", 5), B("B", 1), B("C", 3), B("D", 0)], { minOrigins: 3, maxBouts: 10 });
  const ids = sel.map((b) => b.boutId);
  ok(!ids.includes("A") && !ids.includes("C"), "1a. WELL/PARTIALLY covered bouts (>= 3) are NOT searched (no amplifiers)");
  ok(ids.includes("B") && ids.includes("D"), "1b. under-covered bouts (< 3) ARE selected");
}

// 2. Neediest (fewest origins) first.
ok(selectUnderCovered([B("A", 2), B("B", 0), B("C", 1)], { minOrigins: 3, maxBouts: 10 }).map((b) => b.boutId).join("") === "BCA", "2. ordered neediest-first (0,1,2)");

// 3. Capped at maxBouts (protects the shared quota).
ok(selectUnderCovered([B("A", 0), B("B", 0), B("C", 0), B("D", 0), B("E", 0)], { minOrigins: 3, maxBouts: 2 }).length === 2, "3. capped at maxBouts");

// 4. Deterministic tiebreak by boutId when origins are equal.
ok(selectUnderCovered([B("Z", 0), B("A", 0), B("M", 0)], { minOrigins: 3, maxBouts: 2 }).map((b) => b.boutId).join("") === "AM", "4. equal-origins tiebreak by boutId (deterministic run-to-run)");

// 5. Non-array / empty -> [] (no crash).
ok(selectUnderCovered(null).length === 0 && selectUnderCovered(undefined).length === 0 && selectUnderCovered([]).length === 0, "5. null/undefined/empty -> []");

// 6. Missing origin data counts as under-covered (fail TOWARD gathering evidence).
ok(selectUnderCovered([B("A", undefined), B("B", null)], { minOrigins: 3, maxBouts: 5 }).length === 2, "6. missing independentOrigins treated as under-covered");

// 7. minOrigins boundary: exactly at the threshold is COVERED (not searched).
ok(selectUnderCovered([B("A", 3)], { minOrigins: 3, maxBouts: 5 }).length === 0, "7. a bout exactly at minOrigins is covered (strict < gate)");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
