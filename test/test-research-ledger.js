// RESEARCH LEDGER — deterministic unit tests. Refusal-first: most cases assert that an ineligible signal
// is REFUSED (OBSERVED_NO_ENTRY) rather than funded, and that the contract math, consolidation, mode gate
// and settlement behave exactly as specified. Runs against the REAL config/research-profile-v1.json in an
// isolated temp DATA_DIR so it never touches production ledgers.
const os = require("os");
const fs = require("fs");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ss-research-ledger-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;

const RL = require("../lib/research-ledger");
const C = require("../lib/contracts");
const profile = RL.loadProfile("research-profile-v1");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; process.stdout.write(`  PASS  ${msg}\n`); } else { fail++; process.stdout.write(`  FAIL  ${msg}\n`); } };
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;
function reset() { try { fs.unlinkSync(RL.FILE); } catch {} }

const NOW = "2026-07-20T12:00:00Z";
function obs(over = {}) {
  return {
    signalId: "s1", event: "UFC-E", eventDate: "2999-01-01", market: "T1", ticker: "T1", side: "YES",
    fighter: "Fighter A", opponent: "Fighter B", fight: "Fighter A vs Fighter B", category: "CORE_BUY",
    estProbability: 0.70, observedAsk: 0.60, marketPriceStatus: "CURRENT", marketPriceTimestamp: NOW, askSource: "SEALED_ALERT",
    signalTimestamp: NOW, forecastHash: "h1", sealedForecastVersion: "v1", postBell: false,
    fightStartTimestamp: "2999-01-01T22:00:00Z", cutoffSource: "PRODUCTION_CARD_CUTOFF",
    coreFraction: 0.05, recommendationId: "UFC-E-B1|T1", qualifiedReason: "test",
    ...over,
  };
}
function runOne(rawObs, mode = RL.MODES.PAPER) {
  reset();
  const state = RL.load();
  const r = RL.processObservations(state, rawObs, { profile, mode, now: NOW });
  return { state, r, summary: RL.summary(state) };
}

// 1. Contract math: exposure = actual total simulated cost, NOT the target allocation. -----------
{
  const { state } = runOne([obs({ observedAsk: 0.38, category: "STRONG_SPECULATION", coreFraction: null })]);
  const p = Object.values(state.positions)[0];
  ok(!!p, "1a. an eligible signal funds a position (PAPER)");
  ok(p && p.effectiveEntryPrice === 0.39, "1b. effectiveEntryPrice = ask + slippage (0.38 + 0.01 = 0.39)");
  ok(p && p.contracts === Math.floor(p.targetAllocationDollars / p.allInCostPerContract), "1c. contracts = floor(target / allInPerContract)");
  ok(p && near(p.totalCost, p.principalCost + p.simulatedFees), "1d. totalCost = principalCost + simulatedFees");
  ok(p && p.simulatedFees === C.tradingFee(p.contracts, p.effectiveEntryPrice), "1e. simulatedFees = production tradingFee (single ceil)");
  ok(p && p.maximumPayout === p.contracts && near(p.maximumProfit, p.contracts - p.totalCost), "1f. maxPayout = contracts, maxProfit = payout - totalCost");
  ok(p && p.stake !== p.targetAllocationDollars && near(RL.summary(state).openExposure, p.totalCost), "1g. stored exposure = totalCost, not the unused target allocation");
}

// 2. Sizing refuses when the allocation buys fewer than one contract. ----------------------------
{
  const sized = RL.sizePosition(profile, { ticker: "T1", side: "YES", observedAsk: 0.60, allowedDollars: 0.10 });
  ok(sized.reject && /fewer than 1 contract/.test(sized.reason), "2. allocation < 1 contract is REFUSED");
}

// 3-8. Gate refusals (no position created). ------------------------------------------------------
{
  const t = (over, why, label) => {
    const { state } = runOne([obs(over)]);
    const funded = Object.keys(state.positions).length;
    ok(funded === 0, label);
  };
  t({ estProbability: 0.05 }, "prob", "3. probability below floor is REFUSED (OBSERVED_NO_ENTRY)");
  t({ observedAsk: 0.97 }, "maxprice", "4. price above research max is REFUSED");
  t({ postBell: true }, "postbell", "5. after fight-start cutoff is REFUSED");
  t({ postBell: undefined }, "nopostbell", "5b. a MISSING postBell fails CLOSED (refused, not skipped)");
  t({ fightStartTimestamp: "garbage" }, "badbell", "5c. an unparseable fight-start time is REFUSED");
  t({ marketPriceTimestamp: "2026-07-20T11:00:00Z" }, "stale", "6. a stale ask (>minFreshnessMinutes old) is REFUSED");
  t({ marketPriceTimestamp: null, marketPriceStatus: null }, "nofresh", "6b. a MISSING freshness timestamp fails CLOSED (refused, not skipped)");
  t({ side: null, sideReason: "unmapped" }, "side", "7. unmapped side is REFUSED");
  t({ estProbability: 0.40, observedAsk: 0.55, category: "STRONG_SPECULATION", coreFraction: null }, "edge", "8. negative post-haircut edge is REFUSED");
}

