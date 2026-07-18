// ADMISSION BOUNDARY — integration tests against the REAL serialized evidence on disk.
//
// These are integration tests on purpose. The defect they cover was invisible to unit tests because
// every unit passed: lib/leakage-guard.js checkClaim() was correct and well-tested, and it was still
// true that no claim was ever excluded from a forecast. The bug lived entirely in the WIRING:
//
//   1. lib/bout-evidence.js never emitted `publishedAt`, so run-forecast.js's
//      `claims.filter(c => c.publishedAt)` emptied the array. admissibleClaims() was handed [] and
//      `leakageRejected` was structurally 0 on every bout ever sealed. The 0 was an artifact of the
//      field's absence and was published as a measurement.
//   2. `adm.admitted` was computed and never read; the next line forecast from the raw evidence.
//   3. The runner borrowed `be.topics[0].claims[0].publishedAt` for any claim missing one — a
//      fabricated timestamp attributed to a different claim.
//   4. Even a correct filter would have leaked, because a topic's `independentOrigins` was computed
//      over the rejected claims too.
//
// So: no test here mocks the evidence shape. They load data/evidence-eval-*.json and assert on what
// the forecaster would actually be handed.
const fs = require("fs");
const path = require("path");
const ADM = require("../lib/admission");
const F = require("../lib/forecast");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const EV_PATH = path.join(__dirname, "..", "data", "evidence-eval-2026-07-18.json");
if (!fs.existsSync(EV_PATH)) { console.log("  SKIP  no serialized evidence on disk"); console.log(`\n${pass}/${pass + fail} passed`); process.exit(0); }

const ev = JSON.parse(fs.readFileSync(EV_PATH, "utf8"));
const SEAL = Date.parse("2026-07-18T20:00:00Z");
const covered = ev.bouts.filter((b) => (b.topics || []).length > 0);
const be0 = covered[0];
const bout0 = ev.card.bouts.find((b) => b.boutId === be0.boutId);
const clone = (o) => JSON.parse(JSON.stringify(o));

// Forge a claim into a real topic — the only way to test a leak against real evidence is to
// introduce one, because the real corpus (correctly) contains none.
const withClaim = (be, extra) => {
  const c = clone(be);
  c.topics[0].claims.push({ ...clone(c.topics[0].claims[0]), ...extra });
  return c;
};

console.log("THE REAL EVIDENCE IS ROUND-TRIPPABLE (the omission that made the gate inert)");
{
  let tot = 0, withPa = 0;
  for (const b of ev.bouts) for (const t of b.topics || []) for (const c of t.claims || []) { tot++; if (c.publishedAt) withPa++; }
  ok("every serialized topic claim carries publishedAt", tot > 0 && withPa === tot, `${withPa}/${tot}`);
  ok("...and it parses as a real date", (() => {
    for (const b of ev.bouts) for (const t of b.topics || []) for (const c of t.claims || [])
      if (!Number.isFinite(Date.parse(c.publishedAt))) return false;
    return true;
  })());
  const claims = ADM.claimsOf(be0);
  ok("claims rebuild with about/direction/boutId restored",
    claims.length > 0 && claims.every((c) => c.about && c.direction && c.boutId === be0.boutId));
}

console.log("\nPOST-SEAL EVIDENCE IS EXCLUDED");
{
  const leak = withClaim(be0, { claim: "A post-seal claim.", channel: "LEAK", publishedAt: "2026-07-19T04:00:00Z" });
  const r = ADM.admissibleEvidence(bout0, leak, SEAL);
  ok("a claim published after the seal is rejected", r.rejected.length === 1);
  ok("...for being post-seal", /AFTER the forecast seal/.test(r.rejected[0].why));
  ok("...and every legitimate claim survives", r.admitted.length === ADM.claimsOf(be0).length);

  // Moving the seal earlier must reject MORE, never fewer.
  const early = ADM.admissibleEvidence(bout0, be0, Date.parse("2026-07-01T00:00:00Z"));
  ok("an earlier seal rejects the whole corpus", early.admitted.length === 0 && early.allRejected === true);
  ok("...and the bout collapses to INSUFFICIENT EVIDENCE", early.be.coverage === "INSUFFICIENT EVIDENCE");
}

