// V1 STRUCTURALLY CANNOT SEND A BUY ALERT.
//
// DoD #13: "No rejected V1 betting alert can reach Telegram." The previous design gated V1's buy path
// behind a module-local ALERTS_ARMED=false flag — which the audit showed is an invitation to flip
// (the four bugs it named were fixed, so a diligent reader concludes the flag should go true). The
// arming consolidation removes the PATH, not just the flag: V1 no longer constructs a buy message at
// all, and there is no ALERTS_ARMED flag left for anyone to flip.
//
// This is a source-level structural assertion because that is exactly the guarantee: not "the flag is
// false" but "the code that would send does not exist".
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const src = fs.readFileSync(path.join(__dirname, "..", "pipeline.js"), "utf8");
// Strip comments so the assertions test CODE, not the notes that describe what was removed.
const code = src.replace(/\r/g, "").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

console.log("V1 HAS NO BUY-MESSAGE BUILDER");
{
  ok("no '🥊 BUY' message is constructed anywhere in pipeline.js", !code.includes("🥊 BUY"));
  ok("buildAlert() is not defined", !/function\s+buildAlert\b/.test(code));
  ok("buildAlert() is not called", !/\bbuildAlert\s*\(/.test(code));
}

console.log("\nV1 HAS NO ARMING FLAG TO FLIP");
{
  ok("there is no ALERTS_ARMED flag in pipeline.js code", !/ALERTS_ARMED/.test(code));
  ok("...so no 'flip this to true' trigger can exist", !/flip this to true/i.test(code));
}

console.log("\nEVERY notify() IN V1 IS A NON-BETTING MESSAGE");
{
  // Enumerate the notify() call sites and confirm each is the paper summary or a failure alert — never
  // a buy instruction. We check the ~120 chars before each call for a betting verb.
  const calls = [...code.matchAll(/notify\s*\(/g)].map((m) => code.slice(Math.max(0, m.index - 200), m.index));
  ok("pipeline.js calls notify() at least once (summary/failure)", calls.length >= 1);
  const bettingContext = calls.filter((ctx) => /buildAlert|🥊|BUY |stake|place this bet/i.test(ctx));
  ok("no notify() call is in a buy-instruction context", bettingContext.length === 0,
    bettingContext.map((c) => c.slice(-60)).join(" | "));
}

console.log("\nTHE ARMED BETTING PATH IS SINGLE AND CENTRAL");
{
  // The only module that builds a buy instruction is lib/telegram-messages.js, and the only script that
  // sends one is run-entertainment-alerts.js behind the 3-gate arming.
  const runner = fs.readFileSync(path.join(__dirname, "..", "run-entertainment-alerts.js"), "utf8");
  ok("the unified runner consults lib/arming for the gate", /require\(["'].*arming/.test(runner));
  ok("...and requires SHARP_PRODUCTION for a production send", /SHARP_PRODUCTION|productionEnabled/.test(runner));
  ok("pipeline.js does NOT import lib/telegram-messages (the buy builder)", !/require\(["'].*telegram-messages/.test(code));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