// 9-10. PRICE_TOO_HIGH -> UNCONFIRMED_CANDIDATE research threshold. -------------------------------
{
  const base = { category: "UNCONFIRMED_CANDIDATE", coreFraction: null, estProbability: 0.60 };
  const inTol = runOne([obs({ ...base, observedAsk: 0.40, productionMaximumAcceptablePrice: 0.38 })]);
  ok(Object.keys(inTol.state.positions).length === 1, "9a. PRICE_TOO_HIGH within research tolerance (ask 0.40 <= prodMax+3c) funds");
  const overTol = runOne([obs({ ...base, observedAsk: 0.45, productionMaximumAcceptablePrice: 0.38 })]);
  ok(Object.keys(overTol.state.positions).length === 0, "9b. PRICE_TOO_HIGH above research tolerance (ask 0.45 > 0.41) is REFUSED");
  const noMax = runOne([obs({ ...base, observedAsk: 0.40, productionMaximumAcceptablePrice: null })]);
  ok(Object.keys(noMax.state.positions).length === 0, "10. UNCONFIRMED_CANDIDATE without a production max is REFUSED");
}

// 11. Direction -> Kalshi side truth table, fail-closed. -----------------------------------------
{
  const m = (about, direction) => RL.mapDirectionToSide({ about, direction, contractYesFighter: "Jon Jones", contractNoFighter: "Stipe Miocic" }).side;
  ok(m("Jon Jones", "favors_about") === "YES", "11a. subject is YES fighter, favours -> YES");
  ok(m("Jon Jones", "against_about") === "NO", "11b. subject is YES fighter, against -> NO");
  ok(m("Stipe Miocic", "favors_about") === "NO", "11c. subject is NO fighter, favours -> NO");
  ok(m("Stipe Miocic", "against_about") === "YES", "11d. subject is NO fighter, against -> YES");
  ok(m("Jon Jones", "neutral") === null, "11e. neutral -> no side");
  ok(m("Conor McGregor", "favors_about") === null, "11f. subject matching neither fighter -> fail closed (no side)");
}

// 12. Fee basis VERIFIED inside the envelope; pessimistic == reported. ----------------------------
{
  const { state } = runOne([obs({ ticker: "KXUFCFIGHT-26JUL25AB-A", observedAsk: 0.70, estProbability: 0.95, coreFraction: 0.05 })]);
  const p = Object.values(state.positions)[0];
  ok(p && p.feeBasis === RL.FEE_BASIS.VERIFIED, "12a. in-envelope YES taker fill is VERIFIED");
  ok(p && p.pessimisticFee === p.simulatedFees, "12b. VERIFIED fee: pessimistic == reported");
}

// 13. Fee basis ESTIMATED_OUT_OF_SCOPE at a low price; pessimistic is higher. ---------------------
{
  const { state } = runOne([obs({ observedAsk: 0.30, estProbability: 0.70, category: "STRONG_SPECULATION", coreFraction: null })]);
  const p = Object.values(state.positions)[0];
  ok(p && p.feeBasis === RL.FEE_BASIS.ESTIMATED, "13a. price below the verified band is ESTIMATED_OUT_OF_SCOPE");
  ok(p && Array.isArray(p.feeEnvelopeReasons) && p.feeEnvelopeReasons.length > 0, "13b. envelope-failure reasons are stored");
  ok(p && p.pessimisticTotalCost > p.totalCost && p.estimationReason, "13c. a pessimistic-fee sensitivity cost is computed and higher");
}

// 14. OBSERVE builds observations but funds NOTHING and changes NO balance. -----------------------
{
  const { state, r, summary } = runOne([obs({ category: "STRONG_SPECULATION", coreFraction: null, observedAsk: 0.40 })], RL.MODES.OBSERVE);
  ok(Object.keys(state.positions).length === 0, "14a. OBSERVE creates no funded positions");
  ok(summary.openExposure === 0 && summary.accountValue === 10000, "14b. OBSERVE changes no balance (exposure 0, account 10000)");
  ok(state.prospectiveStartAt === null, "14c. OBSERVE does NOT stamp the official prospective start");
  ok(r.counts.proposed >= 1, "14d. OBSERVE still reports what WOULD fund (proposed >= 1)");
}

