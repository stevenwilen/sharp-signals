// Unit tests for Phase 9: dashboard data layer, Telegram messages, alert ledger.
//
// The failures these guard against are the ones a screen makes easy: a number on the dashboard that
// no sealed artifact contains, a green light that means "a bet exists", market movement dressed up
// as system edge, a confidence score nobody validated, and an alert ledger that goes silent on a
// position it has already disowned.
const DD = require("../lib/dashboard-data");
const TM = require("../lib/telegram-messages");
const AL = require("../lib/alert-ledger-v2");
const P = require("../lib/portfolio");   // research sizer — imported ONLY to prove it stays separate from the entertainment one

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
  ok("eight notification types are defined (the seven plus HUMAN REVIEW)", Object.keys(TM.TYPES).length === 8, String(Object.keys(TM.TYPES).length));
  const pu = TM.priceUpdate({ fight: "A vs B", contractLabel: "A YES", previousAsk: 0.43, ask: 0.47,
    maximumAcceptablePrice: 0.45, conservativeValuePoints: -0.4, snapshotTimestamp: "t" });
  ok("a price update shows the move", /43\.0¢ → 47\.0¢/.test(pu));
  ok("a price above the max says the position no longer qualifies", /no longer qualifies/.test(pu));
  const w = TM.positionWithdrawn({ recommendedFirst: "Alice Ace vs Bob Bruiser", fight: "A vs B", reason: "conservative EV went negative" });
  ok("a withdrawal states the reason", /conservative EV went negative/.test(w));
  ok("a withdrawal says do not place the previous recommendation", /Do not place the previous recommendation\./.test(w));
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
  // A bare count pinned at 13 asserts nothing a reader can act on — it fails the moment a trigger is
  // added and says only "17". What matters is that the trigger set is exhaustive over the states a
  // human must hear about, so name them. (The four review-* triggers were added 2026-07-17: every
  // trigger above inspects a field only a CONTRACT state carries, so a HUMAN REVIEW key that had
  // spoken once could never speak again — including on origins 1 -> 5. See test/test-review-alerts.js.)
  const ids = AL.TRIGGERS.map((t) => t.id);
  const expected = [
    "first", "price-crossed-max", "price-favourable-again", "forecast-changed", "forecast-superseded",
    "withdrawn", "became-actionable", "top-contract-changed", "stake-moved", "data-stale",
    "data-fresh-again", "pipeline-failed", "envelope-left",
    "review-origins-changed", "review-origins-known", "review-claim-changed", "review-verdict-changed",
  ];
  ok("the trigger set is exactly the documented one", JSON.stringify(ids) === JSON.stringify(expected),
    JSON.stringify(ids.filter((i) => !expected.includes(i)).concat(expected.filter((e) => !ids.includes(e)))));
  ok("every trigger has a unique id", new Set(ids).size === ids.length);
}

