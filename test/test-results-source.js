// VALIDATION GATE for the Wikipedia results reader. Kalshi's settled UFC markets are ground truth
// for who won; check that Wikipedia agrees before we trust it to grade the historical backfill.
const k = require("../lib/kalshi");
const results = require("../lib/ufc-results");
const { wonFromMarket } = require("../lib/results");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const markets = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "settled" });
  const byEvent = {};
  for (const m of markets) if (m.event_ticker && m.yes_sub_title) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);

  const fights = [];
  for (const ms of Object.values(byEvent)) {
    if (ms.length < 2) continue;
    const [a, b] = ms;
    const ra = wonFromMarket(a);
    if (ra == null || !a.yes_sub_title || !b.yes_sub_title) continue;
    fights.push({ fighter: a.yes_sub_title, opponent: b.yes_sub_title, result: ra, date: (a.close_time || "").slice(0, 10) });
  }
  const sample = fights.slice(0, 16);
  console.log(`checking ${sample.length} settled fights (Wikipedia result vs Kalshi truth):\n`);

  let agree = 0, checked = 0, miss = 0;
  for (const f of sample) {
    let w;
    try { w = await results.didWin(f.fighter, f.opponent, f.date); }
    catch (e) { console.log(`${f.fighter} vs ${f.opponent}: ERROR ${e.message}`); miss++; await sleep(400); continue; }
    if (!w.ok) { console.log(`${(f.fighter + " vs " + f.opponent).slice(0, 42).padEnd(42)} wiki miss`); miss++; await sleep(400); continue; }
    checked++;
    const ok = w.result === f.result;
    if (ok) agree++;
    console.log(`${(f.fighter + " vs " + f.opponent).slice(0, 42).padEnd(42)} kalshi=${f.result} wiki=${w.result} ${ok ? "agree" : "*** DISAGREE ***"}`);
    await sleep(400);
  }
  console.log(`\n${agree}/${checked} agree with Kalshi. ${miss} not found on Wikipedia.`);
  console.log(agree === checked && checked >= 8
    ? "VERDICT: PASS — Wikipedia results are reliable; safe to use for the historical backfill."
    : "VERDICT: NEEDS REVIEW.");
})();
