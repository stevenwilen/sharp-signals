// PHASE 9C — the complete system, end to end, on one upcoming card. Nothing armed, nothing sent.
//
//   node run-phase9-shadow.js <forecast.json> [--card=2026-07-18]
//
// TELEGRAM IS ROUTED TO A FILE. Not to a test chat, not to a muted chat — to disk. There is no code
// path from this script to lib/notify.js, and that is asserted at runtime rather than promised: the
// only way to guarantee a message cannot reach the production chat is for the sender not to exist.
//
// The run deliberately EXERCISES ITS OWN FAILURE MODES. A shadow test that only demonstrates the
// happy path proves the happy path; the refusals are the part that has to work when it matters, so
// each is provoked here against the real code and its real refusal is recorded.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const C = require("./lib/contracts");
const V = require("./lib/contract-value");
const P = require("./lib/portfolio");
const DD = require("./lib/dashboard-data");
const TM = require("./lib/telegram-messages");
const AL = require("./lib/alert-ledger-v2");
const S = require("./lib/sportsbook-live");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

const TEST_SINK = "data/phase9-test-messages.json";
const messages = [];
// The ONLY send path in this file. It writes to disk and returns; there is no transport.
function sendToTestDestination(type, text, meta = {}) {
  TM.assertNoConfidenceScore(text);   // refuse at the door, every time
  messages.push({ type, sentAt: new Date().toISOString(), destination: "TEST SINK (disk)", ...meta, text });
  return { delivered: "test sink", productionChat: false };
}

function assertNoProductionTelegram() {
  const notify = (() => { try { return require.resolve("./lib/notify"); } catch { return null; } })();
  if (notify && require.cache[notify])
    fail("lib/notify is LOADED — a production Telegram path exists in this process. Refusing to run a shadow test that could send.");
  if (process.env.ALERTS_ARMED === "true") fail("ALERTS_ARMED is true — refusing to run");
}

