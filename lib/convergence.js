// CONVERGENCE ANALYSIS — read-only. Does Kalshi's birth price walk to the sharp book, or the book to
// Kalshi? That is the one live structural question this project has not answered, and the answer
// decides whether a market-birth edge exists at all.
//
// It RECORDS a verdict, never a bet. It is deliberately incapable of influencing a live decision — no
// caller on the forecast/alert path imports this. And it REFUSES a verdict below a minimum sample:
// with two births that are the two sides of one fight, n = 1 event, and n = 1 answers nothing.
//
// The unit of analysis is a FIGHT, not a market. The two sides of a bout are one de-vigged line seen
// twice; counting them as two observations would double every sample and fake significance.
require("./env");

// A price "moved" only if it moved more than this — below it is quote noise, not a walk.
const MOVE_EPSILON = 0.01;

// Group the recorded markets into fight-level events. Each event pairs the two sides (fighter/opponent)
// so the de-vigged line is one observation. preExisting markets — listed before monitoring began — are
// excluded: their first sighting is not a birth and must never be analysed as one.
function toEvents(state) {
  const markets = Object.values((state && state.markets) || {});
  const byEvent = new Map();
  for (const m of markets) {
    if (m.preExisting) continue;                 // the honesty hinge — never analyse a non-birth as a birth
    // A fight key that is order-independent in the two fighters.
    const pair = [m.fighter, m.opponent].map((s) => String(s || "").toLowerCase().trim()).sort().join(" vs ");
    const key = `${m.fightDate || "?"}|${pair}`;
    if (!byEvent.has(key)) byEvent.set(key, { key, fightDate: m.fightDate, sides: [] });
    byEvent.get(key).sides.push(m);
  }
  return [...byEvent.values()];
}

// For one event, describe the birth and the trajectory of ONE canonical side (the first fighter
// alphabetically), so "who moved" is measured on a single consistent price series.
function analyseEvent(ev) {
  // Pick the canonical side deterministically.
  const side = ev.sides.slice().sort((a, b) => String(a.fighter).localeCompare(String(b.fighter)))[0];
  if (!side || !side.birth || side.birth.gap == null) {
    return { key: ev.key, usable: false, reason: "no birth gap recorded for this event" };
  }
  const samples = (side.samples || []).filter((s) => s.sharp != null && s.ask != null);
  if (samples.length < 2) {
    return { key: ev.key, usable: false, reason: `only ${samples.length} paired sample(s) — a trajectory needs at least 2` };
  }
  const first = samples[0], last = samples[samples.length - 1];

  const kalshiMove = +(last.ask - first.ask).toFixed(4);         // how far Kalshi walked
  const sharpMove = +(last.sharp - first.sharp).toFixed(4);      // how far the book walked
  const birthGap = +side.birth.gap.toFixed(4);                    // sharp - ask at birth (who's "right")
  const closeGap = +(last.sharp - last.ask).toFixed(4);          // the gap at the last sample

  // Who converged toward whom? If |gap| shrank, they converged. Attribute the convergence to whichever
  // price moved TOWARD the other's birth level.
  const gapNarrowed = Math.abs(closeGap) < Math.abs(birthGap) - MOVE_EPSILON;
  let convergedBy = "neither";
  if (gapNarrowed) {
    const kalshiTowardSharp = Math.sign(kalshiMove) === Math.sign(birthGap) && Math.abs(kalshiMove) > MOVE_EPSILON;
    const sharpTowardKalshi = Math.sign(sharpMove) === -Math.sign(birthGap) && Math.abs(sharpMove) > MOVE_EPSILON;
    convergedBy = kalshiTowardSharp && sharpTowardKalshi ? "both"
      : kalshiTowardSharp ? "kalshi->sharp (Kalshi's birth was stale — a real edge)"
      : sharpTowardKalshi ? "sharp->kalshi (Kalshi knew first — we'd have been the sucker)"
      : "unclear";
  }

  // Did the apparent birth edge exceed the cost of taking it (fee at the ask + half the bid/ask spread)?
  const fee = side.birth.feeAtAsk != null ? side.birth.feeAtAsk : 0.07 * side.birth.ask * (1 - side.birth.ask);
  const halfSpread = side.birth.bid != null ? Math.max(0, (side.birth.ask - side.birth.bid) / 2) : null;
  const cost = fee + (halfSpread || 0);
  const edgeAfterCost = halfSpread == null ? null : +(Math.abs(birthGap) - cost).toFixed(4);

  return {
    key: ev.key, usable: true, canonicalSide: side.fighter,
    birthAsk: side.birth.ask, birthSharp: side.birth.sharp, birthGap,
    firstSeen: side.firstSeen, birthLatencyH: side.birthLatencyMs != null ? +(side.birthLatencyMs / 3600000).toFixed(2) : null,
    samples: samples.length, kalshiMove, sharpMove, closeGap,
    whoMovedFarther: Math.abs(kalshiMove) > Math.abs(sharpMove) + MOVE_EPSILON ? "kalshi"
      : Math.abs(sharpMove) > Math.abs(kalshiMove) + MOVE_EPSILON ? "sharp" : "tied/none",
    convergedBy,
    birthEdgeAfterCost: edgeAfterCost,
    edgeSurvivedCost: edgeAfterCost == null ? null : edgeAfterCost > 0,
  };
}

// The verdict over all events. REFUSES below minEvents — the whole point is not to fool ourselves with
// n=1.
function evaluate(state, { minEvents = 20 } = {}) {
  const events = toEvents(state);
  const analysed = events.map(analyseEvent);
  const usable = analysed.filter((a) => a.usable);

  const verdict = {
    genuineBirthEvents: events.length,
    usableEvents: usable.length,
    minEventsForVerdict: minEvents,
    ready: usable.length >= minEvents,
  };

  if (!verdict.ready) {
    verdict.finding = `NOT ENOUGH DATA: ${usable.length} usable birth event(s), need ${minEvents}. A verdict now would be n=${usable.length}, which answers nothing. Keep recording.`;
    verdict.events = analysed;
    return verdict;
  }

  const tally = (pred) => usable.filter(pred).length;
  verdict.kalshiWalkedToSharp = tally((a) => /kalshi->sharp/.test(a.convergedBy));
  verdict.sharpWalkedToKalshi = tally((a) => /sharp->kalshi/.test(a.convergedBy));
  verdict.both = tally((a) => a.convergedBy === "both");
  verdict.neither = tally((a) => a.convergedBy === "neither" || a.convergedBy === "unclear");
  verdict.birthEdgeSurvivedCost = tally((a) => a.edgeSurvivedCost === true);
  verdict.finding = verdict.kalshiWalkedToSharp > verdict.sharpWalkedToKalshi
    ? "Kalshi tends to walk toward the sharp book — a stale birth price is the more common pattern. Necessary, not sufficient: only the after-cost survivors matter."
    : "The sharp book walks to Kalshi at least as often — no reliable birth edge; we'd have been the sucker as often as not.";
  verdict.events = analysed;
  return verdict;
}

module.exports = { evaluate, toEvents, analyseEvent, MOVE_EPSILON };
