// Show a UFC card from Kalshi with live implied win probabilities per fighter.
//   node card.js 26JUL18        (date code inside the event ticker)
const k = require("./lib/kalshi");

const SERIES = "KXUFCFIGHT";
const DATE = (process.argv[2] || "26JUL18").toUpperCase();

const pct = (v) => (v == null ? " n/a " : (v * 100).toFixed(0).padStart(3) + "%");

(async () => {
  const markets = await k.marketsAll({ series_ticker: SERIES, status: "open" });
  const fights = markets.filter((m) => m.ticker.includes(`-${DATE}`));
  // group markets by event (each fight = one event with 2 fighter markets)
  const byEvent = {};
  for (const m of fights) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);

  const events = Object.keys(byEvent);
  console.log(`\nUFC card ${DATE} — ${events.length} fights (live Kalshi implied odds)\n`);
  console.log("  FIGHTER".padEnd(26) + "IMPLIED   |  vs".padEnd(20));
  console.log("  " + "-".repeat(60));

  for (const ev of events) {
    const ms = byEvent[ev];
    const rows = [];
    for (const m of ms) {
      const { mid } = await k.impliedYes(m.ticker);
      const name = (m.yes_sub_title || m.ticker.split("-").pop()).trim();
      rows.push({ name, mid, ticker: m.ticker });
    }
    rows.sort((a, b) => (b.mid || 0) - (a.mid || 0));
    const title = rows.map((r) => r.name).join("  vs  ");
    console.log(`  ${title}`);
    for (const r of rows) console.log(`    ${r.name.padEnd(24)} ${pct(r.mid)}     ${r.ticker}`);
    console.log("");
  }
})();
