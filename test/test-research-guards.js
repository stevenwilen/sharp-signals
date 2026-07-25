// RESEARCH v2 GUARDS — refusal-first. Fight day exposed two ways v2 could fund a bad position: a STALE
// prior traded against a live price (manufacturing edge from a timing gap), and BOTH SIDES of one bout as
// the price drifted. These pin the fixes. Isolated: builds observations in memory, no network, no ledger file.
const RL = require("../lib/research-ledger");
const FR = require("../lib/freshness");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const profile = RL.loadProfile("research-profile-v2");
const now = "2026-07-25T20:00:00Z";
const freshState = () => ({ startingDollars: 10000, positions: {}, observations: {}, paperModeActivatedAt: null });
const obs = (over = {}) => ({
  signalId: over.ticker || "s", event: "2026-07-25", eventDate: "2026-07-25",
  market: "KXUFCFIGHT-26JUL25AAABBB-AAA", ticker: "KXUFCFIGHT-26JUL25AAABBB-AAA",
  side: "YES", fighter: "Alpha", opponent: "Bravo", fight: "Alpha vs Bravo", category: "CREATIVE_SPECULATION",
  estProbability: 0.60, observedAsk: 0.50, marketPriceStatus: FR.S.CURRENT,
  signalTimestamp: "2026-07-25T19:40:00Z", marketPriceTimestamp: "2026-07-25T19:55:00Z",   // seal 15 min before price
  fightStartTimestamp: "2026-07-25T22:00:00Z", postBell: false, cutoffSource: RL.CUTOFF.CARD,
  ...over,
});

// 1. A fresh, contemporaneous, +edge speculative signal funds.
{
  const st = freshState();
  const { counts } = RL.processObservations(st, [obs()], { profile, mode: RL.MODES.PAPER, now });
  ok(counts.funded === 1 && Object.values(st.positions).some((p) => p.status === RL.STATUS.OPEN), "1. fresh contemporaneous +edge speculative signal -> FUNDED");
}
// 2. STALE PRIOR: the sealed forecast is 8h older than the live ask -> refused (edge is drift, not skill).
{
  const st = freshState();
  const stale = obs({ signalTimestamp: "2026-07-25T11:55:00Z" });   // 8h before the 19:55 price
  const { counts } = RL.processObservations(st, [stale], { profile, mode: RL.MODES.PAPER, now });
  ok(counts.funded === 0 && counts.observedNoEntry >= 1, "2. sealed prior 8h older than the live price -> REFUSED (no funding)");
}
// 3. ONE PER BOUT: a second signal on the SAME bout (other side) is refused once one side is held.
{
  const st = freshState();
  const sideA = obs({ ticker: "KXUFCFIGHT-26JUL25AAABBB-AAA", market: "KXUFCFIGHT-26JUL25AAABBB-AAA", fighter: "Alpha" });
  const sideB = obs({ ticker: "KXUFCFIGHT-26JUL25AAABBB-BBB", market: "KXUFCFIGHT-26JUL25AAABBB-BBB", fighter: "Bravo", signalId: "s2" });
  const { counts } = RL.processObservations(st, [sideA, sideB], { profile, mode: RL.MODES.PAPER, now });
  const open = Object.values(st.positions).filter((p) => p.status === RL.STATUS.OPEN);
  ok(counts.funded === 1 && open.length === 1, "3. both sides of ONE bout offered -> exactly ONE funded, never both");
}
// 4. Two DIFFERENT bouts both fund (the guard is per-bout, not a global cap of one).
{
  const st = freshState();
  const b1 = obs({ ticker: "KXUFCFIGHT-26JUL25AAABBB-AAA", market: "KXUFCFIGHT-26JUL25AAABBB-AAA" });
  const b2 = obs({ ticker: "KXUFCFIGHT-26JUL25CCCDDD-CCC", market: "KXUFCFIGHT-26JUL25CCCDDD-CCC", signalId: "s2", fight: "Charlie vs Delta", fighter: "Charlie", opponent: "Delta" });
  const { counts } = RL.processObservations(st, [b1, b2], { profile, mode: RL.MODES.PAPER, now });
  ok(counts.funded === 2, "4. two SEPARATE bouts both fund (one-per-bout is per bout, not global)");
}

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
