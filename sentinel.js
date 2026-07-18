// FIGHT-DAY SENTINEL — the bounded loop that does 15-minute price checks inside ONE GitHub Actions job.
//
//   node sentinel.js [--minutes=300] [--interval-sec=900] [--iterations=N] [--once]
//
// WHY A LOOP INSIDE ONE JOB. GitHub cron cannot reliably fire every 15 minutes (measured ~14% of a
// */15 schedule on this public repo). So on fight day a single job starts this sentinel, which loops
// on a REAL 15-minute wall-clock interval until its time budget runs out. Cron only has to land the
// job once.
//
// Each iteration is CHEAP: it re-runs the unified alert path (run-entertainment-alerts.js), which
// re-values the listed contracts against current Kalshi prices and lets the alert ledger fire its
// price-crossed / became-actionable / withdrawn triggers. NO Gemini extraction, no re-forecast — the
// sealed forecast is fixed for the card; only prices move.
//
// Durability: after any iteration that changed the alert ledger (i.e. may have sent a message), the
// sentinel persists immediately, so a cancelled job never loses the record of what it sent and cannot
// re-send on the next run. SIGTERM (GitHub's cancellation signal) is caught and drains one final
// persist before exiting.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { notify } = require("./lib/notify");

const ROOT = __dirname;
const argv = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const say = (s) => process.stdout.write(`[sentinel] ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEDGER = path.join(ROOT, "data", "alert-ledger-v2.json");
const ledgerFingerprint = () => { try { return fs.statSync(LEDGER).mtimeMs + ":" + fs.statSync(LEDGER).size; } catch { return "none"; } };

// Persist through the same committed helper the other workflows use. Only in CI — locally it is a
// no-op so a test run never tries to push.
function persist(label) {
  if (!process.env.GITHUB_ACTIONS) { say(`(local: skip persist ${label})`); return; }
  try { execFileSync("bash", [path.join(ROOT, ".github", "save-data.sh"), `sentinel-${label}`], { cwd: ROOT, stdio: "inherit" }); }
  catch (e) {
    // A failed rebase leaves the repo mid-rebase; retrying the SAME commit next iteration replays the
    // same conflict forever. Abort cleanly so the next persist starts from a fresh base (the ledger
    // content in the worktree is preserved — only the git state is reset).
    say(`persist failed (${e.status}) — aborting any half-rebase so the next attempt starts clean`);
    try { execFileSync("git", ["rebase", "--abort"], { cwd: ROOT, stdio: "ignore" }); } catch (_) {}
  }
}

// PULL BEFORE EACH TICK (certification fix). The sentinel job checks out once and can run ~5h while the
// hourly dispatcher pushes its own alert-ledger updates. Without a pull, this runner's dedup state is
// frozen at job start — a message the dispatcher already sent looks unsent here, and a DUPLICATE
// Telegram needs no git conflict at all. A cheap rebase-pull each tick keeps the dedup current; a
// transient pull failure is logged and the tick proceeds on the previous state (atomic ledger writes +
// reload-before-write still bound the damage).
function refreshState() {
  if (!process.env.GITHUB_ACTIONS) return;
  try { execFileSync("git", ["pull", "--rebase", "--autostash", "-q"], { cwd: ROOT, stdio: "inherit", timeout: 60000 }); }
  catch (_) { say("pull failed (transient) — continuing on current state"); try { execFileSync("git", ["rebase", "--abort"], { cwd: ROOT, stdio: "ignore" }); } catch (_) {} }
}

// One cheap price-check iteration. Returns true if it exited cleanly. Never throws — a transient
// Kalshi/network failure must not kill the whole fight-day loop; it is logged and retried next tick.
function priceCheck(forecastFile, evalFile) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, "run-entertainment-alerts.js"), forecastFile, `--eval=${evalFile}`, "--send"],
      { cwd: ROOT, stdio: "inherit" });
    return true;
  } catch (e) { say(`price-check exited ${e.status} — transient, retrying next tick`); return false; }
}

// Find the active card's sealed forecast + eval (the soonest event-dated forecast on disk).
function activeCardFiles() {
  const dir = path.join(ROOT, "data");
  const forecasts = fs.readdirSync(dir).filter((f) => /^forecast-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!forecasts.length) return null;
  const fc = forecasts[forecasts.length - 1];       // latest event date
  const ed = fc.match(/forecast-(\d{4}-\d{2}-\d{2})\.json/)[1];
  const evalFile = `data/evidence-eval-${ed}.json`;
  if (!fs.existsSync(path.join(dir, `evidence-eval-${ed}.json`))) return null;
  return { forecastFile: `data/forecast-${ed}.json`, evalFile, eventDate: ed };
}

async function main() {
  const minutes = Number(argv("minutes", "300"));
  const intervalSec = Number(argv("interval-sec", "900"));
  const once = process.argv.includes("--once");
  const maxIterations = argv("iterations") ? Number(argv("iterations")) : (once ? 1 : Infinity);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 350) { say("--minutes must be 1..350 (GitHub's 6h job cap)"); process.exit(2); }

  const files = activeCardFiles();
  if (!files) { say("no sealed forecast on disk — nothing to watch. Exiting cleanly."); return 0; }
  say(`watching ${files.eventDate} for ${minutes}m, every ${intervalSec}s (max ${maxIterations === Infinity ? "∞" : maxIterations} iterations)`);

  const deadline = Date.now() + minutes * 60 * 1000;
  let stopping = false;
  // GitHub sends SIGTERM ~a few seconds before SIGKILL on cancellation. Drain one persist and stop.
  const onStop = (sig) => { say(`received ${sig} — draining and exiting`); stopping = true; };
  process.on("SIGTERM", () => onStop("SIGTERM"));
  process.on("SIGINT", () => onStop("SIGINT"));

  let iter = 0, lastFail = 0;
  while (!stopping && iter < maxIterations && Date.now() < deadline) {
    iter++;
    refreshState();   // pull the dispatcher's ledger updates so dedup state is current, not job-start stale
    const before = ledgerFingerprint();
    say(`iteration ${iter} @ ${new Date().toISOString()}`);
    const okRun = priceCheck(files.forecastFile, files.evalFile);
    if (!okRun) { lastFail++; if (lastFail >= 5) { await notify("⚠️ Sharp Signals sentinel: 5 consecutive price-check failures").catch(() => {}); lastFail = 0; } }
    else lastFail = 0;

    // Shadow fight-intelligence tick — the final-48h recheck cadence (§14). On the SAME sealed forecast
    // (no re-forecast), it refreshes market before/after snapshots and reclassifies (priced-out /
    // available-again). Shadow: run-intel is called WITHOUT --send, so no Telegram. Non-fatal.
    if (process.env.FIGHT_INTEL_ENABLED === "1") {
      try { execFileSync(process.execPath, [path.join(ROOT, "run-intel.js"), files.forecastFile, `--eval=${files.evalFile}`], { cwd: ROOT, stdio: "inherit" }); }
      catch (e) { say(`intel tick exited ${e.status} — non-fatal`); }
    }

    // Persist immediately if the ledger changed — that is the only state a cancellation could lose in a
    // way that causes a duplicate send.
    if (ledgerFingerprint() !== before) { say("ledger changed — persisting"); persist(`iter${iter}`); }

    if (stopping || iter >= maxIterations || Date.now() + intervalSec * 1000 > deadline) break;
    // Sleep in short slices so a SIGTERM during the wait is honoured within a second.
    const wake = Date.now() + intervalSec * 1000;
    while (Date.now() < wake && !stopping) await sleep(Math.min(1000, wake - Date.now()));
  }

  persist("final");
  say(`done after ${iter} iteration(s).`);
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c || 0)).catch(async (e) => {
    process.stdout.write(`[sentinel] FATAL: ${e.message}\n`);
    await notify(`⚠️ Sharp Signals sentinel FAILED: ${e.message}`).catch(() => {});
    process.exit(1);
  });
}

module.exports = { activeCardFiles };
