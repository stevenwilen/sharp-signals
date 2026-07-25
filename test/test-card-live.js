// CARD-LIVE LOCK — the one definition of "the card has started" both the entertainment gate and the
// research halt share. Betting locks the moment ANY bout on THIS card leaves the tradeable set, read from
// real Kalshi status (not a 22:00 bell), because fight day varies. Refusal-first: fail-closed inputs and a
// resolved bout on a DIFFERENT card must NOT lock this one, and must NOT wrongly report "live".
const { cardIsLive, tickerDateFor } = require("../lib/freshness");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const M = (ticker, status) => ({ ticker, status });
const EVENT = "2026-07-25";                 // -> KXUFCFIGHT-26JUL25
const mk = (suffix, status) => M(`KXUFCFIGHT-26JUL25${suffix}`, status);

// tickerDateFor: the reverse of the ticker parser.
ok(tickerDateFor("2026-07-25") === "26JUL25", "1. tickerDateFor 2026-07-25 -> 26JUL25");
ok(tickerDateFor("2026-01-03") === "26JAN03", "2. tickerDateFor keeps zero-padding (26JAN03)");
ok(tickerDateFor("garbage") === null && tickerDateFor(null) === null, "3. unparseable date -> null (never a bogus prefix)");

// All bouts still tradeable -> NOT live.
ok(cardIsLive([mk("WALPET-WAL", "active"), mk("WALPET-PET", "active"), mk("ANKGUS-ANK", "open")], EVENT) === false,
  "4. every bout active/open -> NOT live");

// The moment ONE bout resolves, the WHOLE card is live (halts even still-open bouts).
for (const st of ["determined", "finalized", "settled", "closed"]) {
  ok(cardIsLive([mk("WALPET-WAL", "active"), mk("PONPAT-PON", st)], EVENT) === true,
    `5. a bout with status "${st}" -> card is LIVE`);
}

// A resolved bout on a DIFFERENT card must NOT lock this one (prefix must match exactly).
ok(cardIsLive([mk("WALPET-WAL", "active"), M("KXUFCFIGHT-26AUG01FOOBAR-FOO", "finalized")], EVENT) === false,
  "6. a resolved bout on ANOTHER card (26AUG01) does NOT lock this card (26JUL25)");

// Fail-closed inputs return false — the lock only ADDS via cardIsLive; it never removes the 22:00 fallback.
ok(cardIsLive([], EVENT) === false, "7. no markets -> false (not live)");
ok(cardIsLive(null, EVENT) === false, "8. null markets -> false");
ok(cardIsLive([mk("WALPET-WAL", "finalized")], "not-a-date") === false, "9. unparseable eventDate -> false (no prefix, no lock)");
ok(cardIsLive([{ status: "finalized" }, { ticker: 42, status: "closed" }], EVENT) === false, "10. malformed market rows -> false (no ticker match)");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
