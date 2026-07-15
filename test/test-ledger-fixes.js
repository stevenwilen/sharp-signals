// Offline proof for the pick-ledger review fixes. No network, no Telegram.
const fs = require("fs");
const L = require("../lib/pick-ledger");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ok   " + msg); } else { fail++; console.log("  FAIL " + msg); } };
const day = 86400000, now = Date.now(), iso = (ms) => new Date(ms).toISOString();

console.log("in-memory lifecycle (upsert / settle / revive / prune):");

// 1. a new pick enters as waiting
let m = {};
L.upsert(m, { source: "S", domain: "mma", pick: "Jon Jones", opponent: "Ciryl Gane", timestamp: iso(now), quote: "q", url: "u" });
ok(L.active(m).length === 1 && Object.values(m)[0].status === "waiting", "new pick enters as waiting");

// 2. settled + NEWER pick => revived (rebooking within the 30-day settled window)  [findings #8/#11]
const key = L.keyOf("S", "Jon Jones");
L.settle(m, key, "market closed (fight over)");
m[key].settledAt = iso(now - 10 * day);
ok(m[key].status === "settled", "pick is settled");
L.upsert(m, { source: "S", domain: "mma", pick: "Jon Jones", opponent: "Tom Aspinall", timestamp: iso(now) });
ok(m[key].status === "waiting", "a NEWER pick revives a settled entry (rebooking)");
ok(m[key].opponent === "Tom Aspinall", "revived entry adopts the new opponent");

// 3. settled + OLDER video => stays settled (anti-zombie guard)
let m2 = {};
L.upsert(m2, { source: "S", domain: "mma", pick: "X Y", opponent: "A B", timestamp: iso(now - 20 * day) });
const k2 = L.keyOf("S", "X Y");
L.settle(m2, k2, "market closed (fight over)");
m2[k2].settledAt = iso(now - 5 * day);
L.upsert(m2, { source: "S", domain: "mma", pick: "X Y", opponent: "A B", timestamp: iso(now - 20 * day) });
ok(m2[k2].status === "settled", "a lingering OLD video does NOT resurrect a finished fight");

// 4. same-key opponent change is surfaced (logs WARN) and keeps the newer   [finding #10]
let m3 = {};
L.upsert(m3, { source: "S", domain: "mma", pick: "Bruno Silva", opponent: "Alex Perez", timestamp: iso(now) });
L.upsert(m3, { source: "S", domain: "mma", pick: "Bruno Silva", opponent: "Different Guy", timestamp: iso(now) });
ok(Object.values(m3)[0].opponent === "Different Guy", "same-key opponent change keeps newer (WARN logged above)");

// 5. waiting-expiry is now 120 days, not 45   [finding #12]
let m4 = {};
L.upsert(m4, { source: "S", domain: "mma", pick: "Old Pick", timestamp: iso(now) });
const k4 = L.keyOf("S", "Old Pick");
m4[k4].firstSeen = iso(now - 100 * day);
L.prune(m4);
ok(m4[k4].status === "waiting", "a waiting pick 100 days old is STILL alive (would have died at 45)");
m4[k4].firstSeen = iso(now - 130 * day);
L.prune(m4);
ok(m4[k4].status === "settled" && /expired/.test(m4[k4].settledReason), "a waiting pick past 120 days expires");

// 6. load()/save() corruption handling — touches the real file, always restored   [findings #1/#3/#7]
console.log("\npersistence (atomic save / fail-loud load):");
const FILE = L.FILE;
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
try {
  fs.writeFileSync(FILE, "{ this is not valid json");
  let threw = false;
  try { L.load(); } catch (_) { threw = true; }
  ok(threw, "load() THROWS on a corrupt file (not a silent empty {})");

  fs.unlinkSync(FILE);
  let res = null, threw2 = false;
  try { res = L.load(); } catch (_) { threw2 = true; }
  ok(!threw2 && res && Object.keys(res).length === 0, "load() returns {} on a MISSING file (legit first run)");

  L.save({ [key]: { key, status: "waiting" } });
  ok(fs.existsSync(FILE) && !fs.existsSync(FILE + ".tmp"), "save() leaves no .tmp behind (atomic rename)");
  const rt = L.load();
  ok(rt[key] && rt[key].status === "waiting", "save() -> load() round-trips");
} finally {
  if (backup != null) { fs.writeFileSync(FILE, backup); console.log("  (restored the real pick-ledger.json)"); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
