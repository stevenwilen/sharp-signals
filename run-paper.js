// PAPER STRATEGY hook — auto-creates $10,000 paper positions for FORMAL system BUYs, settles resolved
// ones read-only from the public market, and rewrites the canonical data/bankrolls.json. Decoupled from
// the armed alert path: it reads only SEALED artifacts (forecast + entertainment-alerts + combo-audit),
// so it can never place, alert, or affect real money. Idempotent — safe to run every cycle.
//
//   node run-paper.js [--settle]
//
// A paper position is created ONLY for a formal core-lane BUY or a formal combo-engine BUY. Exploration/
// speculative, discretionary, PRICE_TOO_HIGH, WATCH, withdrawn, manual combos and post-bell are excluded
// (the lane filter + paper-ledger's own eligibility/fight-start guards enforce this).
require("./lib/env");
const { paths, readJson } = require("./lib/store");
const path = require("path");
const PL = require("./lib/paper-ledger");
const BK = require("./lib/bankrolls");

const CORE_TIER_FRACTION = { "standard experimental": 0.03, "strong experimental": 0.04, "rare maximum": 0.05 };
const say = (s) => process.stdout.write(s + "\n");
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

function activeCard() {
  const r = readJson(path.join(paths.data, "dispatch-receipts.json"), null);
  return r && r.lastCard ? r.lastCard : null;
}

// Normalise one formal core BUY buyInstruction into a paper recommendation.
function coreBuyToRec(b, forecast, eventDate) {
  const st = b.state || {};
  if (b.verdict !== "BUY") return null;
  const lane = st.lane || (CORE_TIER_FRACTION[st.classification] ? "core" : null);
  if (lane !== "core") return null;                       // formal CORE only — exploration is excluded
  const fc = (forecast.forecasts || []).find((x) => x.boutId === b.boutId) || {};
  const fighter = (String(b.text || "").match(/^Buy:\s+(.+?)\s+YES$/m) || [])[1] || null;
  const ask = num(st.ask);
  const fraction = st.stakePercent != null ? st.stakePercent / 100 : CORE_TIER_FRACTION[st.classification] || null;
  const prob = fighter && fc.systemCentral ? num(fc.systemCentral[fighter]) : null;
  return {
    recommendationId: `${b.boutId}|${b.ticker}`, ticker: b.ticker, market: b.ticker, side: "YES",
    eventDate, fight: fc.fight || null, tier: st.classification || null, category: "CONFIRMED_SYSTEM_BET",
    kind: "single", fraction, entryPrice: ask,
    edgeAtEntry: prob != null && ask != null ? +(prob - ask).toFixed(4) : null,
  };
}

// The one formal combo BUY (if any) from the latest combo-audit record.
function comboBuyToRec(eventDate) {
  const audit = readJson(path.join(paths.data, "combo-audit.json"), null);
  if (!audit || !audit.records) return null;
  const recs = Object.values(audit.records).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const rec = recs[0];
  if (!rec || rec.decision !== "COMBO_BUY") return null;
  const pr = (rec.audit && rec.audit.pricing) || {};
  const key = audit.lastSentKey || `combo|${(rec.legs || []).join("+")}`;
  return {
    recommendationId: key, ticker: key, market: key, side: "YES", eventDate,
    fight: (rec.legs || []).join(" + "), tier: "COMBO", category: "SYSTEM_COMBO", kind: "combo",
    fraction: null, entryPrice: num(pr.liveQuote) ?? num(pr.maxBuyPrice),
    edgeAtEntry: num(pr.fairPrice) != null && num(pr.liveQuote) != null ? +((pr.fairPrice - pr.liveQuote)).toFixed(4) : null,
  };
}

(async () => {
  const now = new Date().toISOString();
  const card = activeCard();
  const pl = PL.load();
  let created = 0, skipped = 0;

  if (card && card.eventDate) {
    const forecast = readJson(path.join(paths.data, `forecast-${card.eventDate}.json`), null) || {};
    const alerts = readJson(path.join(paths.data, `entertainment-alerts-${card.eventDate}.json`), null) || {};
    const recs = [];
    for (const b of alerts.buyInstructions || []) { const r = coreBuyToRec(b, forecast, card.eventDate); if (r) recs.push(r); }
    const combo = comboBuyToRec(card.eventDate); if (combo) recs.push(combo);
    for (const r of recs) {
      const res = PL.openPaper(pl, r, { now });
      if (res.created) { created++; say(`  + PAPER ${r.kind} ${r.fight || r.ticker} — $${res.position.paperStake} @ ${Math.round((r.entryPrice || 0) * 100)}c (${res.position.contracts} contracts)`); }
      else skipped++;
    }
  }

  let settled = { settled: [], pending: [], unreadable: [] };
  if (process.argv.includes("--settle")) {
    const K = require("./lib/kalshi");
    settled = await PL.settleFromMarket(pl, { settlement: (t) => K.settlement(t), now });
    for (const s of settled.settled) say(`  ${s.result === 1 ? "WON " : s.result === 0 ? "LOST" : "VOID"} PAPER ${s.fight}  simulated P&L $${s.paperPnl}`);
  }

  PL.save(pl);
  const b = BK.write({ now });
  say(`run-paper: ${created} created, ${skipped} unchanged, ${settled.settled.length} settled. Paper: $${b.paper.accountValue} account, $${b.paper.availableCash} available (start ${b.paper.prospectiveStartAt || "not yet"}).`);
  process.exit(0);
})().catch((e) => { console.error("run-paper error:", e.message); process.exit(1); });
