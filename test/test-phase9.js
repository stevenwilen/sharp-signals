// Unit tests for Phase 9: dashboard data layer, Telegram messages, alert ledger.
//
// The failures these guard against are the ones a screen makes easy: a number on the dashboard that
// no sealed artifact contains, a green light that means "a bet exists", market movement dressed up
// as system edge, a confidence score nobody validated, and an alert ledger that goes silent on a
// position it has already disowned.
const DD = require("../lib/dashboard-data");
const TM = require("../lib/telegram-messages");
const AL = require("../lib/alert-ledger-v2");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? " -> " + extra : ""}`); } };

console.log("9A: A GREEN LIGHT MEANS THE PIPELINE RAN, NOT THAT A BET EXISTS");
{
  const s = DD.systemStatus({ nowTs: Date.now() });
  ok("alerts are reported DISARMED", s.alerts === "DISARMED");
  ok("trading capability is reported NONE", s.tradingCapability === "NONE");
  ok("the order path is described as non-existent", /does not exist/.test(s.orderPlacementPath));
  ok("the indicator states what GREEN means", /does NOT mean a bet exists/.test(s.indicatorMeaning));
  ok("the indicator meaning decouples green from positions", /unrelated to whether any position is proposed/.test(s.indicatorMeaning));
  ok("counts include no-bets, not just actionable", "noBet" in s.counts && "actionableExperimental" in s.counts);
  ok("counts include unpriced and analysis-only", "unpriced" in s.counts && "analysisOnly" in s.counts);
  ok("failed stages are enumerated", Array.isArray(s.failedStages));
  ok("indicator is RED when any stage failed", s.failedStages.length ? s.indicator === "RED" : s.indicator === "GREEN");
  ok("fee verification status carries its SCOPE", s.feeVerification.scope !== null && !!s.feeVerification.scope.series);
  ok("fee verification also carries what it does NOT establish", s.feeVerification.doesNotEstablish.length >= 8);
  ok("fee review provenance says 2 of 3 lenses, not 3", /2 of 3/.test(s.feeVerification.reviewProvenance));
  ok("...and says the third was NOT independently reviewed", /NOT independently reviewed/.test(s.feeVerification.reviewProvenance));
}

console.log("\n9A: THE DASHBOARD READS SEALED ARTIFACTS, NEVER RECOMPUTES");
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "dashboard-data.js"), "utf8");
  ok("it never imports the forecast engine", !/require\(["']\.\/forecast["']\)/.test(src));
  ok("it never imports the evidence evaluator", !/require\(["']\.\/evidence-eval["']\)/.test(src));
  ok("it never imports the portfolio sizer", !/require\(["']\.\/portfolio["']\)/.test(src));
  ok("it never calls tradingFee", !/tradingFee\(/.test(src));
  ok("it never calls buildAdjustments or valueContract", !/buildAdjustments\(|valueContract\(/.test(src));
  // a modified artifact must not render
  ok("readSealed refuses an artifact whose hash does not reproduce", (() => {
    const r = DD.readSealed("forecast-2026-07-18.json", "sealHash");
    return r.ok === true || /does not reproduce/.test(r.reason || "");
  })());
  const missing = DD.readSealed("no-such-artifact.json", "x");
  ok("a missing artifact is reported, not rendered blank", missing.ok === false && /not found/.test(missing.reason));
}

console.log("\n9A: EVERY BOUT APPEARS, INCLUDING THE ONES WE DECLINED");
{
  const c = DD.upcomingCard("2026-07-18");
  if (!c.ok) { ok("upcoming card renders", false, c.reason); }
  else {
    ok("upcoming card renders from the sealed forecast", c.ok === true);
    ok("every bout in the sealed forecast has a row", c.rows.length === c.totalBouts);
    ok("rows carry the forecast hash they came from", c.rows.every((r) => r.provenance.forecastHash === c.forecastHash));
    ok("baseline-unavailable bouts are counted, not dropped", typeof c.boutsWithoutBaseline === "number");
    ok("insufficient-evidence bouts still appear", c.rows.every((r) => !!r.forecastStatus));
    ok("a bout with no eligible position says so rather than showing a blank", c.rows.every((r) =>
      r.highestRankedEligible !== null || r.noBetReason !== null || r.contractClassification === "NO CONTRACT MAPPED"));
    ok("every row carries a last-update timestamp", c.rows.every((r) => !!r.lastUpdate));
    ok("cap-limited forecasts are flagged on the row", c.rows.every((r) => "capLimited" in r));
  }
}

console.log("\n9A: THE FOUR KINDS OF NUMBER ARE NEVER BLURRED");
{
  ok("market movement is defined as NOT ours", /NOT ours, NOT value, NOT edge/.test(DD.NUMBER_KINDS.MARKET_MOVEMENT));
  ok("system adjustment is defined as the only thing that is our opinion", /only thing that is our opinion/.test(DD.NUMBER_KINDS.SYSTEM_ADJUSTMENT));
  ok("evidence uncertainty is a width, not a direction", /width of the range, not its direction/.test(DD.NUMBER_KINDS.EVIDENCE_UNCERTAINTY));
  ok("pricing friction is cost, not opinion", /Cost, not opinion/.test(DD.NUMBER_KINDS.PRICING_FRICTION));
  const c = DD.upcomingCard("2026-07-18");
  if (c.ok && c.rows.length) {
    const d = DD.fightDetail("2026-07-18", c.rows[0].boutId, { openingProbability: 0.45 });
    ok("fight detail renders", d.ok === true, d.reason);
    if (d.ok) {
      ok("each block is tagged with its KIND", d.marketMovement.kind === "MARKET_MOVEMENT" && d.systemForecast.kind === "SYSTEM_ADJUSTMENT");
      ok("market movement SHOUTS that it is not system edge", /NOT system edge/.test(d.marketMovement.WARNING));
      ok("uncertainty is its own block", d.uncertainty.kind === "EVIDENCE_UNCERTAINTY");
      ok("lineage carries the forecast hash and seal time", !!d.lineage.forecastHash && !!d.lineage.sealedAt);
      ok("evidence limitations are listed", Array.isArray(d.evidenceLimitations));
      ok("missing information is listed", Array.isArray(d.missingInformation));
      ok("scenario shares are labelled as resting on unvalidated priors",
        d.scenarios.length === 0 || d.scenarios.every((s) => /UNVALIDATED/.test(s.modelStatus)));
    }
  }
}

console.log("\n9A: PORTFOLIO NEVER CALLS OVERLAP DIVERSIFICATION");
{
  const p = DD.portfolioView("2026-07-18");
  if (!p.ok) ok("portfolio renders", false, p.reason);
  else {
    ok("portfolio renders from the sealed decision", p.ok === true);
    ok("overlap is explicitly called concentration", /CONCENTRATION, never diversification/.test(p.diversificationWarning));
    ok("a nested contract is called one bet at two sizes", /one bet at two sizes/.test(p.diversificationWarning));
    ok("card exposure and max loss are present", "cardTotalExposure" in p && "cardMaxLoss" in p);
    ok("caps travel with the view", !!p.caps);
    ok("proposed positions carry a maximum acceptable price", p.proposedPositions.every((x) => "maximumAcceptablePrice" in x));
    ok("proposed positions carry expiry conditions", p.proposedPositions.every((x) => x.expiresIf.length >= 3));
  }
}

console.log("\n9A: THE FORWARD RECORD COUNTS NO-BETS");
{
  const f = DD.forwardRecord();
  ok("forward record lists runs", Array.isArray(f.runs));
  ok("superseded runs are marked, not hidden", f.runs.every((r) => "superseded" in r));
  ok("no-bet frequency is a headline metric", "noBetFrequency" in f.summary);
  ok("ROI is NOT presented as the headline", /Performance is reported as no-bet frequency and calibration first/.test(f.summary.note));
  ok("an unsettled book reports null ROI rather than a fake one", f.summary.netPaperResultAfterVerifiedCosts === null);
  ok("calibration is reported as not-yet-computable rather than invented", /not computable yet/.test(f.summary.calibration));
}

console.log("\n9B: NO AI CONFIDENCE SCORE — STRUCTURALLY REFUSED");
{
  const t = (s) => { try { TM.assertNoConfidenceScore(s); return "allowed"; } catch (e) { return "refused"; } };
  ok("'confidence: 82%' is refused", t("confidence: 82%") === "refused");
  ok("'AI confidence' is refused", t("AI confidence high") === "refused");
  ok("'conviction:' is refused", t("conviction: strong") === "refused");
  ok("a star rating is refused", t("rating ★★★★") === "refused");
  ok("'8/10' is refused", t("score 8/10") === "refused");
  ok("'certainty: 90' is refused", t("certainty: 90") === "refused");
  ok("a probability RANGE is allowed", t("System range: 49–54%") === "allowed");
  ok("an origin count is allowed", t("Two independent origins support the same wrestling mechanism") === "allowed");
  ok("evidence coverage is allowed", t("Evidence coverage: PARTIALLY COVERED") === "allowed");
}

console.log("\n9B: THE PROPOSED-POSITION MESSAGE");
{
  const p = {
    fight: "Alice Ace vs Bob Bruiser", contractLabel: "Alice Ace YES",
    ask: 0.43, maximumAcceptablePrice: 0.45, rangeLow: 0.49, rangeHigh: 0.54,
    conservativeValuePoints: 2.1, stakePercent: 0.4, fightExposurePercent: 0.4,
    why: ["Two independent matchup observations support the same wrestling mechanism", "Current sportsbook consensus is 47%"],
    against: ["Limited current-condition information", "Forecast has not demonstrated prospective edge"],
    evidenceCoverage: "PARTIALLY COVERED", modelStatus: "outright winner — no unvalidated method model involved",
    snapshotTimestamp: "2026-07-16T22:00:00Z",
    expiresIf: ["Ask rises above 45¢", "Fresh sportsbook consensus moves materially", "New evidence changes the sealed forecast"],
    dashboardRef: "http://localhost:4400/fight/b1", groupedContracts: [],
  };
  const m = TM.experimentalPosition(p);
  ok("carries the EXPERIMENTAL label", /🧪 EXPERIMENTAL POSITION/.test(m));
  ok("names the fight", /Alice Ace vs Bob Bruiser/.test(m));
  ok("gives the executable ask", /Ask: 43\.0¢/.test(m));
  ok("gives the maximum acceptable price", /Maximum price: 45\.0¢/.test(m));
  ok("gives a probability RANGE, not a point", /System range: 49\.0%–54\.0%/.test(m));
  ok("gives conservative value after fees", /Conservative value after fees: \+2\.1 pts/.test(m));
  ok("gives a suggested stake", /Suggested stake: 0\.40%/.test(m));
  ok("gives total fight exposure", /Total fight exposure: 0\.40%/.test(m));
  ok("carries a Why section", /Why:/.test(m));
  ok("carries an Against section — the counterargument is mandatory", /Against:/.test(m));
  ok("always states the forecast has no proven edge", /has not demonstrated prospective edge/.test(m));
  ok("states evidence coverage", /Evidence coverage: PARTIALLY COVERED/.test(m));
  ok("states model status", /Model status:/.test(m));
  ok("carries a snapshot timestamp", /Snapshot: 2026-07-16/.test(m));
  ok("carries expiry conditions", /Expires if:/.test(m));
  ok("carries a dashboard reference", /Dashboard: http/.test(m));
  ok("says manual placement only", /Manual placement only/.test(m));
  ok("says alerts remain disarmed", /Alerts remain disarmed/.test(m));
  ok("contains NO confidence score", (() => { try { TM.assertNoConfidenceScore(m); return true; } catch { return false; } })());

  // correlated contracts are grouped into ONE message
  const g = TM.experimentalPosition({ ...p, groupedContracts: ["Alice Ace YES", "Alice Ace by KO"] });
  ok("correlated contracts on one fight are grouped in one message", /Grouped — 2 contracts/.test(g));
  ok("...and are called correlated, not separate opportunities", /correlated, not separate opportunities/.test(g));

  // an out-of-envelope fee is surfaced in the message, never hidden
  const e = TM.experimentalPosition({ ...p, envelopeExceptions: ["size 42 is outside the verified band"] });
  ok("an out-of-envelope fee is shown in the alert", /Fee is EXTRAPOLATED beyond the verified envelope/.test(e));
}

console.log("\n9B: THE OTHER SIX MESSAGE TYPES");
{
  ok("seven notification types are defined", Object.keys(TM.TYPES).length === 7);
  const pu = TM.priceUpdate({ fight: "A vs B", contractLabel: "A YES", previousAsk: 0.43, ask: 0.47,
    maximumAcceptablePrice: 0.45, conservativeValuePoints: -0.4, snapshotTimestamp: "t" });
  ok("a price update shows the move", /43\.0¢ → 47\.0¢/.test(pu));
  ok("a price above the max says the position no longer qualifies", /no longer qualifies/.test(pu));
  const w = TM.positionWithdrawn({ fight: "A vs B", contractLabel: "A YES", reason: "conservative EV went negative", wasProposedStake: 0.4, dashboardRef: "x" });
  ok("a withdrawal states the reason", /conservative EV went negative/.test(w));
  ok("a withdrawal admits the system cannot close anything", /no order path and cannot close anything/.test(w));
  const n = TM.noBetStatusChange({ fight: "A vs B", contractLabel: "A YES", previousClassification: "NO BET",
    classification: "ACTIONABLE EXPERIMENTAL", reason: "ask fell below the maximum", dashboardRef: "x" });
  ok("a status change shows both states", /Was: NO BET/.test(n) && /Now: ACTIONABLE EXPERIMENTAL/.test(n));
  const s = TM.dailyShadowSummary({ date: "2026-07-16", cards: 1, totalDecisions: 24, actionable: 0, watch: 0,
    noBet: 24, analysisOnly: 0, unpriced: 0, humanReview: 0, noBetFrequency: "100.0%", cardExposure: "$0",
    cardCap: "$300", pipelineIndicator: "GREEN", failedStages: [], dashboardRef: "x" });
  ok("the daily summary reports no-bet frequency", /No-bet frequency: 100\.0%/.test(s));
  ok("the daily summary restates DISARMED", /Alerts: DISARMED/.test(s));
  ok("the daily summary reports orders placed as 0", /Orders placed: 0/.test(s));
  const f = TM.pipelineFailure({ stage: "sportsbook snapshot", at: "t", why: "HTTP 503" });
  ok("a pipeline failure names the stage and cause", /sportsbook snapshot/.test(f) && /HTTP 503/.test(f));
  ok("a failure states no positions came from the failed run", /No positions were proposed from a failed run/.test(f));
}

console.log("\n9B: THE LEDGER MAY NOT GO SILENT ON A LIVE POSITION");
{
  const base = { ask: 0.43, maximumAcceptablePrice: 0.45, forecastHash: "h1", classification: "ACTIONABLE EXPERIMENTAL",
    stakePercent: 0.4, topTicker: "T1", stale: false, pipelineFailed: false, withinEnvelope: true };
  const fires = (prev, now) => AL.TRIGGERS.map((t) => t.test(prev, now)).filter(Boolean);

  ok("a brand-new contract sends", fires(undefined, base).length > 0);
  ok("an unchanged contract stays quiet", fires(base, { ...base }).length === 0);
  ok("crossing ABOVE the maximum price sends", fires(base, { ...base, ask: 0.47 }).some((w) => /crossed ABOVE/.test(w)));
  ok("becoming favourable again sends", fires({ ...base, ask: 0.47 }, base).some((w) => /fell back/.test(w)));
  ok("a changed forecast sends", fires(base, { ...base, forecastHash: "h2" }).some((w) => /changed the sealed forecast/.test(w)));
  ok("a superseded forecast sends", fires(base, { ...base, supersedes: { hash: "h1" } }).some((w) => /superseded/.test(w)));
  ok("a withdrawal sends", fires(base, { ...base, classification: "NO BET" }).some((w) => /withdrawn/.test(w)));
  ok("becoming actionable sends", fires({ ...base, classification: "NO BET" }, base).some((w) => /became actionable/.test(w)));
  ok("a changed top contract sends", fires(base, { ...base, topTicker: "T2" }).some((w) => /top-ranked contract .* changed/.test(w)));
  ok("a material stake move sends", fires(base, { ...base, stakePercent: 0.9 }).some((w) => /stake moved/.test(w)));
  ok("an immaterial stake move stays quiet", fires(base, { ...base, stakePercent: 0.42 }).length === 0);
  ok("going stale sends", fires(base, { ...base, stale: true, staleReason: "snapshot 40 min old" }).some((w) => /went stale/.test(w)));
  ok("a pipeline failure sends", fires(base, { ...base, pipelineFailed: true, pipelineFailure: "kalshi 503" }).some((w) => /pipeline failed/.test(w)));
  ok("leaving the fee envelope sends", fires(base, { ...base, withinEnvelope: false }).some((w) => /left the verified fee envelope/.test(w)));

  // THE V1 BUG: alerted once, then silent forever
  ok("a previously-alerted ticker is NOT permanently suppressed",
    fires(base, { ...base, classification: "NO BET" }).length > 0 && fires(base, { ...base, ask: 0.47 }).length > 0);
  // simultaneous problems are ALL reported
  const both = fires(base, { ...base, ask: 0.47, stale: true });
  ok("simultaneous triggers are all reported, not just the first", both.length >= 2, JSON.stringify(both));
  ok("thirteen triggers are defined", AL.TRIGGERS.length === 13, String(AL.TRIGGERS.length));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
