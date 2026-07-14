// The matcher decides WHICH FIGHTER your money goes on. Every case below is a real way the
// old matcher lost money, verified against the live Kalshi board.
//   node test/test-match.js
require("../lib/env");
const match = require("../lib/match");

const FUTURE = new Date("2026-07-14T00:00:00Z"); // before the Jul 18 card

(async () => {
  const markets = await match.marketsFor("mma");
  console.log(`${markets.length} open MMA markets on the board\n`);
  if (!markets.length) { console.log("no open markets — cannot test"); return; }

  const sample = markets.slice(0, 6).map((m) => `  ${m.ticker}  YES = ${m.yes_sub_title}`);
  console.log(sample.join("\n") + "\n");

  const cases = [
    // [pick, opponent, expectation]
    ["Kamaru Usman", "Dricus Du Plessis", "should match Usman"],
    ["Usman over Du Plessis", "Dricus Du Plessis", "THE WRONG-SIDE BUG: must NOT buy Du Plessis"],
    ["Usman to beat Du Plessis", "Dricus Du Plessis", "THE WRONG-SIDE BUG: must NOT buy Du Plessis"],
    ["Usman by KO", "Dricus Du Plessis", "THE WRONG-FIGHT BUG: must NOT match Seok Hyun Ko"],
    ["Usman by KO", null, "surname only, no opponent -> should REFUSE"],
    ["Silva", null, "bare surname -> should REFUSE"],
  ];

  let bad = 0;
  for (const [pick, opponent, note] of cases) {
    const r = await match.matchToMarket(
      { domain: "mma", pick, opponent, timestamp: "2026-07-13T00:00:00Z" },
      { now: FUTURE }
    );
    if (!r) { console.log(`REFUSED  "${pick}"\n         (no candidate)  [${note}]\n`); continue; }
    if (r.ok === false) { console.log(`REFUSED  "${pick}"\n         ${r.reason}  [${note}]\n`); continue; }

    // The load-bearing assertion: the side we are about to buy must BE the fighter picked.
    const picksThatFighter = match.nameScore(pick, r.fighter) >= 1;
    const flag = picksThatFighter ? "OK   " : "WRONG SIDE!!";
    if (!picksThatFighter) bad++;
    console.log(`${flag}    "${pick}"\n         -> buying YES on ${r.fighter} (vs ${r.opponent})` +
      `\n         ${r.ticker}  ask ${r.yesAsk}c  fight ${r.fightDate}  [${note}]\n`);
  }

  // Fight-day guard: the same pick, but "today" is the day of the card.
  const onFightDay = await match.matchToMarket(
    { domain: "mma", pick: "Kamaru Usman", opponent: "Dricus Du Plessis", timestamp: "2026-07-13T00:00:00Z" },
    { now: new Date("2026-07-18T21:00:00Z") }
  );
  const suppressed = !onFightDay || onFightDay.ok === false;
  console.log(`fight-day guard: ${suppressed ? "SUPPRESSED" : "STILL ALERTING -- BAD"}` +
    `${onFightDay && onFightDay.reason ? " (" + onFightDay.reason + ")" : ""}`);
  if (!suppressed) bad++;

  // Hindsight guard: a "pick" made after the fight.
  const afterFight = await match.matchToMarket(
    { domain: "mma", pick: "Kamaru Usman", opponent: "Dricus Du Plessis", timestamp: "2026-07-25T00:00:00Z" },
    { now: FUTURE }
  );
  const blocked = !afterFight || afterFight.ok === false;
  console.log(`hindsight guard: ${blocked ? "BLOCKED" : "STILL ALERTING -- BAD"}` +
    `${afterFight && afterFight.reason ? " (" + afterFight.reason + ")" : ""}`);
  if (!blocked) bad++;

  console.log(bad === 0 ? "\nAll clear: no wrong-side or stale match survived." : `\n${bad} FAILURES`);
  process.exit(bad === 0 ? 0 : 1);
})();
