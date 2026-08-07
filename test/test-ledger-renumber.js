// BOUT RENUMBER DEDUP — the still-open structural bug, now guarded ticker-first.
//
// Kalshi renumbers bouts as a card firms up (B04->B05->B08). The alert ledger key embeds the bout id, so
// the SAME live contract reappears under a NEW key each renumber. The old exact-key lookup then saw a
// never-seen key and re-fired `first` — a DUPLICATE 🟢 BUY for a bet already sent (the operator pays the
// fee twice). shouldSend now falls back to the most-recent prior entry for the same TICKER + lane, so dedup
// follows the contract's stable identity. These pin that: a renumbered contract with no material change is
// silent; one with a real change still speaks; and lanes never cross on a shared ticker.
const fs = require("fs");
const AL = require("../lib/alert-ledger-v2");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const FILE = AL.FILE;
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
try {
  // A prior exploration BUY on ticker T-USM, recorded under the B04 bout key it had at the time.
  const priorBuy = {
    ask: 0.42, maximumAcceptablePrice: 0.62, verdict: "BUY", classification: "CREATIVE SPECULATIVE",
    forecastHash: "aaa", stakePercent: 3, topTicker: "T-USM", lane: "exploration", stale: false,
    lastSentAt: "2026-01-01T00:00:00.000Z",
  };
  const same = (over = {}) => ({ ...priorBuy, ...over });

  fs.writeFileSync(FILE, JSON.stringify({ "explore|UFC-2026-01-01-B04|T-USM": priorBuy }));

  // 1. RENUMBER, no material change: same contract (ticker T-USM) now under the B05 key, only the sealed
  //    forecast hash rolled (it re-seals every cycle). MUST be silent — this is the duplicate BUY.
  ok(AL.shouldSend("explore|UFC-2026-01-01-B05|T-USM", same({ forecastHash: "bbb" })).send === false,
    "1. renumbered contract, no material change -> NO duplicate BUY");

  // 2. RENUMBER + a MATERIAL change: the ask crossed above the ceiling. Dedup follows the ticker, so it
  //    still finds the prior state and correctly fires the material trigger.
  ok(AL.shouldSend("explore|UFC-2026-01-01-B05|T-USM", same({ ask: 0.66, verdict: "PRICE_TOO_HIGH", classification: "PRICE_TOO_HIGH" })).send === true,
    "2. renumbered contract + price crossed the ceiling -> DOES speak (material)");

  // 3. A DIFFERENT ticker is a different contract — first sighting must still send.
  ok(AL.shouldSend("explore|UFC-2026-01-01-B06|T-OTHER", same({ topTicker: "T-OTHER" })).send === true,
    "3. a genuinely different ticker still sends (fallback only collapses the SAME contract)");

  // 4. LANE ISOLATION: the core lane betting the same ticker must NOT be suppressed by the exploration
  //    entry — they are different bets on the same contract and each must be able to speak once.
  ok(AL.shouldSend("core|T-USM", same({ lane: "core" })).send === true,
    "4. a core-lane bet on the same ticker is not cross-suppressed by the exploration entry");

  // 5. The prior entry was written under its bout key and is UNTOUCHED — the fallback is read-only, it
  //    never migrates or rewrites keys (so it can't race the concurrent sentinel writer).
  const after = JSON.parse(fs.readFileSync(FILE, "utf8"));
  ok(Object.keys(after).length === 1 && after["explore|UFC-2026-01-01-B04|T-USM"],
    "5. shouldSend is read-only — the ledger key is unchanged (no migration, no write)");
} finally {
  if (backup != null) fs.writeFileSync(FILE, backup); else if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
}

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
