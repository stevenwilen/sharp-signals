// PHASE 6 — evaluate an extracted card's evidence. Organizes, downgrades, and states its gaps.
// Produces NO probability, method call, edge, stake, ranking, or recommendation.
//
//   node run-evidence-eval.js data/card-evidence-2026-07-11.json [--out=path]
require("./lib/env");
const fs = require("fs");
const path = require("path");
const be = require("./lib/bout-evidence");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

// A guard against the single worst way this layer could fail: quietly emitting a number that a
// reader treats as a probability. If any of these appear in the output, the run is a failure.
const BANNED = ["winProbability", "probability", "impliedProb", "edge", "stake", "kelly", "recommendation", "pick", "bet"];

async function main() {
  const src = process.argv[2];
  const outArg = (process.argv.find((a) => a.startsWith("--out=")) || "").split("=")[1];
  say(`[stage 1] validating input ...`);
  if (!src) fail("usage: node run-evidence-eval.js <card-evidence.json> [--out=path]");
  if (!fs.existsSync(src)) fail(`not found: ${src}`);
  const d = JSON.parse(fs.readFileSync(src, "utf8"));
  if (!d.card || !Array.isArray(d.claims)) fail("input is not a card-evidence file");
  if (!d.claims.length) fail(`NOTHING TO EVALUATE: the card file contains 0 claims. That is a real ` +
    `answer about coverage, but there is nothing to evaluate.`);
  say(`[stage 1] ${d.card.eventId}: ${d.card.bouts.length} bouts, ${d.claims.length} claims`);

  say(`[stage 2] evaluating bouts ...`);
  const bouts = d.card.bouts.map((b) => be.evaluateBout(b, d.claims));
  const cov = {};
  for (const b of bouts) cov[b.coverage] = (cov[b.coverage] || 0) + 1;
  say(`[stage 2] coverage: ${JSON.stringify(cov)}`);

  const out = outArg || src.replace(/card-evidence/, "evidence-eval");
  say(`\n${"=".repeat(90)}`);
  say(`EVIDENCE EVALUATION — ${d.card.eventId}   (no probabilities, no bets, no recommendations)`);
  say("=".repeat(90));

  for (const b of bouts.sort((x, y) => y.independentOrigins - x.independentOrigins)) {
    say(`\n${"-".repeat(90)}`);
    say(`${b.fight}`);
    const ob = b.originBreakdown || {};
    say(`  COVERAGE: ${b.coverage}  |  ${b.relevantClaims} claims, ${b.topicCount} topics, ${b.channels} channel(s)`);
    say(`  ORIGINS: ${b.independentOrigins} total = ${ob.analysts || 0} independent analyst(s) + ` +
      `${ob.publicRecords || 0} public record(s) + ${ob.externalReports || 0} external report(s)` +
      `${ob.commentary ? ` + ${ob.commentary} commentary` : ""}`);
    if (b.coverage === "INSUFFICIENT EVIDENCE") {
      say(`  ${b.reason || "not enough analytical evidence to say anything"}`);
      say(`  MISSING: ${b.missingInformation.join(", ")}`);
      continue;
    }
    if (b.strongestFactual.length) {
      say(`  STRONGEST FACTUAL:`);
      for (const f of b.strongestFactual)
        say(`    [${f.strength}] ${f.about} ${f.direction === "favors_about" ? "+" : "-"} ${f.topic}: ${f.claim.slice(0, 58)}`
          + `\n        ${f.origins} origin(s), ${f.amplifiers} channel(s)`);
    }
    if (b.strongestMatchupObservations.length) {
      say(`  STRONGEST MATCHUP OBSERVATIONS:`);
      for (const m of b.strongestMatchupObservations)
        say(`    ${m.about} ${m.direction === "favors_about" ? "+" : "-"} ${m.topic} (${m.independentObservations} independent analyst(s)): ${m.claim.slice(0, 52)}`);
    }
    if (b.currentCondition.length) {
      say(`  CURRENT CONDITION:`);
      for (const c of b.currentCondition.slice(0, 3)) say(`    ${c.about} ${c.topic} [${c.freshness.join("/")}] ${c.origins} origin(s): ${c.claim.slice(0, 50)}`);
    }
    if (b.rumorsAndUnresolved.length) {
      say(`  RUMORS / UNRESOLVED:`);
      for (const r of b.rumorsAndUnresolved.slice(0, 3)) {
        say(`    ${r.about} ${r.topic}: ${r.claim.slice(0, 52)}`);
        say(`      chain: ${r.chain}${r.note ? `\n      NOTE: ${r.note}` : ""}`);
      }
    }
    if (b.contradictions.length) {
      say(`  CONTRADICTIONS (${b.contradictions.length}):`);
      for (const c of b.contradictions.slice(0, 2)) {
        say(`    ${c.proposition} — ${c.disagreementType}${c.bothCanBeTrue ? "  (BOTH CAN BE TRUE)" : ""}`);
        say(`      supporting: ${c.supporting.claims} claim(s), ${c.supporting.independentOrigins} origin(s) — "${(c.supporting.examples[0] || "").slice(0, 46)}"`);
        say(`      opposing  : ${c.opposing.claims} claim(s), ${c.opposing.independentOrigins} origin(s) — "${(c.opposing.examples[0] || "").slice(0, 46)}"`);
      }
    }
    if (b.potentiallyNovel.length) say(`  POTENTIALLY NOVEL: ${b.potentiallyNovel.slice(0, 3).map((p) => `${p.about}/${p.topic} (${p.marketAwareness}, ${p.origins} origin)`).join("; ")}`);
    if (b.widelyKnown.length) say(`  WIDELY KNOWN (likely in the market): ${b.widelyKnown.slice(0, 4).join("; ")}`);
    if (b.missingInformation.length) say(`  MISSING INFORMATION: ${b.missingInformation.join(", ")}`);
    if (b.limitations.length) for (const l of b.limitations) say(`  LIMITATION: ${l}`);
  }

  const review = bouts.flatMap((b) => b.reviewItems.map((r) => ({ fight: b.fight, ...r })));
  say(`\n${"=".repeat(90)}`);
  say(`HUMAN REVIEW QUEUE: ${review.length} material item(s)`);
  for (const r of review.slice(0, 8)) say(`  [${r.why}] ${r.fight} — ${r.topic}${r.example ? `: ${String(r.example).slice(0, 48)}` : ""}${r.detail ? ` (${r.detail})` : ""}`);

  say(`\n[stage 3] validating output ...`);
  const payload = { card: d.card, evaluatedAt: new Date().toISOString(), source: path.basename(src),
    bouts, reviewQueue: review };
  const json = JSON.stringify(payload);
  // the banned-output guard
  const leaked = BANNED.filter((k) => new RegExp(`"${k}"\\s*:`).test(json));
  if (leaked.length) fail(`the evaluator emitted forbidden field(s): ${leaked.join(", ")} — this layer must never produce a probability or a bet`);
  writeJson(out, payload);
  if (!fs.existsSync(out)) fail(`output not written: ${out}`);
  const back = JSON.parse(fs.readFileSync(out, "utf8"));
  if (back.bouts.length !== d.card.bouts.length) fail(`bout count mismatch`);
  // the source record must survive underneath the evaluation
  const kept = back.bouts.reduce((a, b) => a + (b.topics || []).reduce((x, t) => x + t.claims.length, 0), 0);
  const onCard = d.claims.filter((c) => c.boutId).length;
  if (kept < onCard) fail(`source record lost: ${onCard} on-card claims in, ${kept} preserved under the evaluation`);
  say(`[stage 3] output verified: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)}KB, ${kept}/${onCard} source claims preserved, 0 forbidden fields)`);
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
process.on("unhandledRejection", (e) => { process.stdout.write(`\nFATAL (rejection): ${e && e.message}\n`); process.exit(1); });