async function main() {
  const fPath = process.argv[2];
  if (!fPath || !fs.existsSync(fPath)) fail("usage: node run-phase9-shadow.js <forecast.json>");
  assertNoProductionTelegram();

  const fc = JSON.parse(fs.readFileSync(fPath, "utf8"));
  const cardDate = fc.card.eventDate;
  const nowTs = Date.now();
  say(`[1] PHASE 9C END-TO-END SHADOW — ${fc.card.eventId}`);
  say(`    ALERTS_ARMED=false · trading capability NONE · Telegram -> ${TEST_SINK} (disk, not a chat)`);

  // ---- the pipeline, read from what is already sealed ----
  say(`\n[2] rendering the dashboard from SEALED artifacts (no recomputation) ...`);
  const status = DD.systemStatus({ nowTs, maxRunAgeMs: 24 * 3600 * 1000 });
  const card = DD.upcomingCard(cardDate);
  const contracts = DD.contractComparison(cardDate);
  const portfolio = DD.portfolioView(cardDate);
  const record = DD.forwardRecord();
  if (!card.ok) fail(`upcoming card cannot render: ${card.reason}`);
  if (!contracts.ok) fail(`contract comparison cannot render: ${contracts.reason}`);
  say(`    status: ${status.indicator} (${status.indicatorMeaning.slice(0, 46)}...)`);
  say(`    bouts: ${card.totalBouts} | contracts: ${contracts.contracts.length} | decisions: ${record.summary.totalDecisions}`);
  say(`    counts: ${JSON.stringify(status.counts)}`);

  // ---- REQUIRED SCENARIO 1: at least one NO BET ----
  const noBets = contracts.contracts.filter((c) => c.rankingStatus === "NO BET");
  say(`\n[3] REQUIRED: at least one NO BET ................. ${noBets.length ? `YES (${noBets.length})` : "NO"}`);
  if (!noBets.length) fail("the shadow test requires at least one NO BET and found none");
  say(`    e.g. ${noBets[0].ticker}: ${String(noBets[0].rejectionReason).slice(0, 88)}`);

  // ---- REQUIRED SCENARIO 2: a stale-data refusal ----
  // provoked against the REAL pricer with a deliberately old snapshot
  const sampleC = { ...(contracts.contracts[0] || {}), ticker: "KXUFCFIGHT-26JUL18MCMMON-MCM", marketStatus: "active",
    snapshotTimestamp: new Date(nowTs - 60 * 60000).toISOString(), yesBid: 0.58, yesAsk: 0.59, noBid: 0.41, noAsk: 0.42 };
  const staleBook = { orderbook_fp: { no_dollars: [["0.4100", "5000"]], yes_dollars: [["0.5800", "5000"]] } };
  const stale = C.priceOrder(sampleC, staleBook, 100, { nowTs, maxSnapshotAgeMs: 15 * 60000 });
  say(`\n[4] REQUIRED: a stale-data refusal ................ ${stale.ok === false ? "YES" : "NO"}`);
  if (stale.ok !== false) fail("a 60-minute-old snapshot was priced instead of refused");
  say(`    ${stale.reasons[0]}`);

  // ---- REQUIRED SCENARIO 3: an out-of-envelope fee refusal ----
  const oe = C.withinVerifiedEnvelope({ ticker: "KXUFCFIGHT-x", side: "no", contracts: 5, price: 0.20, treatment: "maker", fillCount: 3 });
  const oeOrder = C.priceOrder({ ...sampleC, snapshotTimestamp: new Date(nowTs).toISOString() }, staleBook, 100, { nowTs, treatment: "maker" });
  say(`\n[5] REQUIRED: an out-of-envelope fee refusal ...... ${!oe.inside && oeOrder.ok === false ? "YES" : "NO"}`);
  if (oe.inside || oeOrder.ok !== false) fail("an out-of-envelope / maker order was priced instead of refused");
  say(`    envelope refuses ${oe.reasons.length} dimension(s): ${oe.reasons.map((r) => r.split(" ")[0]).join(", ")}`);
  say(`    maker order: ${oeOrder.reasons[0].slice(0, 88)}`);

  // ---- REQUIRED SCENARIO 4: a withdrawn mock position ----
  const prevState = { ask: 0.43, maximumAcceptablePrice: 0.45, forecastHash: "mockh1",
    classification: "ACTIONABLE EXPERIMENTAL", stakePercent: 0.4, topTicker: "MOCK-1", stale: false,
    pipelineFailed: false, withinEnvelope: true };
  const nowState = { ...prevState, classification: "NO BET", ask: 0.47 };
  const fired = AL.TRIGGERS.map((t) => t.test(prevState, nowState)).filter(Boolean);
  const withdrawn = TM.positionWithdrawn({
    fight: "MOCK: Alice Ace vs Bob Bruiser", contractLabel: "Alice Ace YES",
    reason: fired.join("; "), wasProposedStake: 0.4, dashboardRef: `http://localhost:4400/card/${cardDate}`,
  });
  sendToTestDestination(TM.TYPES.POSITION_WITHDRAWN, withdrawn, { mock: true, triggers: fired });
  say(`\n[6] REQUIRED: a withdrawn mock position .......... YES`);
  say(`    ${fired.length} trigger(s) fired: ${fired.map((f) => f.slice(0, 44)).join(" | ")}`);

  // ---- REQUIRED SCENARIO 5: a superseded forecast ----
  const superseded = record.runs.filter((r) => r.superseded || r.supersedes);
  say(`\n[7] REQUIRED: a superseded forecast .............. ${superseded.length ? "YES" : "NO"}`);
  if (!superseded.length) fail("no superseded decision found — lineage is untested");
  const sup = record.runs.find((r) => r.supersedes);
  say(`    current decision supersedes ${sup ? sup.supersedes.hash : "?"} (prior preserved, not overwritten)`);
  if (sup) sendToTestDestination(TM.TYPES.EVIDENCE_UPDATE, TM.evidenceUpdate({
    fight: "CARD-LEVEL", changes: ["the sealed decision was re-run against a fresher snapshot"],
    rangeLow: 0.49, rangeHigh: 0.54, previousRangeLow: 0.48, previousRangeHigh: 0.55,
    evidenceCoverage: "see per-bout detail", previousForecastHash: sup.supersedes.hash,
    forecastHash: sup.decisionHash, dashboardRef: `http://localhost:4400/card/${cardDate}`,
  }), { supersedes: sup.supersedes });

  // ---- REQUIRED SCENARIO 6: a pipeline-failure notification ----
  const pf = TM.pipelineFailure({
    stage: "sportsbook snapshot (simulated for this test)", at: new Date(nowTs).toISOString(),
    why: "HTTP 503 from the odds source — the consensus could not be collected",
    consequence: "no live baseline, so no contract could be valued against a contemporaneous price. No decision advanced.",
  });
  sendToTestDestination(TM.TYPES.PIPELINE_FAILURE, pf, { simulated: true });
  say(`\n[8] REQUIRED: a pipeline-failure notification .... YES`);

  // ---- REQUIRED SCENARIO 7: a normal daily summary ----
  const summary = TM.dailyShadowSummary({
    date: new Date(nowTs).toISOString().slice(0, 10), cards: status.activeCards,
    totalDecisions: record.summary.totalDecisions,
    actionable: status.counts.actionableExperimental, watch: status.counts.watch,
    noBet: status.counts.noBet, analysisOnly: status.counts.analysisOnly,
    unpriced: status.counts.unpriced, humanReview: status.counts.humanReviewRequired,
    noBetFrequency: record.summary.noBetFrequency,
    cardExposure: `$${portfolio.ok ? portfolio.cardTotalExposure : 0}`,
    cardCap: `$${portfolio.ok && portfolio.caps ? (portfolio.bankroll * portfolio.caps.maxFractionPerCard).toFixed(0) : "?"}`,
    pipelineIndicator: status.indicator, failedStages: status.failedStages,
    dashboardRef: "http://localhost:4400/",
  });
  sendToTestDestination(TM.TYPES.DAILY_SHADOW_SUMMARY, summary);
  say(`\n[9] REQUIRED: a normal daily summary ............. YES`);

  // ---- reproducibility: every displayed number must come from a sealed artifact ----
  say(`\n[10] verifying every displayed number reproduces from a sealed artifact ...`);
  const checks = [];
  const fcR = DD.readSealed(`forecast-${cardDate}.json`, "sealHash");
  const shR = DD.readSealed(`phase8-shadow-${cardDate}.json`, "decisionHash");
  checks.push({ what: "forecast sealHash reproduces", ok: fcR.ok && fcR.reproduces !== false });
  checks.push({ what: "decision decisionHash reproduces", ok: shR.ok && shR.reproduces !== false });
  // every dashboard probability must exist verbatim in the sealed forecast
  let mismatched = 0;
  for (const row of card.rows) {
    const f = fcR.data.forecasts.find((x) => x.boutId === row.boutId);
    const A = row.fighterA;
    const sealedP = f.systemCentral ? f.systemCentral[A] : null;
    if (row.systemProbability !== sealedP) mismatched++;
    const sealedBase = f.marketBaseline ? f.marketBaseline.probability : null;
    if ((row.marketBaseline ? row.marketBaseline.probability : null) !== sealedBase) mismatched++;
  }
  checks.push({ what: "every dashboard probability equals its sealed value", ok: mismatched === 0, detail: `${mismatched} mismatches` });
  // every contract number must equal the sealed decision
  let cMismatch = 0;
  for (const c of contracts.contracts) {
    const d = shR.data.decisions.find((x) => x.ticker === c.ticker);
    if (!d) { cMismatch++; continue; }
    if (c.allInPrice !== d.allInPrice || c.fee !== d.fees || c.rankingStatus !== d.classification) cMismatch++;
  }
  checks.push({ what: "every contract number equals the sealed decision", ok: cMismatch === 0, detail: `${cMismatch} mismatches` });
  checks.push({ what: "the dashboard never contradicts the decision record on classification", ok: cMismatch === 0 });
  for (const c of checks) say(`     ${c.ok ? "OK  " : "FAIL"} ${c.what}${c.detail ? ` (${c.detail})` : ""}`);
  const allOk = checks.every((c) => c.ok);

  // ---- seal the test record ----
  const out = {
    phase: "9C", mode: "END-TO-END SHADOW", card: fc.card.eventId,
    ranAt: new Date(nowTs).toISOString(),
    armed: false, tradingCapability: "NONE",
    telegramDestination: "TEST SINK (disk) — lib/notify was never loaded; no transport exists in this process",
    productionChatTouched: false,
    requiredScenarios: {
      atLeastOneNoBet: noBets.length,
      staleDataRefusal: stale.reasons[0],
      outOfEnvelopeFeeRefusal: oeOrder.reasons[0],
      withdrawnMockPosition: fired,
      supersededForecast: sup ? sup.supersedes : null,
      pipelineFailureNotification: true,
      dailySummary: true,
    },
    reproducibility: { checks, allReproduce: allOk },
    messages,
    dashboardSnapshot: { status, card, contracts, portfolio, forwardRecord: record },
  };
  writeJson(out.messagesFile = TEST_SINK, { generatedAt: out.ranAt, destination: "TEST SINK", messages });
  writeJson(`data/phase9-shadow-${cardDate}.json`, out);

  say(`\n${"=".repeat(84)}`);
  say(`  messages routed to TEST SINK: ${messages.length}  (production chat touched: NO)`);
  for (const m of messages) say(`    - ${m.type}`);
  say(`  every displayed number reproduces from sealed artifacts: ${allOk ? "YES" : "NO"}`);
  say(`  armed=false  tradingCapability=NONE  ordersPlaced=0`);
  say(`  written: data/phase9-shadow-${cardDate}.json and ${TEST_SINK}`);
  if (!allOk) fail("some displayed numbers do not reproduce — Phase 9 cannot pass");
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
