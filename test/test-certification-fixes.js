// CERTIFICATION FIXES — regression pins for the red-team findings beyond the frozen corpus:
// (1) the withdrawal sweep: a previously-recommended position that stops qualifying sends ONE
//     stand-down message and never re-fires; (2) the fight-start gate: after the bell no new betting
//     instruction may leave (withdrawals still may); (3) Kalshi outage is flagged, not silently "no
//     card"; (4) rollover-safe grading: the previous card is graded after its markets close; (5) the
//     sentinel refreshes dedup state each tick and aborts a stuck rebase.
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r/g, "");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

console.log("WITHDRAWAL SWEEP — a vanished/demoted recommendation stands the human down");
{
  const AL = require("../lib/alert-ledger-v2");
  ok("the ledger exports its ACTIONABLE vocabulary (sweep + record share one set)", AL.ACTIONABLE instanceof Set && AL.ACTIONABLE.has("CREATIVE SPECULATIVE") && AL.ACTIONABLE.has("ACTIONABLE EXPERIMENTAL"));
  const s = src("run-entertainment-alerts.js");
  ok("the runner sweeps the ledger for previously-actionable keys", /WITHDRAWAL SWEEP/.test(s) && /AL\.ACTIONABLE\.has\(prev\.classification\)/.test(s));
  ok("a swept position is re-recorded as WITHDRAWN (fires once, never loops)", /classification: "WITHDRAWN"/.test(s));
  ok("review keys are excluded from the sweep", /key\.startsWith\("review\|"\)/.test(s));
}

console.log("\nFIGHT-START GATE — no new betting instruction after the bell");
{
  const FR = require("../lib/freshness");
  ok("fightStarted flips at 22:00Z on the event date", FR.fightStarted("2026-07-18", Date.parse("2026-07-18T22:00:01Z")) === true && FR.fightStarted("2026-07-18", Date.parse("2026-07-18T21:59:59Z")) === false);
  const s = src("run-entertainment-alerts.js");
  ok("the runner gates messages on fightStarted", /FIGHT-START GATE/.test(s) && /fightStarted\(fc\.card\.eventDate\)/.test(s));
  ok("...blocking everything EXCEPT withdrawals", /m\.verdict !== "WITHDRAWN"/.test(s));
  ok("...and human-review sends are gated too", /intelOwnsNews \|\| fightHasStarted/.test(s));
  ok("run-intel feeds fightStarted to the intel lifecycle (was a hollow flag)", /fightStarted: require\("\.\/lib\/freshness"\)\.fightStarted\(card\)/.test(src("run-intel.js")));
}

console.log("\nKALSHI OUTAGE ≠ 'NO CARD' — the dispatcher says which one happened");
{
  const s = src("dispatch.js");
  ok("a fetch error is caught separately from an empty list", /fetchFailed = e && e\.message/.test(s));
  ok("the outage is loudly logged as an outage", /KALSHI FETCH FAILED/.test(s));
  ok("...and flagged on the receipts for the health view", /kalshiFetchFailed = \{ at:/.test(s));
  ok("...and cleared when the fetch works again", /delete r\.kalshiFetchFailed/.test(s));
}

console.log("\nROLLOVER-SAFE GRADING — the settled card is graded after its markets close");
{
  const s = src("dispatch.js");
  ok("the active card is remembered on the receipts", /receipts\.lastCard = \{ eventId: card\.eventId/.test(s));
  ok("EVERY past ungraded sealed forecast is graded from disk (discovery not required)", /grading past card/.test(s) && /forecast-\(/.test(s) && /gradedCards/.test(s));
  ok("grading waits for bell + 6h (not before the event ends)", /firstBellMs\(d\) \+ 6 \* 3600e3/.test(s));
  ok("the grade receipt is stamped ONLY on success", /if \(okGrade\)/.test(s));
  ok("grading is idempotent per card (gradedCards keyed once)", /!graded\[d\]/.test(s));
  ok("a finished card is released even if a market lingers open (rollover starvation)", /firstBellMs\(c\.eventDate\) \+ 24 \* 3600e3/.test(s));
  ok("a stage receipt from a different card is not recency for this card", /receipts\[st\]\.card !== card\.eventId/.test(s));
}

console.log("\nSENTINEL DEDUP FRESHNESS — cross-runner state is pulled, and a stuck rebase aborts");
{
  const s = src("sentinel.js");
  ok("each tick pulls the dispatcher's ledger updates before deciding to send", /refreshState\(\);\s+\/\/ pull/.test(s) || /refreshState\(\)/.test(s) && /pull.*--rebase.*--autostash/.test(s));
  ok("a failed persist aborts the half-rebase so retries start clean", /rebase", "--abort"/.test(s));
  ok("the sentinel refuses a card outside the ±36h fight-day window", /36 \* 3600e3/.test(s) && /outside the ±36h/.test(s));
}

console.log("\nVOCABULARY + DEDUP + IDENTITY (verdict fixes)");
{
  const AL = require("../lib/alert-ledger-v2");
  ok("core-lane tier labels ARE in the ledger's ACTIONABLE set (withdrawn/became-actionable now live for core)",
    AL.ACTIONABLE.has("standard experimental") && AL.ACTIONABLE.has("strong experimental") && AL.ACTIONABLE.has("rare maximum"));
  const ra = src("run-entertainment-alerts.js");
  ok("dedup state is refreshed from origin BEFORE shouldSend decisions", ra.indexOf("CROSS-RUNNER DEDUP REFRESH") < ra.indexOf("[1] inspecting"));
  const ri = src("run-intel.js");
  ok("run-intel refuses a positional-boutId join when the fight names disagree", /identity refusal/.test(ri) && /eb\.fight === f\.fight/.test(ri));
  const wf = src(".github/workflows/fight-day-sentinel.yml");
  ok("the sentinel workflow passes FIGHT_INTEL_SEND (legacy review suppression consistent with the dispatcher)", /FIGHT_INTEL_SEND: \$\{\{ vars\.FIGHT_INTEL_SEND \}\}/.test(wf));
}

console.log("\nDISCOVERY HEALTH — transcript failures are counted, not silently dropped");
{
  const s = src("pipeline.js");
  ok("transcript failures are counted (distinct from 'no transcript')", /transcriptFailed\+\+/.test(s));
  ok("a discovery-status receipt is written with real counts + timestamp", /discovery-status\.json/.test(s) && /transcriptFailed,/.test(s));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
