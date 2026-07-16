// SCENARIO EVALUATION — grade the SEALED ranked paths against what actually happened.
//
//   node run-scenario-eval.js <scenarios-ranked.json>
//
// Outcomes are loaded ONLY here, and only after the ranking artifact's hash is verified.
//
// HOW THIS CAN FAIL — the point of the rebuild. The scenario set enumerates all six
// (fighter x method) cells, so the realized path is ALWAYS present somewhere. Presence therefore
// proves nothing, which is exactly the trap v1 fell into when it reported "winning path
// represented: 12/12". Credit is given for RANK, never presence:
//
//   * A layer with skill puts realized paths near rank 1.
//   * A layer that is noise averages rank 3.5 of 6 — the null.
//   * A realized path landing on a DOWNWEIGHTED role is a MISS, recorded as one.
//
// Nothing here rewrites a scenario or touches a numerical rule.
require("./lib/env");
const fs = require("fs");
const R = require("./lib/scenarios-ranked");
const U = require("./lib/ufc-results");
const E = require("./lib/evidence-eval");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

// What mechanism does a realized finish demonstrate? Deterministic, and deliberately conservative:
// a decision does not reveal its mechanism, and an injury stoppage is not a mechanism we model.
// Guessing here would manufacture agreement between the forecast and the result.
function realizedMechanism(method, detail) {
  const d = String(detail || "").toLowerCase();
  if (/injur|doctor|cut\b|eye poke|illegal|retirement|towel|accidental/.test(d))
    return { mech: null, why: "injury/stoppage — not a mechanism this system models" };
  if (method === "Submission") return { mech: "grappling", why: `submission finish (${detail})` };
  if (method === "KO/TKO") {
    if (/punch|kick|elbow|knee|strike|slam|head/.test(d)) return { mech: "striking", why: `strike finish (${detail})` };
    return { mech: "striking", why: `KO/TKO, mechanism assumed striking (${detail})` };
  }
  if (method === "Decision") return { mech: null, why: "a decision does not reveal which mechanism was decisive" };
  return { mech: null, why: `unmodelled method (${detail})` };
}

