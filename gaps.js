// Where is the roster thin? And what markets are we ignoring?
const { paths, readJson } = require("./lib/store");
const k = require("./lib/kalshi");

(async () => {
  const g = readJson(paths.graded, {});
  const src = readJson(paths.sources, { sources: [] }).sources || [];

  console.log("=== THE INSIDER THESIS IS UNTESTED ===");
  console.log("(active fighters/coaches — the whole Arman idea — barely have any graded picks)\n");
  const insiders = src.filter((s) => ["fighter", "coach"].includes(s.type));
  for (const s of insiders) {
    const rec = Object.values(g).find((x) => x.source === s.name || (x.source || "").startsWith(s.name));
    console.log(`  ${(s.name + " (" + s.type + ")").padEnd(38)} picks graded: ${rec ? rec.n : 0}`);
  }

  console.log("\n=== WHAT KALSHI ACTUALLY OFFERS (are we ignoring soft markets?) ===");
  const series = ["KXUFCFIGHT", "KXBOXING", "KXPFL", "KXLFA", "KXKSW", "KXBELLATOR", "KXONEFC", "KXCAGEWARRIORS"];
  for (const s of series) {
    try {
      const open = await k.marketsAll({ series_ticker: s, status: "open" });
      const settled = await k.marketsAll({ series_ticker: s, status: "settled" });
      if (open.length || settled.length)
        console.log(`  ${s.padEnd(16)} open: ${String(open.length).padStart(3)}   settled(gradeable history): ${settled.length}`);
    } catch (_) { /* series doesn't exist */ }
  }
})();
