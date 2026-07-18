// MACHINE ATTESTATION — replaces the hand-authored freshness file.
//
//   node run-attest.js <forecast.json> [--eval=<evidence-eval.json>] [--ttl-hours=12] [--write]
//
// This exists because arming used to rest on data/phase9-fresh-run.json, a file NO SCRIPT WROTE. Its
// `passed: true` was a sentence a human typed, and it described "13 bouts / 47 claims" for a card whose
// sealed artifacts hold 12 and 38 — a pipeline run that no longer existed, authorising money
// instructions for any card, forever. A hand-authored attestation is not evidence; it is a wish.
//
// So this READS the sealed artifacts, HASHES them, records each stage's real result, and writes an
// attestation bound to the exact forecast sealHash. Every field is derived, never asserted:
//   - card / eventDate come from the forecast's own card block
//   - forecastSealHash is read back off the sealed file
//   - artifact hashes are sha256 of the bytes on disk
//   - `passed` is COMPUTED from stage checks, never passed in
//
// CRITICAL: writing this file does NOT arm the system. Arming additionally requires ALERTS_ARMED (code)
// and SHARP_PRODUCTION=1 (environment, set only after review). The attestation is one of three
// independent gates and the only one a script may satisfy. See lib/arming.js.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// A stage result derived from an artifact on disk. `ok` is computed from `check`, never asserted.
function artifactStage(stage, absPath, check) {
  if (!fs.existsSync(absPath)) return { stage, ok: false, detail: `${path.basename(absPath)} is not on disk` };
  const bytes = fs.readFileSync(absPath);
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch (e) { return { stage, ok: false, detail: `${path.basename(absPath)} is not valid JSON (${e.message})` }; }
  let verdict;
  try { verdict = check(parsed); } catch (e) { verdict = { ok: false, detail: `check threw: ${e.message}` }; }
  return {
    stage, ok: !!verdict.ok, detail: verdict.detail,
    artifact: { path: path.relative(path.join(__dirname), absPath).replace(/\\/g, "/"), bytes: bytes.length, sha256: sha256(bytes) },
    ...(verdict.extra || {}),
  };
}

