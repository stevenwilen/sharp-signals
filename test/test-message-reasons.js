// TELEGRAM MESSAGE REASONS — a bullet section must render a LIST, never a string iterated character by
// character. The exploration lane passed `why` as one concatenated sentence, and "Why it qualifies"
// rendered "• W", "• h", "• y", ... one bullet per letter. These tests pin the defensive normalizer
// AND the property no message may ever violate: no bullet line is a single character.
const TM = require("../lib/telegram-messages");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

console.log("toReasons NORMALIZES ANY SHAPE TO A CLEAN string[]");
{
  ok("multiple reasons as an array pass through", JSON.stringify(TM.toReasons(["a", "b", "c"])) === JSON.stringify(["a", "b", "c"]));
  ok("one reason as a STRING becomes a single-element array", JSON.stringify(TM.toReasons("just one reason")) === JSON.stringify(["just one reason"]));
  ok("...and is NOT split into characters", TM.toReasons("Why").length === 1);
  ok("an empty string yields []", JSON.stringify(TM.toReasons("")) === "[]");
  ok("a whitespace-only string yields []", JSON.stringify(TM.toReasons("   ")) === "[]");
  ok("null yields []", JSON.stringify(TM.toReasons(null)) === "[]");
  ok("undefined yields []", JSON.stringify(TM.toReasons(undefined)) === "[]");
  ok("a number yields []", JSON.stringify(TM.toReasons(42)) === "[]");
  ok("an object yields []", JSON.stringify(TM.toReasons({ why: "x" })) === "[]");
  ok("an array with malformed entries drops the bad ones", JSON.stringify(TM.toReasons(["good", null, 5, "  ", { x: 1 }, "also good"])) === JSON.stringify(["good", "also good"]));
  ok("entries are trimmed", JSON.stringify(TM.toReasons(["  spaced  "])) === JSON.stringify(["spaced"]));
  ok("bullets() prefixes each with '• '", JSON.stringify(TM.bullets(["a", "b"])) === JSON.stringify(["• a", "• b"]));
  ok("bullets() on a string is ONE bullet, not per-character", JSON.stringify(TM.bullets("hello world")) === JSON.stringify(["• hello world"]));
}

// A minimal-but-complete buy instruction fixture. `why`/`against` are overridden per test.
const buy = (o = {}) => ({
  fight: "Fighter A vs Fighter B", contractWording: "Fighter A wins", ticker: "KXUFCFIGHT-26JUL18XX-A",
  ask: 0.60, maximumAcceptablePrice: 0.62, percentOfBankroll: 3, bankroll: 100, stake: 3, contracts: 5,
  tierLabel: "CREATIVE SPECULATIVE", contractsCompared: 1, whyTopRanked: "only contract on this fight",
  why: ["a reason"], against: ["a counter"], doNotPlaceIf: ["the ask moves"],
  rangeLow: 0.5, rangeHigh: 0.7, conservativeValuePoints: -1, evidenceCoverage: "THINLY COVERED",
  modelStatus: "EXPLORATION", snapshotTimestamp: "2026-07-18T20:00:00Z", feeGate: { withinVerifiedEnvelope: true },
  ...o,
});

// The property the bug violated: no bullet line may be a single character (i.e. "• X" where X is 1 char).
const hasOneCharBullet = (text) => text.split("\n").some((line) => /^[•\-]\s\S$/.test(line.trim()));

console.log("\nA STRING `why` NEVER RENDERS ONE BULLET PER CHARACTER (the actual bug)");
{
  const msg = TM.buyInstruction(buy({ why: "This is one long concatenated sentence that used to explode into 60 bullets" }));
  ok("the message builds", typeof msg === "string" && msg.length > 0);
  ok("NO bullet line is a single character", !hasOneCharBullet(msg), msg.split("\n").filter((l) => /^•\s\S$/.test(l.trim())).slice(0, 5).join(" | "));
  ok("the string renders as exactly ONE 'Why it qualifies' bullet",
    (msg.match(/Why it qualifies:\n((?:• .*\n)+)/) || [, ""])[1].trim().split("\n").length === 1);
}

console.log("\nAN ARRAY `why` RENDERS ONE BULLET PER REASON");
{
  const msg = TM.buyInstruction(buy({ why: ["Cannonier chin is declining", "2 independent origins · NOVEL", "May be underpriced: not yet public"] }));
  const section = (msg.match(/Why it qualifies:\n((?:• .*\n)+)/) || [, ""])[1].trim().split("\n");
  ok("three reasons render as three bullets", section.length === 3, section.join(" | "));
  ok("...each is a full readable line, not a character", section.every((l) => l.replace(/^•\s/, "").length > 3));
  ok("no one-character bullet anywhere", !hasOneCharBullet(msg));
}

console.log("\nEMPTY / NULL / MALFORMED `why` RENDER NO BULLETS, NOT GARBAGE");
{
  for (const [label, val] of [["empty string", ""], ["null", null], ["undefined", undefined], ["object", { x: 1 }], ["number", 7]]) {
    const msg = TM.buyInstruction(buy({ why: val }));
    const section = (msg.match(/Why it qualifies:\n((?:• .*\n)*)/) || [, ""])[1].trim();
    ok(`${label} why -> zero bullets, no crash`, section === "" && !hasOneCharBullet(msg));
  }
}

console.log("\nTHE SAME GUARANTEE HOLDS FOR `against` AND `doNotPlaceIf`");
{
  const msg = TM.buyInstruction(buy({ why: ["ok"], against: "one string counterargument", doNotPlaceIf: "one string condition" }));
  ok("a string `against` is one bullet, not per-character", !hasOneCharBullet(msg));
  const against = (msg.match(/Main counterargument:\n((?:• .*\n)+)/) || [, ""])[1].trim().split("\n");
  ok("...against renders as one bullet", against.length === 1 && against[0].length > 3);
}

console.log("\nTHE EXPLORATION LANE NOW EMITS ARRAY REASONS AT THE SOURCE");
{
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "run-entertainment-alerts.js"), "utf8").replace(/\r/g, "");
  // The exploration buyInstruction call must pass why/against as arrays, not template strings.
  const block = src.slice(src.indexOf("EXPLORATION lane — creative speculative"), src.indexOf("EXPLORATION lane — creative speculative") + 1200);
  ok("exploration `why` is an array literal, not a backtick string", /why:\s*\[/.test(block));
  ok("exploration `against` is an array literal", /against:\s*\[/.test(block));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
