// Offline proof for the paper-position ledger. No network. Uses a throwaway state object for the
// in-memory logic; the load/save corruption test touches the real file and always restores it.
const fs = require("fs");
const P = require("../lib/positions");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m); } };

console.log("recordOpen / settle / pnl:");
const st = { positions: {}, meta: {} };

// open once, entry locked
const sig = { ticker: "T1", fighter: "Jon Jones", opponent: "Ciryl Gane", domain: "mma",
  fightDate: "2020-01-01", entryCost: 0.4, fairValueCents: 55, stakePct: 3, sources: ["A"] };
ok(P.recordOpen(st, sig) === "opened", "first recordOpen returns 'opened'");
ok(P.recordOpen(st, { ...sig, entryCost: 0.9, sources: ["B"] }) === null, "second recordOpen is a no-op (returns null)");
ok(st.positions.T1.entryCost === 0.4, "entry price is LOCKED at first sighting (not moved to 0.9)");
ok(st.positions.T1.sources.join(",") === "A,B", "new source is merged in");

// newlyOpened before summarizing
ok(P.newlyOpened(st).length === 1, "position shows as newly-opened before it is summarized");
P.markSummarized(st, ["T1"], "open");
ok(P.newlyOpened(st).length === 0, "after markSummarized(open) it no longer shows as newly-opened");

// settle a WIN and check paper P&L math
P.settle(st, "T1", 1, 1, "kalshi settled");
ok(st.positions.T1.status === "settled" && st.positions.T1.result === 1, "settle marks win");
// win at 40c: roi = (1-0.4)/0.4 = 1.5 => +150%
ok(st.positions.T1.pnlPct === 150, "win at 40c => +150% paper ROI");
// $500 bankroll, 3% stake = $15 staked, +150% => +$22.50
ok(P.pnlDollars(st.positions.T1, 500) === 22.5, "win: +$22.50 paper on $500 @ 3% stake");

// settle a LOSS
P.recordOpen(st, { ticker: "T2", fighter: "Loser", opponent: "X", domain: "mma",
  fightDate: "2020-01-01", entryCost: 0.6, fairValueCents: 70, stakePct: 2, sources: ["A"] });
P.settle(st, "T2", 0, 0, "kalshi settled");
ok(st.positions.T2.pnlPct === -100, "loss => -100% paper ROI");
ok(P.pnlDollars(st.positions.T2, 500) === -10, "loss: -$10 paper on $500 @ 2% stake");

// void
P.recordOpen(st, { ticker: "T3", fighter: "Void", opponent: "Y", domain: "mma",
  fightDate: "2020-01-01", entryCost: 0.5, fairValueCents: 60, stakePct: 1, sources: ["A"] });
P.settle(st, "T3", null, null, "void/cancelled");
ok(st.positions.T3.pnlPct === 0, "void => 0% paper");

// newlySettled surfaces all three, then clears
ok(P.newlySettled(st).length === 3, "three positions show as newly-settled");
P.markSummarized(st, ["T1", "T2", "T3"], "settled");
ok(P.newlySettled(st).length === 0, "after markSummarized(settled) none remain");

// double-settle is a no-op (idempotent)
const beforePnl = st.positions.T1.pnlPct;
P.settle(st, "T1", 0, 0, "again");
ok(st.positions.T1.pnlPct === beforePnl, "settling an already-settled position does nothing");

// ---- load()/save() corruption handling — touches the real file, always restored ----
console.log("\npersistence (atomic save / fail-loud load):");
const FILE = P.FILE;
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
try {
  fs.writeFileSync(FILE, "{ not json");
  let threw = false;
  try { P.load(); } catch (_) { threw = true; }
  ok(threw, "load() THROWS on a corrupt file (not a silent empty book)");

  if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  const res = P.load();
  ok(res && res.positions && Object.keys(res.positions).length === 0, "load() returns empty on a MISSING file");

  P.save({ positions: { Z: { ticker: "Z", status: "open" } }, meta: { lastSummaryDate: "2026-07-14" } });
  ok(fs.existsSync(FILE) && !fs.existsSync(FILE + ".tmp"), "save() leaves no .tmp behind (atomic)");
  const rt = P.load();
  ok(rt.positions.Z && rt.meta.lastSummaryDate === "2026-07-14", "save() -> load() round-trips positions + meta");
} finally {
  if (backup != null) { fs.writeFileSync(FILE, backup); console.log("  (restored real positions.json)"); }
  else if (fs.existsSync(FILE)) { fs.unlinkSync(FILE); console.log("  (removed test positions.json — none existed before)"); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
