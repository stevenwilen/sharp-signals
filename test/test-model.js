// Is the cheaper model good enough? The ONLY question that matters is DIRECTION.
// A missing pick costs nothing. A backwards pick poisons a track record.
//   node test/test-model.js                      (tests the configured model)
//   EXTRACT_MODEL=gemini-2.5-flash-lite node test/test-model.js
require("../lib/env");
const { extractFromTranscript } = require("../lib/extractor");

// Each case: the speaker clearly favours ONE man. Naive extraction picks the man they MENTION.
const TRAPS = [
  { text: `Look, I love Dricus Du Plessis, but his cardio is gone. He got dropped twice in camp,
           he's fighting on a bad knee, and Usman's wrestling is a nightmare matchup for him.
           I don't see how Dricus gets out of the third round here.`,
    want: "usman", why: "negative talk ABOUT Du Plessis -> the pick is Usman" },

  { text: `Everyone is on Ilia Topuria and I get it, he's special. But Gaethje at +400? That is
           free money. One clean right hand and this is over. The market is sleeping on his power.`,
    want: "gaethje", why: "value talk -> the pick is Gaethje, not the man praised first" },

  { text: `Jared Cannonier is the bigger name, no question. Christian Duncan though, nobody is
           talking about his footwork. Cannonier has been stopped in three of his last five.
           I'd be shocked if Duncan doesn't pick him apart.`,
    want: "duncan", why: "the underdog is the pick despite the favourite being named first" },

  { text: `Chase Hooper is a submission wizard, genuinely elite on the mat. Ramirez has never
           been submitted and stuffs 90 percent of takedowns. Hooper cannot get this to the floor,
           and standing up it is not close.`,
    want: "ramirez", why: "praise for Hooper, but the conclusion favours Ramirez" },
];

(async () => {
  const model = process.env.EXTRACT_MODEL || "gemini-flash-latest";
  console.log(`MODEL: ${model}\n`);
  let pass = 0;
  for (const t of TRAPS) {
    let got = [];
    try {
      got = await extractFromTranscript(t.text, {
        source: "test", domain: "mma", timestamp: "2026-07-14T00:00:00Z", url: "test",
      });
    } catch (e) { console.log(`  ERROR: ${e.message}`); continue; }

    const picks = got.map((p) => String(p.pick).toLowerCase());
    const ok = picks.some((p) => p.includes(t.want));
    if (ok) pass++;
    console.log(`  ${ok ? "ok  " : "WRONG DIRECTION"}  wanted ${t.want.padEnd(9)} got [${picks.join(", ") || "nothing"}]`);
    if (!ok) console.log(`        ${t.why}`);
  }
  console.log(`\n${pass}/${TRAPS.length} directions correct on ${model}`);
  console.log(pass === TRAPS.length
    ? "SAFE: this model gets direction right on every trap."
    : "DO NOT USE: a backwards pick poisons the track records. Cost savings are irrelevant.");
  process.exit(pass === TRAPS.length ? 0 : 1);
})();
