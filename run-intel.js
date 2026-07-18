// FIGHT INTELLIGENCE — the cloud/manual entry point (§13). Runs the automated report lifecycle on the
// SAME cached evidence and SEALED forecast the rest of the pipeline produced. No re-extraction, no
// second forecast. In shadow mode it records + dashboards only and sends no Telegram.
//
//   node run-intel.js data/forecast-<card>.json --eval=data/evidence-eval-<card>.json [--send]
//
// --send is honoured ONLY with FIGHT_INTEL_ENABLED=1 AND SHARP_PRODUCTION=1. Absent either, it is
// shadow: the phone receives nothing and the old HUMAN REVIEW path is untouched.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const PIPE = require("./lib/intel-pipeline");
const { productionEnabled } = require("./lib/arming");
const N = require("./lib/evidence-eval").norm;

const say = (s) => process.stdout.write(s + "\n");
const arg = (k) => { const p = process.argv.find((a) => a.startsWith(`--${k}=`)); return p ? p.split("=").slice(1).join("=") : null; };
const flag = (k) => process.argv.includes(`--${k}`);

function readJson(f) { return JSON.parse(fs.readFileSync(f, "utf8")); }

// Build the pipeline batch + forecast/market maps from the sealed artifacts. Reuses the evaluator's own
// topic shape (about/topic/direction/origin/claims) so origins are never recounted here. `cardDate` is
// the YYYY-MM-DD the dashboard keys on — it MUST be a string (forecast.card can be an object), so the
// store lands at intelligence-<date>.json where the dashboard looks for it.
function build(forecast, evalData, cardDate) {
  const card = cardDate;
  const eventId = cardDate;   // stable per card, so a story keeps its id across runs
  const forecastByBout = {}, marketByBout = {}, bouts = [];
  const evalBouts = (evalData && evalData.bouts) || [];
  for (const f of forecast.forecasts || []) {
    forecastByBout[f.boutId] = { ...f, sealHash: forecast.sealHash };
    const eb = evalBouts.find((b) => b.boutId === f.boutId);
    // IDENTITY REFUSAL (certification fix): boutId is a POSITIONAL index that renumbers when a bout
    // drops off the card. Joining on it alone once bound a Kevin Holland rumour to Usman's bout. If the
    // eval bout and the forecast disagree about which FIGHT this is, refuse the topics (fail closed)
    // rather than attach intelligence to the wrong fighters.
    const identityOk = !eb || !eb.fight || !f.fight || eb.fight === f.fight;
    const topics = (identityOk && eb && eb.topics) || [];
    if (!identityOk) say(`[intel] ⛔ identity refusal: ${f.boutId} is "${f.fight}" in the forecast but "${eb.fight}" in the eval — topics dropped`);
    const [A, B] = String(f.fight || "").split(" vs ");
    const opponentOf = {};
    if (A && B) { opponentOf[N(A)] = B; opponentOf[N(B)] = A; }
    bouts.push({ boutId: f.boutId, fight: f.fight, opponentOf, topics,
      contradictionByKey: contradictions(eb) });
    const mb = f.marketBaseline || {};
    const ask = mb.probability != null ? mb.probability : (mb.price != null ? mb.price : null);
    // fightStarted gates ALL intel alerts once the event begins (§ shouldAlert). This was wired in the
    // message layer but never FED from production — the sentinel runs during the event, so without this
    // flag a mid-event run could still alert on pre-fight intelligence.
    marketByBout[f.boutId] = { kalshiAsk: ask, sportsbook: ask, subject: A || null,
      fightStarted: require("./lib/freshness").fightStarted(card) };
  }
  return { batch: { card, eventId, now: null, bouts }, forecastByBout, marketByBout, seal: forecast.sealedAt || null, card };
}

// Map a bout's evaluated contradictions to the by-key form the pipeline reads (keyed on fighter|topic).
function contradictions(eb) {
  const out = {};
  for (const c of (eb && eb.contradictions) || []) {
    const m = /^(.*) — (.*)$/.exec(c.proposition || "");
    if (!m) continue;
    out[`${N(m[1])}|${m[2]}`] = { disagreementType: c.disagreementType, supportingOrigins: c.supporting && c.supporting.independentOrigins, opposingOrigins: c.opposing && c.opposing.independentOrigins };
  }
  return out;
}

(async () => {
  const forecastFile = process.argv[2];
  const evalFile = arg("eval");
  if (!forecastFile || !fs.existsSync(forecastFile)) { say("[intel] no forecast file — nothing to do."); process.exit(0); }
  const forecast = readJson(forecastFile);
  const evalData = evalFile && fs.existsSync(evalFile) ? readJson(evalFile) : null;

  const enabled = PIPE.enabled();
  const wantSend = flag("send");
  const send = wantSend && enabled && productionEnabled();
  const shadow = !send;
  say(`[intel] FIGHT_INTEL_ENABLED=${enabled ? "1" : "0"} · send=${send} · mode=${shadow ? "SHADOW (no Telegram)" : "LIVE"}`);
  if (!enabled) { say("[intel] lifecycle disabled — recording nothing. (set FIGHT_INTEL_ENABLED=1 to shadow it)"); process.exit(0); }

  // The card date the dashboard keys on comes from the forecast filename (its own convention), never the
  // possibly-object forecast.card field.
  const m = path.basename(forecastFile).match(/forecast-(\d{4}-\d{2}-\d{2})\.json/);
  const cardDate = (m && m[1]) || (typeof forecast.card === "string" ? forecast.card : (forecast.sealedAt || "").slice(0, 10)) || "unknown";
  const { batch, forecastByBout, marketByBout, seal, card } = build(forecast, evalData, cardDate);
  const now = new Date().toISOString();
  const r = await PIPE.runIntel({ card, batch, forecastByBout, marketByBout, seal, now, send, dashboard: process.env.DASHBOARD_URL || null });

  const counts = {};
  for (const res of r.results) counts[res.action] = (counts[res.action] || 0) + 1;
  say(`[intel] ${r.results.length} record(s): ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  say(`[intel] ${shadow ? "SHADOW — 0 Telegram sent" : `${r.messages.length} Telegram message(s) sent`}. Persisted data/intelligence-${card}.json`);
  process.exit(0);
})().catch((e) => { say(`[intel] error: ${e && e.message}`); process.exit(1); });
