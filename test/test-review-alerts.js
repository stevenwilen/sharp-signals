// Unit tests for the HUMAN REVIEW alert path.
//
// Both halves of this file cover failures that REACHED A HUMAN'S PHONE on 2026-07-17. Three HUMAN
// REVIEW messages were sent (data/alert-ledger-v2.json, messageCount:1 on each) binding a Kevin
// Holland withdrawal rumour to Kamaru Usman's bout — for a Holland fight that had already been removed
// from the card. Neither failure was exotic; both were a comparison nobody made.
//
//   1. IDENTITY. run-entertainment-alerts.js took the fight name from the forecast and the claim from
//      the eval bout, joined on boutId, and never compared them — though the eval bout carries its own
//      `fight` string. boutId is a positional index (lib/target-card.js:68), so when a bout leaves the
//      card every later id re-binds to a different fight.
//   2. SUPPRESSION. Every ledger trigger except `first` inspected a field only a contract state carries,
//      so a review key that had spoken once could never speak again — including on origins 1 -> 5, the
//      one transition the governing rule says is the difference between "moves nothing" and "MAJOR".
const AL = require("../lib/alert-ledger-v2");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const fire = (prev, now) => AL.TRIGGERS.map((t) => ({ id: t.id, why: t.test(prev, now) })).filter((x) => x.why);
const fired = (prev, now, id) => fire(prev, now).some((f) => f.id === id);

const review = (o = {}) => ({
  newsKey: "review|UFC-2026-07-18-B01|injury_health|Kevin Holland",
  about: "Kevin Holland", topic: "injury_health", origins: 1,
  why: "high-impact injury rumor", claimHash: "aaaaaaaaaaaaaaaa", ...o,
});

console.log("A REVIEW ALERT CAN SPEAK TWICE WHEN THE NEWS CHANGES");
{
  const prev = review();

  // The headline case. Under the governing rule 1 origin moves the forecast by exactly zero and 5 is
  // MAJOR. Before this fix the transition fired ZERO triggers.
  ok("origins 1 -> 5 re-alerts", fired(prev, review({ origins: 5 }), "review-origins-changed"));
  ok("...and says both numbers", fire(prev, review({ origins: 5 })).some((f) => /1 -> 5/.test(f.why)));
  ok("origins 5 -> 1 also re-alerts (retraction is news too)", fired(review({ origins: 5 }), prev, "review-origins-changed"));
  ok("origins unknown -> 3 re-alerts", fired(review({ origins: undefined }), review({ origins: 3 }), "review-origins-known"));

  // A withdrawal rumour must not be swallowed because a knee rumour about the same fighter was sent.
  ok("a different claim about the same fighter+topic re-alerts",
    fired(prev, review({ claimHash: "bbbbbbbbbbbbbbbb" }), "review-claim-changed"));
  ok("verification status changing re-alerts",
    fired(prev, review({ verdict: "CONFIRMED" }), "review-verdict-changed"));
  ok("unverified -> CONTRADICTED re-alerts",
    fired(prev, review({ verdict: "CONTRADICTED" }), "review-verdict-changed"));
}

console.log("\n...BUT IT STILL DOES NOT SPAM");
{
  const prev = review();
  // The other half of the ledger's job. The V1 ledger existed because the pipeline re-sent the same
  // message ~18 times a fight week; loosening suppression must not walk back into that.
  ok("an identical re-run stays quiet", fire(prev, review()).length === 0, JSON.stringify(fire(prev, review())));
  ok("a re-worded claim with the same hash stays quiet", fire(prev, review({ why: "reworded" })).length === 0);
  ok("a never-seen review still fires exactly once", fire(undefined, review()).length === 1);
  ok("...and that once is `first`", fired(undefined, review(), "first"));
}

