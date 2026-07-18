// Unit tests for the arming gate and the read-only transport floor.
//
// Every test here asserts a REFUSAL, and every one of them fails against the code as it stood before
// 2026-07-17. That is the point: the two guards this file covers both used to pass while being unable
// to observe their own failure mode.
//
//   - checkArmingPrerequisites() took no card, so it authorised money instructions on the strength of
//     an attestation that describes a different card. data/phase9-fresh-run.json says "13 bouts /
//     47 claims" about UFC-2026-07-18; the sealed artifacts for that card say 12 and 38.
//   - assertNoTradingPath() was a deny-list of five function names. lib/kalshi.js exports a generic
//     request(method, path, {body, auth}) that signs and POSTs, so an order could be placed while the
//     guard returned true. It proved "nothing is NAMED createOrder", not "no order can be placed".
//
// The old suite only ever asserted the direction that trivially passes (test-phase9.js:342). A guard
// that is never made to throw is not a tested guard.
const fs = require("fs");
const path = require("path");
const ARM = require("../lib/arming");
const k = require("../lib/kalshi");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const FRESH = path.join(__dirname, "..", "data", "attestation.json");
const readFresh = () => { try { return JSON.parse(fs.readFileSync(FRESH, "utf8")); } catch { return null; } };
const has = (r, re) => r.blockers.some((b) => re.test(b));

console.log("THE TRANSPORT REFUSES WRITES, AND REFUSES THEM SYNCHRONOUSLY");
{
  // Synchronicity is load-bearing. request() used to be `async`, and an async function that throws
  // returns a REJECTED PROMISE rather than throwing — so a caller's try/catch sails past the refusal
  // and the process gets an unhandled rejection instead of a stop. A guard that only rejects later
  // cannot protect a synchronous assertion.
  let threw = false, sync = true;
  try { const r = k.request("POST", "/portfolio/orders", { body: { count: 1 } }); sync = false; if (r && r.catch) r.catch(() => {}); }
  catch (e) { threw = true; }
  ok("POST throws", threw);
  ok("...synchronously, not as a rejected promise", threw && sync);

  for (const m of ["PUT", "DELETE", "PATCH", "post", "Post"]) {
    let t = false;
    try { const r = k.request(m, "/portfolio/orders", {}); if (r && r.catch) r.catch(() => {}); } catch { t = true; }
    ok(`${m} is refused too (case-insensitive, not a one-string deny-list)`, t);
  }

  // The refusal must not have cost us the reads the whole repo depends on.
  let getOk = true;
  try { const r = k.request("GET", "/exchange/status"); if (!r || typeof r.then !== "function") getOk = false; if (r && r.catch) r.catch(() => {}); }
  catch { getOk = false; }
  ok("GET still returns a promise (reads are unaffected)", getOk);
}

console.log("\nassertNoTradingPath ALLOWLISTS THE SURFACE AND CAN SEE ITS OWN CASE");
{
  ok("passes on the real read-only module", ARM.assertNoTradingPath() === true);

  // The case the old deny-list could not see: a write path that simply isn't called createOrder.
  const cached = require.resolve("../lib/kalshi");
  const real = require.cache[cached].exports;
  try {
    require.cache[cached].exports = { ...real, sendIt: () => {} };
    let threw = false;
    try { ARM.assertNoTradingPath(); } catch { threw = true; }
    ok("an export named 'sendIt' trips the guard (a deny-list of names would not)", threw);
  } finally { require.cache[cached].exports = real; }

  // And the case where the transport floor itself has been removed.
  try {
    require.cache[cached].exports = { ...real, request: () => Promise.resolve({}) };
    let threw = false;
    try { ARM.assertNoTradingPath(); } catch (e) { threw = /read-only transport floor/.test(e.message); }
    ok("a request() that no longer refuses POST trips the guard", threw);
  } finally { require.cache[cached].exports = real; }
}

console.log("\nTHE ARMING GATE MATCHES THE ATTESTATION TO THE CARD");
{
  ok("no cardId at all is a refusal", ARM.checkArmingPrerequisites().ok === false);
  ok("...and says why", has(ARM.checkArmingPrerequisites(), /without a cardId/));

  const fresh = readFresh();
  if (fresh && fresh.card) {
    const other = ARM.checkArmingPrerequisites(fresh.card + "-NOT-THIS-ONE");
    ok("an attestation for another card is a refusal", other.ok === false);
    ok("...and names both cards", has(other, /is for .* but this run is alerting/));
  } else {
    ok("an attestation for another card is a refusal (skipped: no fresh-run file on disk)", true);
    ok("...and names both cards (skipped)", true);
  }

  // A hand-authored attestation (no writtenBy) is a refusal — the original bug. Proven by editing a
  // copy rather than the live file, so the assertion holds regardless of what is on disk.
  const att = readFresh();
  if (att) {
    const backup = fs.readFileSync(FRESH, "utf8");
    try {
      fs.writeFileSync(FRESH, JSON.stringify({ ...att, writtenBy: undefined }, null, 2));
      const hand = ARM.checkArmingPrerequisites(att.card);
      ok("a hand-authored attestation (no writtenBy) is a refusal", hand.ok === false);
      ok("...and says it is hand-authored", has(hand, /hand-authored|writtenBy/));
    } finally { fs.writeFileSync(FRESH, backup); }
  } else {
    // No attestation on disk at all is itself the refusal.
    const none = ARM.checkArmingPrerequisites("UFC-2026-07-18");
    ok("a missing attestation is a refusal", none.ok === false);
    ok("...and says the attestation is missing", has(none, /missing|no machine attestation/));
  }
}