console.log("\nPOST-FIGHT EVIDENCE IS EXCLUDED");
{
  // An outcome FIELD. Present-but-false still proves the source knows.
  for (const f of ["result", "winner", "method", "finishRound"]) {
    const leak = withClaim(be0, { claim: `Carries ${f}.`, channel: "LEAK", [f]: f === "result" ? 0 : "x" });
    const r = ADM.admissibleEvidence(bout0, leak, SEAL);
    ok(`a claim carrying the outcome field "${f}" is rejected`, r.rejected.length === 1 && /outcome field/.test(r.rejected[0].why));
  }
}

console.log("\nRETROSPECTIVE LANGUAGE IS EXCLUDED");
{
  const phrases = [
    "He defeated Usman last night.",
    "Post-fight, it was clear he was hurt.",
    "He won by KO in the second round.",
    "As it turned out, the cardio held up.",
  ];
  for (const p of phrases) {
    const leak = withClaim(be0, { claim: p, quote: p, channel: "LEAK", publishedAt: "2026-07-12T21:00:00Z" });
    const r = ADM.admissibleEvidence(bout0, leak, SEAL);
    ok(`"${p.slice(0, 34)}..." is rejected`, r.rejected.length === 1 && /retrospective language/.test(r.rejected[0].why));
  }
  // Retrospective text is rejected even though its TIMESTAMP is impeccably pre-seal — the two checks
  // are independent, and a leak dressed in a valid date must still not pass.
  const leak = withClaim(be0, { claim: "He knocked him out in the first.", quote: "he knocked him out in the first", channel: "LEAK", publishedAt: "2026-07-12T21:00:00Z" });
  ok("a pre-seal timestamp does not rescue retrospective language",
    ADM.admissibleEvidence(bout0, leak, SEAL).rejected.length === 1);
}

console.log("\nREJECTED EVIDENCE CANNOT INFLUENCE ORIGINS, ADJUSTMENTS OR RANGES");
{
  const cleanR = ADM.admissibleEvidence(bout0, be0, SEAL);
  const A = bout0.a.name, B = bout0.b.name;
  const cleanAdj = F.buildAdjustments(cleanR.be, A, B);

  // THE CENTRAL TEST. Ten leaked claims from ten distinct channels — the shape that would otherwise
  // manufacture ten origins and drive a MAJOR adjustment.
  let leak = clone(be0);
  for (let i = 0; i < 10; i++) {
    leak.topics[0].claims.push({ ...clone(be0.topics[0].claims[0]),
      claim: `Leaked observation ${i}.`, channel: `LEAK CHANNEL ${i}`, publishedAt: "2026-07-19T04:00:00Z" });
  }
  const leakR = ADM.admissibleEvidence(bout0, leak, SEAL);

  ok("ten leaked claims are all rejected", leakR.rejected.length === 10);
  ok("ORIGINS are identical to the clean run — the leak contributed no origin",
    leakR.be.independentOrigins === cleanR.be.independentOrigins,
    `${cleanR.be.independentOrigins} -> ${leakR.be.independentOrigins}`);
  ok("COVERAGE is unchanged", leakR.be.coverage === cleanR.be.coverage);
  ok("ADJUSTMENTS are byte-identical to the clean run",
    JSON.stringify(F.buildAdjustments(leakR.be, A, B)) === JSON.stringify(cleanAdj));
  ok("topic claim counts do not include the leak",
    leakR.be.topics.reduce((s, t) => s + t.claimCount, 0) === cleanR.be.topics.reduce((s, t) => s + t.claimCount, 0));
  ok("no leaked channel appears anywhere in the admitted evidence",
    !/LEAK CHANNEL/.test(JSON.stringify(leakR.be)));
}

