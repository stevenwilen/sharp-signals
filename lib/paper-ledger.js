// PAPER STRATEGY LEDGER — a $10,000 SIMULATED bankroll that measures the SYSTEM'S prospective
// performance on FORMAL system BUYs only. It is FULLY SEPARATE from the real entertainment ledger
// (lib/manual-bankroll.js): its own file (data/paper-ledger.json), schema, position IDs, P&L, and
// calculations. No real money, no Kalshi write path — paper positions are simulated and settled from the
// PUBLIC market resolution, never placed.
//
// ELIGIBILITY (formal only): a paper position is created ONLY for a formal core-lane individual BUY or a
// formal combo-engine BUY. It EXCLUDES exploration/speculative bets, discretionary bets, PRICE_TOO_HIGH,
// WATCH, withdrawn recommendations, manually-invented combos, retrospective recommendations, and anything
// after the fight has started. Callers decide eligibility; openPaper() also fails closed on non-eligible.
//
// AUTO-CREATED at recommendation time — NEVER requires manual confirmation.
//
// SIZING = percentage scaling (Option A): the FROZEN strategy fractions (3% / 4% / 5%) applied to the
// $10,000 bankroll → $300 / $400 / $500, per-fight cap $500, per-card cap $1,000, formal-combo cap $200.
// The frozen thresholds / gates / recommendation logic are NOT changed — only the bankroll denominator.
//
// PROSPECTIVE START: the ledger stamps `prospectiveStartAt` once, at creation. Official paper performance
// begins then; nothing before it is counted (no retrospective seeding).
require("./env");
const fs = require("fs");
const path = require("path");
const { paths } = require("./store");
const C = require("./contracts");
const FR = require("./freshness");

