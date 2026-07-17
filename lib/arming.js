// ARMING — what this system is permitted to do, stated in one place.
//
// TWO DIFFERENT THINGS, DELIBERATELY NOT ONE FLAG. "Armed" here means Telegram may send a human a
// message. It has never meant, and cannot mean, that anything gets placed: there is no Kalshi write
// call anywhere in this build, so trading is not disabled by a setting that could be flipped — it is
// absent. A single `ARMED` boolean covering both would be exactly the over-generalisation this
// project has spent every phase removing.
//
// The two prerequisites below were set by the human and are checked at RUNTIME, not remembered:
// flipping ALERTS_ARMED without them is refused by the runner, so the flag cannot get ahead of the
// evidence.
require("./env");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const ARMING = {
  // Telegram MAY send. Manual instructions only — the human reads and types.
  ALERTS_ARMED: true,
  armedAt: "2026-07-17",
  armedBy: "explicit human instruction, after both prerequisites were met",
  permits: [
    "Telegram buy instructions for positions the research gates already ruled ACTIONABLE EXPERIMENTAL",
    "Telegram HUMAN REVIEW alerts for unverified news (withdrawal / injury / cancellation)",
    "Telegram price updates, withdrawals, status changes, daily summaries, pipeline failures",
  ],

  // Not a setting. There is no code path to flip.
  TRADING_ENABLED: false,
  tradingNote: "There is no Kalshi write call in this build. Trading is not disabled — it does not exist. `false` here is documentation, not a switch: setting it true would change nothing because nothing reads it to place an order.",

  prerequisites: {
    smallOrderFeeTickets: "authenticated $2 and $5 unsubmitted Quick Order tickets at 0.59 reproduce exactly (3.28 -> $0.06, 8.23 -> $0.14); envelope floor now 3.28 contracts",
    freshFullPipelineRun: "data/phase9-fresh-run.json — every stage executed on live data for UFC-2026-07-18",
  },

  standingWarning:
    "This system has NOT demonstrated a predictive edge. The only evaluation that ever showed one is void (contaminated baseline). Every alert carries this.",
};

// The prerequisites, re-checked every run rather than trusted. An armed flag whose evidence has gone
// missing is worse than a disarmed one: it looks like a decision that was made.
function checkArmingPrerequisites() {
  const blockers = [];
  const fee = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "fee-examples.json"), "utf8")); } catch { return []; } })();
  const small = fee.filter((e) => e.totalCost >= 2 && e.totalCost <= 5 && e.treatment === "taker");
  if (!small.length) blockers.push("no authenticated $2-$5 Quick Order fee example — an entertainment order's fee would be extrapolated");
  const fresh = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "phase9-fresh-run.json"), "utf8")); } catch { return null; } })();
  if (!fresh || !fresh.passed) blockers.push("no fresh full-pipeline card run has passed");
  return { ok: blockers.length === 0, blockers, smallOrderTickets: small.length };
}

// A hard structural assertion: if anything ever adds an order path, this trips rather than trades.
function assertNoTradingPath() {
  const k = require("./kalshi");
  const writes = ["createOrder", "placeOrder", "submitOrder", "cancelOrder", "batchCreateOrders"];
  const found = writes.filter((w) => typeof k[w] === "function");
  if (found.length) throw new Error(`a Kalshi WRITE path exists (${found.join(", ")}) — this build must not be able to place orders`);
  return true;
}

module.exports = { ARMING, checkArmingPrerequisites, assertNoTradingPath };
