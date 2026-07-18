// MACHINE ATTESTATION — the generator and its arming contract.
//
// Arming used to rest on data/phase9-fresh-run.json, which no script wrote: `passed: true` was a
// sentence a human typed, describing "13 bouts / 47 claims" for a card whose sealed artifacts held 12
// and 38 — a run that no longer existed, authorising any card forever. run-attest.js replaces it with
// an attestation DERIVED from the sealed artifacts and bound to the exact forecast hash.
//
// The load-bearing guarantees, each tested here:
//   - `passed` is COMPUTED from stage checks, never accepted as input;
//   - the attestation binds to the forecast sealHash, not merely the card;
//   - generating it satisfies ONLY the freshness gate — it cannot arm, because production is a
//     separate environment switch no script can set.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const ROOT = path.join(__dirname, "..");
const FC = path.join(ROOT, "data", "forecast-2026-07-18.json");
const EV = path.join(ROOT, "data", "evidence-eval-2026-07-18.json");

if (!fs.existsSync(FC)) { console.log("  SKIP  no sealed forecast on disk"); console.log(`\n${pass}/${pass + fail} passed`); process.exit(0); }

// Run the generator in a scratch dir so the test never touches the live data/ tree. We copy the
// forecast + eval + fee-examples in, run --write, and read the attestation it produces.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sharp-attest-"));
const dataDir = path.join(scratch, "data");
fs.mkdirSync(dataDir, { recursive: true });
const fc = JSON.parse(fs.readFileSync(FC, "utf8"));
fs.copyFileSync(FC, path.join(dataDir, "forecast-2026-07-18.json"));
if (fs.existsSync(EV)) fs.copyFileSync(EV, path.join(dataDir, "evidence-eval-2026-07-18.json"));
const feeSrc = path.join(ROOT, "data", "fee-examples.json");
if (fs.existsSync(feeSrc)) fs.copyFileSync(feeSrc, path.join(dataDir, "fee-examples.json"));

const runAttest = (extraArgs = []) => {
  const args = [path.join(ROOT, "run-attest.js"), path.join(dataDir, "forecast-2026-07-18.json"),
    `--eval=${path.join(dataDir, "evidence-eval-2026-07-18.json")}`, ...extraArgs];
  try { return { out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" }), code: 0 }; }
  catch (e) { return { out: (e.stdout || "") + (e.stderr || ""), code: e.status || 1 }; }
};

try {
  console.log("DRY RUN WRITES NOTHING");
  {
    const r = runAttest([]);
    ok("dry run exits 0", r.code === 0);
    ok("...and says it wrote nothing", /Nothing written|DRY RUN/.test(r.out));
    ok("...and no attestation.json appears", !fs.existsSync(path.join(dataDir, "attestation.json")));
    ok("...and states plainly that writing does not arm", /does NOT arm/.test(r.out));
  }

  console.log("\n--write PRODUCES AN ATTESTATION DERIVED FROM THE ARTIFACTS");
  {
    const r = runAttest(["--ttl-hours=8", "--write"]);
    ok("write exits 0", r.code === 0);
    const p = path.join(dataDir, "attestation.json");
    ok("attestation.json exists", fs.existsSync(p));
    const a = JSON.parse(fs.readFileSync(p, "utf8"));

    ok("it is machine-written", a.writtenBy === "run-attest.js");
    ok("card comes from the forecast", a.card === fc.card.eventId);
    ok("event date comes from the forecast", a.eventDate === fc.card.eventDate);
    ok("it binds to the forecast sealHash", a.forecastSealHash === fc.sealHash);
    ok("it records the rules version", a.rulesVersion === (fc.rulesVersion || (fc.versions && fc.versions.rules)));
    ok("it records machine provenance", a.machine && a.machine.node && a.machine.platform);
    ok("...WITHOUT leaking a hostname or cwd (public repo)",
      a.machine.host === undefined && a.machine.cwd === undefined && /^[0-9a-f]{12}$/.test(a.machine.hostFingerprint));
    ok("ranAt and expiresAt are real timestamps", Number.isFinite(Date.parse(a.ranAt)) && Number.isFinite(Date.parse(a.expiresAt)));
    ok("expiresAt honours the ttl", Math.abs((Date.parse(a.expiresAt) - Date.parse(a.ranAt)) / 3600000 - 8) < 0.01);
    ok("it records exact stage results", Array.isArray(a.stages) && a.stages.length >= 3);
    ok("every stage carries a detail string", a.stages.every((s) => typeof s.detail === "string"));
    ok("artifact stages carry a sha256", a.stages.filter((s) => s.artifact).every((s) => /^[0-9a-f]{64}$/.test(s.artifact.sha256)));

    // The sha256 must be the real hash of the bytes on disk — not a fabricated one.
    const fcStage = a.stages.find((s) => s.artifact && /forecast/.test(s.stage));
    const realHash = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dataDir, "forecast-2026-07-18.json"))).digest("hex");
    ok("the forecast artifact hash matches the bytes on disk", fcStage.artifact.sha256 === realHash);
  }

  console.log("\n`passed` IS COMPUTED FROM STAGES, NEVER ASSERTED");
  {
    // Break a dependency the generator checks — remove the fee example — and the attestation must fail,
    // not pass. Nothing in the input said passed:false; the generator derived it.
    fs.unlinkSync(path.join(dataDir, "fee-examples.json"));
    const r = runAttest(["--write"]);
    const a = JSON.parse(fs.readFileSync(path.join(dataDir, "attestation.json"), "utf8"));
    ok("removing a checked dependency makes passed=false", a.passed === false);
    ok("...and the failure is named", a.failures.some((f) => /fee example/.test(f)));
    ok("...the run still exits 0 (a truthful FAIL is not a crash)", r.code === 0);
    // restore for later
    if (fs.existsSync(feeSrc)) fs.copyFileSync(feeSrc, path.join(dataDir, "fee-examples.json"));
  }

  console.log("\nA FORECAST WITH NO sealHash CANNOT BE ATTESTED");
  {
    const unsealed = { ...fc }; delete unsealed.sealHash;
    fs.writeFileSync(path.join(dataDir, "forecast-2026-07-18.json"), JSON.stringify(unsealed));
    const r = runAttest(["--write"]);
    ok("an unsealed forecast is refused", r.code !== 0 && /not sealed|no sealHash/.test(r.out));
    // restore
    fs.copyFileSync(FC, path.join(dataDir, "forecast-2026-07-18.json"));
  }

  console.log("\nGENERATING THE ATTESTATION DOES NOT SET THE PRODUCTION SWITCH");
  {
    // The generator's whole output is a file. It never touches process env or any arming flag. Prove
    // the arming module still reports production disabled after a generation.
    delete process.env.SHARP_PRODUCTION;
    const ARM = require("../lib/arming");
    runAttest(["--write"]);
    ok("productionEnabled() remains false after generating", ARM.productionEnabled() === false);
    // Strip comments before checking, so the prose that DESCRIBES the arming contract ("requires
    // ALERTS_ARMED and SHARP_PRODUCTION=1") is not mistaken for code that sets it.
    const src = fs.readFileSync(path.join(ROOT, "run-attest.js"), "utf8")
      .replace(/\r/g, "").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    ok("run-attest.js has no code that assigns SHARP_PRODUCTION or ALERTS_ARMED",
      !/process\.env\.SHARP_PRODUCTION\s*=[^=]|ALERTS_ARMED\s*=[^=]/.test(src));
    ok("...and never requires lib/arming at all", !/require\(["'][^"']*arming/.test(src));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
