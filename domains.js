// Probe Kalshi for "UFC-like" inefficient markets: boxing, esports, reality TV.
const k = require("./lib/kalshi");
const cands = {
  boxing: ["KXBOXING", "KXBOXINGFIGHT", "KXBOX", "KXBOXINGBOUT"],
  esports_cs: ["KXCS2", "KXCSGO", "KXCS2MATCH", "KXCS2GAME"],
  esports_lol: ["KXLOL", "KXLEAGUE", "KXLOLMATCH", "KXLCS"],
  esports_valorant: ["KXVALORANT", "KXVAL", "KXVCT"],
  esports_dota: ["KXDOTA", "KXDOTA2"],
  esports_generic: ["KXESPORTS", "KXMVESPORTS", "KXMVESPORTSMULTIGAMEEXTENDED"],
  reality_survivor: ["KXSURVIVOR", "KXSURVIVORWIN"],
  reality_bb: ["KXBIGBROTHER", "KXBB"],
  reality_loveisland: ["KXLOVEISLAND", "KXLOVEISLANDUSA"],
  reality_drag: ["KXDRAGRACE", "KXRUPAUL"],
  reality_bachelor: ["KXBACHELOR", "KXBACHELORETTE"],
  reality_dwts: ["KXDWTS", "KXDANCINGSTARS"],
};
(async () => {
  for (const [label, list] of Object.entries(cands)) {
    for (const s of list) {
      try {
        const r = await k.events({ series_ticker: s, status: "open", limit: 3 });
        const n = (r && r.events && r.events.length) || 0;
        if (n > 0) {
          console.log(`FOUND [${label}] ${s}: ${n}+ open events`);
          for (const e of r.events.slice(0, 3)) console.log(`     ${e.event_ticker} | ${e.title || ""}`);
        }
      } catch (_) { /* not found / not a series */ }
    }
  }
  console.log("(done — only hits shown)");
})();
