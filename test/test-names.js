// Every case here is a real corruption found in data/predictions.json.
//   node test/test-names.js
const n = require("../lib/names");

let bad = 0;
function t(text, name, wantMatch, why) {
  const s = n.nameScore(text, name);
  const got = s >= 2;
  const ok = got === wantMatch;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${String(s)}  "${text}" vs "${name}"  — ${why}`);
}

// THE WRONG-TICKER BUG: these are two different humans who share a surname. The old code
// matched them and graded a Daniel Santos pick against Junior dos Santos's price.
t("Daniel Santos", "Junior dos Santos", false, "different fighters, same surname — must NOT match");
t("Junior dos Santos", "Junior dos Santos", true, "same fighter — must match");

// ONE FIGHTER, TWO SPELLINGS: sources spell these differently from Kalshi, so picks were
// dropped and both sides of a fight could resolve to the same man.
t("Patty Pimblett", "Paddy Pimblett", true, "alias — must match");
t("Shawn O'Malley", "Sean O'Malley", true, "alias — must match");
t("Ray Tsuruya", "Rei Tsuruya", true, "alias — must match");
t("Brian Norman", "Brian Norman Jr.", true, "suffix — must match");

// Ordinary cases that must keep working.
t("Kamaru Usman by KO", "Kamaru Usman", true, "name inside a phrase — must match");
t("Silva", "Anderson Silva", false, "bare surname — must NOT be enough on its own");
t("Usman over Du Plessis", "Dricus Du Plessis", false, "names the opponent — must NOT match him");

console.log(bad ? `\n${bad} FAILURES` : "\nname matching clean");
process.exit(bad ? 1 : 0);
