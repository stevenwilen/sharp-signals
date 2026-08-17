// CHANNEL GRADING — how good is a channel, measured the way the confidence engine actually uses it?
//
// The old grading scored every channel on ROI vs the BETTING LINE. That belonged to the machine that
// tried to beat the market, and it died with it: nothing has written data/sources_graded.json since
// 2026-07-16, so the weights the confidence engine reads have been a fossil while six cards settled.
//
// The replacement asks the only question a consensus engine needs answered:
//
//     On the fights this channel called, did it pick winners MORE OFTEN THAN THE REST OF THE FIELD DID?
//
// edge = mean(won - fieldShare), where fieldShare is the fraction of the OTHER channels covering that
// same fight who took the same side. A channel that only ever echoes the crowd scores ~0 — correctly,
// because it adds nothing to a consensus that already contains the crowd. A channel that breaks from
// the crowd and is right scores high. Being right about a 95%-obvious favourite is worth 0.05; being
// wrong about one costs 0.95.
//
// WHY NOT ROI. ROI (won/price - 1) is unbounded below zero and explodes on longshots: one correct
// contrarian call at a 5% field share pays +19 and can carry a channel to the top tier on its own.
// That fat tail is exactly how this project kept crowning lucky nobodies. `won - fieldShare` is
// bounded to [-1, +1], so no single fight can buy a tier.
//
// NO MARKET DATA. fieldShare comes from the pick corpus itself and the outcome from Kalshi settlement.
// There is no price, no line, no odds feed, and no bet — the torn-out market machinery stays torn out.
//
// Pure logic, no I/O, no clock of its own (the caller passes `now`) — so it is unit-testable.

const DAY = 86400000;

// One channel, one opinion per fight. Recency-weighted on the FIGHT date, not the pick date: what
// decays is how long ago the channel was proven right or wrong, not how early it spoke.
function weightOf(row, now, halfLifeDays) {
  const t = Date.parse(row.fightTime || row.timestamp || 0) || 0;
  const ageDays = Math.max(0, (now - t) / DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// Grade one channel's rows. Each row: { won: 0|1, fieldShare: 0..1, fightTime, timestamp }.
function gradeOne(rows, { halfLifeDays = 365, priorWeight = 10, now = Date.now() } = {}) {
  const usable = rows.filter((r) => (r.won === 0 || r.won === 1) && Number.isFinite(r.fieldShare));
  if (!usable.length) return { n: 0, effN: 0, edge: null, hitRate: null };

  let wSum = 0, wEdge = 0, wHit = 0, wField = 0;
  for (const r of usable) {
    const w = weightOf(r, now, halfLifeDays);
    wSum += w;
    wEdge += w * (r.won - r.fieldShare);
    wHit += w * r.won;
    wField += w * r.fieldShare;
  }
  if (!wSum) return { n: usable.length, effN: 0, edge: null, hitRate: null };

  const effN = wSum;
  const edge = wEdge / wSum;
  // Shrink toward 0 by sample: a channel with 8 graded fights has not earned a headline number.
  const shrunkEdge = edge * (effN / (effN + priorWeight));

  let varNum = 0;
  for (const r of usable) varNum += weightOf(r, now, halfLifeDays) * Math.pow((r.won - r.fieldShare) - edge, 2);
  const std = effN > 1 ? Math.sqrt(varNum / (effN - 1)) : null;
  const se = std != null ? std / Math.sqrt(effN) : null;
  // BOTH bounds, because the tier rule needs both directions (lib/channel-weights.js): a channel is
  // promoted only if its whole interval sits ABOVE the field, and demoted only if the whole interval
  // sits BELOW it. Anything straddling zero is "we cannot tell", which is the truth for almost everyone.
  const edgeLcb = se != null ? edge - 1.645 * se : null;
  const edgeUcb = se != null ? edge + 1.645 * se : null;

  return {
    n: usable.length,
    effN: +effN.toFixed(1),
    hitRate: +(wHit / wSum).toFixed(3),
    fieldHitRate: +(wField / wSum).toFixed(3),   // what the REST of the field managed on these same fights
    edge: +edge.toFixed(3),
    shrunkEdge: +shrunkEdge.toFixed(3),
    edgeSe: se != null ? +se.toFixed(4) : null,
    edgeLcb: edgeLcb != null ? +edgeLcb.toFixed(3) : null,
    edgeUcb: edgeUcb != null ? +edgeUcb.toFixed(3) : null,
  };
}

// Grade every channel present in `rows` (each row additionally carries `source`).
function gradeAll(rows, opts = {}, sourceMeta = {}) {
  const bySource = {};
  for (const r of rows) (bySource[r.source] = bySource[r.source] || []).push(r);
  const out = {};
  for (const [source, rs] of Object.entries(bySource)) {
    out[source] = { source, ...(sourceMeta[source] || {}), ...gradeOne(rs, opts) };
  }
  return out;
}

// Turn the outcome ledger (data/channel-results.json) into gradeable rows.
//
// `before` is the whole reason this lives here rather than inside the runner. Grading a channel on a
// fight and then scoring its vote on that SAME fight is in-sample: the weights already know the answer,
// so the scoreboard reports an accuracy the engine never actually achieved live. run-fit-calibration
// therefore rebuilds each past card using ONLY fights that had already settled when that card ran — a
// walk-forward, which is what the live engine genuinely had. This project has been burned by exactly
// this before (lib/grade.js's dead `trusted` flag was in-sample, and the trusted group turned out to do
// no better out of sample than picking everyone).
//
// fieldShare is recomputed here, never stored: a fight re-seen later with better channel coverage
// should simply produce a better yardstick.
function rowsFromLedger(ledger, { before = Infinity, minField = 3 } = {}) {
  const rows = [];
  for (const f of Object.values((ledger && ledger.fights) || {})) {
    const t = Date.parse(f.fightTime || 0);
    if (!Number.isFinite(t) || t >= before) continue;
    const voters = Object.entries(f.votes || {});
    if (voters.length < minField) continue;         // too thin to be a yardstick
    const total = voters.length;
    const votesA = voters.filter(([, s]) => s === "a").length;
    for (const [source, side] of voters) {
      const sameSide = (side === "a" ? votesA : total - votesA) - 1;   // leave THIS channel out
      rows.push({ source, won: side === f.winner ? 1 : 0, fieldShare: sameSide / (total - 1),
        fightTime: f.fightTime, fight: f.fight });
    }
  }
  return rows;
}

module.exports = { gradeOne, gradeAll, rowsFromLedger, weightOf };
