// Explore the Kalshi API: confirm status, list UFC events + markets with prices.
const k = require("./lib/kalshi");

const c = (v) => (v == null ? "-" : v); // cents helper

(async () => {
  try {
    const st = await k.status();
    console.log("exchange status:", JSON.stringify(st));
  } catch (e) { console.log("status error:", e.message); }

  const SERIES = process.argv[2] || "KXUFCFIGHT";
  console.log(`\n=== events for series ${SERIES} (open) ===`);
  let evs = [];
  try {
    evs = await k.eventsAll({ series_ticker: SERIES, status: "open" });
  } catch (e) { console.log("events error:", e.message); }
  console.log("open events:", evs.length);
  for (const e of evs.slice(0, 25))
    console.log(`  ${e.event_ticker}  |  ${e.title || e.sub_title || ""}`);

  // Pull markets for the series and show prices (cents = implied %).
  console.log(`\n=== open markets for series ${SERIES} (with prices) ===`);
  let mks = [];
  try {
    mks = await k.marketsAll({ series_ticker: SERIES, status: "open" });
  } catch (e) { console.log("markets error:", e.message); }
  console.log("open markets:", mks.length);
  for (const m of mks.slice(0, 30)) {
    console.log(
      `  ${m.ticker}\n     ${m.title || ""} [${m.yes_sub_title || ""}]` +
      `  yes_bid=${c(m.yes_bid)} yes_ask=${c(m.yes_ask)} last=${c(m.last_price)}` +
      `  vol=${c(m.volume)} close=${m.close_time || ""}`
    );
  }
})();