async function main() {
  const sPath = process.argv[2];
  if (!sPath) fail("usage: node run-scenario-eval.js <scenarios-ranked.json>");
  if (!fs.existsSync(sPath)) fail(`not found: ${sPath}`);
  const sealed = JSON.parse(fs.readFileSync(sPath, "utf8"));

  say(`[stage 1] verifying the sealed ranking BEFORE loading any outcome ...`);
  const stored = sealed.scenarioSetHash;
  const recomputed = R.sha({ ...sealed, scenarioSetHash: undefined });
  if (stored !== recomputed) fail(`scenario ranking hash does not reproduce (${stored} vs ${recomputed}) — refusing to grade a mutated artifact`);
  if (sealed.outcomesLoaded) fail("this artifact was written with outcomes loaded — not a blind ranking");
  say(`[stage 1] scenarioSetHash VERIFIED ${stored} — ranking is unchanged since sealing`);
  say(`[stage 1] sealed at ${sealed.scenariosSealedAt}, rules v${sealed.rulesVersion}`);

  say(`\n[stage 2] loading outcomes (permitted only now) ...`);
  const bouts = Object.entries(sealed.scenarios).filter(([, v]) => (v.scenarios || []).length);
  say(`[stage 2] ${bouts.length} bout(s) carry a ranked set`);

  const rows = [];
  for (const [boutId, set] of bouts) {
    const p = set.scenarios.find((s) => s.role === "PRIMARY");
    const A = p.winner, other = set.scenarios.find((s) => s.winner !== A);
    const B = other ? other.winner : null;
    if (!B) { rows.push({ boutId, klass: "NOT EVALUABLE", why: "only one fighter in the set" }); continue; }

    let res = null;
    try { res = await U.outcome(A, B, null); } catch (e) { /* fall through */ }
    if (!res || res.result === null || res.result === undefined) {
      rows.push({ boutId, fight: `${A} vs ${B}`, klass: "NOT EVALUABLE", why: "no result found for this bout" });
      continue;
    }
    const winner = res.result === 1 ? A : B;
    const method = res.method || null;
    const detail = res.methodDetail || null;
    if (!method) {
      rows.push({ boutId, fight: `${A} vs ${B}`, klass: "NOT EVALUABLE", why: "result found but method unavailable" });
      continue;
    }

    const rm = realizedMechanism(method, detail);
    // the realized cell, by rank
    const realized = set.scenarios.find((s) => E.norm(s.winner) === E.norm(winner) && s.expectedMethod === method);
    const winnerRight = E.norm(p.winner) === E.norm(winner);
    const methodRight = p.expectedMethod === method;
    const mechRight = rm.mech ? p.decisiveMechanisms.includes(rm.mech) : null;

    let klass;
    if (!realized) klass = "MISSED PATH";
    else if (realized.role === "DOWNWEIGHTED") klass = "MISSED PATH";
    else if (winnerRight && methodRight && mechRight === true) klass = "STRONG MATCH";
    else if (winnerRight && methodRight) klass = "PARTIAL MATCH";
    else if (winnerRight && mechRight === false) klass = "RIGHT WINNER, WRONG MECHANISM";
    else if (winnerRight) klass = "PARTIAL MATCH";
    else if (mechRight === true) klass = "WRONG WINNER, RIGHT MECHANISM";
    else klass = "MISSED PATH";

    // did we lean on a mechanism that demonstrably never appeared?
    const absent = rm.mech ? p.decisiveMechanisms.filter((m) => m !== rm.mech) : [];
    rows.push({
      boutId, fight: `${A} vs ${B}`, winner, method, detail, klass,
      primary: `${p.winner} by ${p.expectedMethod}`, primaryShare: p.sharePercent,
      primaryMechs: p.decisiveMechanisms,
      realizedRank: realized ? realized.rank : null,
      realizedRole: realized ? realized.role : null,
      realizedShare: realized ? realized.sharePercent : null,
      winnerRight, methodRight, mechRight, realizedMech: rm.mech, realizedMechWhy: rm.why,
      reliedOnAbsent: rm.mech ? absent : [],
      falsifiedBy: p.falsifiedBy,
    });
  }

  say(`\n${"=".repeat(94)}\nPER-BOUT\n${"=".repeat(94)}`);
  for (const r of rows) {
    if (r.klass === "NOT EVALUABLE") { say(`  NOT EVALUABLE  ${r.fight || r.boutId} — ${r.why}`); continue; }
    say(`  ${r.fight}`);
    say(`     actual      : ${r.winner} by ${r.method} (${r.detail})`);
    say(`     PRIMARY     : ${r.primary} @ ${r.primaryShare}%  mechs: ${r.primaryMechs.join("/") || "none"}`);
    say(`     realized path ranked #${r.realizedRank} of 6 (${r.realizedRole}, ${r.realizedShare}%)`);
    say(`     winner ${r.winnerRight ? "RIGHT" : "WRONG"} | method ${r.methodRight ? "RIGHT" : "WRONG"} | mechanism ${r.mechRight === null ? "NOT EVALUABLE" : r.mechRight ? "RIGHT" : "WRONG"} (${r.realizedMechWhy})`);
    if (r.reliedOnAbsent.length) say(`     leaned on mechanisms that did not decide it: ${r.reliedOnAbsent.join(", ")}`);
    say(`     => ${r.klass}`);
  }

  const ev = rows.filter((r) => r.klass !== "NOT EVALUABLE");
  say(`\n${"=".repeat(94)}\nCLASSIFICATION\n${"=".repeat(94)}`);
  const counts = {};
  for (const r of ev) counts[r.klass] = (counts[r.klass] || 0) + 1;
  for (const k of ["STRONG MATCH", "PARTIAL MATCH", "WRONG WINNER, RIGHT MECHANISM", "RIGHT WINNER, WRONG MECHANISM", "MISSED PATH"])
    say(`  ${k.padEnd(32)} ${counts[k] || 0}`);
  say(`  ${"NOT EVALUABLE".padEnd(32)} ${rows.length - ev.length}`);

  if (ev.length) {
    const ranks = ev.map((r) => r.realizedRank).filter((x) => x);
    const mean = ranks.reduce((a, x) => a + x, 0) / ranks.length;
    say(`\n${"=".repeat(94)}\nTHE FALSIFIABLE TEST — rank of the realized path\n${"=".repeat(94)}`);
    say(`  realized-path ranks: ${ranks.join(", ")}`);
    say(`  mean realized rank : ${mean.toFixed(2)} of 6`);
    say(`  null (no skill)    : 3.50 of 6`);
    say(`  => ${mean < 3.5 ? `BETTER than chance by ${(3.5 - mean).toFixed(2)} ranks` : `NO BETTER than chance (${(mean - 3.5).toFixed(2)} worse)`}`);
    say(`  primary identified the winner: ${ev.filter((r) => r.winnerRight).length}/${ev.length}`);
    say(`  primary identified the method: ${ev.filter((r) => r.methodRight).length}/${ev.length}`);
    const mEval = ev.filter((r) => r.mechRight !== null);
    say(`  primary identified the mechanism: ${mEval.filter((r) => r.mechRight).length}/${mEval.length} (${ev.length - mEval.length} not evaluable)`);
    say(`  realized path landed on a DOWNWEIGHTED role: ${ev.filter((r) => r.realizedRole === "DOWNWEIGHTED").length}/${ev.length}`);
    say(`\n  n=${ev.length}. This measures whether the layer CAN fail, not whether it has skill.`);
  }
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