console.log("\nREVIEW TRIGGERS DO NOT THROW ON CONTRACT STATE, AND VICE VERSA");
{
  // Every trigger runs against every state. A review trigger that throws on a contract state would take
  // the whole run down — and a ledger that throws is a ledger that sends nothing.
  const contract = { ticker: "KXUFCFIGHT-26JUL18DUUSM-DU", ask: 0.69, maximumAcceptablePrice: 0.72,
    classification: "ACTIONABLE EXPERIMENTAL", stakePercent: 3, forecastHash: "abc", stale: false, withinEnvelope: true };
  let threw = null;
  try { fire(contract, { ...contract, ask: 0.75 }); fire(review(), contract); fire(contract, review()); }
  catch (e) { threw = e.message; }
  ok("mixing review and contract states never throws", threw === null, threw);
  ok("a contract trigger still fires on contract state",
    fired(contract, { ...contract, classification: "NO BET" }, "withdrawn"));
}

console.log("\nIDENTITY: A BOUT WHOSE TWO HALVES DISAGREE IS REFUSED, NOT RENDERED");
{
  // Reproduces the shipped artifact exactly: the forecast and the eval bind the same boutId to
  // different fights. The old code rendered this into a Telegram message; the fix refuses it.
  const path = require("path");
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sharp-review-"));
  const evalPath = path.join(dir, "eval.json");

  const evalDoc = { bouts: [{
    boutId: "UFC-2026-07-18-B01",
    fight: "Jacobe Smith vs Kevin Holland",              // what the EVAL believes B01 is
    reviewItems: [{ why: "high-impact injury rumor", topic: "injury_health",
      about: "Kevin Holland", example: "Kevin Holland has withdrawn due to injury." }],
  }] };
  fs.writeFileSync(evalPath, JSON.stringify(evalDoc));

  const fcMismatch = { card: { eventId: "UFC-2026-07-18" }, forecasts: [
    { boutId: "UFC-2026-07-18-B01", fight: "Kamaru Usman vs Dricus Du Plessis", appliedAdjustments: [] }] };
  const fcAgree = { card: { eventId: "UFC-2026-07-18" }, forecasts: [
    { boutId: "UFC-2026-07-18-B01", fight: "Jacobe Smith vs Kevin Holland", appliedAdjustments: [] }] };
  const fcMissing = { card: { eventId: "UFC-2026-07-18" }, forecasts: [] };

  // humanReviewAlerts is module-private, so exercise it the way the runner does. Normalize CRLF first
  // — git may check the file out with \r\n, and the "\n}\n" boundary below would never match, slicing
  // the function to garbage.
  const run = (fc) => {
    const src = fs.readFileSync(path.join(__dirname, "..", "run-entertainment-alerts.js"), "utf8").replace(/\r/g, "");
    const body = src.slice(src.indexOf("function humanReviewAlerts"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);
    const crypto = require("crypto");
    const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);
    const lines = [];
    const say = (s) => lines.push(s);
    const TM = { humanReview: (a) => `HUMAN REVIEW ${a.fight} :: ${a.about}` };
    // eslint-disable-next-line no-new-func
    const make = new Function("fs", "TM", "sha", "say", `${fn}; return humanReviewAlerts;`);
    return { out: make(fs, TM, sha, say)(evalPath, fc), lines };
  };

  try {
    const bad = run(fcMismatch);
    ok("a boutId bound to two different fights produces NO alert", bad.out.length === 0, JSON.stringify(bad.out.map((o) => o.text)));
    ok("...and the refusal is printed, not silent", bad.lines.some((l) => /REFUSED/.test(l)));
    ok("...and it names both fights so the mis-bind is diagnosable",
      bad.lines.some((l) => /Kevin Holland/.test(l) && /Usman/.test(l)));

    const missing = run(fcMissing);
    ok("a bout with no forecast produces NO alert", missing.out.length === 0);
    ok("...and says so", missing.lines.some((l) => /no forecast/.test(l)));

    const good = run(fcAgree);
    ok("a bout whose halves AGREE still alerts normally", good.out.length === 1, JSON.stringify(good.lines));
    ok("...using the agreed fight name", good.out.length === 1 && /Jacobe Smith vs Kevin Holland/.test(good.out[0].text));
    ok("...and carries a claimHash for the ledger", good.out.length === 1 && /^[0-9a-f]{16}$/.test(good.out[0].meta.claimHash));
    ok("...and no refusal was printed", !good.lines.some((l) => /REFUSED/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