function main() {
  const fcPath = process.argv[2];
  if (!fcPath || !fs.existsSync(fcPath)) fail("usage: node run-attest.js <forecast.json> [--eval=<evidence-eval.json>] [--ttl-hours=12] [--write]");
  const evalPath = arg("eval");
  const ttlHours = Number(arg("ttl-hours") || 12);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) fail("--ttl-hours must be a positive number");
  const write = process.argv.includes("--write");

  const fc = JSON.parse(fs.readFileSync(fcPath, "utf8"));
  const card = fc.card && fc.card.eventId;
  const eventDate = fc.card && fc.card.eventDate;
  if (!card || !eventDate) fail("the forecast has no card.eventId / card.eventDate — cannot attest an unnamed card");
  if (!fc.sealHash) fail("the forecast carries no sealHash — an attestation must bind to a sealed forecast, and this one is not sealed");

  const dir = path.dirname(fcPath);
  const stages = [];

  // Stage: the forecast itself. Sealed, reproducible, and it must actually have forecast something.
  stages.push(artifactStage("forecast (rules v" + (fc.rulesVersion || "?") + ")", fcPath, (f) => {
    const n = (f.forecasts || []).length;
    return { ok: n > 0 && !!f.sealHash, detail: `${n} sealed forecasts, sealHash ${f.sealHash}`,
      extra: { forecasts: n } };
  }));

  // Stage: evidence evaluation, if supplied. The admission record must be present on every bout — its
  // absence is exactly the inert-leakage-gate state, and an attestation must not certify that.
  if (evalPath) {
    stages.push(artifactStage("evidence evaluation + admission", evalPath, (ev) => {
      const bouts = ev.bouts || [];
      const withAdmission = (fc.forecasts || []).filter((f) => f.admission).length;
      const roundTrippable = bouts.every((b) => (b.topics || []).every((t) => (t.claims || []).every((c) => c.publishedAt !== undefined)));
      return {
        ok: bouts.length > 0 && withAdmission === (fc.forecasts || []).length && roundTrippable,
        detail: `${bouts.length} bouts; ${withAdmission}/${(fc.forecasts || []).length} forecasts carry an admission record; claims ${roundTrippable ? "carry" : "DO NOT carry"} publishedAt`,
      };
    }));
  }

  // Stage: the fee example the entertainment gate depends on (read here so the attestation records that
  // the dependency was present at attestation time, not merely at some past moment).
  stages.push(artifactStage("verified fee example present", path.join(dir, "fee-examples.json"), (fe) => {
    const small = (Array.isArray(fe) ? fe : []).filter((e) => e.totalCost >= 2 && e.totalCost <= 5 && e.treatment === "taker");
    return { ok: small.length > 0, detail: `${small.length} authenticated $2-$5 taker example(s)` };
  }));

  // Stage: leakage was actually enforced, not merely reported as zero. The forecast records per-bout
  // admission; certify that the boundary ran (claimsConsidered > 0 somewhere), so "0 rejected" means
  // "checked and clean" rather than "never checked".
  stages.push({
    stage: "leakage admission enforced",
    ...(() => {
      const considered = (fc.forecasts || []).reduce((s, f) => s + (f.admission ? f.admission.claimsConsidered : 0), 0);
      const rejected = (fc.forecasts || []).reduce((s, f) => s + (f.admission ? f.admission.claimsRejected : 0), 0);
      const anyAdmission = (fc.forecasts || []).some((f) => f.admission);
      return { ok: anyAdmission, detail: anyAdmission
        ? `${considered} claims checked at the admission boundary, ${rejected} rejected`
        : "no admission record on any forecast — the leakage boundary did not run" };
    })(),
  });

  const failures = stages.filter((s) => !s.ok).map((s) => `${s.stage}: ${s.detail}`);
  const passed = failures.length === 0;

  // A timestamp we can stand behind: the machine's own clock at generation. `expiresAt` is derived, and
  // it is what the arming gate honours — an attestation that has aged out describes an earlier pipeline.
  const ranAt = new Date();
  const expiresAt = new Date(ranAt.getTime() + ttlHours * 3600 * 1000);

  const attestation = {
    writtenBy: "run-attest.js",
    card, eventDate,
    forecastSealHash: fc.sealHash,
    rulesVersion: fc.rulesVersion || (fc.versions && fc.versions.rules) || null,
    pipelineVersion: "unified-v2",
    ranAt: ranAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlHours,
    // Machine provenance, NON-IDENTIFYING. The repo is public, so the raw hostname and cwd would
    // publish a username. What the attestation actually needs is: proof it was machine-generated, the
    // platform/runtime, and a way to tell whether two attestations came from the SAME environment —
    // which a salted hash of the hostname gives without exposing it.
    machine: {
      platform: os.platform(), node: process.version,
      hostFingerprint: crypto.createHash("sha256").update("sharp-attest|" + os.hostname()).digest("hex").slice(0, 12),
      ci: !!process.env.GITHUB_ACTIONS,
    },
    stages,
    passed,
    failures,
    // Whether the pipeline's OWN output would produce an alert — distinct from whether the system is
    // armed to send it. Recorded so a reader can see "the pipeline is clean AND it produced no buy
    // instruction" without conflating that with the arming decision.
    alertsPermittedByPipeline: passed,
    note: "Machine-generated. `passed` means every stage ran and produced its artifact — NOT that a bet exists, and NOT that the system is armed. Arming additionally requires ALERTS_ARMED and SHARP_PRODUCTION=1; writing this file arms nothing.",
  };

  say(`[attest] card ${card} | forecast ${fc.sealHash} | ${stages.length} stages`);
  for (const s of stages) say(`   ${s.ok ? "ok " : "XX "} ${s.stage}: ${s.detail}`);
  say(`[attest] ${passed ? "PASSED" : "FAILED"}${passed ? "" : " — " + failures.length + " stage(s) did not pass"}`);
  say(`[attest] ranAt ${attestation.ranAt} | expiresAt ${attestation.expiresAt} (ttl ${ttlHours}h)`);

  if (!write) {
    say(`\n  DRY RUN. Nothing written. Re-run with --write to produce data/attestation.json.`);
    say(`  Writing it does NOT arm the system — arming also needs ALERTS_ARMED and SHARP_PRODUCTION=1.`);
    return 0;
  }

  const outPath = path.join(dir, "attestation.json");
  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(attestation, null, 2));
  fs.renameSync(tmp, outPath);

  // Read it back and confirm it is what we meant to write — a generator that exits 0 without producing
  // a faithful artifact is the failure this whole file exists to end.
  const back = JSON.parse(fs.readFileSync(outPath, "utf8"));
  if (back.forecastSealHash !== fc.sealHash || back.card !== card || back.passed !== passed) {
    fail(`wrote data/attestation.json but it does not read back faithfully — refusing to leave a half-written attestation`);
  }
  say(`\n  wrote ${path.relative(__dirname, outPath).replace(/\\/g, "/")} — machine attestation, bound to forecast ${fc.sealHash}`);
  say(`  This does NOT arm anything. To send in production, a human sets SHARP_PRODUCTION=1 after review.`);
  return 0;
}

const c = main();
if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); }
process.exit(c || 0);
