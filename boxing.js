// Show upcoming boxing events from Kalshi with live implied win odds per boxer.
//   node boxing.js
const k = require("./lib/kalshi");
const pct = (v) => (v == null ? " n/a " : (v * 100).toFixed(0).padStart(3) + "%");
const day = (t) => (t ? String(t).slice(0, 10) : "?");

(async () => {
  const markets = await k.marketsAll({ series_ticker: "KXBOXING", status: "open" });
  const byEvent = {};
  for (const m of markets) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);

  // sort events by soonest close_time
  const events = Object.keys(byEvent).sort((a, b) => {
    const ca = Math.min(...byEvent[a].map((m) => Date.parse(m.close_time) || Infinity));
    const cb = Math.min(...byEvent[b].map((m) => Date.parse(m.close_time) || Infinity));
    return ca - cb;
  });

  console.log(`\nBoxing on Kalshi — ${events.length} open events (live implied odds)\n`);
  for (const ev of events) {
    const ms = byEvent[ev];
    const rows = [];
    for (const m of ms) {
      const { mid } = await k.impliedYes(m.ticker);
      rows.push({ name: (m.yes_sub_title || m.ticker.split("-").pop()).trim(), mid });
    }
    rows.sort((a, b) => (b.mid || 0) - (a.mid || 0));
    const when = day(ms[0].close_time);
    const title = rows.map((r) => r.name).join("  vs  ");
    console.log(`  ${when}   ${title}`);
    for (const r of rows) console.log(`             ${pct(r.mid)}  ${r.name}`);
    console.log("");
  }
})();