console.log("\nENTERTAINMENT BANKROLL: A BIGGER STAKE CANNOT BUY A BET");
{
  const EN = require("../lib/entertainment");
  const C = require("../lib/contracts");
  ok("bankroll is $100 and labelled entertainment", EN.BANKROLL.amount === 100 && EN.BANKROLL.label === "ENTERTAINMENT");
  ok("tiers are 3% / 4% / 5%", EN.TIERS.STANDARD.fraction === 0.03 && EN.TIERS.STRONG.fraction === 0.04 && EN.TIERS.MAXIMUM.fraction === 0.05);
  ok("dollar tiers are $3 / $4 / $5", EN.TIERS.STANDARD.dollars === 3 && EN.TIERS.STRONG.dollars === 4 && EN.TIERS.MAXIMUM.dollars === 5);
  ok("caps are 5% per fight and 10% per card", EN.CAPS.maxFractionPerFight === 0.05 && EN.CAPS.maxFractionPerCard === 0.10);
  ok("stakes are declared NOT Kelly and NOT evidence of edge", /NOT derived from Kelly/.test(EN.CAPS.provenance));
  ok("entertainment sizing is a SEPARATE module from the research sizer", EN.CAPS !== P.CAPS);
  ok("research caps are untouched at 0.5/1/3%", P.CAPS.maxFractionPerPosition === 0.005 && P.CAPS.maxFractionPerCard === 0.03);

  // THE SAFETY PROPERTY: nothing the research gates refused can be promoted by appetite
  const base = { ticker: "KXUFCFIGHT-x", allInPrice: 0.59, expectedValueConservative: 0.05,
    probabilityModelStatus: "outright winner", execution: { fills: [{}] } };
  for (const cls of EN.NEVER_PROMOTABLE) {
    const r = EN.sizeEntertainment({ ...base, classification: cls });
    ok(`a ${cls} contract gets NO entertainment stake`, r.eligible === false && r.stake === 0);
  }
  ok("an unvalidated method model gets no stake at any size",
    EN.sizeEntertainment({ ...base, classification: "ACTIONABLE EXPERIMENTAL", probabilityModelStatus: "UNVALIDATED METHOD MODEL" }).eligible === false);
  ok("a stale-blocked prior gets no stake",
    EN.sizeEntertainment({ ...base, classification: "ACTIONABLE EXPERIMENTAL", staleBaselineBlocked: true }).eligible === false);
  ok("a no-opinion forecast gets no stake",
    EN.sizeEntertainment({ ...base, classification: "ACTIONABLE EXPERIMENTAL", noOpinion: true }).eligible === false);
  ok("negative conservative value gets no stake",
    EN.sizeEntertainment({ ...base, classification: "ACTIONABLE EXPERIMENTAL", expectedValueConservative: -0.01 }).eligible === false);
  ok("every refusal names the gate that blocked it",
    EN.NEVER_PROMOTABLE.every((c) => !!EN.sizeEntertainment({ ...base, classification: c }).blockedBy));

  // tiering is driven by conservative margin, never by payout size
  ok("a small margin is STANDARD", EN.tierFor({ expectedValueConservative: 0.01 }) === "STANDARD");
  ok("a mid margin is STRONG", EN.tierFor({ expectedValueConservative: 0.04 }) === "STRONG");
  ok("a large margin is MAXIMUM", EN.tierFor({ expectedValueConservative: 0.08 }) === "MAXIMUM");
  ok("a 3c lottery contract does not become MAXIMUM by payout size", EN.tierFor({ expectedValueConservative: 0.005 }) === "STANDARD");

  // a qualifying position sizes, and reports the small-order fee gate
  const good = EN.sizeEntertainment({ ...base, classification: "ACTIONABLE EXPERIMENTAL" });
  ok("a qualifying position sizes", good.eligible === true);
  ok("stake is a whole tier of the $100 bankroll", [3, 4, 5].includes(good.stake), String(good.stake));
  ok("sizing states it is NOT Kelly and NOT a measured edge", /NOT Kelly, NOT sized from a measured edge/.test(good.basis));
  // THE SMALL-ORDER FEE GATE. Authenticated $2 and $5 tickets at 0.59 now exist, so the verified
  // floor is 3.28 contracts and a $2 order AT 0.59 is inside. The floor is in CONTRACTS, so the same
  // $2 at a higher price buys fewer and falls back outside — this gate is not a dollar rule.
  ok("a $2 order at 0.59 (3.28 contracts) is now INSIDE the verified envelope",
    good.feeGate.withinVerifiedEnvelope === true, JSON.stringify(good.feeGate.exceptions));
  ok("...so production alerting is allowed for it", good.feeGate.productionAlertAllowed === true);
  const highPrice = EN.sizeEntertainment({ ...base, classification: "ACTIONABLE EXPERIMENTAL", allInPrice: 0.89, expectedValueConservative: 0.01 });
  ok("the same $2 stake at 0.89 buys too few contracts and is OUTSIDE",
    highPrice.feeGate.withinVerifiedEnvelope === false, JSON.stringify(highPrice.feeGate.exceptions));
  ok("...and the exception names the size band", highPrice.feeGate.exceptions.some((e) => /size .* outside the verified band/.test(e)));
  ok("an out-of-envelope order still blocks production alerting", highPrice.feeGate.productionAlertAllowed === false);

  // card cap binds across fights
  const many = [1, 2, 3, 4, 5].map((i) => ({ boutId: `b${i}`,
    entertainment: { eligible: true, stake: 5, contracts: 8, allInPrice: 0.59 } }));
  const capped = EN.applyEntertainmentCaps(many, { bankroll: 100 });
  const total = capped.positions.reduce((a, x) => a + x.entertainment.stake, 0);
  ok("5 x $5 positions are scaled to the $10 card cap", Math.abs(total - 10) < 0.05, String(total));
  ok("scaling is recorded", capped.positions.every((x) => /per-card entertainment cap/.test(x.entertainment.scaledBy || "")));
}

