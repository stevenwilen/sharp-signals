// UNIFIED DISPATCHER — the pure decision logic that decides which stages are due.
//
// GitHub cron fires unreliably (~14-40% of schedule on this public repo), so the cloud cannot rely on
// "run stage X on cron Y". Instead every cron invokes the dispatcher, which decides due-ness from the
// card date and a receipts file of last-run times. Missed crons self-heal: the next invocation sees
// the stage overdue and runs it. These tests pin that decision.
const D = require("../dispatch");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const ED = "2026-07-18";
const BELL = D.firstBellMs(ED);
const H = 3600 * 1000;
const at = (h) => BELL - h * H;   // h hours BEFORE first bell
const due = (p) => Object.entries(p.due).filter(([, v]) => v).map(([k]) => k).sort();

console.log("CADENCE TIERS BY TIME TO FIRST BELL");
{
  ok("2 weeks out is outside-fight-week", D.decideDueStages(ED, at(336), {}).tier === "outside-fight-week");
  ok("5 days out is fight-week", D.decideDueStages(ED, at(120), {}).tier === "fight-week");
  ok("30h out is final-48h", D.decideDueStages(ED, at(30), {}).tier === "final-48h");
  ok("3h to bell is fight-day", D.decideDueStages(ED, at(3), {}).tier === "fight-day");
  ok("during the card (+4h) is still fight-day", D.decideDueStages(ED, at(-4), {}).tier === "fight-day");
  ok("8h after first bell is post-card", D.decideDueStages(ED, at(-8), {}).tier === "post-card");
}

console.log("\nA COLD START RUNS EVERYTHING DUE FOR THE TIER");
{
  const p = D.decideDueStages(ED, at(120), {});   // fight week, no receipts
  ok("collect/forecast/confidence are due on a cold start", due(p).join() === "collect,confidence,forecast");
  ok("grade is not due before the card", p.due.grade === false);
}

console.log("\nRECEIPTS GATE RE-RUNS TO THE TIER INTERVAL");
{
  const now = at(120);   // fight week: 2h evidence + forecast cadence (loosened to cut the evidence lag)
  ok("forecast NOT due 1h after last run",
    D.decideDueStages(ED, now, { forecast: { ranAt: new Date(now - 1 * H).toISOString() } }).due.forecast === false);
  ok("forecast due again after 3h",
    D.decideDueStages(ED, now, { forecast: { ranAt: new Date(now - 3 * H).toISOString() } }).due.forecast === true);

  const day = at(24);   // final-48h: 1h cadence
  ok("in final-48h, forecast NOT due 40min after last run",
    D.decideDueStages(ED, day, { forecast: { ranAt: new Date(day - 40 * 60 * 1000).toISOString() } }).due.forecast === false);
  ok("in final-48h, forecast due after 90min",
    D.decideDueStages(ED, day, { forecast: { ranAt: new Date(day - 90 * 60 * 1000).toISOString() } }).due.forecast === true);

  const fd = at(3);   // fight day: hourly forecast
  ok("on fight day, forecast due after 70min",
    D.decideDueStages(ED, fd, { forecast: { ranAt: new Date(fd - 70 * 60 * 1000).toISOString() } }).due.forecast === true);
  ok("...but NOT after 20min", D.decideDueStages(ED, fd, { forecast: { ranAt: new Date(fd - 20 * 60 * 1000).toISOString() } }).due.forecast === false);
}

console.log("\nCOLLECT AND FORECAST ARE GATED INDEPENDENTLY BY THEIR OWN RECEIPTS");
{
  const fd = at(3);   // fight day: 1h collect + 1h forecast (loosened; the fight-day sentinel still does the 15-min price checks)
  const r = { collect: { ranAt: new Date(fd - 40 * 60 * 1000).toISOString() }, forecast: { ranAt: new Date(fd - 90 * 60 * 1000).toISOString() } };
  const p = D.decideDueStages(ED, fd, r);
  ok("forecast due after 90min on fight day (1h cadence)", p.due.forecast === true);
  ok("collect NOT due after 40min on fight day (1h cadence)", p.due.collect === false);
}

console.log("\nCONFIDENCE PIGGYBACKS ON FORECAST; GRADE IS POST-CARD ONLY");
{
  ok("confidence is due exactly when forecast is", (() => {
    const p = D.decideDueStages(ED, at(120), { forecast: { ranAt: new Date(at(120) - 1 * H).toISOString() } });
    return p.due.confidence === p.due.forecast;
  })());
  const post = D.decideDueStages(ED, at(-8), {});
  ok("grade is due 8h after bell", post.due.grade === true);
  ok("collect/forecast do NOT run post-card", post.due.collect === false && post.due.forecast === false);
  ok("grade gated for 24h after running",
    D.decideDueStages(ED, at(-8), { grade: { ranAt: new Date(at(-8) - 2 * H).toISOString() } }).due.grade === false);
}

console.log("\nTICKER PARSING");
{
  const c = D.cardFromTicker("KXUFCFIGHT-26JUL18DUUSM");
  ok("parses ticker date", c.tickerDate === "26JUL18");
  ok("parses event date", c.eventDate === "2026-07-18");
  ok("builds the event id", c.eventId === "UFC-2026-07-18");
  ok("returns null on garbage", D.cardFromTicker("nonsense") === null);
}

console.log("\nWHICH CARD IS OURS (uncoverable cards are skipped, not crashed on)");
{
  const NOW = Date.parse("2026-08-18T21:00:00Z");
  // The real shape of the outage: a 5-bout DWCS card tonight, the real 13-bout UFC card on Saturday.
  const dwcs = { eventDate: "2026-08-18", eventId: "UFC-2026-08-18", bouts: 5, startMs: Date.parse("2026-08-19T04:00:00Z") };
  const ufc = { eventDate: "2026-08-22", eventId: "UFC-2026-08-22", bouts: 13, startMs: Date.parse("2026-08-23T02:00:00Z") };

  ok("the soonest live card wins when nothing is skipped",
    D.pickActiveCard([ufc, dwcs], NOW, {}).eventId === "UFC-2026-08-18");

  // THE FIX: once a card is recorded as uncoverable, the dispatcher moves to the next one instead of
  // dying on it every run and starving the card the operator actually bets on.
  ok("an uncoverable card is skipped for the next real one",
    D.pickActiveCard([ufc, dwcs], NOW, { "2026-08-18": { reason: "no coverage" } }).eventId === "UFC-2026-08-22");

  ok("a card whose bell passed >24h ago is finished, not active",
    D.pickActiveCard([{ ...dwcs, startMs: NOW - 30 * 3600e3 }, ufc], NOW, {}).eventId === "UFC-2026-08-22");

  // REFUSAL: skipping must never invent a card. If every open card is uncoverable, say nothing is active.
  ok("all cards uncoverable -> null, never a fabricated fallback",
    D.pickActiveCard([ufc, dwcs], NOW, { "2026-08-18": {}, "2026-08-22": {} }) === null);
  ok("no cards at all -> null", D.pickActiveCard([], NOW, {}) === null);

  // The skip list is keyed by event DATE; an unrelated entry must not shadow a live card.
  ok("an unrelated skip entry does not affect this card",
    D.pickActiveCard([ufc], NOW, { "2026-07-11": {} }).eventId === "UFC-2026-08-22");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
