// PHASE 8H/8I — SHADOW MODE. Run the full contract pipeline and place nothing.
//
//   node run-phase8-shadow.js <forecast.json> [--bankroll=10000] [--contracts=100]
//
// NOTHING HERE CAN TRADE OR ALERT. There is no Kalshi order call, no notify import, no Telegram.
// The output is a sealed decision record: what the system WOULD have proposed, at what price, with
// what reasoning — written before the fights, so it can be graded later without reconstruction.
//
// NO-BETS ARE PART OF THE RECORD. A system that only journals its bets cannot be evaluated: the
// question "how often did it decline?" is exactly as important as "how often did it win?", and a
// record that quietly drops rejections will look like a strategy that never says no.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const k = require("./lib/kalshi");
const C = require("./lib/contracts");
const V = require("./lib/contract-value");
const P = require("./lib/portfolio");
const E = require("./lib/evidence-eval");
const { writeJson } = require("./lib/store");

let LINES = 0;
const say = (s) => { LINES++; process.stdout.write(s + "\n"); };
const fail = (m) => { say(`\nFATAL: ${m}`); process.exit(2); };

// A hard structural guarantee, asserted at runtime rather than promised in a comment.
const FORBIDDEN_MODULES = ["./lib/notify", "./lib/positions", "./lib/sizing"];
function assertShadowSafe() {
  for (const m of FORBIDDEN_MODULES) {
    const resolved = (() => { try { return require.resolve(m); } catch { return null; } })();
    if (resolved && require.cache[resolved]) fail(`${m} is loaded — shadow mode must not be able to alert or trade`);
  }
  if (typeof k.createOrder === "function" || typeof k.placeOrder === "function")
    say("  note: the kalshi client exposes no order function in this build");
}

