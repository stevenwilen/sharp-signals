// PHASE 9B — the alert ledger, rebuilt.
//
// THE V1 LEDGER SOLVED THE WRONG HALF OF THE PROBLEM. It existed because the pipeline re-sent the
// same bet on every run: ~18 byte-identical "BET: Du Plessis, 5% of bankroll" messages for one pick,
// which a human acting on each would turn into 90% of bankroll on one fight. Real problem, and its
// fix — suppress unless a new source appears or the stake moves 1pt — was too blunt in the other
// direction. Under it, a ticker alerted once could go stale, cross its maximum price, have its
// forecast superseded, or be withdrawn entirely, and the human would hear NOTHING. Silence after
// the first message is its own failure: it leaves a human holding a position the system has since
// disowned.
//
// So: still no duplicate spam, but a MATERIAL CHANGE always speaks. The triggers below are the
// exhaustive list, each one a state the human must know about even though they were told once.
require("./env");
const fs = require("fs");
const path = require("path");
const { paths } = require("./store");

const FILE = path.join(path.dirname(paths.predictions), "alert-ledger-v2.json");

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } };
const save = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2));

// Materiality thresholds. Deliberately modest: the cost of one extra message is a glance, the cost
// of a missed withdrawal is a live position nobody is watching.
const MATERIAL = {
  stakePercentPoints: 0.1,       // suggested stake moved this much
  pricePoints: 0.02,             // executable ask moved 2c
  consensusPoints: 0.02,         // sportsbook consensus moved 2 points
};

// The exhaustive re-alert triggers. Each returns a reason string or null.
//
// Every trigger after `first` compares against a PREVIOUS state, so each guards on `prev` existing.
// Without that guard the comparison triggers throw on a never-seen contract — and a ledger that
// throws is a ledger that sends nothing, which is the failure mode this file exists to prevent.
const TRIGGERS = [
  { id: "first", test: (prev) => !prev ? "first time this contract has been seen" : null },
  { id: "price-crossed-max", test: (prev, now) => !prev ? null :
      (prev.ask <= prev.maximumAcceptablePrice && now.ask > now.maximumAcceptablePrice)
        ? `ask ${fmt(now.ask)} crossed ABOVE the maximum acceptable price ${fmt(now.maximumAcceptablePrice)}` : null },
  { id: "price-favourable-again", test: (prev, now) => !prev ? null :
      (prev.ask > prev.maximumAcceptablePrice && now.ask <= now.maximumAcceptablePrice)
        ? `ask ${fmt(now.ask)} fell back to or below the maximum acceptable price ${fmt(now.maximumAcceptablePrice)}` : null },
  { id: "forecast-changed", test: (prev, now) => !prev ? null :
      prev.forecastHash && now.forecastHash && prev.forecastHash !== now.forecastHash
        ? `new evidence changed the sealed forecast (${prev.forecastHash} -> ${now.forecastHash})` : null },
  { id: "forecast-superseded", test: (prev, now) => !prev ? null :
      now.supersedes && prev.forecastHash && now.supersedes.hash === prev.forecastHash
        ? `the forecast this position rested on was superseded` : null },
  { id: "withdrawn", test: (prev, now) => !prev ? null :
      (prev.classification === "ACTIONABLE EXPERIMENTAL" && now.classification !== "ACTIONABLE EXPERIMENTAL")
        ? `position withdrawn: ${prev.classification} -> ${now.classification}` : null },
  { id: "became-actionable", test: (prev, now) => !prev ? null :
      (prev.classification !== "ACTIONABLE EXPERIMENTAL" && now.classification === "ACTIONABLE EXPERIMENTAL")
        ? `became actionable: ${prev.classification} -> ${now.classification}` : null },
  { id: "top-contract-changed", test: (prev, now) => !prev ? null :
      prev.topTicker && now.topTicker && prev.topTicker !== now.topTicker
        ? `the top-ranked contract on this fight changed (${prev.topTicker} -> ${now.topTicker})` : null },
  { id: "stake-moved", test: (prev, now) => !prev ? null :
      (Number.isFinite(prev.stakePercent) && Number.isFinite(now.stakePercent) &&
       Math.abs(now.stakePercent - prev.stakePercent) >= MATERIAL.stakePercentPoints)
        ? `suggested stake moved ${prev.stakePercent.toFixed(2)}% -> ${now.stakePercent.toFixed(2)}%` : null },
  { id: "data-stale", test: (prev, now) => !prev ? null :
      (!prev.stale && now.stale) ? `data went stale: ${now.staleReason || "snapshot exceeded its freshness limit"}` : null },
  { id: "data-fresh-again", test: (prev, now) => !prev ? null :
      (prev.stale && !now.stale) ? "data is fresh again" : null },
  { id: "pipeline-failed", test: (prev, now) => !prev ? null :
      (!prev.pipelineFailed && now.pipelineFailed) ? `pipeline failed: ${now.pipelineFailure || "unknown stage"}` : null },
  { id: "envelope-left", test: (prev, now) => !prev ? null :
      (prev.withinEnvelope === true && now.withinEnvelope === false)
        ? "the order left the verified fee envelope — its fee is now extrapolated" : null },
];

const fmt = (x) => x == null ? "n/a" : `${(x * 100).toFixed(1)}c`;

// Should we speak about this contract now?
//
// Returns EVERY trigger that fired, not just the first. A position that simultaneously went stale
// AND crossed its max price is two different problems, and reporting one hides the other.
function shouldSend(key, state) {
  const all = load();
  const prev = all[key];
  const fired = [];
  for (const t of TRIGGERS) {
    const why = t.test(prev, state);
    if (why) fired.push({ trigger: t.id, why });
  }
  // No trigger fired -> stay quiet. This is the ONLY quiet path, and it is narrow by design: it
  // means nothing the human needs to know has changed since we last spoke.
  if (!fired.length) return { send: false, why: "no material change since the last message", triggers: [], previouslySent: !!prev };
  return { send: true, why: fired.map((f) => f.why).join("; "), triggers: fired, previouslySent: !!prev };
}

function record(key, state, sentType) {
  const all = load();
  const prev = all[key] || {};
  all[key] = {
    ...state,
    lastSentAt: new Date().toISOString(),
    lastType: sentType,
    firstSentAt: prev.firstSentAt || new Date().toISOString(),
    messageCount: (prev.messageCount || 0) + 1,
  };
  save(all);
  return all[key];
}

// Drop entries whose event is long past. Pruning is by EVENT date, never by "we already told them":
// forgetting a live position because it is old is how a withdrawal goes unsent.
function prune(activeKeys) {
  const all = load();
  let dropped = 0;
  for (const k of Object.keys(all)) if (!activeKeys.includes(k)) { delete all[k]; dropped++; }
  save(all);
  return dropped;
}

module.exports = { shouldSend, record, prune, TRIGGERS, MATERIAL, FILE, load };
