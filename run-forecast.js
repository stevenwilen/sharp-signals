// PHASE 7 — build SEALED forecasts for one card.
//
//   node run-forecast.js <evidence-eval.json> --seal=<ISO> [--out=path]
//
// Produces win/method/round probabilities with explicit uncertainty. Produces NO bet, stake, Kelly
// fraction, edge claim, BUY/SELL, or alert. Fully deterministic: same inputs + same config version
// -> byte-identical output. No language model touches a number.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const F = require("./lib/forecast");
const L = require("./lib/leakage-guard");
const E = require("./lib/evidence-eval");
const MB = require("./lib/market-baseline");
const O = require("./lib/odds-history");
const { paths, readJson, writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };
const sha = (o) => crypto.createHash("sha256").update(typeof o === "string" ? o : JSON.stringify(o)).digest("hex").slice(0, 16);

// ---- MARKET BASELINE ------------------------------------------------------------------------
// The baseline now comes from lib/market-baseline.js — a deterministic A/B/C/D waterfall reading
// BFO directly. The two functions below are SUPERSEDED and kept only so the sealed Phase 7
// artifacts remain reproducible from the code that produced them.
//
// Why they were replaced, both defects found in Phase 7.5:
//
//   1. SOURCE. baselineFromBfo read predictions.json — the graded PICK ledger. A bout only had a
//      price if a tipster happened to pick it, so coverage tracked tipster attention: 5/15, every
//      one a headline fight, every prelim missing. Reading BFO directly gives 15/15 (96.4% across
//      8 cards). The data was always there.
//
//   2. LEAKAGE. It used the de-vigged CLOSING line stamped `sealTs - 2h` (line ~39) — a synthetic
//      timestamp, not when the price was quoted. The leakage guard passed it because it checked the
//      fabricated time rather than a real one. Open-to-close drift on that card reached 14.9 points,
//      so the "prior" carried up to 14.9 points of information it could not have had.
//
// Do not reuse these. buildBaselines() below is the live path.
function baselineFromBfo_SUPERSEDED(card, sealTs) {
  const rows = readJson(paths.predictions, []);
  const out = {};
  const norm = E.norm;
  for (const b of card.bouts) {
    const hit = rows.find((p) => p.priceSource === "bfo" && p.priceAtCall > 0 && p.priceAtCall < 1 &&
      ((norm(p.pick) === b.a.norm && norm(p.opponent) === b.b.norm) || (norm(p.pick) === b.b.norm && norm(p.opponent) === b.a.norm)));
    if (!hit) continue;
    const pForA = norm(hit.pick) === b.a.norm ? hit.priceAtCall : 1 - hit.priceAtCall;
    // the de-vigged CLOSING line is a pre-fight price; timestamp it 2h before the seal, which is
    // when a closing line is actually quoted. Anything later would be a price we must not see.
    out[b.boutId] = {
      probability: +pForA.toFixed(4), forFighter: b.a.name,
      timestamp: new Date(sealTs - 2 * 3600 * 1000).toISOString(),
      sportsbooks: ["BestFightOdds consensus"], deVigMethod: "normalise two sides' implied probabilities to sum to 1",
      dispersion: null, note: "de-vigged closing consensus",
    };
  }
  return out;
}
// THE LIVE BASELINE PATH. Deterministic waterfall, full provenance, no closing line, no invented
// timestamp. Returns the same {boutId: baseline} shape the forecaster already consumes, so the
// engine and its frozen v7.0.0 rules are untouched.
async function buildBaselines(card, sealTs) {
  const out = {};
  const stats = { A: 0, B: 0, C: 0, D: 0 };
  const fightMs = Date.parse(`${card.eventDate}T22:00:00Z`);
  for (const b of card.bouts) {
    let hit = null;
    try {
      hit = await O.lookup(b.a.name, b.b.name, fightMs);
      if (!hit) {
        const v = await O.lookup(b.b.name, b.a.name, fightMs);
        if (v) hit = { me: v.opp, opp: v.me, ft: v.ft };  // on the opponent's page the sides swap
      }
    } catch (e) { /* the waterfall records this as a missing-source reason */ }
    const rec = MB.buildBaseline(b, { liveSnapshot: null, bfoHit: hit, kalshi: null }, sealTs);
    stats[rec.fallbackLevel]++;
    if (rec.probability === null) continue;   // tier D: no baseline, the bout is not forecast
    // shape it for the forecaster, carrying the full provenance through rather than flattening it
    out[b.boutId] = {
      probability: rec.probability, forFighter: rec.forFighter,
      // A LOGICAL_OPEN price gets NO wall-clock `timestamp`. Synthesising one here — even an
      // honest-looking one — is exactly the superseded bug: the old code stamped `sealTs - 2h` on a
      // closing line and the guard believed it. Absence is the truthful value.
      timestamp: rec.clockBasis === "LOGICAL_OPEN" ? null : rec.forecastTimestamp,
      forecastTimestamp: rec.forecastTimestamp,
      sportsbooks: rec.sourceBooks, deVigMethod: rec.deVigMethod,
      dispersion: rec.marketDispersion,
      note: `${rec.tier} (fallback ${rec.fallbackLevel}); ${rec.tierMeaning}`,
      rawPrices: rec.rawPrices, priceTimestamps: rec.priceTimestamps,
      clockBasis: rec.clockBasis, derivedFrom: rec.derivedFrom,
      staleCheckEnforceable: rec.staleCheckEnforceable,
      oldestPriceAgeHours: rec.oldestPriceAgeHours,
      fallbackLevel: rec.fallbackLevel, missingSourceReasons: rec.missingSourceReasons,
      baselineHash: rec.contentHash,
    };
  }
  return { baselines: out, stats };
}

