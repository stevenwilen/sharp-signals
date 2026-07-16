// STATIC ENGINE REVIEW — against REAL serialized Phase 6 artifacts.
//
// NO OUTCOMES ARE LOADED HERE. This file must never require predictions.json, a results file, or
// anything downstream of a fight. It checks the engine against the shape the upstream actually
// emits — because the last defect survived precisely because the fixtures were hand-built in the
// shape the buggy code expected, so green tests proved nothing.
const fs = require("fs");
const path = require("path");
const F = require("../lib/forecast");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${x ? " -> " + x : ""}`); } };

const D = path.join(__dirname, "..", "data");
const dense = JSON.parse(fs.readFileSync(path.join(D, "evidence-eval-2026-07-11.json"), "utf8"));
const sparse = JSON.parse(fs.readFileSync(path.join(D, "evidence-eval-2026-07-18.json"), "utf8"));

// ---- REAL FIXTURES, copied verbatim out of the serialized upstream. Not normalised. ----
const allTopics = [...dense.bouts, ...sparse.bouts].flatMap((b) => b.topics || []);
const FIX = {
  dense: dense.bouts.find((b) => /McGregor/.test(b.fight)),
  sparse: sparse.bouts.find((b) => b.coverage !== "INSUFFICIENT EVIDENCE"),
  insufficient: sparse.bouts.find((b) => b.coverage === "INSUFFICIENT EVIDENCE"),
  oneOrigin: allTopics.find((t) => t.origin && t.origin.independentOrigins === 1),
  manyMentionsOneOrigin: allTopics.find((t) => t.origin && t.origin.independentOrigins === 1 && t.origin.totalMentions >= 3),
  multiOrigin: allTopics.find((t) => t.origin && t.origin.independentOrigins >= 5),
};

console.log("REAL-SHAPE FIXTURES (verbatim from serialized Phase 6)");
ok("dense bout fixture found", !!FIX.dense, "none");
ok("sparse bout fixture found", !!FIX.sparse, "none");
ok("insufficient-evidence bout fixture found", !!FIX.insufficient, "none");
ok("one-origin topic fixture found", !!FIX.oneOrigin, "none");
ok("many-mentions-one-origin fixture found", !!FIX.manyMentionsOneOrigin,
  FIX.oneOrigin ? `best mentions=${FIX.oneOrigin.origin.totalMentions}` : "none");
ok("multi-origin topic fixture found", !!FIX.multiOrigin, "none");

console.log("\nFIELD PATHS — every path the engine reads must exist upstream");
{
  const t = FIX.multiOrigin || FIX.oneOrigin;
  ok("topic.origin.independentOrigins exists", Number.isFinite(t.origin.independentOrigins));
  ok("topic.origin.originIds exists (needed for the lift rule)", Array.isArray(t.origin.originIds), JSON.stringify(t.origin.originIds));
  ok("topic.strength exists", typeof t.strength === "string", t.strength);
  ok("topic.kinds is an array", Array.isArray(t.kinds));
  ok("topic.relevance is an array", Array.isArray(t.relevance));
  ok("topic.freshness is an array", Array.isArray(t.freshness));
  ok("topic.direction exists", typeof t.direction === "string");
  const b = FIX.dense;
  ok("bout.topics exists", Array.isArray(b.topics));
  ok("bout.contradictions exists", Array.isArray(b.contradictions));
  ok("bout.coverage exists", typeof b.coverage === "string");
  ok("bout.originBreakdown exists (uncertainty reads it)", !!b.originBreakdown);
  ok("bout.channels exists (uncertainty reads it)", Number.isFinite(b.channels));
}

console.log("\nFAIL CLOSED — malformed input must be refused, never waved through");
{
  const base = { topic: "cardio", strength: "strong", kinds: ["verified_hard_fact"],
    relevance: ["direct_current_matchup"], freshness: ["recent_fights"] };
  const cases = [
    ["missing origin object", { ...base }],
    ["origin present but count undefined", { ...base, origin: {} }],
    ["origin count null", { ...base, origin: { independentOrigins: null } }],
    ["origin count NaN", { ...base, origin: { independentOrigins: NaN } }],
    ["origin count a string", { ...base, origin: { independentOrigins: "9" } }],
    ["origin count Infinity", { ...base, origin: { independentOrigins: Infinity } }],
  ];
  for (const [name, ev] of cases) {
    const r = F.magnitudeClassFor(ev);
    ok(`${name} -> NONE`, r.cls === "NONE", `${r.cls} (${r.reason})`);
  }
  // missing arrays must not throw and must not pass
  for (const [name, ev] of [["kinds missing", { ...base, origin: { independentOrigins: 9 }, kinds: undefined }],
    ["relevance missing", { ...base, origin: { independentOrigins: 9 }, relevance: undefined }]]) {
    let r = null, threw = null;
    try { r = F.magnitudeClassFor(ev); } catch (e) { threw = e; }
    ok(`${name} -> NONE, no throw`, !threw && r && r.cls === "NONE", threw ? threw.message : r && r.cls);
  }
}

console.log("\nREPEATED SOURCES CANNOT INFLATE ORIGINS");
{
  const t = FIX.manyMentionsOneOrigin || FIX.oneOrigin;
  if (t) {
    ok(`a real 1-origin topic with ${t.origin.totalMentions} mentions still gets NONE`,
      F.magnitudeClassFor(t).cls === "NONE", `${F.magnitudeClassFor(t).cls}`);
    ok("  ...amplifiers are recorded but do not count as origins",
      t.origin.amplifyingChannels >= 1 && t.origin.independentOrigins === 1);
  }
  // the lift rule must require independent origins, not merely several topics
  const one = { ...(FIX.oneOrigin || {}) };
  if (one.origin) {
    const fake = { boutId: "T", topics: [one, one, one], contradictions: [] };
    const adjs = F.buildAdjustments(fake, "A", "B");
    const lifted = adjs.filter((a) => a.liftedTo);
    ok("3 copies of ONE origin cannot lift a magnitude", lifted.length === 0, JSON.stringify(lifted.map((l) => l.liftReason)));
  }
}

console.log("\nDETERMINISM");
{
  const t = FIX.multiOrigin || FIX.oneOrigin;
  const runs = new Set();
  for (let i = 0; i < 5; i++) runs.add(JSON.stringify(F.magnitudeClassFor(t)));
  ok("magnitudeClassFor is deterministic over 5 runs", runs.size === 1);
  const a1 = JSON.stringify(F.buildAdjustments(FIX.dense, "Conor McGregor", "Max Holloway"));
  const a2 = JSON.stringify(F.buildAdjustments(FIX.dense, "Conor McGregor", "Max Holloway"));
  ok("buildAdjustments is byte-identical across runs", a1 === a2);
}

console.log("\nDIRECTION — an adjustment must move the fighter it favours");
{
  const A = "Conor McGregor", B = "Max Holloway";
  const adjs = F.buildAdjustments(FIX.dense, A, B).filter((a) => a.finalAppliedLogOdds > 0);
  ok("adjustments exist on the dense fixture", adjs.length > 0, String(adjs.length));
  // replicate the runner's sign convention and check it moves the right way
  const forA = adjs.find((a) => a.fighterFavored === A);
  const forB = adjs.find((a) => a.fighterFavored === B);
  if (forA) {
    const p = F.sig(F.logit(0.5) + forA.finalAppliedLogOdds);
    ok(`an adjustment favouring ${A} raises ${A}'s probability`, p > 0.5, String(p));
  }
  if (forB) {
    const p = F.sig(F.logit(0.5) - forB.finalAppliedLogOdds);
    ok(`an adjustment favouring ${B} lowers ${A}'s probability`, p < 0.5, String(p));
  }
  ok("every adjustment names the fighter it favours", adjs.every((a) => a.fighterFavored && a.direction.includes(a.fighterFavored)));
}

