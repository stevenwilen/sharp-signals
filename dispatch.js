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
  // A Kalshi OUTAGE must be distinguishable from "no card this week": an outage used to yield [] and a
  // clean green exit, silently skipping every stage. Now the error is surfaced (loudly logged + flagged
  // on the receipts) while remaining non-fatal — a transient blip self-heals next cron.
  let fetchFailed = null;
  const open = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" })
    .catch((e) => { fetchFailed = e && e.message || "unknown"; return []; });
  if (fetchFailed) {
    say(`[dispatch] ⚠ KALSHI FETCH FAILED (${fetchFailed}) — this is an OUTAGE, not "no card"; skipping this cycle, next cron self-heals`);
    const r = readReceipts(); r.kalshiFetchFailed = { at: new Date().toISOString(), error: String(fetchFailed).slice(0, 200) }; persistReceipts(r);
    return null;
  }
  { const r = readReceipts(); if (r.kalshiFetchFailed) { delete r.kalshiFetchFailed; persistReceipts(r); } }
  const cards = new Map();
  for (const m of open) {
    const c = cardFromTicker(m.event_ticker);
    if (!c) continue;
    if (forceTickerDate && c.tickerDate !== forceTickerDate) continue;
    if (!cards.has(c.eventDate)) cards.set(c.eventDate, { ...c, bouts: 0 });
    cards.get(c.eventDate).bouts++;
  }
  if (!cards.size) return null;
  // The SOONEST card by event date is the active one — but a card whose bell passed more than 24h ago
  // is FINISHED, however long Kalshi keeps a rescheduled market open on it. One lingering market used
  // to pin the prior card active for up to a week, starving the next card of collect/forecast/alerts
  // while every run exited green (rollover starvation). Grading no longer needs discovery (the
  // gradedCards sweep grades from disk), so a finished card can simply be released.
  const live = [...cards.values()].filter((c) => Date.now() < firstBellMs(c.eventDate) + 24 * 3600e3);
  if (!live.length) return null;
  return live.sort((a, b) => firstBellMs(a.eventDate) - firstBellMs(b.eventDate))[0];
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

  // ROLLOVER-SAFE GRADING (certification fix). Grading used to be structurally unreachable: card
  // discovery requires OPEN markets, but a settled card's markets are closed — so the moment an event
  // finished, the dispatcher could no longer see the card it needed to grade, and post-card learning
  // silently never ran. The last active card is now remembered on the receipts, and once its bell has
  // passed, its grade runs regardless of whether Kalshi still lists it — even after the NEXT card has
  // become active. Idempotent: gradedCards records each card once.
  {
    const r = readReceipts();
    const graded = r.gradedCards || {};
    // Every past sealed forecast on disk that has never been graded is due — not just the most recent
    // card. Discovery is NOT required (a settled card's markets are closed and gone from the board);
    // grading works from the sealed file + Kalshi settlement reads. Bounded to 3 cards per run.
    const ungraded = fs.readdirSync(path.join(ROOT, "data"))
      .map((f) => (f.match(/^forecast-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean)
      .filter((d) => !graded[d] && nowMs > firstBellMs(d) + 6 * 3600e3 && (!card || card.eventDate !== d))
      .sort().slice(-3);
    for (const d of ungraded) {
      say(`[dispatch] grading past card ${d} (settled; discovery not required)`);
      if (dry) continue;
      const okGrade = run("run-grade-card.js", [`data/forecast-${d}.json`, "--write"], { allowFail: true });
      const scen = `data/scenarios-ranked-${d}.json`;
      if (fs.existsSync(path.join(ROOT, scen))) run("run-scenario-eval.js", [scen], { allowFail: true });
      run("run-convergence-eval.js", ["--write"], { allowFail: true });
      // stamp ONLY on success — a failed grade (settlement not in) must stay due, not look done
      if (okGrade) { const r2 = readReceipts(); (r2.gradedCards = r2.gradedCards || {})[d] = new Date().toISOString(); persistReceipts(r2); }
    }
  }

  if (!card) { say("[dispatch] no open KXUFCFIGHT card found — nothing else to do."); return 0; }
  say(`[dispatch] active card: ${card.eventId} (${card.tickerDate}), ${card.bouts} bouts, first bell ${new Date(firstBellMs(card.eventDate)).toISOString()}`);

  const receipts = readReceipts();
  // remember the active card so its grade can run after its markets close (see above)
  receipts.lastCard = { eventId: card.eventId, eventDate: card.eventDate, tickerDate: card.tickerDate };
  // ROLLOVER RECENCY (certification fix): a stage receipt stamped for a DIFFERENT card is not recency
  // for THIS card. Without this, a fresh card inherited the old card's ranAt and waited a full cadence
  // interval before its first collect/forecast — a silent dead window at every rollover.
  for (const st of ["collect", "forecast", "alerts", "grade"]) {
    if (receipts[st] && receipts[st].card && receipts[st].card !== card.eventId) delete receipts[st];
  }
  persistReceipts(receipts);
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

    // COVERAGE-GATED PER-FIGHT SEARCH (opt-in, shadow; default OFF). For each bout the ~50-channel roster
    // leaves UNDER-COVERED (< COVERAGE_MIN_ORIGINS independent origins), YouTube-search "<A> vs <B>
    // prediction" and ingest the hits through the SAME transcript/extract/picks path, then re-run
    // selection+evidence so they fold into the corpus before the forecast stage. It ADDS candidate videos
    // only — the frozen originAnalysis re-decides independence, so it can never assert an origin or amplify a
    // well-covered fight. Non-fatal; run-coverage-search fails closed on a missing key and caps the search
    // at COVERAGE_MAX_BOUTS to protect the shared YouTube quota.
    if (process.env.COVERAGE_SEARCH_ENABLED === "1") {
      run("run-evidence-eval.js", [ceEvidence], { allowFail: true });          // cheap: materialize per-bout origins
      run("run-coverage-search.js", [evalFile, sel], { allowFail: true });     // gate + search + ingest
      run("make-card-selection.js", [td, ed, sel], { allowFail: true });       // fold searched videos into selection
      run("run-card-evidence.js", [sel], { allowFail: true });                 // tag their claims to bouts
    }
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

  // COMBO ENGINE — runs AFTER the individual recommendation cycle, on the SAME sealed singles. Gated by
  // COMBO_ENABLED (shadow: records + audit only, no Telegram); --send only when it is promoted. Reads
  // sealed artifacts, adds no forecast, has no order path. Non-fatal.
  if (process.env.COMBO_ENABLED === "1" && (dueList.includes("alerts") || dueList.includes("forecast"))) {
    const comboArgs = process.env.COMBO_SEND === "1" ? ["--send"] : [];
    run("run-combo.js", comboArgs, { allowFail: true });
  }

  // PAPER STRATEGY LEDGER — auto-creates $10,000 paper positions for FORMAL system BUYs (core + formal
  // combo) from the SAME sealed artifacts, settles resolved ones read-only, and refreshes the canonical
  // data/bankrolls.json both dashboards read. No real money, no order path, no Telegram. Always on (paper
  // is simulated, not gated by arming). Non-fatal. --settle only when a grade is due (outcomes may be in).
  if (dueList.includes("alerts") || dueList.includes("forecast") || dueList.includes("grade")) {
    run("run-paper.js", dueList.includes("grade") ? ["--settle"] : [], { allowFail: true });
  }

  // SPECULATIVE RESEARCH PORTFOLIO (isolated experiment) — ONE-WAY: reads sealed artifacts, writes only
  // its own ledger/health. Spawned as a child process, so dispatch (and all production) never imports the
  // research module — the isolation invariant is "no research->production dependency", grep-enforced by
  // test-research-isolation. Opt-in + FAIL-CLOSED: only spawned when RESEARCH_ENABLED=1 (RESEARCH_MODE in
  // {OBSERVE,PAPER} decides observe-only vs funded, inside the runner). With RESEARCH_ENABLED unset it is
  // never invoked, so removing it is a no-op for production. The runner fingerprints its inputs and skips
  // when unchanged, so this is cheap and idempotent. Non-fatal — research must never break the pipeline.
  if (process.env.RESEARCH_ENABLED === "1" && (dueList.includes("alerts") || dueList.includes("forecast") || dueList.includes("grade"))) {
    run("run-research.js", dueList.includes("grade") ? ["--settle"] : [], { allowFail: true });
  }

  // GRADE — post-fight. Append-only. Grades the SEALED forecast against real Kalshi outcomes (log
  // loss vs the market prior — did the forecast improve on the market, not just "did the pick win").
  // Also runs the scenario grader if a sealed scenario set exists. Both verify the seal before reading
  // any outcome, so a grade can never be an artifact of hindsight.
  if (dueList.includes("grade")) {
    // Stamp the receipt (and the per-card graded record) ONLY when the grade actually succeeded — a
    // failed grade must stay due, not look done. A settlement that isn't in yet is exactly that case.
    let okGrade = false;
    if (fs.existsSync(path.join(ROOT, forecastFile))) okGrade = run("run-grade-card.js", [forecastFile, "--write"], { allowFail: true });
    const scen = `data/scenarios-ranked-${ed}.json`;
    if (fs.existsSync(path.join(ROOT, scen))) run("run-scenario-eval.js", [scen], { allowFail: true });
    run("run-convergence-eval.js", ["--write"], { allowFail: true });   // update the read-only convergence record
    if (okGrade) {
      stamp(receipts, "grade", { card: card.eventId });
      (receipts.gradedCards = receipts.gradedCards || {})[ed] = new Date().toISOString();
    } else {
      say("[dispatch] grade did not complete (settlement likely not in) — staying due for the next cycle");
    }
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
