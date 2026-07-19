// COMPACT NOTIFICATIONS — the opt-in layer that slims Telegram to "something changed → open the
// dashboard" pings. These tests assert the REFUSALS as hard as the happy path:
//   • OFF by default: every send is byte-for-byte the caller's original (the armed path is untouched).
//   • DASHBOARD-ONLY kinds are SUPPRESSED (forSend → null), never quietly turned into a push.
//   • an UNKNOWN kind FAILS TOWARD DELIVERY (returns the full message), never drops a real alert.
//   • a compact push carries NO betting detail (no price, stake, ¢, probability) and no confidence scalar.
const N = require("../lib/notification");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };
const on = () => { process.env.COMPACT_NOTIFICATIONS = "1"; };
const off = () => { delete process.env.COMPACT_NOTIFICATIONS; };

const FULL = "🧪 EXPERIMENTAL — $4\nBuy: Alberto Montes YES\nCurrent: 35¢\nMaximum: 40¢\nStake: $4 of $100\nSystem estimate: 55%";

// The approved mapping, encoded as data so the test IS the mapping.
const PUSH_KINDS = [
  "BUY", "SPECULATIVE_BET", "PRICE_TOO_HIGH", "PRICED_OUT", "WITHDRAWN",
  "COMBO_BUY", "COMBO_PRICE_TOO_HIGH", "COMBO_WITHDRAWN",
  "FIGHT_STARTED", "SETTLED", "DEGRADATION", "RECOMMENDATION_CHANGED",
];
const DASHBOARD_ONLY_KINDS = [
  "WATCH", "FORECAST_UPDATED", "MARKET_MOVED", "CONFIRMED", "DISPROVED", "HUMAN_ACTION_REQUIRED", "HUMAN_REVIEW",
];

console.log("OFF BY DEFAULT — the armed path is byte-for-byte unchanged");
{
  off();
  ok("compactEnabled() is false when the flag is unset", N.compactEnabled() === false);
  for (const k of [...PUSH_KINDS, ...DASHBOARD_ONLY_KINDS, "SOME_UNKNOWN_KIND"]) {
    ok(`forSend passes the full message through unchanged (${k})`, N.forSend(FULL, k) === FULL);
  }
  ok("degrade passes the full failure text through unchanged", N.degrade("⚠️ pipeline FAILED: boom") === "⚠️ pipeline FAILED: boom");
}

console.log("\nCOMPACT MODE — push kinds become a short 'open the dashboard' ping");
{
  on();
  delete process.env.DASHBOARD_URL;
  for (const k of PUSH_KINDS) {
    const t = N.forSend(FULL, k);
    ok(`${k} pushes a compact message`, typeof t === "string" && t.length > 0 && t !== FULL, JSON.stringify(t));
    ok(`${k} says "Sharp Signals Updated"`, /Sharp Signals Updated/.test(t));
    ok(`${k} points to the dashboard`, /Open Sharp Signals to review\./.test(t));
    ok(`${k} is SHORT (<= 3 lines)`, t.split("\n").length <= 3, t);
    ok(`${k} carries NO betting detail (no price/stake/¢/%)`, !/¢|Stake|Maximum|Current:|\bYES\b|\bNO\b|\d%|\$\d/.test(t), t);
  }
}

console.log("\nCOMPACT MODE — dashboard-only kinds are SUPPRESSED (no phone push)");
{
  on();
  for (const k of DASHBOARD_ONLY_KINDS) {
    ok(`forSend(${k}) returns null (suppressed)`, N.forSend(FULL, k) === null);
    ok(`compact(${k}) returns null`, N.compact(k) === null);
  }
}

console.log("\nCOMPACT MODE — an UNKNOWN kind fails TOWARD delivery (never drops a real alert)");
{
  on();
  ok("unknown kind returns the full message, not null", N.forSend(FULL, "TOTALLY_NEW_KIND") === FULL);
  ok("compact() of an unknown kind is null (only forSend has the fallback)", N.compact("TOTALLY_NEW_KIND") === null);
}

console.log("\nCOMPACT MODE — icons match the approved mapping");
{
  on();
  delete process.env.DASHBOARD_URL;
  const icon = (k) => N.compact(k).split(" ")[0];
  ok("new recommendation is 🟢", icon("BUY") === "🟢" && icon("SPECULATIVE_BET") === "🟢");
  ok("priced-out change is 🟡", icon("PRICE_TOO_HIGH") === "🟡" && icon("PRICED_OUT") === "🟡" && icon("COMBO_PRICE_TOO_HIGH") === "🟡");
  ok("withdrawn is 🔴", icon("WITHDRAWN") === "🔴" && icon("COMBO_WITHDRAWN") === "🔴");
  ok("combo available is 🟠", icon("COMBO_BUY") === "🟠");
  ok("fight started / settled is ⚪", icon("FIGHT_STARTED") === "⚪" && icon("SETTLED") === "⚪");
  ok("degradation is ⚠️", icon("DEGRADATION") === "⚠️");
}

