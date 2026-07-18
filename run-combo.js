// COMBO ENGINE — cloud/manual entry. Runs AFTER the individual recommendation cycle. Reads sealed
// singles, decides COMBO_BUY / COMBO_PRICE_TOO_HIGH / NO_COMBO_BET / COMBO_UNAVAILABLE, and (only with
// COMBO_ENABLED=1 + SHARP_PRODUCTION=1 + --send) sends one Telegram message. Never places anything.
//
//   node run-combo.js [--send]
require("./lib/env");
const PIPE = require("./lib/combo-pipeline");
const { productionEnabled } = require("./lib/arming");

const say = (s) => process.stdout.write(s + "\n");

(async () => {
  const enabled = PIPE.enabled();
  const wantSend = process.argv.includes("--send");
  const send = wantSend && enabled && productionEnabled();
  say(`[combo] COMBO_ENABLED=${enabled ? "1" : "0"} · send=${send} · mode=${send ? "LIVE" : "SHADOW (no Telegram)"}`);
  if (!enabled) { say("[combo] disabled — set COMBO_ENABLED=1 to shadow it."); process.exit(0); }

  const r = await PIPE.runCombo({ send });
  say(`[combo] ${r.legs} eligible leg(s), ${r.combosAnalyzed || 0} combination(s) analyzed -> ${r.decision}: ${r.reason}`);
  say(`[combo] ${r.shadow ? "SHADOW — 0 Telegram sent" : `${r.sent.length} Telegram message(s) sent`}`);
  process.exit(0);
})().catch((e) => { say(`[combo] error: ${e && e.message}`); process.exit(1); });
