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
// ATOMIC write (temp + rename). The dispatcher's alerts stage and the fight-day sentinel BOTH write
// this ledger (from separate concurrency groups, overlapping on fight day). record() already reloads
// the current file immediately before writing so it only ever changes its OWN key; the atomic rename
// makes a concurrent reader never see a half-written ledger — together they protect the "already sent"
// dedup that stops a duplicate Telegram.
const save = (o) => { const tmp = FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, FILE); };

// Materiality thresholds. Deliberately modest: the cost of one extra message is a glance, the cost
// of a missed withdrawal is a live position nobody is watching.
// The classifications the system would actually instruct a human to place: core's ACTIONABLE
// EXPERIMENTAL and the exploration lane's three speculative tiers. Used by the withdrawn /
// became-actionable triggers so both lanes are handled identically.
// BOTH lanes' vocabularies, exactly as they are RECORDED into ledger state: the exploration tiers
// record their tier names; the CORE lane records entertainment.tierLabel ("standard experimental" /
// "strong experimental" / "rare maximum"). The set missing the core labels made the withdrawn /
// became-actionable triggers dead for every core-lane BUY — the tool that couldn't catch its own case.
const ACTIONABLE = new Set([
  "ACTIONABLE EXPERIMENTAL", "CREATIVE SPECULATIVE", "STRONG SPECULATIVE", "BEST EXPERIMENTAL",
  "standard experimental", "strong experimental", "rare maximum",
]);

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
  // "Actionable" means a position the system would instruct a human to place — core's ACTIONABLE
  // EXPERIMENTAL OR any of the exploration lane's speculative tiers. A withdrawal must fire when a
  // position leaves that set, whichever lane produced it.
  { id: "withdrawn", test: (prev, now) => !prev ? null :
      (ACTIONABLE.has(prev.classification) && !ACTIONABLE.has(now.classification))
        ? `position withdrawn: ${prev.classification} -> ${now.classification}` : null },
  { id: "became-actionable", test: (prev, now) => !prev ? null :
      (!ACTIONABLE.has(prev.classification) && ACTIONABLE.has(now.classification))
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

  // ---- HUMAN REVIEW triggers -------------------------------------------------------------------
  // Every trigger above inspects a field only a CONTRACT state carries (ask, classification,
  // forecastHash, stakePercent, stale). A human-review state carries {newsKey, about, topic, origins,
  // why, claimHash} and matches none of them, so after `first` fired once, a review key could never
  // speak again — verified by execution: a review escalating origins 1 -> 5 fired ZERO triggers and
  // returned "no material change since the last message".
  //
  // That is the exact inverse of what the governing rule cares about. One origin moves the forecast by
  // zero and five is MAJOR, so 1 -> 5 is the single transition the human most needs to hear — and it
  // was the one transition that could not be sent.
  { id: "review-origins-changed", test: (prev, now) => !prev ? null :
      (Number.isFinite(prev.origins) && Number.isFinite(now.origins) && prev.origins !== now.origins)
        ? `independent origins moved ${prev.origins} -> ${now.origins}` : null },
  // Origins arriving where there were none (or going missing) is also material, and `unknown -> 3`
  // is not comparable with the numeric test above.
  { id: "review-origins-known", test: (prev, now) => !prev ? null :
      (!Number.isFinite(prev.origins) && Number.isFinite(now.origins))
        ? `independent origins are now counted (${now.origins}) where they were previously unknown` : null },
  // A DIFFERENT claim about the same fighter and topic is different news. The ledger key is
  // review|boutId|topic|about and deliberately omits the claim text, so without this a withdrawal
  // rumour is swallowed because a knee rumour about the same fighter was already sent. Keying on the
  // claim instead would fix that and break something worse — every re-worded transcript would re-send —
  // so the key stays coarse and the CHANGE is what speaks.
  { id: "review-claim-changed", test: (prev, now) => !prev ? null :
      (prev.claimHash && now.claimHash && prev.claimHash !== now.claimHash)
        ? `a different claim is now being reported about this fighter and topic` : null },
  { id: "review-verdict-changed", test: (prev, now) => !prev ? null :
      (prev.verdict !== now.verdict && (prev.verdict || now.verdict))
        ? `verification status changed: ${prev.verdict || "unverified"} -> ${now.verdict || "unverified"}` : null },
];

const fmt = (x) => x == null ? "n/a" : `${(x * 100).toFixed(1)}c`;

// Triggers that are news ONLY to someone HOLDING the position: a forecast re-seal, a stake tweak, a
// re-rank. For a PRICE_TOO_HIGH contract the human holds nothing (it is a "DO NOT BUY"), so these fired
// the SAME "PRICE TOO HIGH at 22c" every 2h on each re-seal even though the price never moved — the
// duplicate the operator saw. They are suppressed while a contract is priced out; the price-favourable-
// again and withdrawn triggers still speak, because "it is buyable now" is the one update that matters.
const HOLDER_TRIGGERS = new Set(["forecast-changed", "forecast-superseded", "stake-moved", "top-contract-changed"]);

// Should we speak about this contract now?
//
// Returns EVERY trigger that fired, not just the first. A position that simultaneously went stale
// AND crossed its max price is two different problems, and reporting one hides the other.
function shouldSend(key, state) {
  const all = load();
  const prev = all[key];
  let fired = [];
  for (const t of TRIGGERS) {
    const why = t.test(prev, state);
    if (why) fired.push({ trigger: t.id, why });
  }
  // A priced-out contract is a "DO NOT BUY" the human holds nothing in, so a re-seal / stake tweak /
  // re-rank is not news about it — those re-sent the identical "PRICE TOO HIGH" on every forecast cycle.
  // Suppress the holder-only triggers while priced out; a price-favourable-again or withdrawn still fires
  // (both are OUTSIDE this set), so the human still hears "it is buyable now" or "it is gone". Guarded on
  // `prev` so a genuine first sighting (only `first` fires, which is not a holder trigger) is untouched.
  if (prev && (state.verdict === "PRICE_TOO_HIGH" || state.classification === "PRICE_TOO_HIGH")) {
    fired = fired.filter((f) => !HOLDER_TRIGGERS.has(f.trigger));
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

module.exports = { shouldSend, record, prune, TRIGGERS, MATERIAL, FILE, load, ACTIONABLE };