console.log("\nDASHBOARD LINK — uses DASHBOARD_URL when set, a plain instruction when not");
{
  on();
  process.env.DASHBOARD_URL = "https://sharp-signals-dashboard.vercel.app";
  const t = N.compact("BUY");
  ok("includes the configured URL", /Open: https:\/\/sharp-signals-dashboard\.vercel\.app/.test(t), t);
  ok("does NOT include the fallback text", !/Open Sharp Signals to review/.test(t));
  process.env.DASHBOARD_URL = "  https://x.example  ";
  ok("URL is trimmed", /Open: https:\/\/x\.example\n?$/.test(N.compact("BUY").trim() + "") || /Open: https:\/\/x\.example/.test(N.compact("BUY")));
  delete process.env.DASHBOARD_URL;
  ok("falls back to a plain instruction when unset", /Open Sharp Signals to review\./.test(N.compact("BUY")));
}

console.log("\nDEGRADE — always a push, never dashboard-only");
{
  on();
  delete process.env.DASHBOARD_URL;
  const t = N.degrade("⚠️ Sharp Signals sentinel FAILED: something broke");
  ok("degrade compacts to the ⚠️ notice", /⚠️ Sharp Signals Updated/.test(t) && /data may be delayed/.test(t));
  ok("degrade does NOT leak the raw error text", !/something broke/.test(t), t);
}

console.log("\nINTEL STAND-DOWN SAFETY — a record that PUSHED a bet never has a later change suppressed");
{
  // A record with NO prior bet push: pure-intel lifecycle stays dashboard-only (nothing was placed).
  off();
  ok("legacy: forSendIntel passes full text through (droveBet=false)", N.forSendIntel(FULL, "DISPROVED", false) === FULL);
  ok("legacy: forSendIntel passes full text through (droveBet=true)", N.forSendIntel(FULL, "DISPROVED", true) === FULL);
  on();
  ok("compact + no prior bet: DISPROVED stays DASHBOARD-ONLY (suppressed)", N.forSendIntel(FULL, "DISPROVED", false) === null);
  ok("compact + no prior bet: MARKET_MOVED stays suppressed", N.forSendIntel(FULL, "MARKET_MOVED", false) === null);
  // A record that DID push a bet: every later material change must reach the phone (the alert-ledger rule).
  const disproved = N.forSendIntel(FULL, "DISPROVED", true);
  ok("compact + prior bet: DISPROVED is PROMOTED to a push (not null)", disproved !== null && disproved !== FULL, disproved);
  ok("...as a 🔴 withdrawal", /🔴 Sharp Signals Updated/.test(disproved) && /withdrawn/i.test(disproved));
  ok("compact + prior bet: CONFIRMED (suspension) promotes to 🔴 withdrawal", /🔴/.test(N.forSendIntel(FULL, "CONFIRMED", true) || ""));
  for (const k of ["MARKET_MOVED", "HUMAN_ACTION_REQUIRED", "WATCH", "FORECAST_UPDATED"]) {
    const t = N.forSendIntel(FULL, k, true);
    ok(`compact + prior bet: ${k} promotes to 🟡 "recommendation changed"`, /🟡 Sharp Signals Updated/.test(t || "") && /A recommendation changed/.test(t || ""), t);
  }
  // Kinds that are ALREADY a push are unaffected by the promotion path.
  ok("compact + prior bet: SPECULATIVE_BET still 🟢", /🟢/.test(N.forSendIntel(FULL, "SPECULATIVE_BET", true) || ""));
  ok("compact + prior bet: WITHDRAWN still 🔴", /🔴/.test(N.forSendIntel(FULL, "WITHDRAWN", true) || ""));
  ok("compact + prior bet: PRICED_OUT still 🟡", /🟡/.test(N.forSendIntel(FULL, "PRICED_OUT", true) || ""));
}

console.log("\nSUPPRESSION SET is EXACTLY the intelligence / news kinds (no accidental drops)");
{
  const nullKinds = Object.keys(N.SPECS).filter((k) => N.SPECS[k] === null).sort();
  ok("dashboard-only set matches the approved mapping exactly", JSON.stringify(nullKinds) === JSON.stringify([...DASHBOARD_ONLY_KINDS].sort()), nullKinds.join(","));
}

console.log("\nNO CONFIDENCE SCALAR can appear in a compact push (construction guard holds)");
{
  on();
  for (const k of PUSH_KINDS) {
    let threw = false;
    try { N.compact(k); } catch { threw = true; }
    ok(`${k} builds without tripping the confidence-scalar guard`, !threw);
  }
}

off();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
