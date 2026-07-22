// RESEARCH ISOLATION + REMOVABILITY — the proofs that the research module is one-way and safe to remove.
// Spawns run-research.js as a CHILD PROCESS against a temp DATA_DIR seeded with copies of the real sealed
// artifacts, and asserts: production data hashes are unchanged; the runner is opt-in + fail-closed; a
// broken profile fails visibly (health ERROR) without breaking production; inputs-unchanged skips; and the
// import graph has NO research->production edge and NO Telegram path.
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

// ---- seed a temp DATA_DIR with copies of the real sealed artifacts (OFFLINE: no intel file, so no live
// Kalshi read is triggered — this test is deterministic). ---------------------------------------
const CARD = "2026-07-25";
const TMP = path.join(os.tmpdir(), `ss-research-iso-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const seed = [
  `forecast-${CARD}.json`, `entertainment-alerts-${CARD}.json`, `evidence-eval-${CARD}.json`,
  `intelligence-${CARD}.json`, "combo-audit.json",
  "manual-bankroll.json", "paper-ledger.json", "bankrolls.json",
];
for (const f of seed) { if (fs.existsSync(path.join(DATA, f))) fs.copyFileSync(path.join(DATA, f), path.join(TMP, f)); }
fs.writeFileSync(path.join(TMP, "dispatch-receipts.json"), JSON.stringify({ lastCard: { eventId: `UFC-${CARD}`, eventDate: CARD, tickerDate: "26JUL25" } }));

const PROD_FILES = seed.filter((f) => fs.existsSync(path.join(TMP, f)));
const hashesBefore = Object.fromEntries(PROD_FILES.map((f) => [f, sha(fs.readFileSync(path.join(TMP, f)))]));

function runResearch(env) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "run-research.js")], {
      cwd: ROOT, env: { ...process.env, DATA_DIR: TMP, ...env }, stdio: "pipe",
    });
    return { code: 0, out: out.toString() };
  } catch (e) { return { code: e.status || 1, out: (e.stdout ? e.stdout.toString() : "") + (e.stderr ? e.stderr.toString() : "") }; }
}
const health = () => { try { return JSON.parse(fs.readFileSync(path.join(TMP, "research-health.json"), "utf8")); } catch { return null; } };
const prodUnchanged = () => PROD_FILES.every((f) => sha(fs.readFileSync(path.join(TMP, f))) === hashesBefore[f]);

// 1. DISABLED by default: RESEARCH_ENABLED unset => no ledger, health enabledState false. ----------
{
  const r = runResearch({ RESEARCH_ENABLED: "", RESEARCH_MODE: "" });
  const h = health();
  ok(r.code === 0, "1a. disabled run exits 0 (non-fatal)");
  ok(h && h.enabledState === false && h.mode === "DISABLED", "1b. RESEARCH_ENABLED unset => enabledState false, mode DISABLED");
  ok(!fs.existsSync(path.join(TMP, "research-ledger.json")), "1c. disabled run writes NO research ledger");
  ok(prodUnchanged(), "1d. disabled run leaves all production artifacts unchanged");
}

// 2. Mode fail-closed: RESEARCH_ENABLED=1 but bogus mode => DISABLED. ------------------------------
{
  const r = runResearch({ RESEARCH_ENABLED: "1", RESEARCH_MODE: "BOGUS" });
  const h = health();
  ok(r.code === 0 && h && h.mode === "DISABLED", "2. RESEARCH_ENABLED=1 + unrecognized RESEARCH_MODE => DISABLED (fail closed)");
}

// 3. OBSERVE against the REAL sealed card: builds observations, funds NOTHING, changes NO production. --
{
  const r = runResearch({ RESEARCH_ENABLED: "1", RESEARCH_MODE: "OBSERVE" });
  const h = health();
  ok(r.code === 0, "3a. OBSERVE run exits 0");
  ok(h && h.mode === "OBSERVE" && h.enabledState === true && h.status === "OK", "3b. health: mode OBSERVE, enabled, status OK");
  ok(h && h.positionsFunded === 0, "3c. OBSERVE funds zero positions");
  ok(h && h.paperProspectiveStartAt === null, "3d. OBSERVE never stamps the official prospective start");
  ok(prodUnchanged(), "3e. OBSERVE leaves forecast/alerts/real/paper/bankrolls byte-for-byte unchanged");
  ok(fs.existsSync(path.join(TMP, "research-ledger.json")) && fs.existsSync(path.join(TMP, "research-health.json")) && fs.existsSync(path.join(TMP, "research-summary.json")), "3f. only research-* artifacts are created (ledger, health, summary)");
  // v2: the separate directional-intel stream is RETIRED — a seeded WATCH record must no longer become a
  // WATCH_EXPERIMENT observation; that evidence now flows through the forecast's creative tier instead.
  let ledger = null; try { ledger = JSON.parse(fs.readFileSync(path.join(TMP, "research-ledger.json"), "utf8")); } catch {}
  const obs = ledger ? Object.values(ledger.observations || {}) : [];
  ok(!obs.some((o) => o.category === "WATCH_EXPERIMENT"), "3g. v2: the retired intel stream produces NO WATCH_EXPERIMENT observation");
  process.stdout.write(`        [certification] observations=${h && h.observationsGenerated} proposed=${h && h.positionsProposed} funded=${h && h.positionsFunded} notes=${JSON.stringify((h && h.notes) || [])}\n`);
}

// 4. Fingerprint skip: a second identical OBSERVE run detects unchanged inputs and skips. ----------
{
  const r = runResearch({ RESEARCH_ENABLED: "1", RESEARCH_MODE: "OBSERVE" });
  const h = health();
  ok(r.code === 0 && /unchanged/.test(r.out) && h.notes.some((n) => /unchanged/.test(n)), "4. re-run with unchanged inputs skips (fingerprint gate)");
}

// 5. Broken profile fails VISIBLY (health ERROR) but NOT fatally to production. --------------------
{
  const r = runResearch({ RESEARCH_ENABLED: "1", RESEARCH_MODE: "OBSERVE", RESEARCH_PROFILE_VERSION: "research-profile-vNOPE" });
  const h = health();
  ok(r.code === 1, "5a. an unreadable profile exits non-zero (visible to the dispatcher log)");
  ok(h && h.status === "ERROR" && h.errorCategory === "PROFILE_UNREADABLE", "5b. health records status ERROR / PROFILE_UNREADABLE — never silent");
  ok(prodUnchanged(), "5c. the failure leaves all production artifacts unchanged");
}

// 6. Import graph: NO production module imports the research module (one-way). ---------------------
{
  const prodJs = [];
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith(".js") && f !== "run-research.js") prodJs.push(path.join(ROOT, f));
  for (const f of fs.readdirSync(path.join(ROOT, "lib"))) if (f.endsWith(".js") && f !== "research-ledger.js") prodJs.push(path.join(ROOT, "lib", f));
  const RESEARCH_REQUIRE = /require\(\s*['"][^'"]*research-(ledger|profile|health|exploration)[^'"]*['"]\s*\)/;
  const offenders = prodJs.filter((f) => RESEARCH_REQUIRE.test(fs.readFileSync(f, "utf8")));
  ok(offenders.length === 0, `6a. no production module require()s a research module (offenders: ${offenders.map((f) => path.basename(f)).join(", ") || "none"})`);
  // dispatch.js may reference run-research.js only as a spawned child-process STRING, never a require.
  const dispatch = fs.readFileSync(path.join(ROOT, "dispatch.js"), "utf8");
  ok(!/require\(\s*['"][^'"]*run-research[^'"]*['"]\s*\)/.test(dispatch) && /run-research\.js/.test(dispatch), "6b. dispatch spawns run-research.js as a child process, never require()s it");
}

// 7. No Telegram path: the research module and runner never import the notification layer. ---------
{
  const runner = fs.readFileSync(path.join(ROOT, "run-research.js"), "utf8");
  const ledger = fs.readFileSync(path.join(ROOT, "lib", "research-ledger.js"), "utf8");
  const NOTIF = /require\(\s*['"][^'"]*notification[^'"]*['"]\s*\)/;
  ok(!NOTIF.test(runner) && !NOTIF.test(ledger), "7. research runner + ledger never import lib/notification (no Telegram path)");
}

// 9. Shadow exploration (RESEARCH_EXPLORATION_ENABLED=1): reuses production calc but writes ONLY its own
//    artifact — NEVER the sealed forecast — and the fingerprint is stable (a second run skips). ------
{
  for (const f of ["research-ledger.json", "research-health.json", "research-summary.json"]) { try { fs.unlinkSync(path.join(TMP, f)); } catch {} }
  const fcBefore = sha(fs.readFileSync(path.join(TMP, `forecast-${CARD}.json`)));
  const r1 = runResearch({ RESEARCH_ENABLED: "1", RESEARCH_MODE: "OBSERVE", RESEARCH_EXPLORATION_ENABLED: "1" });
  const fcAfter = sha(fs.readFileSync(path.join(TMP, `forecast-${CARD}.json`)));
  ok(r1.code === 0 && fcAfter === fcBefore, "9a. shadow exploration NEVER modifies forecast-<CARD>.json (hash identical, exploration on vs off)");
  ok(fs.existsSync(path.join(TMP, `research-exploration-${CARD}.json`)), "9b. shadow exploration writes its own research-exploration artifact");
  const r2 = runResearch({ RESEARCH_ENABLED: "1", RESEARCH_MODE: "OBSERVE", RESEARCH_EXPLORATION_ENABLED: "1" });
  ok(/unchanged/.test(r2.out), "9c. a second identical exploration run SKIPS (fingerprint no longer self-invalidates)");
  ok(prodUnchanged(), "9d. exploration runs leave all production artifacts unchanged");
}

// 8. Removability: deleting the research artifacts is a no-op for production data. -----------------
{
  for (const f of ["research-ledger.json", "research-health.json", "research-summary.json", `research-exploration-${CARD}.json`]) { try { fs.unlinkSync(path.join(TMP, f)); } catch {} }
  ok(prodUnchanged(), "8. removing every research artifact leaves production data unchanged");
}

fs.rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