function baselineFromKalshi_SUPERSEDED(card, sealTs) {
  const lw = readJson(path.join(paths.root, "data", "listing-watch.json"), { markets: {} });
  const out = {};
  for (const b of card.bouts) {
    const mk = Object.values(lw.markets || {}).filter((m) =>
      (E.norm(m.fighter) === b.a.norm && E.norm(m.opponent) === b.b.norm) || (E.norm(m.fighter) === b.b.norm && E.norm(m.opponent) === b.a.norm));
    const forA = mk.find((m) => E.norm(m.fighter) === b.a.norm);
    const forB = mk.find((m) => E.norm(m.fighter) === b.b.norm);
    if (!forA || !forB || !forA.last || !forB.last) continue;
    const a = forA.last.ask, bb = forB.last.ask;
    if (!(a > 0 && a < 1 && bb > 0 && bb < 1)) continue;
    const pA = a / (a + bb);  // de-vig: the two asks sum to >1; normalise
    out[b.boutId] = {
      probability: +pA.toFixed(4), forFighter: b.a.name,
      timestamp: forA.last.t, sportsbooks: ["Kalshi"], deVigMethod: "normalise both sides' asks to sum to 1",
      dispersion: +Math.abs((a + bb) - 1).toFixed(4), note: "live Kalshi asks (overround " + (a + bb).toFixed(3) + ")",
      rawPrices: { [b.a.name]: a, [b.b.name]: bb },
    };
  }
  return out;
}

