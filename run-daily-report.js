// DAILY SYSTEM ACTIVITY REPORT — build it, persist the full detail for the dashboard, and (with --send)
// push ONE compact receipt to Telegram. This is a health receipt, NOT a bet. It never places or lists an
// order; it only reads artifacts and reports. Exit non-zero if it cannot build its artifact (house rule:
// a script that exits 0 without producing its artifact is a failure).
//
//   node run-daily-report.js                 # build + write dashboard JSON, print the message, DO NOT send
//   node run-daily-report.js --send          # also push to Telegram (once — guarded by the report file)
//   node run-daily-report.js --now=<ISO>     # pretend "now" is a given instant (testing / backfill)
require("./lib/env");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const DR = require("./lib/daily-report");

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const argv = (k) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split("=").slice(1).join("=") : null; };
const flag = (k) => process.argv.includes(`--${k}`);
const say = (s) => process.stdout.write(s + "\n");

function load(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")); } catch { return null; }
}

// unified-v2 run history for the day, via gh (present locally and on GitHub runners). Null if unavailable —
// which is honest: the report then renders run counts as "—" rather than inventing them, and the verdict
// falls back to the receipts (collect/forecast ran today) as the reliable "did the pipeline run" signal.
function fetchRuns() {
  try {
    const out = execFileSync("gh", ["run", "list", "--workflow", "unified-v2.yml", "--limit", "200",
      "--json", "conclusion,createdAt,status"], { cwd: __dirname, timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return JSON.parse(out).filter((r) => r.status === "completed").map((r) => ({ conclusion: r.conclusion, createdAt: r.createdAt }));
  } catch { return null; }
}

function tzNow() {
  const nowMs = argv("now") ? Date.parse(argv("now")) : Date.now();
  const tz = process.env.REPORT_TZ || "America/New_York";
  return { nowMs, tz, reportDate: DR.dayKey(nowMs, tz) };
}

function activeCard(receipts) {
  const c = receipts && receipts.lastCard;
  if (!c) return { eventId: null, eventDate: null, active: false };
  const bellMs = c.eventDate ? Date.parse(c.eventDate + "T22:00:00Z") : null;   // card is "active" until first bell has passed
  const active = bellMs ? Date.now() < bellMs + 6 * 3.6e6 : false;              // (+6h margin, matches the post-card tier)
  return { eventId: c.eventId, eventDate: c.eventDate, active };
}

function telegramSendsToday(intel, ent, reportDate, tz) {
  let n = 0;
  for (const r of Object.values((intel && intel.records) || {}))
    for (const m of r.telegramLineage || []) if (m.sentAt && DR.dayKey(Date.parse(m.sentAt), tz) === reportDate) n++;
  if (ent && DR.dayKey(Date.parse(ent.ranAt || 0), tz) === reportDate) n += (ent.delivery || {}).delivered || 0;
  return n;
}

async function main() {
  const { nowMs, tz, reportDate } = tzNow();
  const receipts = load("dispatch-receipts.json");
  const card = activeCard(receipts);
  const d = card.eventDate;   // "2026-07-25"

  const intel = d ? load(`intelligence-${d}.json`) : null;
  const ent = d ? load(`entertainment-alerts-${d}.json`) : null;
  const runs = fetchRuns();

  const report = DR.buildReport({
    now: nowMs, tz, reportDate,
    cardActive: card.active,
    expectedRunsToday: 6 * DR.hourIn(nowMs, tz),          // external trigger fires ~every 10 min = 6/hour
    receipts,
    forecast: d ? load(`forecast-${d}.json`) : null,
    intelligence: intel,
    entertainment: ent,
    research: load("research-ledger.json"),
    bankrolls: load("bankrolls.json"),
    manualBankroll: load("manual-bankroll.json"),
    paperLedger: load("paper-ledger.json"),
    candidateIndex: load("candidate-index-status.json"),
    coverage: d ? load(`coverage-search-${d}.json`) : null,
    cardEvidence: d ? load(`card-evidence-${d}.json`) : null,
    alertLedger: load("alert-ledger-v2.json"),
    geminiUsage: load("gemini-usage.json"),
    combo: d ? load(`combo-${d}.json`) : null,
    comboEnabled: process.env.COMBO_ENABLED === "1",
    researchModeEnv: process.env.RESEARCH_MODE || null,
    runs,
    telegramSends: telegramSendsToday(intel, ent, reportDate, tz),
  });

  const message = DR.formatTelegram(report);
  report.telegramMessage = message;

  // persist the FULL detail for the dashboard (the receipt lives on Telegram; the detail lives here)
  const outFile = path.join(DATA, `daily-report-${reportDate}.json`);
  const prior = load(`daily-report-${reportDate}.json`);
  const alreadySent = prior && prior.telegramSentAt;
  report.telegramSentAt = alreadySent || null;

  say(message);
  say(`\n--- status: ${report.status} ---`);

  if (flag("send") && !flag("dry")) {
    if (alreadySent) { say(`already sent today at ${alreadySent} — not re-sending (once-per-day guard)`); }
    else {
      const { notify } = require("./lib/notify");
      const res = await notify(message);
      if (res && (res.ok || (res.sent || []).length)) { report.telegramSentAt = new Date(nowMs).toISOString(); say("sent to Telegram ✓"); }
      else { say(`Telegram send FAILED: ${JSON.stringify(res)}`); writeReport(outFile, report); process.exit(1); }
    }
  }
  writeReport(outFile, report);
  if (!fs.existsSync(outFile)) { say(`FATAL: report artifact not written: ${outFile}`); process.exit(1); }
  say(`wrote ${outFile}`);
  return 0;
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
}

main().then((c) => process.exit(c || 0)).catch((e) => { process.stdout.write(`\nFATAL: ${e.message}\n`); process.exit(1); });
