// CANONICAL BANKROLLS SUMMARY — the SINGLE source of truth both dashboards read for current real and
// paper money. It calls each ledger module's own summary() and writes data/bankrolls.json. The production
// board (public/unified.html via dashboard-data.js) and the Sharp Signals app both consume THIS file;
// neither recomputes money independently, so their totals can never diverge.
//
// The two ledgers are the sole canonical sources for current balances. The archived V1 paper book
// (data/positions.json) and the phase-8 $10k sizing shadow (data/phase8-shadow-*.json) are LEGACY:
// preserved, never deleted, and excluded from every current bankroll number.
require("./env");
const path = require("path");
const { paths, writeJson } = require("./store");
const MB = require("./manual-bankroll");
const PL = require("./paper-ledger");

const FILE = () => path.join(paths.data, "bankrolls.json");

function build({ now, realState, paperState } = {}) {
  const real = MB.summary(realState || MB.load());   // "Real Entertainment Bankroll" ($100)
  const paper = PL.summary(paperState || PL.load());  // "Paper Strategy Bankroll" ($10,000)
  return {
    schemaVersion: 1,
    generatedAt: now || new Date().toISOString(),
    canonical: "These two summaries are the sole sources for current real and paper balances. Do not recompute money elsewhere.",
    real,
    paper,
    legacy: {
      note: "Archived research, NOT part of any current bankroll calculation. Preserved, not deleted.",
      v1PaperBook: { file: "data/positions.json", label: "Legacy V1 paper book", reason: "repealed pre-b1399bd guru gate; superseded by the Paper Strategy Bankroll", excludedFromCurrentLedgers: true },
      phase8Shadow: { file: "data/phase8-shadow-*.json", label: "Legacy $10k sizing shadow", reason: "a decision journal that never settles into a running balance", excludedFromCurrentLedgers: true },
    },
  };
}

// Write the canonical file. Callers: dispatch (after the alerts stage), and the confirm/settle/paper flows.
function write(opts = {}) {
  const b = build(opts);
  if (opts.persist !== false) writeJson(FILE(), b);
  return b;
}

module.exports = { build, write, FILE };