// 15. Activation semantics: PAPER activates the official window (even with 0 positions), separate from the
//     first fill; OBSERVE never activates; the timestamps are never rewritten or erased. ----------------
{
  // (a) PAPER stamps the experiment start even with ZERO eligible positions; firstFunded stays separate.
  reset();
  const zeroCard = RL.load();
  RL.processObservations(zeroCard, [obs({ estProbability: 0.05 })], { profile, mode: RL.MODES.PAPER, now: NOW }); // ineligible -> 0 funded
  ok(Object.keys(zeroCard.positions).length === 0 && zeroCard.paperModeActivatedAt === NOW && zeroCard.prospectiveStartAt === NOW, "15a. PAPER activates the official start even with ZERO funded positions");
  ok(zeroCard.firstFundedPositionAt === null, "15b. firstFundedPositionAt stays null until a position actually funds");

  // (c) OBSERVE never activates; switching OBSERVE -> PAPER creates the timestamp; (e) first fill is separate.
  reset();
  const st = RL.load();
  RL.processObservations(st, [obs({ estProbability: 0.05 })], { profile, mode: RL.MODES.OBSERVE, now: "2026-07-19T00:00:00Z" });
  ok(st.paperModeActivatedAt == null, "15c-i. OBSERVE never activates the official window");
  RL.processObservations(st, [obs({ observedAsk: 0.40, category: "STRONG_SPECULATION", coreFraction: null })], { profile, mode: RL.MODES.PAPER, now: NOW });
  const activated = st.paperModeActivatedAt, funded1 = st.firstFundedPositionAt;
  ok(activated === NOW, "15c-ii. switching OBSERVE -> PAPER creates paperModeActivatedAt");
  ok(funded1 === NOW, "15e. the first funded position stamps a SEPARATE firstFundedPositionAt");

  // (b) repeated PAPER runs and (d) a switch back to OBSERVE never move or erase the timestamps.
  RL.processObservations(st, [obs({ market: "T9", ticker: "T9", observedAsk: 0.40, category: "STRONG_SPECULATION", coreFraction: null })], { profile, mode: RL.MODES.PAPER, now: NOW });
  ok(st.paperModeActivatedAt === activated && st.firstFundedPositionAt === funded1, "15d-i. repeated PAPER runs never rewrite either timestamp");
  RL.processObservations(st, [obs({ market: "T10", ticker: "T10", observedAsk: 0.40, category: "STRONG_SPECULATION", coreFraction: null })], { profile, mode: RL.MODES.OBSERVE, now: NOW });
  ok(st.paperModeActivatedAt === activated && st.firstFundedPositionAt === funded1, "15d-ii. switching back to OBSERVE does NOT erase the timestamps");

  // (f) a pre-activation OBSERVE observation is labeled EXCLUDED and not in official performance.
  reset();
  const st2 = RL.load();
  RL.processObservations(st2, [obs({ signalId: "pre", market: "PRE", ticker: "PRE", estProbability: 0.05 })], { profile, mode: RL.MODES.OBSERVE, now: "2026-07-19T00:00:00Z" });
  RL.processObservations(st2, [obs({ market: "POST", ticker: "POST", observedAsk: 0.40, category: "STRONG_SPECULATION", coreFraction: null })], { profile, mode: RL.MODES.PAPER, now: NOW });
  const sum = RL.summary(st2);
  const preObs = sum.observations.find((o) => o.market === "PRE");
  ok(preObs && preObs.officialPerformanceExcluded === true && /EXCLUDED FROM OFFICIAL PERFORMANCE/.test(preObs.exclusionLabel || ""), "15f. a pre-activation observation is labeled EXCLUDED FROM OFFICIAL PERFORMANCE");

  // (rule 4) a position created BEFORE activation is excluded from official performance metrics.
  reset();
  const st3 = RL.load();
  st3.paperModeActivatedAt = NOW; st3.prospectiveStartAt = NOW;
  st3.positions["research|pre"] = { researchPositionId: "research|pre", event: "E", market: "PRE", ticker: "PRE", side: "YES", primaryQualification: "STRONG_SPECULATION", contributingQualifications: ["STRONG_SPECULATION"], status: "RESEARCH_SETTLED", openedAt: "2026-07-01T00:00:00Z", settledAt: "2026-07-02T00:00:00Z", result: 1, pnl: 100, pessimisticPnl: 80, totalCost: 200, effectiveEntryPrice: 0.4, estimatedEdgeAfterHaircut: 0.05, contracts: 500, maximumPayout: 500 };
  const sum3 = RL.summary(st3);
  ok(sum3.blendedAggressive.numBets === 0 && sum3.counts.preActivationExcluded === 1, "15g. a position opened before activation is EXCLUDED from official performance (rule 4)");
}

