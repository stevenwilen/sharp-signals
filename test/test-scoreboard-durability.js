// THE SCOREBOARD MUST OUTLIVE KALSHI'S MEMORY.
//
// Kalshi serves ~63 days of settled markets. The calibration scoreboard used to resolve every past read
// against that live list, so the oldest card silently dropped out of `graded` each week — the record
// churned instead of growing, with no error to notice. The ledger stores every winner permanently, so it
// is now the first source and Kalshi is only the fallback for something not yet recorded.
const CG = require("../lib/channel-grade");
const N = require("../lib/names");
const C = require("../lib/confidence");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS  " + m); } else { fail++; console.log("  FAIL  " + m); } };
const ms = (d) => Date.parse(d + "T00:00:00Z");

// A ledger old enough that Kalshi would long since have forgotten these fights.
const ledger = {
  fights: {
    "ancient@2024-07-13": { a: "Alpha One", b: "Beta Two", winner: "a", fightTime: "2024-07-13T22:00:00Z", votes: {} },
    "recent@2026-08-22": { a: "Roman Dolidze", b: "Reinier de Ridder", winner: "b", fightTime: "2026-08-23T05:20:00Z", votes: {} },
    "pairA@2026-05-02": { a: "Ty Miller", b: "Billy Goff", winner: "a", fightTime: "2026-05-02T22:00:00Z", votes: {} },
    "pairB@2026-05-02": { a: "Juliana Miller", b: "Luana Oliveira", winner: "b", fightTime: "2026-05-02T22:00:00Z", votes: {} },
  },
};
const lookup = (pick, opp, date) => CG.winnerFromLedger(ledger, pick, opp, ms(date), N.surname, C.surnameEq);

// 1. A fight from 2024 still resolves — the whole point.
ok(lookup("Alpha One", "Beta Two", "2024-07-13") === 1, "1. a two-year-old outcome still resolves from the ledger");
ok(lookup("Beta Two", "Alpha One", "2024-07-13") === 0, "1b. ...and correctly from the losing side");

// 2. Date drift between sources must not lose the fight: Kalshi settles after midnight UTC, the
//    historical rows carry the local event date, so the two differ by a day.
ok(lookup("Reinier de Ridder", "Roman Dolidze", "2026-08-22") === 1, "2. a fight settling past midnight UTC still matches its card date");

// 3. REFUSAL: the surname PAIR is required. Two Millers on one card must not collide — a single-surname
//    match would hand back the wrong fight's winner, which is worse than no answer.
ok(lookup("Ty Miller", "Billy Goff", "2026-05-02") === 1, "3. the right Miller resolves to the right fight");
ok(lookup("Juliana Miller", "Luana Oliveira", "2026-05-02") === 0, "3b. ...and the other Miller to the other fight");

// 4. REFUSAL: an unknown fight returns null so the caller falls back, rather than guessing.
ok(lookup("Nobody Here", "Also Nobody", "2026-08-22") === null, "4. an unrecorded fight returns null, never a guessed outcome");
ok(lookup("Alpha One", "Beta Two", "2025-01-01") === null, "4b. a right-name/wrong-date match is REFUSED");

// 5. REFUSAL: half a pair is not a match.
ok(lookup("Alpha One", "", "2024-07-13") === null, "5. a missing opponent name resolves nothing");

console.log("");
console.log(pass + "/" + (pass + fail) + " passed");
process.exit(fail ? 1 : 0);