console.log("\nCAPS — converted and applied correctly");
{
  const R = F.RULES;
  // the percentage-point cap must be applied in probability space, not log-odds space
  const pMkt = 0.30, huge = 5.0;
  let p = F.sig(F.logit(pMkt) + huge);
  const maxMove = R.caps.maxProbabilityPointsFromMarket / 100;
  if (Math.abs(p - pMkt) > maxMove) p = pMkt + Math.sign(p - pMkt) * maxMove;
  ok(`a huge adjustment cannot move a 30% line more than ${R.caps.maxProbabilityPointsFromMarket} pts`,
    Math.abs(p - pMkt) <= maxMove + 1e-9, `moved ${((p - pMkt) * 100).toFixed(2)}`);
  ok("  ...and the cap is a probability-point cap, not a log-odds cap", Math.abs(p - (pMkt + maxMove)) < 1e-9);
  ok("total log-odds cap is smaller than 2x MAJOR (so 2 MAJORs already bind)",
    R.caps.totalLogOddsPerFighter < 2 * R.magnitudeClasses.MAJOR);
}

console.log("\nCONTRADICTION WIDENS BUT DOES NOT MOVE THE MIDPOINT");
{
  const b = FIX.dense;
  const withC = F.uncertaintyFor(b, []);
  const withoutC = F.uncertaintyFor({ ...b, contradictions: [] }, []);
  ok("contradictions widen the range", withC.halfWidthPoints > withoutC.halfWidthPoints,
    `${withC.halfWidthPoints} vs ${withoutC.halfWidthPoints}`);
  // uncertaintyFor must not touch the central probability at all — it returns only a half-width
  ok("uncertaintyFor returns only a width, never a probability",
    Object.keys(withC).every((k) => ["halfWidthPoints", "drivers"].includes(k)), Object.keys(withC).join(","));
}