// 16. Consolidation: co-qualifying categories on ONE market/side => ONE funded position. ----------
{
  const shared = { event: "UFC-E", market: "TX", ticker: "TX", side: "YES", observedAsk: 0.40, estProbability: 0.70, eventDate: "2999-01-01", coreFraction: null };
  const { state } = runOne([
    obs({ ...shared, signalId: "a", category: "STRONG_SPECULATION" }),
    obs({ ...shared, signalId: "b", category: "WATCH_EXPERIMENT" }),
    obs({ ...shared, market: "TY", ticker: "TY", signalId: "c", category: "STRONG_SPECULATION" }),
  ]);
  const positions = Object.values(state.positions);
  const tx = positions.find((p) => p.market === "TX");
  ok(positions.length === 2, "16a. two markets => two positions (no duplicate exposure on the shared market)");
  ok(tx && tx.primaryQualification === "STRONG_SPECULATION", "16b. primary = highest-stake category (STRONG 2% over WATCH 0.5%)");
  ok(tx && tx.contributingQualifications.includes("WATCH_EXPERIMENT") && tx.strongestEligibleStakePct === 0.02, "16c. contributors retained; stake = strongest eligible %");
}

// 16d. Per-fight cap holds ACROSS markets on one fight (running per-fight exposure). --------------
{
  const shared = { event: "UFC-F", eventDate: "2999-01-01", fight: "A vs B", side: "YES", observedAsk: 0.40, estProbability: 0.95, marketPriceTimestamp: NOW, category: "CORE_BUY", coreFraction: 0.05 };
  const { state } = runOne([
    obs({ ...shared, market: "F1", ticker: "F1", signalId: "f1" }),
    obs({ ...shared, market: "F2", ticker: "F2", signalId: "f2" }),
  ]);
  const onFight = Object.values(state.positions).filter((p) => p.fight === "A vs B");
  const totalFightExposure = onFight.reduce((a, p) => a + p.totalCost, 0);
  const cap = 0.05 * 10000; // perFightPct * bankroll = $500
  ok(totalFightExposure <= cap + 0.5, `16d. two markets on one fight share the per-fight cap (total $${totalFightExposure.toFixed(2)} <= $${cap})`);
}

