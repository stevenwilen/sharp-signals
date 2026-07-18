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
const N = require("./lib/names");
const { writeJson } = require("./lib/store");

// IDENTITY. A block is matched to a bout by boutId and nothing else, and boutId is a POSITIONAL index
// (lib/target-card.js:68) over an array that renumbers whenever a bout leaves the card. So a block
// naming the right fighter and a stale boutId lands, silently, on a bout that fighter is not in —
// attaching "Usman's knee is hurt" to Ramirez vs Hooper with no complaint. On 2026-07-17 three HUMAN
// REVIEW alerts shipped with exactly that mis-bind, and every one of their boutIds EXISTS, so the
// `if (!bout)` guard could not see any of them.
//
// The bout knows who is fighting. Ask it. This is the check lib/contracts.js:265-268 already makes on
// the contract path ("matches neither fighter in the mapped bout") — reused, not reinvented.
//
// A bare surname (nameScore 1) is deliberately NOT enough: two fighters share a surname more often
// than you would think, and "Usman over Du Plessis" scores 1 against Du Plessis. lib/names.js:50-52
// says a 1 must be corroborated or refused; here there is nothing to corroborate it with, so refuse.
function fighterIsInBout(about, bout) {
  const fight = bout && bout.fight;
  if (!about || !fight) return { ok: false, why: `bout ${bout && bout.boutId} carries no fight name — cannot confirm "${about}" is in it` };
  const sides = String(fight).split(/\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean);
  if (sides.length !== 2) return { ok: false, why: `cannot read two fighters out of "${fight}" — refusing rather than guessing which side "${about}" is` };
  const scores = sides.map((s) => N.nameScore(s, about));
  const best = Math.max(...scores);
  // Ambiguity is a refusal, not a coin flip. nameScore returns 2 when every token of `about` appears,
  // so a SINGLE-token about ("Silva") scores 2 against "Bruno Silva" by its surname alone — and MMA
  // cards do run Silva vs Silva. If both sides answer to the name we cannot say which one the claim is
  // about, and picking the higher score would just be guessing quietly. lib/match.js:103-116 refuses
  // the same shape on the pick path.
  if (scores[0] >= 2 && scores[1] >= 2) {
    return { ok: false, why: `"${about}" matches BOTH fighters in "${fight}" — ambiguous, refusing rather than guessing a side` };
  }
  if (best >= 2) return { ok: true, side: scores[0] >= 2 ? "a" : "b" };
  if (best === 1) return { ok: false, why: `"${about}" matches only a surname in "${fight}" — a surname alone is never sufficient (lib/names.js:50)` };
  return { ok: false, why: `"${about}" is in neither side of "${fight}" — this block names a fighter who is not in bout ${bout.boutId}` };
}

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
    if (!bout) { say(`     but bout ${r.boutId} is not in this evidence file — nothing to attach it to`); r.identityOk = false; continue; }
    const id = fighterIsInBout(r.claim.about, bout);
    r.identityOk = id.ok;
    if (!id.ok) { say(`     ⛔ IDENTITY REFUSED: ${id.why}`); continue; }
    say(`     bout: ${bout.fight} — "${r.claim.about}" confirmed on side ${id.side}`);
    say(`     bout currently: coverage ${bout.coverage}, ${(bout.topics || []).length} topic(s)`);
  }

  // identityOk is part of admissibility, not a warning printed beside it. The dry run used to warn
  // while the --write path silently dropped (`if (!bout) continue`) — the safer mode told you and the
  // mutating one did not.
  const admissible = results.filter((x) => x.result.ok && x.result.admissible && x.result.identityOk);
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
  const attached = [];
  for (const { result } of admissible) {
    const bout = ev.bouts.find((x) => x.boutId === result.boutId);
    // Belt and braces: `admissible` already required identityOk, but a silent `continue` here is how
    // the tally and the file disagreed in the first place. If this ever fires, it is a bug, not a skip.
    if (!bout || !fighterIsInBout(result.claim.about, bout).ok) {
      fail(`block for ${result.boutId} passed admissibility but failed identity at write time — refusing to write a partial injection`);
    }
    attached.push(result);
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
  // Built from what ACTUALLY attached, not from what was admissible. These were different sets: the
  // ledger was mapped over `admissible` while `added` counted only the blocks that found a bout, so
  // ev.verifiedInjections could record an injection that never happened — a tally edited by hand
  // rather than recomputed, in the tally itself.
  ev.verifiedInjections = attached.map((r) => ({
    boutId: r.boutId, verdict: r.verdict, origins: r.origins,
    originIds: r.originIds, sources: r.claim.sources, injectedAt: new Date().toISOString(),
    humanSupplied: true,
  }));
  if (ev.verifiedInjections.length !== added) fail(`internal: ledger says ${ev.verifiedInjections.length} injections but ${added} attached — refusing to write a record that disagrees with itself`);
  writeJson(out, ev);
  say(`\n  wrote ${out} — ${added} verified topic(s) attached, each marked humanSupplied`);
  say(`  now re-run the forecast against it. The magnitude rules decide; this script does not.`);
  return 0;
}
const c = main();
if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); }
process.exit(c || 0);
