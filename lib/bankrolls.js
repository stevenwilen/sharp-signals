// CANONICAL BANKROLLS SUMMARY — the SINGLE source of truth for current real money. It calls the real
// ledger module's own summary() and writes data/bankrolls.json, which the mobile dashboard consumes
// directly (via GitHub raw); it never recomputes money independently, so totals can never diverge.
//
// The Real Entertainment Bankroll (lib/manual-bankroll.js) is the sole canonical source for the current
// balance. The archived V1 paper book (data/positions.json) and the phase-8 $10k sizing shadow
// (data/phase8-shadow-*.json) are LEGACY: preserved, never deleted, and excluded from every current
// bankroll number.
require("./env");
const path = require("path");
const { paths, writeJson } = require("./store");
const MB = require("./manual-bankroll");

const FILE = () => path.join(paths.data, "bankrolls.json");

function build({ now, realState } = {}) {
  const real = MB.summary(realState || MB.load());   // "Real Entertainment Bankroll" ($100)
  return {
    schemaVersion: 1,
    generatedAt: now || new Date().toISOString(),
    canonical: "This summary is the sole source for the current real balance. Do not recompute money elsewhere.",
    real,
    legacy: {
      note: "Archived research, NOT part of any current bankroll calculation. Preserved, not deleted.",
      v1PaperBook: { file: "data/positions.json", label: "Legacy V1 paper book", reason: "repealed pre-b1399bd guru gate", excludedFromCurrentLedgers: true },
      phase8Shadow: { file: "data/phase8-shadow-*.json", label: "Legacy $10k sizing shadow", reason: "a decision journal that never settles into a running balance", excludedFromCurrentLedgers: true },
    },
  };
}

// Write the canonical file. Callers: dispatch (after the alerts stage), and the confirm/settle flows.
function write(opts = {}) {
  const b = build(opts);
  if (opts.persist !== false) writeJson(FILE(), b);
  return b;
}

module.exports = { build, write, FILE };