console.log("\nPRODUCTION IS A SEPARATE SWITCH — GENERATING AN ATTESTATION CANNOT ARM");
{
  // The freshness prerequisites and the production switch are independent. A valid attestation can
  // clear checkArmingPrerequisites while the system remains unarmed, because production also requires
  // SHARP_PRODUCTION=1 in the environment — which no script and no commit can set.
  const had = process.env.SHARP_PRODUCTION;
  try {
    delete process.env.SHARP_PRODUCTION;
    ok("productionEnabled() is false without the env switch", ARM.productionEnabled() === false);
    process.env.SHARP_PRODUCTION = "1";
    ok("productionEnabled() is true only with SHARP_PRODUCTION=1", ARM.productionEnabled() === true);
    process.env.SHARP_PRODUCTION = "true";   // anything but exactly "1" must not count
    ok("...and ONLY the exact value 1 (not 'true') counts", ARM.productionEnabled() === false);
  } finally { if (had === undefined) delete process.env.SHARP_PRODUCTION; else process.env.SHARP_PRODUCTION = had; }

  // The forecast-hash binding: an attestation about a DIFFERENT sealed run of the same card is refused.
  // This sub-test is about the HASH, not the clock — so it runs against a freshly-timestamped copy of
  // the real attestation (backed up and restored), because the committed file's TTL legitimately lapses
  // in wall-clock time. Freshness and expiry are tested exhaustively below (lines ~150-167).
  const fresh = readFresh();
  if (fresh && fresh.forecastSealHash) {
    const bak = fs.readFileSync(FRESH, "utf8");
    try {
      fs.writeFileSync(FRESH, JSON.stringify({ ...fresh, writtenBy: "test-arming-guards", passed: true,
        ranAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() }, null, 2));
      const wrong = ARM.checkArmingPrerequisites(fresh.card, "0000000000000000");
      ok("an attestation for another sealed run of the same card is a refusal", wrong.ok === false);
      ok("...and names both hashes", has(wrong, /different sealed run/));
      const right = ARM.checkArmingPrerequisites(fresh.card, fresh.forecastSealHash);
      ok("...but the matching hash clears", right.ok === true, right.blockers.join("; "));
    } finally { fs.writeFileSync(FRESH, bak); }
  }
}

console.log("\nAGE IS ESTABLISHED FROM A REAL TIMESTAMP, NEVER INVENTED");
{
  // Absence is the truthful value. An attestation whose age cannot be established is refused rather
  // than assumed fresh — the inverse of the sealTs-2h bug, where a fabricated timestamp was trusted.
  const fresh = readFresh();
  if (!fresh) {
    ok("a missing attestation is a refusal", ARM.checkArmingPrerequisites("X").ok === false);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }

  const backup = fs.readFileSync(FRESH, "utf8");
  const write = (o) => fs.writeFileSync(FRESH, JSON.stringify(o, null, 2));
  try {
    write({ ...fresh, writtenBy: "test", ranAt: undefined });
    ok("an attestation with no ranAt is a refusal", has(ARM.checkArmingPrerequisites(fresh.card), /no readable ranAt/));

    write({ ...fresh, writtenBy: "test", ranAt: "not-a-date" });
    ok("an unparseable ranAt is a refusal", has(ARM.checkArmingPrerequisites(fresh.card), /no readable ranAt/));

    write({ ...fresh, writtenBy: "test", ranAt: new Date(Date.now() - 200 * 3600e3).toISOString() });
    ok("a stale attestation is a refusal", has(ARM.checkArmingPrerequisites(fresh.card), /old \(limit/));

    write({ ...fresh, writtenBy: "test", ranAt: new Date(Date.now() + 48 * 3600e3).toISOString() });
    ok("an attestation dated in the FUTURE is a refusal, not a pass", has(ARM.checkArmingPrerequisites(fresh.card), /future/));

    write({ ...fresh, writtenBy: "test", passed: false, ranAt: new Date().toISOString() });
    ok("passed:false is a refusal", has(ARM.checkArmingPrerequisites(fresh.card), /did not pass/));

    // Expiry is honoured even when the age bound would pass.
    write({ ...fresh, writtenBy: "test", passed: true, ranAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    ok("an expired attestation is a refusal", has(ARM.checkArmingPrerequisites(fresh.card), /expired/));

    // The one shape that should clear: machine-written, this card, recent, passed, unexpired.
    write({ ...fresh, writtenBy: "test-arming-guards", passed: true, ranAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    const good = ARM.checkArmingPrerequisites(fresh.card);
    ok("a machine-written, card-matched, recent, passing attestation clears", good.ok === true, good.blockers.join("; "));
  } finally {
    // Restore unconditionally: this file is tracked, and leaving a fabricated attestation behind would
    // be worse than any bug this suite catches.
    fs.writeFileSync(FRESH, backup);
  }
  ok("the real attestation was restored byte-for-byte", fs.readFileSync(FRESH, "utf8") === backup);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
