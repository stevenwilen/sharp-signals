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

  // Cadence intervals were LOOSENED (cost-tolerant) to reduce the evidence bottleneck: catch a freshly
  // posted prediction video within ~2h instead of up to 24h. Collect (Gemini extraction) is cache-guarded
  // (only NEW videos re-extract), so more frequent collect is cheap. The real ceiling is GitHub cron
  // reliability, not this interval. Tunable per env if a stage needs to go tighter/looser.
  let tier, evidenceEveryH, forecastEveryH;
  if (hoursToBell > 168) { tier = "outside-fight-week"; evidenceEveryH = 6; forecastEveryH = 6; }
  else if (hoursToBell > 48) { tier = "fight-week"; evidenceEveryH = 2; forecastEveryH = 2; }
  else if (hoursToBell > 6) { tier = "final-48h"; evidenceEveryH = 1; forecastEveryH = 1; }
  else if (hoursToBell > -6) { tier = "fight-day"; evidenceEveryH = 1; forecastEveryH = 1; }
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
  // confidence — the pick engine reruns whenever a forecast is (re)sealed (it needs the card's bouts).
  due.confidence = due.forecast;
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
    if (!cards.has(c.eventDate)) cards.set(c.eventDate, { ...c, bouts: 0, startMs: Infinity });
    const card = cards.get(c.eventDate);
    card.bouts++;
    // REAL scheduled fight time from Kalshi (occurrence_datetime), not the 22:00 convention — cards are on
    // different days AND different times. Take the earliest bout on the card = when the action starts.
    const occ = Date.parse(m.occurrence_datetime || m.expected_expiration_time || "");
    if (Number.isFinite(occ) && occ < card.startMs) card.startMs = occ;
  }
  if (!cards.size) return null;
  for (const c of cards.values()) c.startTime = Number.isFinite(c.startMs) ? new Date(c.startMs).toISOString() : null;
  // The SOONEST card is the active one — but a card whose start passed more than 24h ago is FINISHED,
  // however long Kalshi keeps a rescheduled market open on it. One lingering market used to pin the prior
  // card active for up to a week, starving the next card of collect/forecast/alerts while every run exited
  // green (rollover starvation). Uses the real start time when Kalshi gives one, the 22:00 bell otherwise.
  const cardBell = (c) => (Number.isFinite(c.startMs) ? c.startMs : firstBellMs(c.eventDate));
  const live = [...cards.values()].filter((c) => Date.now() < cardBell(c) + 24 * 3600e3);
  if (!live.length) return null;
  return live.sort((a, b) => cardBell(a) - cardBell(b))[0];
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
      if (okGrade) run("run-grade-channels.js", [], { allowFail: true });    // re-rank the CHANNELS on the new results
      if (okGrade) run("run-fit-calibration.js", [], { allowFail: true });   // refit the % calibration on the new results
      // stamp ONLY on success — a failed grade (settlement not in) must stay due, not look done
      if (okGrade) { const r2 = readReceipts(); (r2.gradedCards = r2.gradedCards || {})[d] = new Date().toISOString(); persistReceipts(r2); }
    }
  }

  if (!card) { say("[dispatch] no open KXUFCFIGHT card found — nothing else to do."); return 0; }
  say(`[dispatch] active card: ${card.eventId} (${card.tickerDate}), ${card.bouts} bouts, starts ${card.startTime || `~${new Date(firstBellMs(card.eventDate)).toISOString()} (22:00 fallback)`}`);

  const receipts = readReceipts();
  // remember the active card so its grade can run after its markets close (see above)
  receipts.lastCard = { eventId: card.eventId, eventDate: card.eventDate, tickerDate: card.tickerDate, startTime: card.startTime || null };
  // ROLLOVER RECENCY (certification fix): a stage receipt stamped for a DIFFERENT card is not recency
  // for THIS card. Without this, a fresh card inherited the old card's ranAt and waited a full cadence
  // interval before its first collect/forecast — a silent dead window at every rollover.
  for (const st of ["collect", "forecast", "confidence", "grade"]) {
    if (receipts[st] && receipts[st].card && receipts[st].card !== card.eventId) delete receipts[st];
  }
  persistReceipts(receipts);
  const plan = decideDueStages(card.eventDate, nowMs, receipts);
  // A --force value that names no real stage used to sail straight through: dueList was ["alerts"],
  // nothing matched it, and the run reported "done" having executed nothing. The workflow's own input
  // description still offered `alerts` months after that stage was renamed `confidence`, so the one
  // documented way to force a re-run was a silent no-op. Fail loudly instead.
  const STAGES = ["collect", "forecast", "confidence", "grade"];
  if (force && !STAGES.includes(force)) fail(`--force=${force} is not a stage. Valid: ${STAGES.join(" | ")}`);
  const dueList = force ? [force] : Object.entries(plan.due).filter(([, v]) => v).map(([k2]) => k2);
  // Confidence always follows a forecast: a re-sealed forecast (or freshly extracted picks) can change
  // the consensus, so the pick engine reruns whenever the forecast does — due or forced.
  if (dueList.includes("forecast") && !dueList.includes("confidence")) dueList.push("confidence");
  say(`[dispatch] tier ${plan.tier} · ${plan.hoursToBell}h to bell · due: ${dueList.length ? dueList.join(", ") : "nothing"}${force ? ` (forced: ${force})` : ""}`);

  if (dry) { say(`[dispatch] --dry: would run [${dueList.join(", ")}]. Nothing executed.`); return 0; }

  const td = card.tickerDate, ed = card.eventDate, seal = nowIso;
  const sel = `data/card-selection-${ed}.json`;
  const ceEvidence = `data/card-evidence-${ed}.json`;
  const evalFile = `data/evidence-eval-${ed}.json`;
  const forecastFile = `data/forecast-${ed}.json`;

  // Nothing on the forecast cadence is due. Confidence rides the forecast stage (it needs fresh picks and
  // the sealed bouts), so there is nothing to produce between forecasts.
  if (!dueList.length) { say("[dispatch] nothing due this run."); return 0; }

  // COLLECT — card selection + evidence extraction (Gemini). The expensive stage; caches transcripts
  // and extractions so a re-forecast does not re-pay.
  if (dueList.includes("collect")) {
    // INGEST FIRST — discover + transcribe + extract NEW prediction videos into data/picks, so selection
    // scans a FRESH corpus. Without this the dispatcher just re-processed a frozen set and the confidence
    // never changed (the ingest was lost when the old pipeline was torn out). Key-free (RSS) + cached, so
    // it is cheap; non-fatal so a discovery hiccup never blocks the rest of collect.
    run("run-ingest.js", [], { allowFail: true });
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
    // (removed: phase7-seal / seal-scenarios / attest — those sealed the forecast for the old betting
    //  integrity/alert-gate path. The confidence engine reads only the bout list run-forecast writes.)
    stamp(receipts, "forecast", { card: card.eventId, seal });
  }

  // SELF-HEAL THE CHANNEL RECORD. The weights read `edge`/`edgeLcb` (edge vs the field). A record
  // written by the old ROI-vs-the-line grading has neither, so every channel would silently fall to
  // tier D and the consensus would go flat — a degradation with no error anywhere. Rather than ship a
  // regenerated data file (the cloud owns data/, and a local data commit conflicts on every rebase),
  // the dispatcher notices the incompatible record and rebuilds it once. Normally a no-op.
  {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sources_graded.json"), "utf8")); } catch { /* missing == needs building */ }
    const entries = rec ? Object.values(rec) : [];
    if (!entries.length || !entries.some((e) => e && e.edge != null)) {
      say("[dispatch] channel record is missing or predates edge-vs-field grading — rebuilding it once");
      run("run-grade-channels.js", [], { allowFail: true });
    }
  }

  // CONFIDENCE — the pick engine. On every (re)forecast, rebuild the rank-weighted consensus for the card
  // from the pick corpus and write data/card-confidence-<date>.json (pick, calibrated %, coverage, tier,
  // why, who) for the dashboard. This is the system's only output surface — no Telegram, no price, no
  // stake, no order path. Reads the sealed bouts + evidence-eval + the channel ranking off disk.
  if (dueList.includes("confidence")) {
    run("run-confidence.js", [ed]);
    stamp(receipts, "confidence", { card: card.eventId });
  }

  // GRADE — post-fight. Append-only. THREE things learn from a settled card, and for a month only two
  // of them were wired:
  //   1. the FORECAST is graded against real Kalshi outcomes    (run-grade-card)
  //   2. the CHANNELS are re-ranked on who actually called it   (run-grade-channels)
  //   3. the CALIBRATION is refit so "%" keeps meaning "won about that often" (run-fit-calibration)
  // (2) was the missing one: data/sources_graded.json — the file that decides how much each channel's
  // vote is worth — was last written 2026-07-16, so six settled cards changed no weights at all. Every
  // grade verifies the seal before reading any outcome, so none of this is hindsight.
  if (dueList.includes("grade")) {
    // Stamp the receipt (and the per-card graded record) ONLY when the grade actually succeeded — a
    // failed grade must stay due, not look done. A settlement that isn't in yet is exactly that case.
    let okGrade = false;
    if (fs.existsSync(path.join(ROOT, forecastFile))) okGrade = run("run-grade-card.js", [forecastFile, "--write"], { allowFail: true });
    // Re-rank the channels, then refit the calibration, now that another card's results are in.
    run("run-grade-channels.js", [], { allowFail: true });
    run("run-fit-calibration.js", [], { allowFail: true });
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