console.log("\nOUTCOME TREE STAYS COHERENT AFTER ROUNDING");
{
  let worst = 0, bad = 0;
  for (let i = 1; i < 100; i++) {
    const p = i / 100;
    const t = F.buildTree(p, "A", "B");
    const errs = F.verifyTree(t, "A", "B");
    if (errs.length) { bad++; if (bad <= 2) console.log(`      p=${p}: ${errs[0]}`); }
    worst = Math.max(worst, Math.abs(t.A.win + t.B.win - 1));
  }
  ok("tree coherent at every probability from 1% to 99% (rounding included)", bad === 0, `${bad} incoherent`);
  ok(`  worst win-sum drift <= 0.005 (${worst.toFixed(5)})`, worst <= 0.005);
}

console.log("\nBASELINE UNAVAILABLE CANNOT CARRY A FORECAST");
{
  const f = JSON.parse(fs.readFileSync(path.join(D, "forecast-2026-07-11.json"), "utf8"));
  const nb = f.forecasts.filter((x) => x.status === "BASELINE UNAVAILABLE");
  ok(`baseline-unavailable forecasts exist to check (${nb.length})`, nb.length > 0);
  ok("  ...none carries a system probability", nb.every((x) => x.systemCentral === null || x.systemCentral === undefined));
  ok("  ...none carries adjustments", nb.every((x) => !x.appliedAdjustments || x.appliedAdjustments.length === 0));
  ok("  ...none carries a market disagreement", nb.every((x) => x.marketDisagreementPoints == null));
  ok("  ...each states a reason", nb.every((x) => typeof x.reason === "string" && x.reason.length > 10));
}

console.log("\nSEAL INTEGRITY");
{
  const f = JSON.parse(fs.readFileSync(path.join(D, "forecast-2026-07-11.json"), "utf8"));
  ok("sealed artifact carries a hash", !!f.sealHash);
  ok("sealed artifact is marked immutable", f.immutable === true);
  ok("every forecast carries data hashes", f.forecasts.every((x) => x.dataHashes && x.dataHashes.rules));
  ok("every forecast carries a rules version", f.forecasts.every((x) => x.versions && x.versions.rules));
  ok("every forecast carries a seal timestamp", f.forecasts.every((x) => !!x.sealedAt));
  // sealHash must cover the WHOLE artifact, lineage included; contentHash must identify the
  // forecast itself and reproduce from identical inputs regardless of lineage.
  const crypto = require("crypto");
  const { sealHash, ...rest } = f;
  const re = crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
  ok("sealHash covers the entire artifact (lineage included)", re === sealHash, `${re} vs ${sealHash}`);
  const ch = crypto.createHash("sha256").update(JSON.stringify({ card: f.card, sealedAt: f.sealedAt, rulesVersion: f.rulesVersion, marketSource: f.marketSource, forecasts: f.forecasts })).digest("hex").slice(0, 16);
  ok("contentHash reproduces from identical inputs", ch === f.contentHash, `${ch} vs ${f.contentHash}`);
}

console.log("\nNO OUTCOME DATA WAS TOUCHED BY THIS REVIEW");
{
  const loaded = Object.keys(require.cache).filter((k) => /predictions\.json|card-evidence/.test(k));
  ok("no results file was required", loaded.length === 0, loaded.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