console.log("\nLOWERING THE ORIGIN THRESHOLD CANNOT BYPASS LEAKAGE CONTROLS");
{
  // The exploration lane will let one origin move a speculative forecast. If admission were coupled to
  // the origin thresholds, that change would silently open the leakage door. It is not: admission runs
  // BEFORE any counting and its predicate does not read forecast-rules at all.
  // Grep the CODE, not the prose. The comments in admission.js explain at length why origins must be
  // recomputed rather than filtered, so a naive source grep matches its own documentation and fails a
  // module that is in fact correct — a check that cannot see its own case, in the test this time.
  const raw = fs.readFileSync(path.join(__dirname, "..", "lib", "admission.js"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  ok("lib/admission.js code never reads forecast-rules", !/forecast-rules|RULES\.|magnitudeClass|minIndependentOrigins/.test(code));
  ok("lib/admission.js code never branches on an origin count", !/independentOrigins|originAnalysis/.test(code));
  ok("...and the module does not even require lib/forecast", !/require\(["'][^"']*forecast/.test(code));

  // Empirical: a single leaked claim, alone, still cannot produce evidence at ANY threshold.
  const solo = clone(be0);
  solo.topics = [{ ...clone(be0.topics[0]), claims: [{ ...clone(be0.topics[0].claims[0]),
    claim: "One leaked origin.", channel: "SOLO LEAK", publishedAt: "2026-07-19T04:00:00Z" }] }];
  const r = ADM.admissibleEvidence(bout0, solo, SEAL);
  ok("a lone leaked claim yields zero admitted evidence", r.admitted.length === 0);
  ok("...and zero origins, regardless of any threshold", r.be.independentOrigins === 0);
  ok("...and INSUFFICIENT EVIDENCE, so no lane can act on it", r.be.coverage === "INSUFFICIENT EVIDENCE");
}

console.log("\nADMISSION FAILS CLOSED ON MISSING OR MALFORMED STATUS");
{
  for (const [label, patch] of [
    ["no publishedAt at all", { publishedAt: undefined }],
    ["publishedAt: null", { publishedAt: null }],
    ["publishedAt: ''", { publishedAt: "" }],
    ["publishedAt: 'soon'", { publishedAt: "soon" }],
    ["publishedAt as a number", { publishedAt: 1784278339234 }],
    ["publishedAt: {}", { publishedAt: {} }],
    ["no claim text", { claim: undefined }],
  ]) {
    const bad = withClaim(be0, { channel: "MALFORMED", ...patch });
    const r = ADM.admissibleEvidence(bout0, bad, SEAL);
    ok(`${label} is REFUSED, not skipped`, r.rejected.length === 1, JSON.stringify(r.rejected));
  }
  // The distinction matters: a malformed claim is a refusal we must be able to see, not a silent drop.
  const bad = withClaim(be0, { channel: "MALFORMED", publishedAt: null });
  const rec = ADM.admissionRecord(ADM.admissibleEvidence(bout0, bad, SEAL));
  ok("a malformed claim is counted as malformed, not as leakage",
    rec.rejectedAsMalformed === 1 && rec.rejectedForLeakage === 0);
  ok("...and its rejection is recorded for the artifact", rec.rejections.length === 1 && !!rec.rejections[0].why);

  // A borrowed timestamp is the bug this fix must never re-introduce.
  const src = fs.readFileSync(path.join(__dirname, "..", "run-forecast.js"), "utf8");
  ok("run-forecast no longer borrows a sibling claim's publishedAt",
    !/publishedAt:\s*c\.publishedAt\s*\|\|/.test(src) && !/topics\[0\]\.claims\[0\]\s*\|\|\s*\{\}\)\.publishedAt/.test(src));
  ok("run-forecast no longer computes adm and forecasts from raw evidence",
    /be = adm\.be/.test(src));
}

console.log("\nADMISSION REFUSES ITS OWN MISSING INPUTS");
{
  const threw = (fn) => { try { fn(); return false; } catch (e) { return !!e.admission; } };
  ok("a non-finite seal throws", threw(() => ADM.admissibleEvidence(bout0, be0, NaN)));
  ok("no evidence throws", threw(() => ADM.admissibleEvidence(bout0, null, SEAL)));
  ok("no bout record throws", threw(() => ADM.admissibleEvidence(null, be0, SEAL)));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