async function main() {
  const fPath = process.argv[2];
  const bankroll = Number((process.argv.find((a) => a.startsWith("--bankroll=")) || "=10000").split("=")[1]);
  const contracts = Number((process.argv.find((a) => a.startsWith("--contracts=")) || "=100").split("=")[1]);
  if (!fPath) fail("usage: node run-phase8-shadow.js <forecast.json> [--bankroll=N] [--contracts=N]");
  if (!fs.existsSync(fPath)) fail(`not found: ${fPath}`);
  assertShadowSafe();

  const fc = JSON.parse(fs.readFileSync(fPath, "utf8"));
  const nowTs = Date.now();
  say(`[stage 1] SHADOW MODE — no orders, no alerts. bankroll $${bankroll}, probe size ${contracts} contracts`);
  say(`[stage 1] forecast: ${fc.card.eventId} sealed ${fc.sealedAt} rules v${fc.rulesVersion} hash ${fc.sealHash}`);

  say(`\n[stage 2] snapshotting Kalshi markets ...`);
  const markets = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" }).catch((e) => fail(`kalshi: ${e.message}`));
  const snapshotTs = Date.now();
  // attach each market to a bout on THIS card
  const bouts = fc.card.bouts;
  const mapped = [];
  for (const m of markets) {
    if (m.status !== "active") continue;
    const sub = (m.yes_sub_title || "").trim();
    const bout = bouts.find((b) => E.norm(sub) === b.a.norm || E.norm(sub) === b.b.norm);
    if (!bout) continue;
    mapped.push(C.mapMarket(m, bout, snapshotTs));
  }
  say(`[stage 2] ${mapped.length} active contracts matched to this card`);
  const byType = {};
  for (const c of mapped) byType[c.outcomeType] = (byType[c.outcomeType] || 0) + 1;
  say(`[stage 2] canonical outcome types: ${JSON.stringify(byType)}`);
  const unmappable = mapped.filter((c) => !c.mappable);
  say(`[stage 2] flagged / unmappable: ${unmappable.length}`);
  for (const c of unmappable.slice(0, 5)) say(`    ${c.ticker}: ${c.flags.join("; ")}`);

  say(`\n[stage 3] valuing against the sealed outcome tree (executable prices, fees, depth) ...`);
  const valued = [];
  for (const c of mapped) {
    const f = fc.forecasts.find((x) => x.boutId === c.boutId);
    let ob = null;
    try { ob = await k.orderbook(c.ticker); } catch (e) { /* handled below */ }
    const v = V.valueContract(c, f, ob, { contracts, nowTs, maxSnapshotAgeMs: 30 * 60 * 1000 });
    v.contract = c;
    // mechanisms let the portfolio see when several positions lean on one read
    v.mechanisms = f && f.appliedAdjustments ? [...new Set(f.appliedAdjustments.filter((a) => a.finalAppliedLogOdds > 0).map((a) => a.mechanism))] : [];
    valued.push(v);
  }

  say(`\n[stage 4] ranking (risk-adjusted, not payout size) ...`);
  const ranked = P.rankContracts(valued, { contracts });
  const counts = {};
  for (const r of ranked) counts[r.classification] = (counts[r.classification] || 0) + 1;
  for (const s of P.STATUSES) say(`    ${s.padEnd(26)} ${counts[s] || 0}`);

  say(`\n[stage 5] sizing (conservative fractional Kelly, capped) ...`);
  for (const r of ranked) r.sizing = P.sizePosition(r, bankroll);
  const capped = P.applyPortfolioCaps(ranked, bankroll);
  const proposed = capped.positions.filter((r) => r.sizing && r.sizing.sized && r.sizing.proposedStake > 0);
  say(`[stage 5] positions the system WOULD propose: ${proposed.length}`);
  say(`[stage 5] card cap $${capped.cardCap} | per-fight cap $${capped.fightCap}`);

  say(`\n[stage 6] portfolio risk across terminal outcomes ...`);
  const positions = proposed.map((r) => ({ boutId: r.boutId, contract: r.contract, mechanisms: r.mechanisms,
    contracts: r.sizing.contracts, totalCost: r.sizing.proposedStake }));
  const port = positions.length ? P.analysePortfolio(positions, fc.forecasts)
    : { perBout: [], cardTotalExposure: 0, cardMaxLoss: 0, cardMaxGain: 0, concentrationByFighter: {}, note: "no positions proposed" };
  say(`[stage 6] card exposure $${port.cardTotalExposure} | max loss $${port.cardMaxLoss} | max gain $${port.cardMaxGain}`);
  for (const b of port.perBout) {
    if (b.nestedPositions && b.nestedPositions.length) say(`    NESTED on ${b.fight}: ${b.nestedPositions[0].note}`);
    if (b.diversificationNote) say(`    ${b.fight}: ${b.diversificationNote}`);
  }

  say(`\n${"=".repeat(96)}\nSHADOW DECISION RECORD — ${fc.card.eventId}   (NOTHING PLACED, NO ALERTS)\n${"=".repeat(96)}`);
  for (const r of capped.positions.slice(0, 14)) {
    const px = r.allInPrice != null ? `${(r.allInPrice * 100).toFixed(1)}c` : "  n/a";
    const p = r.systemCentralProbability != null ? `${(r.systemCentralProbability * 100).toFixed(1)}%` : " n/a ";
    const cons = r.conservativeProbability != null ? `${(r.conservativeProbability * 100).toFixed(1)}%` : " n/a ";
    say(`  #${String(r.rank).padStart(2)} ${r.classification.padEnd(26)} ${String(r.outcomeSubject || "?").padEnd(22)} sys ${p} cons ${cons} all-in ${px}`);
    if (r.classification === "ACTIONABLE EXPERIMENTAL")
      say(`      ${r.unverifiedEstimatedEdge.label}: ${r.unverifiedEstimatedEdge.conservativePoints} pts conservative | stake $${r.sizing.proposedStake} | max acceptable ${(r.maximumAcceptablePrice * 100).toFixed(1)}c`);
    else say(`      ${String(r.reason || "").slice(0, 104)}`);
  }

  // ---- 8H: the sealed decision record ----
  const record = {
    card: fc.card.eventId, phase: 8, mode: "SHADOW",
    decisionTimestamp: new Date(nowTs).toISOString(),
    armed: false, alertsSent: 0, ordersPlaced: 0,
    forecastHash: fc.sealHash, forecastFile: path.basename(fPath),
    contractSnapshotHash: C.sha(mapped.map((m) => m.contractHash)),
    snapshotTimestamp: new Date(snapshotTs).toISOString(),
    versions: { rules: fc.rulesVersion, contracts: "contracts@1.0.0", value: "contract-value@1.0.0", portfolio: "portfolio@1.0.0" },
    feeSchedule: C.FEES,
    bankroll, probeContracts: contracts,
    caps: P.CAPS,
    // EVERY decision, including the no-bets. A record of only the bets cannot be evaluated.
    decisions: capped.positions.map((r) => ({
      ticker: r.ticker, bout: r.bout, contractWording: r.contractWording,
      settlementRules: r.settlementRules,
      outcomeType: r.outcomeType, outcomeSubject: r.outcomeSubject,
      systemProbability: r.systemCentralProbability ?? null,
      conservativeProbability: r.conservativeProbability ?? null,
      probabilityModelStatus: r.probabilityModelStatus ?? null,
      askPrice: r.topOfBookPrice ?? null,
      executablePrice: r.executablePrice ?? null,
      fees: r.fees ?? null, slippage: r.slippage ?? null,
      allInPrice: r.allInPrice ?? null,
      netExpectedValueCentral: r.expectedValueCentral ?? null,
      netExpectedValueConservative: r.expectedValueConservative ?? null,
      breakEvenProbability: r.breakEvenProbability ?? null,
      maximumAcceptablePrice: r.maximumAcceptablePrice ?? null,
      availableLiquidity: r.availableLiquidity ?? null,
      fullyFillable: r.fullyFillable ?? null,
      proposedStake: r.sizing && r.sizing.sized ? r.sizing.proposedStake : 0,
      proposedContracts: r.sizing && r.sizing.sized ? r.sizing.contracts : 0,
      flatStakeComparison: r.sizing && r.sizing.sized ? r.sizing.flatStakeComparison : null,
      classification: r.classification,
      rank: r.rank, leverageScore: r.leverageScore ?? null,
      reason: r.reason || (r.rankingReasons || []).join("; "),
      forecastStatus: r.forecastStatus ?? null,
      evidenceCoverage: r.evidenceCoverage ?? null,
      mainUncertainty: r.mainUncertainty ?? null,
      unverifiedEstimatedEdge: r.unverifiedEstimatedEdge ?? null,
      contractHash: r.contract ? r.contract.contractHash : null,
    })),
    portfolioExposure: port,
    // filled in later by the settlement pass; declared now so the shape cannot drift
    outcomeTracking: { closingPrice: null, settlement: null, netResultAfterCosts: null, couldRealisticallyFill: null,
      note: "to be filled by a later settlement pass — the decision above is sealed and must not be edited then" },
    immutable: true,
  };
  record.decisionHash = C.sha(record);

  const out = `data/phase8-shadow-${fc.card.eventDate}.json`;
  if (fs.existsSync(out)) {
    const prior = JSON.parse(fs.readFileSync(out, "utf8"));
    if (prior.decisionHash && prior.decisionHash !== record.decisionHash) {
      // A price or evidence change makes a NEW version. Overwriting would erase what we actually
      // decided at the time, which is the only thing worth recording.
      const v = out.replace(/\.json$/, `.v${prior.decisionHash}.json`);
      fs.renameSync(out, v);
      record.supersedes = { file: path.basename(v), hash: prior.decisionHash };
      say(`\n  prior decision preserved as ${path.basename(v)} — this is a NEW version, nothing overwritten`);
    }
  }
  writeJson(out, record);
  if (!fs.existsSync(out)) fail(`not written: ${out}`);
  say(`\n  SEALED: ${out}`);
  say(`  decisionHash        = ${record.decisionHash}`);
  say(`  forecastHash        = ${record.forecastHash}`);
  say(`  contractSnapshotHash= ${record.contractSnapshotHash}`);
  say(`  armed=${record.armed}  alertsSent=${record.alertsSent}  ordersPlaced=${record.ordersPlaced}`);
  say(`  decisions recorded: ${record.decisions.length} (including ${record.decisions.filter((d) => d.classification === "NO BET").length} NO BET — no-bets are part of the record)`);
  return 0;
}
main().then((c) => { if (!LINES) { process.stdout.write("FATAL: no output\n"); process.exit(4); } process.exit(c || 0); })
  .catch((e) => { process.stdout.write(`\nFATAL (unhandled): ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
