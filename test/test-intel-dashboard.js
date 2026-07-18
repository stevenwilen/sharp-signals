// FIGHT INTELLIGENCE DASHBOARD (§16). The dashboard READS the persisted intelligence records and
// partitions them by lifecycle stage. It must recompute NOTHING — the displayed status/action are
// whatever the pipeline sealed, even in a combination the classifier would never produce. That is the
// house rule: a dashboard that recalculates is a second implementation, and the screen must never win
// an argument with the sealed record.
const fs = require("fs"), path = require("path");
const DD = require("../lib/dashboard-data");
const I = require("../lib/intelligence");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

const rec = (o = {}) => ({
  intelligenceId: "intel_" + (o.id || "x"), proposition: "cond:knee", fighter: "Kevin Holland",
  fight: "Jacobe Smith vs Kevin Holland", claim: "Holland hurt his knee in camp", topic: "injury_health",
  reportType: I.REPORT_TYPE.CURRENT_CONDITION, mechanismStrength: "moderate",
  truthStatus: I.TRUTH_STATUS.PLAUSIBLE, actionStatus: I.ACTION_STATUS.WATCH,
  firstSeenAt: "2026-07-17T12:00:00Z", lastUpdatedAt: "2026-07-17T13:00:00Z",
  originalOrigin: "report:helwani", independentOrigins: 1, amplifierCount: 2, accessRelevance: I.ACCESS.FIRSTHAND,
  specificity: "specific", recency: "fresh", plausibility: "high",
  quotes: [{ quote: "his knee is hurt in camp per one report", channel: "MMAClips" }],
  contradictions: [], kalshiBefore: { ask: 0.54, ts: "t0" }, kalshiAfter: [{ ask: 0.60, ts: "t1" }],
  forecastImpact: null, positionVersions: [], telegramLineage: [], actionHistory: [{ at: "t0", status: "PLAUSIBLE", action: null, note: "first seen" }],
  ...o,
});

console.log("intelDisplay ECHOES THE PERSISTED RECORD — IT DOES NOT RECOMPUTE");
{
  // A deliberately inconsistent record the classifier would NEVER produce: DISPROVED but SPECULATIVE_BET.
  const d = DD.intelDisplay(rec({ truthStatus: I.TRUTH_STATUS.DISPROVED, actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }));
  ok("displays the PERSISTED status, not a recomputed one", d.status === "DISPROVED", d.status);
  ok("displays the PERSISTED action, not a recomputed one", d.action === "SPECULATIVE_BET", d.action);
  const full = DD.intelDisplay(rec());
  for (const f of ["report", "fighter", "fight", "firstSeen", "lastUpdated", "originalSource", "independentOrigins", "amplifiers", "accessRelevance", "quotes", "contradictions", "forecastImpact", "timeline", "telegramHistory"])
    ok(`display carries §16 field: ${f}`, f in full);
  ok("market movement is plain arithmetic over persisted before/after", full.marketMovementPoints === 6.0, full.marketMovementPoints);
}

console.log("\nfightIntelligenceView PARTITIONS PERSISTED RECORDS BY LIFECYCLE STAGE");
{
  const CARD = "TEST-INTEL-2000-01-01";
  const file = path.join(__dirname, "..", "data", `intelligence-${CARD}.json`);
  const records = {
    a: rec({ id: "a", actionStatus: I.ACTION_STATUS.SPECULATIVE_BET }),
    b: rec({ id: "b", actionStatus: I.ACTION_STATUS.WATCH }),
    c: rec({ id: "c", actionStatus: I.ACTION_STATUS.MARKET_ALREADY_MOVED }),
    d: rec({ id: "d", actionStatus: I.ACTION_STATUS.FORECAST_UPDATED }),
    e: rec({ id: "e", actionStatus: I.ACTION_STATUS.REPORT_CONFIRMED }),
    f: rec({ id: "f", actionStatus: I.ACTION_STATUS.REPORT_DISPROVED }),
    g: rec({ id: "g", actionStatus: I.ACTION_STATUS.IGNORE }),
    h: rec({ id: "h", actionStatus: I.ACTION_STATUS.DASHBOARD_ONLY, reportType: I.REPORT_TYPE.LOW_VALUE, mechanismStrength: "none" }),
  };
  try {
    fs.writeFileSync(file, JSON.stringify({ card: CARD, updatedAt: "2026-07-17T13:00:00Z", records }, null, 2));
    const v = DD.fightIntelligenceView(CARD);
    ok("present", v.present === true);
    ok("total counts all persisted records", v.total === 8, v.total);
    ok("SPECULATIVE_BET → bet proposed", v.groups.betProposed.length === 1);
    ok("WATCH → watching", v.groups.watching.length === 1);
    ok("MARKET_ALREADY_MOVED → market moved", v.groups.marketMoved.length === 1);
    ok("FORECAST_UPDATED → influenced forecast", v.groups.influencedForecast.length === 1);
    ok("REPORT_CONFIRMED → confirmed", v.groups.confirmed.length === 1);
    ok("REPORT_DISPROVED → disproved", v.groups.disproved.length === 1);
    ok("IGNORE and low-value dashboard-only → ignored", v.groups.ignored.length === 2, v.groups.ignored.length);
  } finally { try { fs.unlinkSync(file); } catch (_) {} }
}

console.log("\nA CARD WITH NO INTELLIGENCE STORE SAYS SO (never a plausible blank)");
{
  const v = DD.fightIntelligenceView("TEST-INTEL-NONEXISTENT-9999-99-99");
  ok("present is false", v.present === false);
  ok("carries a note, not fake data", /No fight intelligence/.test(v.note));
  ok("groups are all empty", Object.values(v.groups).every((g) => g.length === 0));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
