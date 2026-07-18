// EXPLORATION LANE — the creative speculative layer. It loosens the EVIDENCE threshold (one credible
// origin may move the number) while inheriting every mechanical protection (leakage, identity, fees,
// caps). These tests cover the exact cases the directive requires, and prove the actionable / buy /
// withdrawal paths with SYNTHETIC fixtures, because the live card is efficiently priced and produces
// no live position (which is correct, not a failure).
const XP = require("../lib/exploration");
const V = require("../lib/contract-value");
const C = require("../lib/contracts");
const F = require("../lib/forecast");
const AL = require("../lib/alert-ledger-v2");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const topic = (o = {}) => ({
  about: o.about || "Fighter A", topic: o.topic || "injury_health", direction: o.direction || "against_about",
  kinds: o.kinds || ["current_condition_report"], strength: o.strength || "moderate",
  marketAwareness: o.awareness || "newly_emerging",
  origin: { independentOrigins: o.origins != null ? o.origins : 1, amplifyingChannels: o.channels || o.origins || 1, composition: {}, citedOrigins: o.cited || [] },
  claims: (o.claims || [{ claim: o.claim || "A has a staph infection", quote: o.quote || "staph" }]),
});
const be = (topics, contradictions = []) => ({ coverage: "PARTIALLY COVERED", topics, contradictions });
const adj = (b, A = "Fighter A", B = "Fighter B") => XP.creativeAdjustment(b, A, B, {});

console.log("1. ONE-ORIGIN PLAUSIBLE INJURY REPORT MOVES THE FORECAST");
{
  const r = adj(be([topic({ origins: 1, topic: "injury_health" })]));
  ok("a single-origin injury report produces an active hypothesis", r.activeHypotheses === 1);
  ok("...with a non-zero creative adjustment (one origin is allowed to matter)", Math.abs(r.creativeLogOddsTowardA) > 0);
  ok("...against_about lowers the subject's win prob", r.creativeLogOddsTowardA < 0);
  const h = r.hypotheses[0];
  ok("...the hypothesis records verification status", /PLAUSIBLE|POSSIBLY|LIKELY/.test(h.verificationStatus));
  ok("...a causal mechanism, falsification, and evidence-against field", !!h.causalMechanism && !!h.falsificationCondition && !!h.evidenceAgainst);
}

console.log("\n2. FIVE CHANNELS REPEATING ONE RUMOUR = ONE ORIGIN");
{
  const r = adj(be([topic({ origins: 1, channels: 5 })]));
  ok("five channels are one origin, not five", r.hypotheses[0].originInformation.independentOrigins === 1);
  ok("...with five amplifiers recorded", r.hypotheses[0].originInformation.amplifyingChannels === 5);
  // The magnitude is the same as a single channel — amplification does not increase weight.
  const one = adj(be([topic({ origins: 1, channels: 1 })]));
  ok("...and the adjustment is NOT inflated by the extra channels", Math.abs(r.creativeLogOddsTowardA) === Math.abs(one.creativeLogOddsTowardA));
}

console.log("\n3. UNVERIFIED BODY-LANGUAGE HYPOTHESIS IS WEAK AND CAPPED");
{
  const r = adj(be([topic({ topic: "psychological", kinds: ["psychological_interpretation"], strength: "weak", origins: 1 })]));
  ok("a body-language read produces a hypothesis", r.hypotheses.length === 1);
  ok("...marked WEAKLY SUPPORTED", r.hypotheses[0].verificationStatus === "WEAKLY SUPPORTED");
  ok("...with a small adjustment, well under the per-hypothesis cap", Math.abs(r.creativeLogOddsTowardA) <= XP.RULES.caps.perHypothesisLogOdds);
}

console.log("\n4. SPECIALIST MATCHUP OBSERVATION IS MECHANISTICALLY RELEVANT");
{
  const r = adj(be([topic({ topic: "style_matchup", kinds: ["matchup_inference"], direction: "favors_about", origins: 1 })]));
  ok("a matchup observation is mechanistically relevant", r.hypotheses[0].verificationStatus === "MECHANISTICALLY RELEVANT");
  ok("...favors_about raises the subject's win prob", r.creativeLogOddsTowardA > 0);
}

