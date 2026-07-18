// UNIFIED DISPATCHER — the single entry point the cloud calls. It decides what work is DUE for the
// active card and runs the existing, tested production scripts in order. It does NOT reimplement any
// pipeline stage; a stage is a real script (make-card-selection, run-forecast, run-attest, ...).
//
//   node dispatch.js [--card=26JUL18] [--now=<ISO>] [--force=collect|forecast|alerts|grade] [--dry]
//
// WHY A DISPATCHER. GitHub cron fires unreliably (measured ~14-40% of schedule on this public repo), so
// a workflow that "runs stage X on cron Y" silently under-runs. Instead every cron just invokes this,
// and this decides — from the card date and a receipts file of last-run times — which stages are due.
// Missed crons self-heal: the next invocation sees the stage is overdue and runs it.
//
// CADENCE (hours until first bell):
//   > 168h  outside fight week : discovery + light evidence, daily
//   48-168h fight week         : full evidence refresh, daily
//   6-48h   final 2 days       : full evidence + forecast, every 6h
//   0-6h    fight day          : full reasoning hourly (15-min price checks are the sentinel's job)
//   < 0h    post-card          : detect settlement, grade
//
// Expensive Gemini extraction (the `collect` stage) is gated to at most the tier interval, never every
// run — a re-forecast reuses the cached evidence.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const k = require("./lib/kalshi");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const argv = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

const ROOT = __dirname;
const RECEIPTS = path.join(ROOT, "data", "dispatch-receipts.json");
const H = 3600 * 1000;

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
// First bell is ~22:00 UTC on the event date for a UFC card. A real, disclosed convention — not a
// synthetic per-price timestamp. Only used to decide CADENCE, never to stamp a forecast.
const firstBellMs = (eventDate) => Date.parse(`${eventDate}T22:00:00Z`);

// Parse a Kalshi event ticker's date segment -> { tickerDate: "26JUL18", eventDate: "2026-07-18" }.
function cardFromTicker(eventTicker) {
  const m = String(eventTicker || "").match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m || MONTHS[m[2]] == null) return null;
  const yyyy = 2000 + Number(m[1]);
  const mm = String(MONTHS[m[2]] + 1).padStart(2, "0");
  const dd = m[3];
  return { tickerDate: `${m[1]}${m[2]}${m[3]}`, eventDate: `${yyyy}-${mm}-${dd}`, eventId: `UFC-${yyyy}-${mm}-${dd}` };
}

// ---------------------------------------------------------------------------------------------
// THE PURE DECISION. Given the card, the current time, and the receipts, which stages are due?
// Pure so it can be unit-tested without touching Kalshi, the clock, or the filesystem.
// ---------------------------------------------------------------------------------------------
function decideDueStages(eventDate, nowMs, receipts) {
  const bell = firstBellMs(eventDate);
  const hoursToBell = (bell - nowMs) / H;

  let tier, evidenceEveryH, forecastEveryH;
  if (hoursToBell > 168) { tier = "outside-fight-week"; evidenceEveryH = 24; forecastEveryH = 24; }
  else if (hoursToBell > 48) { tier = "fight-week"; evidenceEveryH = 24; forecastEveryH = 24; }
  else if (hoursToBell > 6) { tier = "final-48h"; evidenceEveryH = 6; forecastEveryH = 6; }
  else if (hoursToBell > -6) { tier = "fight-day"; evidenceEveryH = 6; forecastEveryH = 1; }
  else { tier = "post-card"; evidenceEveryH = Infinity; forecastEveryH = Infinity; }

  const since = (stage) => {
    const t = Date.parse((receipts[stage] || {}).ranAt || "");
    return Number.isFinite(t) ? (nowMs - t) / H : Infinity;
  };
  const due = {};
  // collect (Gemini extraction) — expensive, so only at the evidence cadence, and never post-card.
  due.collect = tier !== "post-card" && since("collect") >= evidenceEveryH;
  // forecast (eval -> seal -> attest) — at the forecast cadence, and never post-card.
  due.forecast = tier !== "post-card" && since("forecast") >= forecastEveryH;
  // alerts — whenever a forecast is (re)sealed. Piggybacks on forecast.
  due.alerts = due.forecast;
  // grade — post-card only, once, after first bell + a settlement margin.
  due.grade = tier === "post-card" && hoursToBell < -3 && since("grade") >= 24;

  return { tier, hoursToBell: +hoursToBell.toFixed(1), due };
}

