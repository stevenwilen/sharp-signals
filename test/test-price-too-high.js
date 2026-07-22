// PRICE TOO HIGH — two operator-reported bugs, pinned refusal-first:
//   (1) a correct refusal rendered as the nonsensical "22¢ is above the maximum 22¢" because the
//       fee-adjusted ceiling (21.6¢) was rounded UP to a whole cent that equalled the ask;
//   (2) the SAME priced-out alert re-sent on every 2h forecast re-seal even though the price never moved.
const fs = require("fs");
const TM = require("../lib/telegram-messages");
const AL = require("../lib/alert-ledger-v2");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

// ---------- (1) DISPLAY: the ceiling must be distinguishable from the ask ----------
{
  // Live ask 22¢, fee-adjusted ceiling 21.6¢ — the operator's exact case. Both used to render "22¢".
  const msg = TM.priceTooHigh({ recommendedFirst: "Gibson vs Hussein", ask: 0.22, maximumAcceptablePrice: 0.216 });
  ok(/Ask now: 22¢/.test(msg), "1. shows the live ask as '22¢'");
  ok(/21\.6¢/.test(msg), "2. shows the ceiling at FINE precision (21.6¢), not rounded up to 22¢");
  ok(!/maximum 22¢/i.test(msg) && !/22¢ is above/.test(msg), "3. never renders the nonsensical '22¢ is above the maximum 22¢'");
  ok(/Wait for 21¢ or lower/.test(msg), "4. 'wait for' is the tradeable whole cent AT OR BELOW the ceiling (21¢), never 22¢");
  ok(msg.match(/22¢/g).length === 1, "5. the ask and the ceiling read as DIFFERENT numbers (only one '22¢')");
}
// whole-cent ceiling still reads cleanly (no trailing .0)
{
  const msg = TM.priceTooHigh({ recommendedFirst: "A vs B", ask: 0.67, maximumAcceptablePrice: 0.61 });
  ok(/Your ceiling: 61¢/.test(msg) && /Wait for 61¢ or lower/.test(msg), "6. a whole-cent ceiling shows '61¢', no '.0'");
}

// ---------- (2) DEDUP: a priced-out contract must not re-ping on holder-only triggers ----------
const FILE = AL.FILE;
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
try {
  const PTH = (over = {}) => ({ ask: 0.66, maximumAcceptablePrice: 0.64, verdict: "PRICE_TOO_HIGH",
    classification: "PRICE_TOO_HIGH", forecastHash: "aaa", stakePercent: 4, topTicker: "T1", stale: false, ...over });
  const BUY = (over = {}) => ({ ask: 0.60, maximumAcceptablePrice: 0.64, verdict: "BUY",
    classification: "standard experimental", forecastHash: "aaa", stakePercent: 4, topTicker: "T1", stale: false, ...over });

  fs.writeFileSync(FILE, JSON.stringify({
    "pth": PTH(), "buy": BUY(),
  }));

  // A: priced out, forecast re-sealed (hash changed), price UNCHANGED -> SUPPRESSED (the duplicate).
  ok(AL.shouldSend("pth", PTH({ forecastHash: "bbb" })).send === false,
    "7. priced-out + forecast re-seal, price unchanged -> NOT re-sent (the duplicate is gone)");
  // A2: priced out, stake tweak only -> also suppressed.
  ok(AL.shouldSend("pth", PTH({ stakePercent: 5 })).send === false,
    "8. priced-out + stake tweak -> NOT re-sent");
  // B: it became BUYABLE (ask fell to/below the ceiling) -> MUST speak.
  ok(AL.shouldSend("pth", BUY({ ask: 0.63 })).send === true,
    "9. priced-out -> ask fell to/below the ceiling -> DOES speak ('it is buyable now')");
  // C (control): a HELD BUY position, forecast re-sealed -> STILL speaks (suppression is priced-out-only).
  ok(AL.shouldSend("buy", BUY({ forecastHash: "bbb" })).send === true,
    "10. a held BUY + forecast re-seal -> still speaks (holder triggers only suppressed while priced out)");
  // D: a genuine FIRST sighting of a priced-out contract still sends (prev absent, only `first` fires).
  ok(AL.shouldSend("never-seen", PTH()).send === true,
    "11. first sighting of a priced-out contract STILL sends (suppression never silences a first alert)");
} finally {
  if (backup != null) fs.writeFileSync(FILE, backup); else if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
}

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
