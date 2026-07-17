// INJECT VERIFIED NEWS — paste a verification block, see what it would actually do.
//
//   node run-inject-verified.js <evidence-eval.json> <verified-block.json> --seal=<ISO> [--write]
//
// The verification chat has no access to this repo, so the bridge is you pasting a block. This reads
// it, COUNTS its origins from the sources it actually supplied, and reports what the forecast would
// do with it. Without --write it changes nothing.
//
// It cannot manufacture a bet. Origins are counted, never accepted; sources need a URL, a quote and
// a date; anything published at or after the seal is refused; and the frozen v7.0.0 magnitude rules
// decide what the count is worth. If you paste one origin, it moves nothing — that is the system
// working, not a bug in the paste.
require("./lib/env");
const fs = require("fs");
const VN = require("./lib/verified-news");
const F = require("./lib/forecast");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

function main() {
  const evPath = process.argv[2], blockPath = process.argv[3];
  const sealArg = (process.argv.find((a) => a.startsWith("--seal=")) || "").split("=")[1];
  const write = process.argv.includes("--write");
  if (!evPath || !blockPath) fail("usage: node run-inject-verified.js <evidence-eval.json> <verified-block.json> --seal=<ISO> [--write]");
  for (const p of [evPath, blockPath]) if (!fs.existsSync(p)) fail(`not found: ${p}`);
  const sealTs = Date.parse(sealArg || "");
  if (!Number.isFinite(sealTs)) fail("--seal=<ISO> is required: sources must be checked against the moment the forecast is sealed");

  const ev = JSON.parse(fs.readFileSync(evPath, "utf8"));
  const raw = JSON.parse(fs.readFileSync(blockPath, "utf8"));
  const blocks = Array.isArray(raw) ? raw : [raw];
  say(`[1] ${blocks.length} verification block(s) | seal ${new Date(sealTs).toISOString()}`);

  const results = [];
  for (const b of blocks) {
    const r = VN.toEvidence(b, sealTs);
    results.push({ block: b, result: r });
    say(`\n  ${b.boutId || "?"} — ${b.about || "?"}: ${b.claim ? String(b.claim).slice(0, 70) : "?"}`);
    if (!r.ok) { say(`     REJECTED:`); for (const e of r.errors) say(`       - ${e}`); continue; }
    if (!r.admissible) { say(`     ${r.verdict} -> ${r.reason}`); continue; }
    say(`     verdict: ${r.verdict}`);
    say(`     independent origins COUNTED from your sources: ${r.origins}  [${r.originIds.join(", ")}]`);
    for (const n of r.notes) say(`     note: ${n}`);
    say(`     what that clears: ${r.wouldClear}`);
    const bout = ev.bouts.find((x) => x.boutId === r.boutId);
    if (!bout) { say(`     but bout ${r.boutId} is not in this evidence file — nothing to attach it to`); continue; }
    say(`     bout currently: coverage ${bout.coverage}, ${(bout.topics || []).length} topic(s)`);
  }

  const admissible = results.filter((x) => x.result.ok && x.result.admissible);
  say(`\n[2] ${admissible.length} of ${blocks.length} block(s) carry evidence the engine can use`);
  if (!admissible.length) { say(`[2] nothing to inject. The forecast is unchanged.`); return 0; }

  const moving = admissible.filter((x) => x.result.origins >= 2);
  say(`[2] ${moving.length} would move the forecast at all (2+ origins). ${admissible.length - moving.length} would move it by exactly zero.`);

  if (!write) {
    say(`\n  DRY RUN. Nothing was written. Re-run with --write to add these to the evidence file,`);
    say(`  then re-run the forecast — the frozen rules decide what happens next, not this script.`);
    return 0;
  }

  // Attach as topics on the bout, in the shape the evaluator already emits, so the forecaster needs
  // no special case for human-supplied evidence: it is evidence, and it is gated like evidence.
  let added = 0;
  for (const { result } of admissible) {
    const bout = ev.bouts.find((x) => x.boutId === result.boutId);
    if (!bout) continue;
    bout.topics = bout.topics || [];
    bout.topics.push({
      topic: result.claim.evidenceType,
      about: result.claim.about,
      direction: result.claim.direction,
      kinds: ["verified_hard_fact"],
      relevance: ["current_condition"],
      freshness: ["current"],
      marketAwareness: "likely_known",   // if reporters have it, assume the market does too
      claims: [result.claim],
      origin: { independentOrigins: result.origins, originIds: result.originIds },
      credibilityComponents: { humanVerified: true, sources: result.claim.sources.length },
      humanSupplied: true,
    });
    added++;
  }
  const out = evPath.replace(/\.json$/, ".with-verified.json");
  ev.verifiedInjections = admissible.map((x) => ({
    boutId: x.result.boutId, verdict: x.result.verdict, origins: x.result.origins,
    originIds: x.result.originIds, sources: x.result.claim.sources, injectedAt: new Date().toISOString(),
    humanSupplied: true,
  }));
  writeJson(out, ev);
  say(`\n  wrote ${out} — ${added} verified topic(s) attached, each marked humanSupplied`);
  say(`  now re-run the forecast against it. The magnitude rules decide; this script does not.`);
  return 0;
}
const c = main();
if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); }
process.exit(c || 0);