// ---------------------------------------------------------------------------------------------
async function discoverCard(forceTickerDate) {
  const open = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" }).catch(() => []);
  const cards = new Map();
  for (const m of open) {
    const c = cardFromTicker(m.event_ticker);
    if (!c) continue;
    if (forceTickerDate && c.tickerDate !== forceTickerDate) continue;
    if (!cards.has(c.eventDate)) cards.set(c.eventDate, { ...c, bouts: 0 });
    cards.get(c.eventDate).bouts++;
  }
  if (!cards.size) return null;
  // The SOONEST card by event date is the active one.
  return [...cards.values()].sort((a, b) => firstBellMs(a.eventDate) - firstBellMs(b.eventDate))[0];
}

const readReceipts = () => { try { return JSON.parse(fs.readFileSync(RECEIPTS, "utf8")); } catch { return {}; } };
function stamp(receipts, stage, extra = {}) {
  receipts[stage] = { ranAt: new Date().toISOString(), ...extra };
}
function persistReceipts(receipts) {
  const tmp = RECEIPTS + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(receipts, null, 2));
  fs.renameSync(tmp, RECEIPTS);
}

// Run a tested production script. Inherits stdio so its output is in the workflow log. Throws on a
// non-zero exit so a failed stage fails the dispatcher (which fails the workflow) — a stage that
// dies must never look like success.
function run(script, args, { allowFail = false } = {}) {
  say(`\n[run] node ${script} ${args.join(" ")}`);
  try { execFileSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: "inherit" }); return true; }
  catch (e) { if (allowFail) { say(`  (non-fatal: ${script} exited ${e.status})`); return false; } throw e; }
}