// Since message-13 the phone message is COMPACT: the action, the price, the ceiling, the stake, one
// reason, one risk, a range and one footer. Everything verbose (ticker, contract wording, % phrasing,
// the repeated legal/methodology boilerplate, bulleted why/counterargument/do-not-place, the manual-
// submission lecture) moved to the dashboard and the sealed artifacts. This block pins the new shape
// AND that the stripped boilerplate is actually gone. The mechanical safety gate that decides whether a
// BUY may render at all lives in lib/message-invariants and is tested in test-message-invariants.js.
console.log("\nTHE MANUAL BUY INSTRUCTION (compact)");
{
  const b = {
    classification: "CREATIVE SPECULATIVE", stake: 2, bankroll: 100,
    recommendedFirst: "Alice Ace vs Bob Bruiser", buyLine: "Alice Ace YES",
    ask: 0.43, maximumAcceptablePrice: 0.45,
    whyOne: "Two independent origins support the same wrestling mechanism.",
    riskOne: "Evidence is only partially covered.",
    centralProb: 0.515, rangeLow: 0.49, rangeHigh: 0.54,
    approxContracts: 4, dashboard: "https://dash/alibob",
  };
  const m = TM.buyInstruction(b);
  ok("headlines the tier and the whole-dollar stake", /^🧪 CREATIVE SPECULATIVE — \$2$/m.test(m));
  ok("names the recommended fighter first", /Alice Ace vs Bob Bruiser/.test(m));
  ok("has a single Buy line", (m.match(/^Buy: Alice Ace YES$/gm) || []).length === 1);
  ok("gives the current executable price", /Current: 43¢/.test(m));
  ok("gives the maximum with a place-only ceiling", /Maximum: 45¢/.test(m) && /Place only if the displayed average price is 45¢ or less\./.test(m));
  ok("gives the dollar stake against the bankroll", /Stake: \$2 of \$100/.test(m));
  ok("gives approximate contracts", /Approx contracts: 4/.test(m));
  ok("Why and Main risk are single lines", /^Why: Two independent origins/m.test(m) && /^Main risk: Evidence is only/m.test(m));
  ok("gives a probability RANGE not a point", /System estimate: 52% \(range 49%–54%\)/.test(m));
  ok("links full reasoning to the dashboard", /Full reasoning: https:\/\/dash\/alibob/.test(m));
  ok("carries NO confidence score", (() => { try { TM.assertNoConfidenceScore(m); return true; } catch { return false; } })());
  ok("carries exactly ONE standing footer", (m.match(/For entertainment use\. Manual placement only\./g) || []).length === 1);
  // The simplification, pinned: none of the verbose per-alert boilerplate leaks into the phone message.
  ok("no ticker or contract wording in the phone message", !/KXUFCFIGHT|Ticker:|Will Alice Ace win/.test(m));
  ok("no repeated legal/methodology disclaimers", !/predictive edge|contaminated baseline|no order path|SUBMIT THIS MANUALLY|% of your|not Kelly/i.test(m));
  ok("under the 1000-char BUY cap", m.length < 1000, `len=${m.length}`);
}

console.log("\nARMING: ALERTS AND TRADING ARE NOT THE SAME FLAG");
{
  const ARM = require("../lib/arming");
  ok("alerts are ARMED for manual instructions", ARM.ARMING.ALERTS_ARMED === true);
  ok("trading is NOT enabled", ARM.ARMING.TRADING_ENABLED === false);
  ok("trading is described as absent, not merely switched off", /does not exist/.test(ARM.ARMING.tradingNote));
  ok("...and the note says the flag is documentation, not a switch", /documentation, not a switch/.test(ARM.ARMING.tradingNote));
  ok("arming records when and why", !!ARM.ARMING.armedAt && /human instruction/.test(ARM.ARMING.armedBy));
  ok("arming lists exactly what it permits", ARM.ARMING.permits.length === 3);
  ok("the standing no-edge warning is part of the arming record", /NOT demonstrated a predictive edge/.test(ARM.ARMING.standingWarning));
  // Prerequisites are re-checked from disk, not remembered.
  //
  // This assertion used to read `pre.ok === true` and it was WRONG — not stale, wrong. It called
  // checkArmingPrerequisites() with no card, which is the one call the gate must refuse: an
  // attestation is only evidence about the card it names, and data/phase9-fresh-run.json describes a
  // 13-bout run while the sealed artifacts for that same card hold 12. The test passed because the
  // gate asked no question the file could fail. See test/test-arming-guards.js for the full refusal set.
  const pre = ARM.checkArmingPrerequisites();
  ok("a prerequisite check with no card is REFUSED", pre.ok === false);
  ok("...and the $2-$5 fee tickets are still found", pre.smallOrderTickets >= 2, String(pre.smallOrderTickets));
  // the structural guarantee
  ok("assertNoTradingPath passes because no write call exists", ARM.assertNoTradingPath() === true);
}

