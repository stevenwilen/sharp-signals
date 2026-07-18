// QUARANTINE PRE-GATE POSITIONS — disown a position's numbers without deleting its history.
//
//   node run-quarantine-positions.js --before=<ISO> --reason="..." --rules-version=<id> [--write]
//
// WHY THIS EXISTS. On 2026-07-16T15:01:48Z commit b1399bd replaced the live-signal gate: in-sample
// "trusted" was no longer sufficient, because the 24-month backfill showed in-sample trust is
// indistinguishable from luck. The new gate is pipeline.js:406 —
//
//     signals.filter(s => s.survives && !s.isFighter && (s.sourceRoiLcb || 0) > 0)
//
// Three paper positions were already open when it landed. All three are sourced to Michael Chiesa, an
// active fighter previewing his own division, so they fail `!s.isFighter` outright — and he is
// `survives: false` in data/sources_graded.json, so they fail that clause too. One was opened EIGHT
// SECONDS before the commit that repealed the gate that admitted it.
//
// Their fights settle 2026-07-18. lib/positions.js recordOpen() returns null forever once a ticker
// exists, so no later run can re-evaluate or withdraw them, and the record carries no rulesVersion —
// so when their P&L entered the daily paper summary, nothing downstream could have said they came
// from a gate that no longer exists. The first numbers this book ever published would have been
// attributed to a system that would have refused all three.
//
// This script does not delete them. Deleting is worse: "recompute tallies, never edit them by hand",
// and a scoreboard you quietly drop rows from is not a scoreboard. The row stays, verbatim, carrying
// the reason it does not count.
require("./lib/env");
const positions = require("./lib/positions");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

function main() {
  const beforeArg = arg("before");
  const reason = arg("reason");
  const rulesVersion = arg("rules-version");
  const write = process.argv.includes("--write");

  if (!beforeArg) fail("--before=<ISO> is required: quarantine must name the moment the rules changed, not 'recently'");
  if (!reason) fail("--reason=\"...\" is required: an unexplained exclusion is indistinguishable from a deletion");
  const before = Date.parse(beforeArg);
  if (!Number.isFinite(before)) fail(`--before=${beforeArg} is not a readable timestamp — refusing to reason about a fabricated one`);

  const state = positions.load();
  const all = Object.values(state.positions);
  say(`[1] ${all.length} position(s) in the book | cutoff ${new Date(before).toISOString()}`);

  // Openness is part of the predicate: a position that already settled under the old rules has already
  // told its truth, and re-labelling history after the fact is its own kind of dishonesty. This is
  // about positions whose numbers have not been published yet.
  const targets = all.filter((p) => p.status === "open" && Date.parse(p.openedAt) < before);
  const already = all.filter((p) => p.status === "quarantined");
  if (already.length) say(`[1] ${already.length} already quarantined — untouched`);

  if (!targets.length) { say(`[2] nothing to quarantine. The book is unchanged.`); return 0; }

  say(`\n[2] ${targets.length} position(s) opened before the cutoff:\n`);
  for (const p of targets) {
    say(`  ${p.ticker}`);
    say(`     fighter        : ${p.fighter} (vs ${p.opponent || "?"})  fight ${p.fightDate}`);
    say(`     opened         : ${p.openedAt}   (${((before - Date.parse(p.openedAt)) / 1000).toFixed(0)}s before the cutoff)`);
    say(`     sources        : ${(p.sources || []).join(", ")}`);
    say(`     entry / stake  : ${(p.entryCost * 100).toFixed(0)}c · ${p.stakePct}% of bankroll`);
    say(`     rules version  : ${rulesVersion || "UNRECONSTRUCTABLE"}`);
  }

  if (!write) {
    say(`\n  DRY RUN. Nothing was written. Re-run with --write to quarantine these.`);
    say(`  Their original records are preserved verbatim; only their eligibility to be COUNTED changes.`);
    return 0;
  }

  let n = 0;
  for (const p of targets) {
    const q = positions.quarantine(state, p.ticker, {
      reason,
      originalRulesVersion: rulesVersion || null,
      quarantinedBy: "run-quarantine-positions.js",
    });
    if (!q) { say(`  (skipped ${p.ticker}: already quarantined)`); continue; }
    n++;
  }
  positions.save(state);

  // save() swallows its errors by design (lib/positions.js:39-45), so a write that silently did
  // nothing would leave this script exiting 0 having reported success. Read it back.
  const after = positions.load();
  const confirmed = Object.values(after.positions).filter((p) => p.status === "quarantined").length;
  if (confirmed !== already.length + n) {
    fail(`wrote ${n} quarantine(s) but the file reports ${confirmed} — the write did not land`);
  }

  say(`\n  quarantined ${n} position(s) — verified on re-read (${confirmed} total in the file)`);
  say(`  Each keeps its original record verbatim under .quarantine.originalRecord.`);
  say(`  includedInPerformance / includedInLearning / includedInSourceScoring = false.`);
  say(`  Settlement will still be RECORDED (for history) but can never reach the paper P&L.`);
  return 0;
}

const c = main();
if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); }
process.exit(c || 0);