async function main() {
  const dry = process.argv.includes("--dry");
  const force = argv("force");
  const nowIso = argv("now") || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) fail(`--now=${nowIso} is not a readable timestamp`);

  const card = await discoverCard(argv("card"));
  if (!card) { say("[dispatch] no open KXUFCFIGHT card found — nothing to do."); return 0; }
  say(`[dispatch] active card: ${card.eventId} (${card.tickerDate}), ${card.bouts} bouts, first bell ${new Date(firstBellMs(card.eventDate)).toISOString()}`);

  const receipts = readReceipts();
  const plan = decideDueStages(card.eventDate, nowMs, receipts);
  const dueList = force ? [force] : Object.entries(plan.due).filter(([, v]) => v).map(([k2]) => k2);
  // Alerts always follow a forecast: a re-sealed forecast may have changed the decision, and the alert
  // ledger must get the chance to fire a price/withdrawal/supersede update. This holds whether the
  // forecast was due or forced.
  if (dueList.includes("forecast") && !dueList.includes("alerts")) dueList.push("alerts");
  say(`[dispatch] tier ${plan.tier} · ${plan.hoursToBell}h to bell · due: ${dueList.length ? dueList.join(", ") : "nothing"}${force ? ` (forced: ${force})` : ""}`);

  if (dry) { say(`[dispatch] --dry: would run [${dueList.join(", ")}]. Nothing executed.`); return 0; }
  if (!dueList.length) { say("[dispatch] nothing due this run."); return 0; }

  const td = card.tickerDate, ed = card.eventDate, seal = nowIso;
  const sel = `data/card-selection-${ed}.json`;
  const ceEvidence = `data/card-evidence-${ed}.json`;
  const evalFile = `data/evidence-eval-${ed}.json`;
  const forecastFile = `data/forecast-${ed}.json`;

  // COLLECT — card selection + evidence extraction (Gemini). The expensive stage; caches transcripts
  // and extractions so a re-forecast does not re-pay.
  if (dueList.includes("collect")) {
    run("make-card-selection.js", [td, ed, sel]);
    run("run-card-evidence.js", [sel]);
    stamp(receipts, "collect", { card: card.eventId });
  }

  // FORECAST — evaluate, baseline, seal, attest. Reuses the cached evidence from collect.
  if (dueList.includes("forecast")) {
    if (!fs.existsSync(path.join(ROOT, ceEvidence))) {
      // No evidence cached yet (e.g. forecast forced without a prior collect) — collect first.
      run("make-card-selection.js", [td, ed, sel]);
      run("run-card-evidence.js", [sel]);
    }
    run("run-evidence-eval.js", [ceEvidence]);
    run("run-baselines.js", [`--cards=${td}`], { allowFail: true });
    // --seal=auto: run-forecast fixes the seal AFTER it fetches the live consensus, so every quote
    // provably predates it. Passing a fixed dispatch-start time would make the later live fetch look
    // post-seal and the leakage guard would (correctly) refuse it.
    run("run-forecast.js", [evalFile, "--seal=auto", "--live"]);
    run("run-phase7-seal.js", [forecastFile, evalFile], { allowFail: true });
    run("run-seal-scenarios.js", [forecastFile, evalFile], { allowFail: true });
    run("run-phase8-shadow.js", [forecastFile], { allowFail: true });
    run("run-attest.js", [forecastFile, `--eval=${evalFile}`, "--ttl-hours=12", "--write"]);
    stamp(receipts, "forecast", { card: card.eventId, seal });
  }

  // ALERTS — the unified decision + Telegram. --send is honoured only if the 3-gate arming clears
  // (ALERTS_ARMED + matching attestation + SHARP_PRODUCTION); otherwise it self-reports TEST mode.
  if (dueList.includes("alerts")) {
    run("run-entertainment-alerts.js", [forecastFile, `--eval=${evalFile}`, "--send"]);
    stamp(receipts, "alerts", { card: card.eventId });
  }

  // FIGHT INTELLIGENCE (shadow) — the automated report lifecycle, on the SAME cached evidence and sealed
  // forecast (no re-extraction, so it honours the recheck cadence cheaply). In shadow it records +
  // dashboards only and sends NO Telegram, so it cannot touch the production alert path. Non-fatal: it
  // may never break the forecast/alerts pipeline while it is being validated. Off unless
  // FIGHT_INTEL_ENABLED=1; --send is deliberately NOT passed until the shadow is switched to production.
  if (process.env.FIGHT_INTEL_ENABLED === "1" && (dueList.includes("alerts") || dueList.includes("forecast"))) {
    const intelArgs = [forecastFile, `--eval=${evalFile}`];
    // TWO gates, both reversible repo variables: FIGHT_INTEL_ENABLED=1 shadows (records only);
    // FIGHT_INTEL_SEND=1 promotes it to production (adds --send, and the legacy HUMAN REVIEW send is
    // suppressed in run-entertainment-alerts). run-intel still requires SHARP_PRODUCTION to actually send.
    if (process.env.FIGHT_INTEL_SEND === "1") intelArgs.push("--send");
    run("run-intel.js", intelArgs, { allowFail: true });
  }

  // GRADE — post-fight. Append-only. Grades the SEALED forecast against real Kalshi outcomes (log
  // loss vs the market prior — did the forecast improve on the market, not just "did the pick win").
  // Also runs the scenario grader if a sealed scenario set exists. Both verify the seal before reading
  // any outcome, so a grade can never be an artifact of hindsight.
  if (dueList.includes("grade")) {
    if (fs.existsSync(path.join(ROOT, forecastFile))) run("run-grade-card.js", [forecastFile, "--write"], { allowFail: true });
    const scen = `data/scenarios-ranked-${ed}.json`;
    if (fs.existsSync(path.join(ROOT, scen))) run("run-scenario-eval.js", [scen], { allowFail: true });
    run("run-convergence-eval.js", ["--write"], { allowFail: true });   // update the read-only convergence record
    stamp(receipts, "grade", { card: card.eventId });
  }

  persistReceipts(receipts);
  say(`\n[dispatch] done. receipts updated: ${dueList.join(", ")}`);
  return 0;
}

if (require.main === module) {
  main().then((c) => { if (!LINES) process.stdout.write("FATAL: no output\n"); process.exit(c || 0); })
    .catch((e) => { say(`\nFATAL: ${e.message}`); process.exit(1); });
}

module.exports = { decideDueStages, cardFromTicker, firstBellMs };