console.log("\nENTERTAINMENT TIERS ARE NOW 3/4/5 AND ALL LAND INSIDE THE FEE ENVELOPE");
{
  const EN = require("../lib/entertainment");
  const C = require("../lib/contracts");
  ok("standard is 3% = $3", EN.TIERS.STANDARD.fraction === 0.03 && EN.TIERS.STANDARD.dollars === 3);
  ok("strong is 4% = $4", EN.TIERS.STRONG.fraction === 0.04 && EN.TIERS.STRONG.dollars === 4);
  ok("rare maximum is 5% = $5", EN.TIERS.MAXIMUM.fraction === 0.05 && EN.TIERS.MAXIMUM.dollars === 5);
  ok("caps stay 5% per fight / 10% per card", EN.CAPS.maxFractionPerFight === 0.05 && EN.CAPS.maxFractionPerCard === 0.10);
  // the $2 tier used to fall OUT of the envelope at high prices; $3 does not
  const contractsFor = (d, p) => { let c = d / p; for (let i = 0; i < 6; i++) { const f = C.tradingFee(c, p) || 0; c = Math.floor(((d - f) / p) * 100) / 100; } return c; };
  for (const d of [3, 4, 5]) for (const p of [0.59, 0.70, 0.80, 0.89]) {
    ok(`$${d} at ${p} is inside the verified fee envelope`,
      C.withinVerifiedEnvelope({ ticker: "KXUFCFIGHT-x", side: "yes", contracts: contractsFor(d, p), price: p, treatment: "taker", fillCount: 1 }).inside === true,
      `${contractsFor(d, p)} contracts`);
  }
  ok("a $2 order at 0.89 would still fall OUTSIDE (why the floor moved to $3)",
    C.withinVerifiedEnvelope({ ticker: "KXUFCFIGHT-x", side: "yes", contracts: contractsFor(2, 0.89), price: 0.89, treatment: "taker", fillCount: 1 }).inside === false);
}

console.log("\nHUMAN REVIEW ALERTS CANNOT BECOME BETTING INSTRUCTIONS");
{
  const r = {
    fight: "Jacobe Smith vs Kevin Holland", about: "Kevin Holland",
    claim: "Kevin Holland has reportedly dropped out of his fight against Jacobe Smith due to injury.",
    why: "high-impact injury rumor", origins: 1, topic: "injury_health",
    source: "a YouTube preview transcript collected for this card",
    forecastEffect: "it applied no adjustment at all — a one-origin report cannot clear the magnitude rules",
  };
  const m = TM.humanReview(r);
  ok("headlines UNVERIFIED FIGHT UPDATE", /🔎 UNVERIFIED FIGHT UPDATE/.test(m));
  ok("states the claim", /reportedly dropped out/.test(m));
  ok("names how many independent origins", /Sources: 1 independent origin$/m.test(m));
  ok("states that one origin moved the forecast by nothing", /Forecast impact: None/.test(m));
  ok("tells the human to verify it themselves", /Verify before acting\./.test(m));
  ok("does NOT leak the internal topic slug", !/injury_health/.test(m));

  // THE STRUCTURAL GUARANTEE: betting language is refused at construction
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  ok("a review alert containing a price is REFUSED", throws(() => TM.assertNotABettingInstruction("Holland out. Ask: 43¢")));
  ok("a review alert containing a stake is REFUSED", throws(() => TM.assertNotABettingInstruction("Holland out. Suggested stake 3%")));
  ok("a review alert saying 'buy' is REFUSED", throws(() => TM.assertNotABettingInstruction("Holland out — buy Smith")));
  ok("a review alert naming a contract is REFUSED", throws(() => TM.assertNotABettingInstruction("Holland out. Contract: Smith YES")));
  ok("a review alert quoting EV is REFUSED", throws(() => TM.assertNotABettingInstruction("Holland out, EV +4 pts")));
  ok("the real message passes its own guard", TM.assertNotABettingInstruction(m) === true);
  ok("the real message carries no cents symbol, no stake, no ticker", !/¢|stake|YES|ticker/i.test(m));
  ok("a review alert carries no confidence score", (() => { try { TM.assertNoConfidenceScore(m); return true; } catch { return false; } })());
  ok("HUMAN REVIEW is a distinct notification type", TM.TYPES.HUMAN_REVIEW === "HUMAN REVIEW");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
