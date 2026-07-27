// APPLY PLACEMENTS — consumes placement confirmations the mobile dashboard drops into data/placements/
// (the "I placed this" button). Each file: { ticker, fillPriceCents, contracts, side?, at }. It records the
// placement into the real bankroll at the EXACT price the human entered, then moves the file out of the
// inbox so it can never re-apply.
//
// This is BOOKKEEPING, NOT trading. There is no Kalshi write anywhere in it — it only marks, in our own
// ledger, a bet the human already placed by hand. Fail-closed per file: a malformed or already-applied
// entry is moved aside, never guessed at, never retried forever.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const MB = require("./lib/manual-bankroll");
const BK = require("./lib/bankrolls");
const { paths } = require("./lib/store");

const say = (s) => process.stdout.write(s + "\n");
const INBOX = path.join(paths.data, "placements");

function fileOutcomeDir(kind) { const d = path.join(INBOX, kind); fs.mkdirSync(d, { recursive: true }); return d; }
function moveOut(fp, kind) { try { fs.renameSync(fp, path.join(fileOutcomeDir(kind), path.basename(fp))); } catch { try { fs.unlinkSync(fp); } catch {} } }

(function main() {
  if (!fs.existsSync(INBOX)) { say("[placements] no inbox — nothing to apply."); process.exit(0); }
  const files = fs.readdirSync(INBOX).filter((f) => f.endsWith(".json"));
  if (!files.length) { say("[placements] inbox empty."); process.exit(0); }
  const state = MB.load();
  let applied = 0, skipped = 0;
  for (const f of files) {
    const fp = path.join(INBOX, f);
    let rec; try { rec = JSON.parse(fs.readFileSync(fp, "utf8")); } catch (e) { say(`  ✗ ${f}: unreadable (${e.message})`); moveOut(fp, "failed"); skipped++; continue; }
    try {
      const ticker = String(rec.ticker || "").trim();
      const cents = Number(rec.fillPriceCents);
      const contracts = Number(rec.contracts);
      if (!/^KXUFCFIGHT-/.test(ticker)) throw new Error("ticker must be a KXUFCFIGHT contract");
      if (!(cents > 0 && cents < 100)) throw new Error("fillPriceCents must be a real cents price in (0,100)");   // never fake a price
      if (!(contracts > 0)) throw new Error("contracts must be > 0");
      const executionPrice = +(cents / 100).toFixed(4);
      // Already placed/settled -> idempotent no-op (a duplicate submit or a re-run), not an error.
      if (Object.values(state.entries).some((e) => e.ticker === ticker && [MB.STATUS.MANUALLY_PLACED, MB.STATUS.SETTLED].includes(e.status))) {
        say(`  · ${ticker}: already placed/settled — skipping (idempotent)`); moveOut(fp, "applied"); continue;
      }
      // Confirm the system's own recommendation if it made one; otherwise record it as discretionary. Either
      // way at the EXACT price + contract count the human entered.
      const rc = Object.values(state.entries).find((e) => e.ticker === ticker && e.status === MB.STATUS.RECOMMENDED_NOT_CONFIRMED);
      const p = rc
        ? MB.confirmPlacement(state, rc.key, { executionPrice, actualStake: +(contracts * executionPrice).toFixed(2), actualContracts: contracts, note: "confirmed via dashboard" })
        : MB.recordDiscretionary(state, { ticker, side: rec.side || "YES", executionPrice, contracts, note: "discretionary placement via dashboard" });
      applied++;
      say(`  ✓ ${ticker} @ ${cents}c × ${contracts} = $${p.actualStake} (${p.status})`);
      moveOut(fp, "applied");
    } catch (e) { say(`  ✗ ${f}: ${e.message}`); moveOut(fp, "failed"); skipped++; }
  }
  if (applied) { MB.save(state); BK.write(); }
  say(`[placements] ${applied} applied, ${skipped} skipped.`);
  process.exit(0);
})();
