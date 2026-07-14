// World Cup view on Kalshi: tournament-winner odds + upcoming 3-way match odds.
//   node worldcup.js
const k = require("./lib/kalshi");
const pct = (v) => (v == null ? " n/a " : (v * 100).toFixed(1).padStart(5) + "%");

async function impliedRows(markets) {
  const rows = [];
  for (const m of markets) {
    const { mid } = await k.impliedYes(m.ticker);
    rows.push({ name: (m.yes_sub_title || m.ticker.split("-").pop()).trim(), mid, ticker: m.ticker });
  }
  rows.sort((a, b) => (b.mid || 0) - (a.mid || 0));
  return rows;
}

(async () => {
  console.log("\n=== 🏆 World Cup winner (Kalshi implied) ===");
  const win = await k.marketsAll({ series_ticker: "KXMENWORLDCUP", status: "open" });
  for (const r of await impliedRows(win)) console.log(`   ${pct(r.mid)}  ${r.name}`);

  console.log("\n=== ⚽ Upcoming matches (3-way, regulation) ===");
  const games = await k.marketsAll({ series_ticker: "KXWCGAME", status: "open" });
  const byEvent = {};
  for (const m of games) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);
  for (const ev of Object.keys(byEvent)) {
    const ms = byEvent[ev];
    const title = (ms[0].title || ev).replace(/:.*/, "");
    console.log(`\n   ${title}   [${ev}]`);
    for (const r of await impliedRows(ms)) console.log(`     ${pct(r.mid)}  ${r.name}`);
  }
})();