// 17. Settlement honours side; losers are booked and preserved. ----------------------------------
{
  const settleWith = (result, side = "YES") => {
    reset();
    const state = RL.load();
    RL.processObservations(state, [obs({ side, observedAsk: 0.40, category: "STRONG_SPECULATION", coreFraction: null })], { profile, mode: RL.MODES.PAPER, now: NOW });
    return RL.settleFromMarket(state, { settlement: async () => ({ status: "settled", result }), now: NOW }).then(() => state);
  };
  (async () => {
    const win = await settleWith("yes", "YES");
    const wp = Object.values(win.positions)[0];
    ok(wp.result === 1 && wp.pnl > 0 && wp.status === "RESEARCH_SETTLED", "17a. YES win: result 1, positive P&L, settled");
    const lose = await settleWith("no", "YES");
    const lp = Object.values(lose.positions)[0];
    ok(lp.result === 0 && near(lp.pnl, -lp.totalCost) && lose.positions[lp.researchPositionId], "17b. YES loss: P&L = -totalCost, and the loser is PRESERVED");
    const noWin = await settleWith("no", "NO");
    ok(Object.values(noWin.positions)[0].result === 1, "17c. NO side wins on result 'no'");

    // 17d. an unreadable market is NEVER settled to a guess — the position stays OPEN.
    { reset(); const st = RL.load();
      RL.processObservations(st, [obs({ side: "YES", observedAsk: 0.40, category: "STRONG_SPECULATION", coreFraction: null })], { profile, mode: RL.MODES.PAPER, now: NOW });
      await RL.settleFromMarket(st, { settlement: async () => null, now: NOW });
      ok(Object.values(st.positions)[0].status === "RESEARCH_OPEN", "17d. an unreadable market leaves the position OPEN (fail closed)"); }
    // 17e. a void refunds the stake: pnl 0, payout = totalCost, break-even.
    { reset(); const st = RL.load();
      RL.processObservations(st, [obs({ side: "YES", observedAsk: 0.40, category: "STRONG_SPECULATION", coreFraction: null })], { profile, mode: RL.MODES.PAPER, now: NOW });
      await RL.settleFromMarket(st, { settlement: async () => ({ status: "finalized", result: "" }), now: NOW });
      const vp = Object.values(st.positions)[0];
      ok(vp.result === null && vp.pnl === 0 && vp.payout === vp.totalCost && vp.status === "RESEARCH_SETTLED", "17e. void: pnl 0, payout = totalCost (break-even)"); }

    // 22. Near-miss (PRICE_TOO_HIGH) tracking: capture the price gap and grade it in its own slice.
    { reset(); const st = RL.load();
      RL.processObservations(st, [obs({ category: "UNCONFIRMED_CANDIDATE", coreFraction: null, observedAsk: 0.40, productionMaximumAcceptablePrice: 0.38, estProbability: 0.70, market: "NM", ticker: "NM" })], { profile, mode: RL.MODES.PAPER, now: NOW });
      const p = Object.values(st.positions)[0];
      ok(p && p.primaryQualification === "UNCONFIRMED_CANDIDATE" && p.priceGapCents === 2, "22a. a near-miss stores the price gap in cents (ask 2c above acceptable)");
      await RL.settleFromMarket(st, { settlement: async () => ({ status: "settled", result: "yes" }), now: NOW });
      const s = RL.summary(st);
      ok(s.nearMiss.numBets === 1 && s.nearMiss.avgPriceGapCents === 2 && s.nearMiss.netPnl > 0, "22b. the near-miss slice grades those bets (count, avg gap, P&L)"); }

    const summaryDone = () => {
      // 21. incremental-ex-CORE_BUY measured separately from copied CORE_BUYs.
      reset();
      const st = RL.load();
      RL.processObservations(st, [
        obs({ event: "E-CORE", fight: "A vs B", market: "C1", ticker: "C1", category: "CORE_BUY", coreFraction: 0.05, observedAsk: 0.40 }),
        obs({ event: "E-SPEC", fight: "C vs D", market: "S1", ticker: "S1", category: "STRONG_SPECULATION", coreFraction: null, observedAsk: 0.40 }),
      ], { profile, mode: RL.MODES.PAPER, now: NOW });
      return RL.settleFromMarket(st, { settlement: async () => ({ status: "settled", result: "yes" }), now: NOW }).then(() => {
        const s = RL.summary(st);
        ok(s.blendedAggressive.numBets === 2 && s.incrementalExCoreBuy.numBets === 1, "21. incremental-ex-CORE_BUY isolates the speculative bet (blended 2, incremental 1)");
        ok(s.blendedAggressive.pessimisticNetPnl != null && s.incrementalExCoreBuy.pessimisticNetPnl != null, "21b. both headline slices expose a pessimistic-fee net P&L");
        finish();
      });
    };
    // 18. Idempotency across fresh runners (dedup key).
    reset();
    const st2 = RL.load();
    const dup = obs({ market: "D1", ticker: "D1", category: "STRONG_SPECULATION", coreFraction: null, observedAsk: 0.40 });
    RL.processObservations(st2, [dup], { profile, mode: RL.MODES.PAPER, now: NOW });
    RL.save(st2);
    const reloaded = RL.load();
    RL.processObservations(reloaded, [dup], { profile, mode: RL.MODES.PAPER, now: NOW });
    ok(Object.keys(reloaded.positions).length === 1, "18. re-processing the same signal never opens a second position (idempotent)");

    // 19. Ruleset version stamped; a different profile version keys a distinct record (v1/v2 separable).
    const p1 = Object.values(reloaded.positions)[0];
    ok(p1.rulesetVersion === "research-profile-v1", "19a. position carries its rulesetVersion");
    const v2 = { ...profile, version: "research-profile-v2" };
    RL.processObservations(reloaded, [dup], { profile: v2, mode: RL.MODES.PAPER, now: NOW });
    ok(Object.keys(reloaded.positions).length === 2, "19b. same signal under a new profile version creates a SEPARATE record");

    summaryDone();
  })().catch((e) => { fail++; process.stdout.write(`  FAIL  async settlement block threw: ${e.message}\n`); finish(); });
}

function finish() {
  reset();
  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}