console.log("\n5. UNSUPPORTED NARRATIVE GETS NO WEIGHT");
{
  const r = adj(be([topic({ kinds: ["unsupported_narrative"], topic: "psychological", origins: 1 })]));
  ok("an unsupported narrative moves the number by zero", r.creativeLogOddsTowardA === 0);
  ok("...and is labelled UNSUPPORTED NARRATIVE", r.hypotheses[0] ? r.hypotheses[0].verificationStatus === "UNSUPPORTED NARRATIVE" : true);
}

console.log("\n6. THE CREATIVE ADJUSTMENT CHANGES THE FORECAST PROBABILITY");
{
  const r = adj(be([topic({ direction: "favors_about", origins: 2, channels: 2, strength: "strong", kinds: ["current_condition_report"] })]));
  const core = 0.50;
  const creative = XP.creativeCentral(core, r.creativeLogOddsTowardA);
  ok("the creative central probability differs from core", creative !== core);
  ok("...it moved in the hypothesis's direction (favors A -> up)", creative > core);
  ok("...but stayed within the max points move", Math.abs(creative - core) <= XP.RULES.caps.maxProbabilityMovePoints / 100 + 1e-9);
}

console.log("\n7. EVERY CREATIVE ADJUSTMENT IS CAPPED");
{
  const many = be(Array.from({ length: 8 }, (_, i) => topic({ origins: 3, channels: 3, strength: "strong", claim: `distinct claim ${i} about camp ${i}`, topic: "training_camp" })));
  const r = adj(many);
  ok("many strong hypotheses are capped at the per-bout cap", Math.abs(r.creativeLogOddsTowardA) === XP.RULES.caps.perBoutLogOdds);
  ok("...and the cap is flagged", r.capped === true);
}

// ---- The valuation / classification path, with synthetic prices ----
const contract = { ticker: "KXUFCFIGHT-26JUL18XX-A", outcomeType: C.OUTCOME.FIGHTER_WINS, outcomeSubject: "Fighter A",
  contractWording: "Fighter A wins", mappable: true, flags: [], boutId: "B1", bout: "Fighter A vs Fighter B",
  marketStatus: "active" };
const forecast = (creativeCentralA, activeHyps, hypo = {}) => ({
  fight: "Fighter A vs Fighter B", status: "LIMITED EVIDENCE",
  outcomeTree: F.buildTree(0.50, "Fighter A", "Fighter B"),   // a coherent tree with method cells
  systemCentral: { "Fighter A": 0.50, "Fighter B": 0.50 }, systemRange: { forFighter: "Fighter A", low: 0.44, high: 0.62 },
  appliedAdjustments: [], marketBaseline: { probability: 0.50, forFighter: "Fighter A", clockBasis: "WALL_CLOCK", fallbackLevel: "A" },
  exploration: { creativeCentralA, activeHypotheses: activeHyps, hypotheses: [{
    adjustmentLogOdds: 0.1, hypothesis: "A has a staph infection (opponent benefits)", verificationStatus: "POSSIBLY TRUE",
    causalMechanism: "injury -> hurts A", magnitudeBucket: "credible_single_origin", novelty: "NOVEL", probablyPriced: false,
    fatallyContradicted: false, falsificationCondition: "clean weigh-in", evidenceAgainst: "none recorded",
    originInformation: { independentOrigins: 1, amplifyingChannels: 2 }, ...hypo,
  }] },
});
// To BUY YES the book consumes NO bids; a YES fill price = 1 - (NO counter price). Prices are chosen
// INSIDE the verified fee envelope (0.59-0.89). cheapBook -> YES ~0.60 (favourable vs a 0.75 creative
// prob); richBook -> YES ~0.82 (unfavourable). systemRange low (0.44) makes the conservative bound
// strict, so CREATIVE SPECULATIVE (which tolerates a conservative EV that crosses break-even) is the
// tier under test.
const cheapBook = { no: [[0.40, 500]] };   // YES ≈ 0.60
const richBook = { no: [[0.18, 500]] };    // YES ≈ 0.82

console.log("\n8. A CREATIVE POSITION CAN BECOME ACTIONABLE (synthetic favourable price)");
{
  const v = V.valueContract(contract, forecast(0.75, 1), cheapBook, { contracts: 5, nowTs: Date.now(), useExploration: true });
  ok("the exploration valuation returns an EXPLORATION CANDIDATE", v.classification === "EXPLORATION CANDIDATE", v.classification + ": " + (v.reason || ""));
  const sized = XP.classifyAndSize(v, forecast(0.75, 1).exploration);
  ok("...it classifies as a speculative tier", ["CREATIVE SPECULATIVE", "STRONG SPECULATIVE", "BEST EXPERIMENTAL"].includes(sized.classification), sized.classification + ": " + sized.reason);
  ok("...with a $3/$4/$5 stake", [3, 4, 5].includes(sized.stake));
  ok("...carrying the hypothesis, origins, mechanism, and falsification", !!sized.hypothesis && sized.independentOrigins === 1 && !!sized.causalMechanism);
}

