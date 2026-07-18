// CONTRACT DISCOVERY — production evaluates only genuine fight-OUTCOME markets, and never an
// announcer-mention prop dressed as one.
//
// The trap is live and specific. On the SAME 2026-07-18 card, KXFIGHTMENTION reuses the IDENTICAL
// event codes as KXUFCFIGHT (both carry 26JUL18DUUSM), its strikes are named "Knockout" and
// "Decision", and it resolves on WHAT THE BROADCAST COMMENTATORS SAY. A discovery path keyed on the
// event code — or on a /KO|decision|round/ title regex — would price a commentary prop as a method
// bet. (That title regex also hits Seok Hyun *Ko* and Donchen*ko*: 100% false positives on real
// markets.) So classification keys on the series and the resolution language, never the title.
const C = require("../lib/contracts");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const outcome = (o = {}) => ({
  ticker: "KXUFCFIGHT-26JUL18DUUSM-USM", yes_sub_title: "Kamaru Usman",
  rules_primary: "If Kamaru Usman wins the Du Plessis vs Usman professional MMA fight originally scheduled for Jul 18, 2026, then the market resolves to Yes.", ...o,
});
const mention = (o = {}) => ({
  ticker: "KXFIGHTMENTION-26JUL18DUUSM-KO", yes_sub_title: "Knockout",
  rules_primary: "If any official broadcast commentator - includes play by play, color commentator, rules analyst or sideline reporter says Knockout as part of Du Plessis vs Usman Fight, then Yes.", ...o,
});

console.log("REAL FIGHT-OUTCOME MARKETS ARE ADMITTED");
{
  const c = C.classifyMarket(outcome());
  ok("a winner market is accepted", c.accept === true && c.kind === "fight_outcome");
  ok("...on the KXUFCFIGHT series", c.series === "KXUFCFIGHT");

  // A method market on an allowed series, resolved on the outcome, is accepted — the mapper is
  // extensible, not winner-only.
  const method = C.classifyMarket(outcome({
    ticker: "KXUFCFIGHT-26JUL18DUUSM-USMKO",
    rules_primary: "If Kamaru Usman wins by KO/TKO in the Du Plessis vs Usman fight, then the market resolves to Yes.",
  }));
  ok("a KO-method market on KXUFCFIGHT is accepted", method.accept === true);
}

console.log("\nANNOUNCER-MENTION MARKETS ARE REFUSED — BY RESOLUTION, NOT TITLE");
{
  const c = C.classifyMarket(mention());
  ok("an announcer-mention market is refused", c.accept === false);
  ok("...classified as announcer_mention", c.kind === "announcer_mention");
  ok("...for resolving on the broadcast, not the outcome", /broadcast|announcer|commentator/.test(c.reason));
  ok("isAnnouncerMentionMarket agrees", C.isAnnouncerMentionMarket(mention()) === true);
  ok("...and a real market is not flagged", C.isAnnouncerMentionMarket(outcome()) === false);

  // The trap: a mention market whose STRIKE is named exactly like a method market. The title says
  // "Knockout"; the rules say the announcer must SAY it. Title-blind classification refuses it anyway.
  const disguised = C.classifyMarket(mention({ yes_sub_title: "Knockout", ticker: "KXFIGHTMENTION-26JUL18DUUSM-KO" }));
  ok("a mention market named 'Knockout' is still refused", disguised.accept === false);

  // Even if KXFIGHTMENTION somehow escaped the series deny-list, the rules text catches it.
  const byRules = C.classifyMarket({ ticker: "KXSOMETHINGELSE-26JUL18DUUSM-X",
    rules_primary: "If any broadcast commentator says 'Let's get it on' during the fight, resolves Yes." });
  ok("announcer resolution is caught even on an unknown series", byRules.kind === "announcer_mention");
}

console.log("\nUNKNOWN SERIES AND UNRECOGNISED RESOLUTIONS ARE REFUSED, NOT GUESSED");
{
  ok("a series not on the allowlist is refused",
    C.classifyMarket({ ticker: "KXMYSTERY-26JUL18-X", rules_primary: "If X wins, resolves Yes." }).kind === "unknown_series");
  ok("a KXUFCFIGHT market with no recognisable outcome language is refused",
    C.classifyMarket({ ticker: "KXUFCFIGHT-26JUL18-X", rules_primary: "This market is about vibes." }).accept === false);
  // A market with no rules text at all on an allowed series: accept (rules may be absent in a snapshot),
  // but never fabricate an outcome reading.
  ok("a KXUFCFIGHT market with no rules text is still accepted (rules may be absent in a snapshot)",
    C.classifyMarket({ ticker: "KXUFCFIGHT-26JUL18DUUSM-USM" }).accept === true);
}

console.log("\nA MIXED BOARD IS FILTERED, AND THE REJECTIONS ARE REPORTED");
{
  const board = [outcome(), outcome({ ticker: "KXUFCFIGHT-26JUL18DUUSM-DU", yes_sub_title: "Dricus Du Plessis" }),
    mention(), mention({ ticker: "KXFIGHTMENTION-26JUL18DUUSM-DEC", yes_sub_title: "Decision" })];
  const r = C.admissibleFightMarkets(board);
  ok("only the outcome markets are admitted", r.admitted.length === 2);
  ok("the announcer props are rejected", r.rejected.length === 2);
  ok("...and each rejection carries a reason", r.rejected.every((x) => !!x.reason));
  ok("...and the ticker, so a caller can log what it dropped", r.rejected.every((x) => !!x.ticker));

  // The title-regex false-positive the guard must NOT reproduce: a real fighter whose surname is "Ko".
  const ko = C.classifyMarket(outcome({ ticker: "KXUFCFIGHT-26JUL18LEBSEO-SEO", yes_sub_title: "Seok Hyun Ko",
    rules_primary: "If Seok Hyun Ko wins the Ko vs Lebosnoyani fight, then the market resolves to Yes." }));
  ok("a fighter named 'Ko' is NOT mistaken for a knockout prop", ko.accept === true);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
