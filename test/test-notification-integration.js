// COMPACT NOTIFICATIONS — INTEGRATION through the REAL combo pipeline. The unit test pins the module;
// this pins the WIRING: that the actual send site passes the correct change kind, so with the flag ON a
// combo BUY leaves as a short dashboard ping, and with the flag OFF the full "🎯 COMBO BUY" body is sent
// byte-for-byte as before. A wrong `kind` at the call site would slip past the unit test and be caught here.
const os = require("os"), fs = require("fs"), pathm = require("path");
const TMP = pathm.join(os.tmpdir(), "ss-notif-integration-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;
process.env.COMBO_ENABLED = "1";
process.env.DASHBOARD_URL = "https://sharp-signals-dashboard.vercel.app";
const PIPE = require("../lib/combo-pipeline");
const CE = require("../lib/combo-engine");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

function writeCard(date, fighter, opp) {
  fs.writeFileSync(pathm.join(TMP, `forecast-${date}.json`), JSON.stringify({
    sealHash: "seal-" + date, forecasts: [{ boutId: `B-${date}`, fight: `${fighter} vs ${opp}`, systemRange: { forFighter: fighter, low: 0.7, high: 0.8 }, systemCentral: { [fighter]: 0.75, [opp]: 0.25 } }],
  }));
  fs.writeFileSync(pathm.join(TMP, `entertainment-alerts-${date}.json`), JSON.stringify({
    card: date, buyInstructions: [{ ticker: `KXUFCFIGHT-${date}-X`, boutId: `B-${date}`, verdict: "BUY",
      text: `🧪 strong experimental — $4\n\n${fighter} vs ${opp}\nBuy: ${fighter} YES\n`,
      state: { ask: 0.5, maximumAcceptablePrice: 0.6, classification: "strong experimental" } }],
  }));
}
writeCard("2026-09-01", "Alice Ace", "Bob Bruiser");
writeCard("2026-09-15", "Carol Crane", "Dan Diaz");

const goodQuote = async () => ({ available: true, yesAsk: 0.35, ts: new Date().toISOString(), ageSec: 0, marketOpen: true });
const spy = () => { const calls = []; const fn = async (t) => { calls.push(t); return { ok: true }; }; fn.calls = calls; return fn; };
const NOW = Date.parse("2026-08-20T12:00:00Z");
const resetDedup = () => { try { fs.rmSync(PIPE.AUDIT_FILE()); } catch {} };

(async () => {
  console.log("LEGACY (flag OFF) — the full '🎯 COMBO BUY' body is sent, unchanged");
  {
    delete process.env.COMPACT_NOTIFICATIONS;
    resetDedup();
    const notifier = spy();
    const r = await PIPE.runCombo({ now: NOW, send: true, quoteProvider: goodQuote, notifier });
    ok("decision is COMBO_BUY", r.decision === CE.DECISION.BUY, r.decision);
    ok("one message sent", notifier.calls.length === 1, notifier.calls.length);
    ok("it is the FULL combo body (legs, prices, correlation)", /🎯 COMBO BUY/.test(notifier.calls[0]) && /Correlation assessment/.test(notifier.calls[0]));
  }

  console.log("\nCOMPACT (flag ON) — the SAME combo BUY leaves as a short dashboard ping");
  {
    process.env.COMPACT_NOTIFICATIONS = "1";
    resetDedup();
    const notifier = spy();
    const r = await PIPE.runCombo({ now: NOW, send: true, quoteProvider: goodQuote, notifier });
    ok("decision is still COMBO_BUY", r.decision === CE.DECISION.BUY, r.decision);
    ok("one message sent", notifier.calls.length === 1, notifier.calls.length);
    const t = notifier.calls[0] || "";
    ok("it is the COMPACT ping (🟠 Sharp Signals Updated)", /🟠 Sharp Signals Updated/.test(t), t);
    ok("...naming a combo bet is available", /A combo bet is available\./.test(t));
    ok("...linking the dashboard", /Open: https:\/\/sharp-signals-dashboard\.vercel\.app/.test(t));
    ok("...and NOT the full body (no legs/prices/correlation)", !/🎯 COMBO BUY/.test(t) && !/Correlation assessment/.test(t) && !/MAX BUY PRICE/.test(t), t);
    ok("...carrying no ¢ price or $ stake", !/¢|\$\d/.test(t), t);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