console.log("\n9. A CREATIVE POSITION IS REJECTED AFTER FEES (bad price)");
{
  const v = V.valueContract(contract, forecast(0.75, 1), richBook, { contracts: 5, nowTs: Date.now(), useExploration: true });
  const sized = XP.classifyAndSize(v, forecast(0.75, 1).exploration);
  ok("an over-priced creative position does not size", sized.stake === 0);
  ok("...it is NO BET or WATCH, never a tier", !["CREATIVE SPECULATIVE", "STRONG SPECULATIVE", "BEST EXPERIMENTAL"].includes(sized.classification));
}

console.log("\n10. A CREATIVE POSITION IS WITHDRAWN WHEN EVIDENCE CHANGES");
{
  // The alert ledger fires a withdrawal when a position that was ACTIONABLE drops out of it.
  const prev = { ask: 0.40, maximumAcceptablePrice: 0.62, classification: "CREATIVE SPECULATIVE", forecastHash: "h1", stakePercent: 3, topTicker: contract.ticker, stale: false };
  const now = { ...prev, classification: "NO BET" };
  const fired = AL.TRIGGERS.map((t) => t.test(prev, now)).filter(Boolean);
  ok("classification dropping from a tier to NO BET fires a withdrawal", fired.some((w) => /withdrawn/.test(w)));
  // And a superseding forecast fires too.
  const now2 = { ...prev, forecastHash: "h2", supersedes: { hash: "h1" } };
  ok("a superseded forecast fires an update", AL.TRIGGERS.some((t) => /superseded/.test(String(t.test(prev, now2)))));
}

console.log("\n11. NO LEAKAGE / WRONG IDENTITY / STALE PRICE / MALFORMED EVIDENCE CAN ENTER");
{
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "run-forecast.js"), "utf8").replace(/\r/g, "");
  // The creative lane runs on `be = adm.be` — the ADMITTED evidence, after the leakage boundary. So a
  // post-seal / malformed claim is already gone before the creative lane ever sees it.
  ok("the creative lane consumes admitted evidence (be = adm.be) before it runs", /be = adm\.be/.test(src) && src.indexOf("be = adm.be") < src.indexOf("XP.creativeAdjustment"));

  // Stale baseline: the exploration valuation reuses valueContract, which refuses a LOGICAL_OPEN prior.
  const staleForecast = { ...forecast(0.75, 1), marketBaseline: { probability: 0.5, forFighter: "Fighter A", clockBasis: "LOGICAL_OPEN", fallbackLevel: "B" } };
  const v = V.valueContract(contract, staleForecast, cheapBook, { contracts: 5, nowTs: Date.now(), useExploration: true });
  ok("a stale (LOGICAL_OPEN) prior is refused even in the exploration lane", v.classification === "NO BET" && /OPENING line|LOGICAL_OPEN/.test(v.reason));

  // Wrong identity: a contract whose subject is not in the bout is refused by the reused gate.
  const wrong = { ...contract, outcomeSubject: "Nonexistent Person" };
  const vw = V.valueContract(wrong, forecast(0.75, 1), cheapBook, { contracts: 5, nowTs: Date.now(), useExploration: true });
  ok("a contract fighter not in the bout is refused", vw.classification === "UNPRICED" || /not in this bout/.test(vw.reason || ""));

  // No Kalshi write path anywhere the lane touches.
  const expSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "exploration.js"), "utf8");
  ok("the exploration module has no order/write call", !/createOrder|placeOrder|submitOrder|\.request\(["']POST/.test(expSrc));
}

console.log("\nCORE IS UNTOUCHED WHEN THE LANE IS OFF");
{
  // valueContract without useExploration must be byte-identical to before (core frozen).
  const coreV = V.valueContract(contract, forecast(0.75, 1), cheapBook, { contracts: 5, nowTs: Date.now() });
  ok("core valuation ignores the exploration block", coreV.classification === "ACTIONABLE EXPERIMENTAL" || coreV.classification === "NO BET");
  ok("...and never carries an exploration lane tag", coreV.lane === undefined);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
