// COMBO PIPELINE end-to-end: gather sealed BUY legs across cards, evaluate, and (enabled + sending)
// deliver ONE message — with the combo recorded as a SEPARATE manual recommendation that never enters
// real P&L, deduped so an unchanged re-run is silent, and gated off once a leg's card has begun.
const os = require("os"), fs = require("fs"), pathm = require("path");
const TMP = pathm.join(os.tmpdir(), "ss-combo-pipeline-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;
process.env.COMBO_ENABLED = "1";
const PIPE = require("../lib/combo-pipeline");
const CE = require("../lib/combo-engine");
const MB = require("../lib/manual-bankroll");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

// Two sealed cards, each with ONE BUY leg, on different future events (independent).
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
const NOW = Date.parse("2026-08-20T12:00:00Z");   // before both bells

(async () => {
  console.log("TWO BUY LEGS + A GOOD QUOTE → ONE COMBO BUY (recorded as a separate manual recommendation)");
  {
    const notifier = spy();
    const r = await PIPE.runCombo({ now: NOW, send: true, quoteProvider: goodQuote, notifier });
    ok("2 eligible legs across cards", r.legs === 2, r.legs);
    ok("decision is COMBO_BUY", r.decision === CE.DECISION.BUY, r.decision + ": " + r.reason);
    ok("exactly one message sent", notifier.calls.length === 1);
    ok("it is a COMBO BUY message", /🎯 COMBO BUY/.test(notifier.calls[0]) && /Correlation assessment: independent/.test(notifier.calls[0]));
    // separate bankroll record, $0 real P&L
    const mb = MB.load();
    const combo = Object.values(mb.entries || {}).find((e) => e.lane === "combo");
    ok("the combo is recorded as a SEPARATE manual recommendation", !!combo && combo.status === "RECOMMENDED_NOT_CONFIRMED");
    ok("...contributing $0 to real P&L until confirmed", MB.realBankrollPnl(mb).realDollarsDeployed === 0);
  }

  console.log("\nUNCHANGED RE-RUN SENDS NO DUPLICATE");
  {
    const notifier = spy();
    const r = await PIPE.runCombo({ now: NOW, send: true, quoteProvider: goodQuote, notifier });
    ok("same combo, same quote → no duplicate", notifier.calls.length === 0, notifier.calls.length);
    ok("still a BUY decision (idempotent)", r.decision === CE.DECISION.BUY);
  }

  console.log("\nNO LIVE QUOTE → COMBO UNAVAILABLE (the read-only reality)");
  {
    const notifier = spy();
    const r = await PIPE.runCombo({ now: NOW, send: true, quoteProvider: async () => ({ available: false, reason: "no readable combo market", requiresWritePath: true }), notifier });
    ok("decision is COMBO_UNAVAILABLE", r.decision === CE.DECISION.UNAVAILABLE, r.decision);
    ok("...and UNAVAILABLE is not blasted to Telegram (awareness, quiet)", notifier.calls.every((t) => !/COMBO BUY/.test(t)));
  }

  console.log("\nFIGHT-START GATE — once a leg's card has begun, no combos");
  {
    const afterBell = Date.parse("2026-09-01T22:30:00Z");   // Alice's card started; Carol's not
    const r = await PIPE.runCombo({ now: afterBell, send: true, quoteProvider: goodQuote, notifier: spy() });
    ok("a started leg drops out → fewer than 2 legs → NO_COMBO_BET", r.decision === CE.DECISION.NO_BET && r.legs < 2, `${r.decision}/${r.legs}`);
  }

  console.log("\nSHADOW MODE SENDS NOTHING");
  {
    const notifier = spy();
    const r = await PIPE.runCombo({ now: NOW, send: false, quoteProvider: goodQuote, notifier });
    ok("send=false → shadow, no Telegram", r.shadow === true && notifier.calls.length === 0);
    ok("...but the decision + audit are still computed", r.decision === CE.DECISION.BUY);
    ok("audit record persisted for the combo", fs.existsSync(PIPE.AUDIT_FILE()));
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