async function main() {
  const src = process.argv[2];
  const sealArg = (process.argv.find((a) => a.startsWith("--seal=")) || "").split("=")[1];
  const outArg = (process.argv.find((a) => a.startsWith("--out=")) || "").split("=")[1];
  const mkt = (process.argv.find((a) => a.startsWith("--market=")) || "").split("=")[1] || "bfo";

  say(`[stage 1] validating inputs ...`);
  if (!src || !sealArg) fail("usage: node run-forecast.js <evidence-eval.json> --seal=<ISO> [--market=bfo|kalshi] [--out=path]");
  if (!fs.existsSync(src)) fail(`not found: ${src}`);
  const sealTs = Date.parse(sealArg);
  if (!isFinite(sealTs)) fail(`--seal is not a valid ISO timestamp: ${sealArg}`);
  const ev = JSON.parse(fs.readFileSync(src, "utf8"));
  if (!ev.card || !Array.isArray(ev.bouts)) fail("input is not an evidence-eval file");
  // the evaluated evidence must not itself contain outcomes
  try { L.assertNoOutcomeFields(ev.bouts, "evidence-eval file"); }
  catch (e) { fail(`LEAKAGE: ${e.message}`); }
  say(`[stage 1] ${ev.card.eventId}: ${ev.bouts.length} bouts | seal ${new Date(sealTs).toISOString()} | rules v${F.RULES.version}`);

  say(`[stage 2] building market baselines via the A/B/C/D waterfall ...`);
  const { baselines, stats } = await buildBaselines(ev.card, sealTs);
  // the guard checks every baseline BEFORE the forecaster sees it
  for (const [id, b] of Object.entries(baselines)) {
    try { L.checkBaseline(b, sealTs); L.assertNoOutcomeFields(b, `baseline ${id}`); }
    catch (e) { fail(`LEAKAGE in baseline ${id}: ${e.message}`); }
  }
  const priced = Object.keys(baselines).length;
  const pct = (priced / ev.card.bouts.length) * 100;
  say(`[stage 2] tiers: A=${stats.A} B=${stats.B} C=${stats.C} D=${stats.D}`);
  say(`[stage 2] ${priced}/${ev.card.bouts.length} bouts have an admissible baseline (${pct.toFixed(1)}%)`);

  say(`[stage 3] forecasting ...`);
  const forecasts = [];
  let leakRejected = 0;
  for (const bout of ev.card.bouts) {
    const be = ev.bouts.find((x) => x.boutId === bout.boutId);
    const base = baselines[bout.boutId];
    const A = bout.a.name, B = bout.b.name;

    if (!base) {
      // A baseline-unavailable forecast is still a forecast ARTIFACT and must be as auditable as any
      // other: same version block, same data hashes. The first cut gave these ten records a flat
      // `rulesVersion` and no dataHashes, so 10 of 15 sealed artifacts could not be reproduced or
      // traced — caught by the static review before any outcome was opened. Provenance is not a
      // reward for having an opinion; it is the record that we declined to have one.
      forecasts.push({ forecastId: sha(`${bout.boutId}|${sealTs}|nobase`), boutId: bout.boutId, fight: `${A} vs ${B}`,
        event: ev.card.eventId,
        status: "BASELINE UNAVAILABLE", sealedAt: new Date(sealTs).toISOString(),
        reason: "no admissible pre-seal market price for this bout — refusing to invent one",
        marketBaseline: null, systemCentral: null, systemRange: null, marketDisagreementPoints: null,
        outcomeTree: null, appliedAdjustments: [], consideredButZero: 0,
        evidenceCoverage: be ? be.coverage : "UNKNOWN",
        versions: { rules: F.RULES.version, evaluator: "phase6", extractor: ev.card.promptVersion || "phase5" },
        dataHashes: { evidenceEval: be ? sha(be) : null, baseline: null, rules: sha(F.RULES) },
      });
      continue;
    }

    // every claim under this bout must be provably pre-seal
    const claims = (be.topics || []).flatMap((t) => t.claims.map((c) => ({ ...c, publishedAt: c.publishedAt || (be.topics[0].claims[0] || {}).publishedAt })));
    const adm = L.admissibleClaims(claims.filter((c) => c.publishedAt), sealTs);
    leakRejected += adm.rejected.length;

    const adjustments = be.coverage === "INSUFFICIENT EVIDENCE" ? [] : F.buildAdjustments(be, A, B);
    const applied = adjustments.filter((a) => a.finalAppliedLogOdds > 0);

    // net log-odds toward A, capped
    let net = 0;
    for (const a of applied) net += (E.norm(a.fighterFavored) === bout.a.norm ? +a.finalAppliedLogOdds : -a.finalAppliedLogOdds);
    let capNote = null;
    const cap = F.RULES.caps.totalLogOddsPerFighter;
    if (Math.abs(net) > cap) { capNote = `net adjustment ${net.toFixed(3)} hit the total cap ±${cap}`; net = Math.sign(net) * cap; }

    const pMkt = base.probability;
    let pSys = F.sig(F.logit(F.clamp(pMkt)) + net);
    // a hard ceiling on how far a qualitative system may depart from the sharpest available price
    const maxMove = F.RULES.caps.maxProbabilityPointsFromMarket / 100;
    if (Math.abs(pSys - pMkt) > maxMove) {
      pSys = pMkt + Math.sign(pSys - pMkt) * maxMove;
      capNote = `${capNote ? capNote + "; " : ""}hit maxProbabilityPointsFromMarket cap (${F.RULES.caps.maxProbabilityPointsFromMarket}pts)`;
    }

    const unc = F.uncertaintyFor(be, applied);
    const tree = F.buildTree(pSys, A, B);
    const treeErrs = F.verifyTree(tree, A, B);
    if (treeErrs.length) fail(`incoherent outcome tree for ${A} vs ${B}: ${treeErrs.join("; ")}`);

    const status = be.coverage === "INSUFFICIENT EVIDENCE" ? "INSUFFICIENT EVIDENCE"
      : (be.reviewItems || []).length && applied.length ? "HUMAN REVIEW REQUIRED"
      : ["THINLY COVERED", "PARTIALLY COVERED"].includes(be.coverage) ? "LIMITED EVIDENCE" : "COMPLETE";

    forecasts.push({
      forecastId: sha(`${bout.boutId}|${sealTs}|${F.RULES.version}|${pSys.toFixed(4)}`),
      sealedAt: new Date(sealTs).toISOString(),
      event: ev.card.eventId, boutId: bout.boutId, fight: `${A} vs ${B}`,
      status,
      marketBaseline: base,
      systemCentral: { [A]: +pSys.toFixed(4), [B]: +(1 - pSys).toFixed(4) },
      systemRange: { forFighter: A, low: +Math.max(0.01, pSys - unc.halfWidthPoints / 100).toFixed(4),
        high: +Math.min(0.99, pSys + unc.halfWidthPoints / 100).toFixed(4) },
      marketDisagreementPoints: +((pSys - pMkt) * 100).toFixed(2),
      outcomeTree: tree, treeCoherent: true,
      appliedAdjustments: applied, consideredButZero: adjustments.filter((a) => a.finalAppliedLogOdds === 0).length,
      netLogOdds: +net.toFixed(4), capNote,
      uncertainty: { halfWidthPoints: unc.halfWidthPoints, primaryDrivers: unc.drivers,
        conditionsThatWouldMove: (be.reviewItems || []).slice(0, 3).map((r) => r.why) },
      evidenceCoverage: be.coverage, independentOrigins: be.independentOrigins, originBreakdown: be.originBreakdown,
      contradictions: (be.contradictions || []).length,
      missingInformation: be.missingInformation, limitations: be.limitations,
      leakageRejected: adm.rejected.length,
      versions: { rules: F.RULES.version, evaluator: "phase6", extractor: ev.card.promptVersion || "phase5" },
      dataHashes: { evidenceEval: sha(be), baseline: sha(base), rules: sha(F.RULES) },
    });
  }

  say(`[stage 3] ${forecasts.length} forecasts | leakage-rejected claims: ${leakRejected}`);
  const byStatus = {}; for (const f of forecasts) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
  say(`[stage 3] statuses: ${JSON.stringify(byStatus)}`);

  say(`\n${"=".repeat(92)}`);
  say(`SEALED FORECASTS — ${ev.card.eventId}   (NO bets, NO stakes, NO edge claims, NO alerts)`);
  say("=".repeat(92));
  for (const f of forecasts.sort((a, b) => Math.abs(b.marketDisagreementPoints || 0) - Math.abs(a.marketDisagreementPoints || 0))) {
    say(`\n${f.fight}   [${f.status}]`);
    if (!f.marketBaseline) { say(`  ${f.reason}`); continue; }
    const A = f.fight.split(" vs ")[0];
    say(`  market ${(f.marketBaseline.probability * 100).toFixed(1)}%  ->  system ${(f.systemCentral[A] * 100).toFixed(1)}%  ` +
      `[range ${(f.systemRange.low * 100).toFixed(1)}-${(f.systemRange.high * 100).toFixed(1)}]  (for ${A})`);
    say(`  disagreement: ${f.marketDisagreementPoints >= 0 ? "+" : ""}${f.marketDisagreementPoints} pts | ` +
      `uncertainty ±${f.uncertainty.halfWidthPoints} pts | ${f.appliedAdjustments.length} adjustment(s), ${f.consideredButZero} considered-but-zero`);
    if (f.capNote) say(`  CAP: ${f.capNote}`);
    for (const a of f.appliedAdjustments.slice(0, 3))
      say(`    +${a.finalAppliedLogOdds} log-odds -> ${a.fighterFavored} | ${a.mechanism} | ${a.rawMagnitudeClass}` +
        `${a.liftedTo ? `->${a.liftedTo}` : ""} | ${a.informationOriginCount} origins | ${a.evidenceTopics.join(",")}` +
        `${a.capOrReductionReason ? `\n       reduced: ${a.capOrReductionReason}` : ""}`);
    if (f.uncertainty.primaryDrivers.length) say(`  uncertainty from: ${f.uncertainty.primaryDrivers.join("; ")}`);
  }

  say(`\n[stage 4] sealing ...`);
  const out = outArg || src.replace(/evidence-eval/, "forecast");
  const payload = { card: ev.card, sealedAt: new Date(sealTs).toISOString(), rulesVersion: F.RULES.version,
    marketSource: mkt, forecasts, sealedBy: "run-forecast.js", immutable: true };

  // IMMUTABILITY: a sealed file is never overwritten. A correction becomes a NEW version beside it,
  // and the original stays readable forever — requirement 14.
  //
  // `contentHash` identifies the FORECAST itself and reproduces from identical inputs regardless of
  // lineage. `sealHash` covers the WHOLE artifact, lineage included. The first cut computed
  // sealHash and only then attached `supersedes`, so the hash did not cover the file it sealed:
  // the lineage could be edited and the hash would still "verify". A seal that does not cover its
  // own contents is decoration.
  payload.contentHash = sha({ card: payload.card, sealedAt: payload.sealedAt,
    rulesVersion: payload.rulesVersion, marketSource: payload.marketSource, forecasts: payload.forecasts });
  if (fs.existsSync(out)) {
    const prior = JSON.parse(fs.readFileSync(out, "utf8"));
    if (prior.contentHash && prior.contentHash !== payload.contentHash) {
      const vpath = out.replace(/\.json$/, `.v${Date.now()}.json`);
      fs.renameSync(out, vpath);
      payload.supersedes = { file: path.basename(vpath), contentHash: prior.contentHash, sealHash: prior.sealHash };
      say(`[stage 4] a different sealed forecast already existed -> preserved as ${path.basename(vpath)}; this is a NEW version`);
    }
  }
  payload.sealHash = sha(payload);   // computed LAST, over everything including lineage
  const banned = ["stake", "kelly", "recommendation", "buy", "sell", "edgeClaim"];
  const leaked = banned.filter((k) => new RegExp(`"${k}"\\s*:`, "i").test(JSON.stringify(payload)));
  if (leaked.length) fail(`forecast emitted forbidden field(s): ${leaked.join(", ")}`);
  writeJson(out, payload);
  if (!fs.existsSync(out)) fail(`not written: ${out}`);
  say(`[stage 4] sealed: ${out}  hash=${payload.sealHash}  (${forecasts.length} forecasts, immutable)`);
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
process.on("unhandledRejection", (e) => { process.stdout.write(`\nFATAL (rejection): ${e && e.message}\n`); process.exit(1); });
