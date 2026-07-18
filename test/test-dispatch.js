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
  ok("collect/forecast/alerts are due on a cold start", due(p).join() === "alerts,collect,forecast");
  ok("grade is not due before the card", p.due.grade === false);
}

console.log("\nRECEIPTS GATE RE-RUNS TO THE TIER INTERVAL");
{
  const now = at(120);   // fight week: 24h evidence + forecast cadence
  ok("forecast NOT due 2h after last run",
    D.decideDueStages(ED, now, { forecast: { ranAt: new Date(now - 2 * H).toISOString() } }).due.forecast === false);
  ok("forecast due again after 30h",
    D.decideDueStages(ED, now, { forecast: { ranAt: new Date(now - 30 * H).toISOString() } }).due.forecast === true);

  const day = at(24);   // final-48h: 6h cadence
  ok("in final-48h, forecast NOT due 2h after last run",
    D.decideDueStages(ED, day, { forecast: { ranAt: new Date(day - 2 * H).toISOString() } }).due.forecast === false);
  ok("in final-48h, forecast due after 7h",
    D.decideDueStages(ED, day, { forecast: { ranAt: new Date(day - 7 * H).toISOString() } }).due.forecast === true);

  const fd = at(3);   // fight day: hourly forecast
  ok("on fight day, forecast due after 70min",
    D.decideDueStages(ED, fd, { forecast: { ranAt: new Date(fd - 70 * 60 * 1000).toISOString() } }).due.forecast === true);
  ok("...but NOT after 20min", D.decideDueStages(ED, fd, { forecast: { ranAt: new Date(fd - 20 * 60 * 1000).toISOString() } }).due.forecast === false);
}

console.log("\nEXPENSIVE COLLECT IS GATED SEPARATELY FROM CHEAP FORECAST ON FIGHT DAY");
{
  const fd = at(3);
  // forecast every 1h, but collect (Gemini) every 6h — so a fight-day hourly run re-forecasts on
  // cached evidence without re-paying for extraction.
  const r = { collect: { ranAt: new Date(fd - 2 * H).toISOString() }, forecast: { ranAt: new Date(fd - 2 * H).toISOString() } };
  const p = D.decideDueStages(ED, fd, r);
  ok("forecast due again after 2h on fight day", p.due.forecast === true);
  ok("collect NOT due after 2h on fight day (6h cadence)", p.due.collect === false);
}

console.log("\nALERTS PIGGYBACK ON FORECAST; GRADE IS POST-CARD ONLY");
{
  ok("alerts are due exactly when forecast is", (() => {
    const p = D.decideDueStages(ED, at(120), { forecast: { ranAt: new Date(at(120) - 1 * H).toISOString() } });
    return p.due.alerts === p.due.forecast;
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

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