const FILE = path.join(paths.data, "paper-ledger.json");
const STARTING_DOLLARS = 10000;
const CAPS = { perFightDollars: 500, perCardDollars: 1000, comboStakeDollars: 200 };
const FEE_MODEL_VERSION = (C.FEES && C.FEES.verifiedScope && C.FEES.verifiedScope.asOf) || "unknown";
const STATUS = Object.freeze({ OPEN: "PAPER_OPEN", SETTLED: "PAPER_SETTLED" });
// The categories that are paper-eligible. Exploration/discretionary/manual-combo are NOT here by design.
const ELIGIBLE_CATEGORIES = Object.freeze(["CONFIRMED_SYSTEM_BET", "SYSTEM_COMBO"]);

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const nowIso = () => new Date().toISOString();

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    j.positions = j.positions || {};
    if (j.startingDollars == null) j.startingDollars = STARTING_DOLLARS;
    return j;
  } catch {
    return { startingDollars: STARTING_DOLLARS, prospectiveStartAt: null, feeModelVersion: FEE_MODEL_VERSION, positions: {}, meta: {} };
  }
}
function save(state) {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

// Stamp the prospective start once. Everything counted in official metrics begins at this instant.
function ensureStarted(state, at = nowIso()) {
  if (!state.prospectiveStartAt) state.prospectiveStartAt = at;
  if (state.startingDollars == null) state.startingDollars = STARTING_DOLLARS;
  if (!state.feeModelVersion) state.feeModelVersion = FEE_MODEL_VERSION;
  return state;
}

// Paper stake for a formal single BUY: the frozen fraction × $10,000, capped per-fight, then trimmed by
// the remaining per-card allowance. Combos use a fixed scaled cap. Never changes the frozen fraction.
function paperStake(rec, cardExposureSoFar) {
  const perCardRemaining = Math.max(0, CAPS.perCardDollars - cardExposureSoFar);
  if (rec.kind === "combo") return r2(Math.min(CAPS.comboStakeDollars, perCardRemaining));
  const raw = r2((rec.fraction || 0) * STARTING_DOLLARS);
  return r2(Math.min(raw, CAPS.perFightDollars, perCardRemaining));
}

// Sum of open exposure (cost incl. simulated fee) for one card, so the per-card cap is enforced live.
function openCardExposure(state, eventDate) {
  return r2(Object.values(state.positions)
    .filter((p) => p.status === STATUS.OPEN && p.eventDate === eventDate)
    .reduce((s, p) => s + (p.totalCost || 0), 0));
}

// Create a paper position for a formal BUY. Idempotent by recommendationId — a re-issued BUY never makes a
// second paper position. Fails closed: not eligible / after the bell / already exists / unusable price →
// returns { created:false, reason }. `rec`:
//   { recommendationId, ticker, market?, side?, eventDate, fight, tier, category, kind:'single'|'combo',
//     fraction, entryPrice, edgeAtEntry }
function openPaper(state, rec, opts = {}) {
  const now = opts.now || nowIso();
  const nowMs = opts.nowMs || Date.parse(now);
  ensureStarted(state, now);

  if (!rec || !rec.recommendationId) return { created: false, reason: "no recommendationId" };
  if (!ELIGIBLE_CATEGORIES.includes(rec.category)) return { created: false, reason: `category ${rec.category} is not paper-eligible` };
  // Idempotent: one paper position per recommendation, ever.
  const existing = Object.values(state.positions).find((p) => p.recommendationId === rec.recommendationId);
  if (existing) return { created: false, reason: "already has a paper position", position: existing };
  if (rec.eventDate && FR.fightStarted(rec.eventDate, nowMs)) return { created: false, reason: "fight has started — no paper entry after the bell" };
  const price = Number(rec.entryPrice);
  if (!(price > 0 && price < 1)) return { created: false, reason: "no usable entry price" };

  const stake = paperStake(rec, openCardExposure(state, rec.eventDate));
  if (!(stake > 0)) return { created: false, reason: "no paper stake room under the per-card cap" };
  const contracts = Math.floor(stake / price);
  if (contracts <= 0) return { created: false, reason: "stake buys zero contracts at this price" };
  const feeSimulated = C.tradingFee(contracts, price);          // simulated with the production fee model
  const notionalCost = r2(contracts * price);
  const totalCost = r2(notionalCost + (feeSimulated || 0));

  const paperPositionId = `paper|${rec.recommendationId}`;
  state.positions[paperPositionId] = {
    paperPositionId,
    recommendationId: rec.recommendationId,     // links to the real position IF the human later confirms
    market: rec.market || rec.ticker,
    ticker: rec.ticker,
    side: rec.side || "YES",
    tier: rec.tier || null,
    category: rec.category,
    kind: rec.kind || "single",                 // 'single' | 'combo'
    eventDate: rec.eventDate || null,
    fight: rec.fight || null,
    paperStake: stake,
    contracts,
    entryPrice: r2(price * 10000) / 10000,
    edgeAtEntry: rec.edgeAtEntry != null ? Number(rec.edgeAtEntry) : null,
    notionalCost, feeSimulated: feeSimulated == null ? null : r2(feeSimulated), feeModelVersion: FEE_MODEL_VERSION,
    totalCost,
    openedAt: now,
    status: STATUS.OPEN,
    result: null, payout: null, paperPnl: null, settledAt: null,
    closingLine: null,                          // filled at settle when a market close is available
    history: [{ from: null, to: STATUS.OPEN, reason: "formal BUY issued — paper position auto-created", at: now }],
  };
  return { created: true, position: state.positions[paperPositionId] };
}

// Settle every open paper position whose market has resolved, read-only from the PUBLIC settlement.
// `settlement` is async (ticker) -> { status, result:'yes'|'no'|'' }. Fails closed: an unreadable or
// unfinalized market is left OPEN, never settled to a guess. Never persists (caller saves).
async function settleFromMarket(state, opts = {}) {
  const settlement = opts.settlement;
  if (typeof settlement !== "function") throw new Error("settleFromMarket needs a read-only settlement(ticker) function");
  const now = opts.now || nowIso();
  const open = Object.values(state.positions).filter((p) => p.status === STATUS.OPEN);
  const settled = [], pending = [], unreadable = [];
  for (const p of open) {
    let s = null;
    try { s = await settlement(p.ticker); } catch { s = null; }
    if (!s || (s.result == null && s.status == null)) { unreadable.push(p.paperPositionId); continue; }
    const result = s.result === "yes" ? 1 : s.result === "no" ? 0
      : (/settl|final|determ/i.test(String(s.status || "")) && s.result === "") ? null : undefined;
    if (result === undefined) { pending.push(p.paperPositionId); continue; }
    bookSettlement(p, result, now, opts.closingLine ? opts.closingLine(p.ticker) : null);
    settled.push({ id: p.paperPositionId, fight: p.fight, result, paperPnl: p.paperPnl });
  }
  return { settled, pending, unreadable };
}

// Book one settlement onto a paper position. YES contract: win pays $1/contract.
function bookSettlement(p, result, at, closingLine) {
  p.result = result;
  if (result === 1) { p.payout = p.contracts; p.paperPnl = r2(p.contracts * (1 - p.entryPrice) - (p.feeSimulated || 0)); }
  else if (result === 0) { p.payout = 0; p.paperPnl = r2(-(p.totalCost)); }
  else { p.payout = r2(p.contracts * p.entryPrice); p.paperPnl = 0; }   // void: stake returned
  p.status = STATUS.SETTLED;
  p.settledAt = at;
  if (closingLine != null) p.closingLine = closingLine;
  p.history.push({ from: STATUS.OPEN, to: STATUS.SETTLED, reason: `settled: ${result === 1 ? "won" : result === 0 ? "lost" : "void"}`, at });
  return p;
}

// The CANONICAL paper summary — the ONE object both dashboards read for the paper bankroll. Nothing
// downstream should recompute paper money; it consumes this.
function summary(state) {
  const s = state || load();
  const positions = Object.values(s.positions || {});
  const open = positions.filter((p) => p.status === STATUS.OPEN);
  const settled = positions.filter((p) => p.status === STATUS.SETTLED);
  const starting = s.startingDollars ?? STARTING_DOLLARS;

  const realizedPnl = r2(settled.reduce((a, p) => a + (p.paperPnl || 0), 0));
  const openExposure = r2(open.reduce((a, p) => a + (p.totalCost || 0), 0));
  const maxPendingPayout = r2(open.reduce((a, p) => a + (p.contracts || 0), 0)); // each YES pays $1
  const availableCash = r2(starting + realizedPnl - openExposure);
  const accountValue = r2(availableCash + openExposure);   // open marked at cost → starting + realizedPnl

  const wins = settled.filter((p) => p.result === 1).length;
  const losses = settled.filter((p) => p.result === 0).length;
  const decided = wins + losses;
  const riskedSettled = r2(settled.reduce((a, p) => a + (p.totalCost || 0), 0));
  const edges = positions.map((p) => p.edgeAtEntry).filter((e) => Number.isFinite(e));

  const byTier = {}, byKind = { single: blankBucket(), combo: blankBucket() };
  for (const p of settled) {
    const t = p.tier || "untiered";
    (byTier[t] = byTier[t] || blankBucket());
    accumulate(byTier[t], p); accumulate(byKind[p.kind === "combo" ? "combo" : "single"], p);
  }

  // Paper Performance list — every paper position, normalized for the dashboards.
  const normalized = positions.map((p) => ({
    paperPositionId: p.paperPositionId, recommendationId: p.recommendationId,
    market: p.market, ticker: p.ticker, side: p.side, category: p.category, tier: p.tier, kind: p.kind,
    fight: p.fight, status: p.status, paperStatus: p.status === STATUS.OPEN ? "PAPER OPEN" : "PAPER SETTLED",
    stake: p.paperStake, contracts: p.contracts, entryPrice: p.entryPrice, edgeAtEntry: p.edgeAtEntry,
    fee: p.feeSimulated, feeModelVersion: p.feeModelVersion, result: p.result, paperPnl: p.paperPnl,
    openedAt: p.openedAt, settledAt: p.settledAt, closingLine: p.closingLine ?? null,
  }));

  return {
    label: "Paper Strategy Bankroll",
    startingDollars: starting,
    prospectiveStartAt: s.prospectiveStartAt || null,
    feeModelVersion: s.feeModelVersion || FEE_MODEL_VERSION,
    availableCash, openExposure, accountValue, realizedPnl, maxPendingPayout,
    positions: normalized,
    counts: { total: positions.length, open: open.length, settled: settled.length, wins, losses, voids: settled.length - decided },
    metrics: {
      numRecommendations: positions.length,
      winRate: decided ? r2((wins / decided) * 100) / 100 : null,
      returnOnCapital: starting ? r2((realizedPnl / starting) * 100) / 100 : null,       // ROC on the $10k
      returnOnRisked: riskedSettled ? r2((realizedPnl / riskedSettled) * 100) / 100 : null,
      avgEdgeAtEntry: edges.length ? r2((edges.reduce((a, e) => a + e, 0) / edges.length) * 100) / 100 : null,
      byTier, bySingleVsCombo: byKind,
      closingLineAvailable: settled.some((p) => p.closingLine != null),
    },
  };
}
function blankBucket() { return { n: 0, wins: 0, losses: 0, pnl: 0 }; }
function accumulate(b, p) { b.n++; if (p.result === 1) b.wins++; else if (p.result === 0) b.losses++; b.pnl = r2(b.pnl + (p.paperPnl || 0)); }

module.exports = {
  FILE, STARTING_DOLLARS, CAPS, STATUS, ELIGIBLE_CATEGORIES, FEE_MODEL_VERSION,
  load, save, ensureStarted, openPaper, settleFromMarket, bookSettlement, summary, paperStake,
};
