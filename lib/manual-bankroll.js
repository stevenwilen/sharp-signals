// MANUAL BANKROLL — the REAL $100 money ledger, structurally separate from the PAPER research book
// (lib/positions.js). Three statuses, and ONLY ONE of them ever touches the real P&L:
//
//   PAPER_ONLY                research tracking only. actualStake $0. NEVER sent as a buy
//                             recommendation. Excluded from the real $100 P&L. (The paper book in
//                             lib/positions.js is the source of these; they are mirrored here only so
//                             the dashboard can show all three statuses in one place.)
//   RECOMMENDED_NOT_CONFIRMED  Telegram sent a buy instruction. You have NOT confirmed you placed it.
//                             actualStake $0. Excluded from the real P&L until you confirm.
//   MANUALLY_PLACED           you confirmed you bought it (run-confirm-placement.js), with the ACTUAL
//                             stake and execution price. INCLUDED in the real $100 bankroll P&L.
//
// THE LOAD-BEARING FACT: this build has no order path, so the system CANNOT know whether you placed a
// bet. A recommendation therefore stays RECOMMENDED_NOT_CONFIRMED forever unless YOU tell it otherwise.
// Nothing enters the real P&L except what you explicitly confirmed placing, at the price you actually
// got. This is the exact opposite of the "confident +$47 for a bet nobody placed" failure the paper
// book was built to avoid — here, a bet nobody confirmed contributes exactly $0.
require("./env");
const fs = require("fs");
const path = require("path");
const { paths } = require("./store");
const C = require("./contracts");   // fee model (tradingFee + verifiedScope version)

// Resolve the ledger through the shared data dir (store.js), like every other module. With DATA_DIR unset
// — production and local both leave it empty — paths.data is repo/data, so this is the SAME file as the
// old hardcoded path; it changes nothing in production. What it fixes: a DATA_DIR-scoped test now writes to
// its temp dir instead of the REAL ledger, so test runs can no longer read or pollute your live positions.
const FILE = path.join(paths.data, "manual-bankroll.json");
const BANKROLL = 100;

const STATUS = Object.freeze({
  PAPER_ONLY: "PAPER_ONLY",
  RECOMMENDED_NOT_CONFIRMED: "RECOMMENDED_NOT_CONFIRMED",
  MANUALLY_PLACED: "MANUALLY_PLACED",
  DECLINED: "DECLINED",          // you told the system you did NOT place it — kept for the audit trail
  SETTLED: "SETTLED",            // a MANUALLY_PLACED position whose fight resolved (real P&L booked)
});

// Only a manually-placed (or its settled form) position is real money.
const isRealMoney = (p) => p.status === STATUS.MANUALLY_PLACED || (p.status === STATUS.SETTLED && p.wasManuallyPlaced);

const nowIso = () => new Date().toISOString();
const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

// ── categorisation ──────────────────────────────────────────────────────────────────────────
// Every real position carries a `category` (5 kinds) and a `source` (SYSTEM | DISCRETIONARY). Only the
// two FORMAL system categories are paper-eligible — everything speculative/discretionary lives ONLY here.
const PAPER_ELIGIBLE_CATEGORIES = Object.freeze(["CONFIRMED_SYSTEM_BET", "SYSTEM_COMBO"]);
function deriveCategory(e) {
  const src = e.source || "SYSTEM";
  const lane = e.lane || "core";
  if (lane === "combo") return src === "DISCRETIONARY" ? "SPECULATIVE_COMBO" : "SYSTEM_COMBO";
  if (src === "DISCRETIONARY") return "DISCRETIONARY_BET";
  if (lane === "exploration") return "SPECULATIVE_BET";
  return "CONFIRMED_SYSTEM_BET";   // core lane = formal individual BUY
}
function stampCategory(e) {
  e.source = e.source || "SYSTEM";
  e.category = deriveCategory(e);
  e.paperEligible = PAPER_ELIGIBLE_CATEGORIES.includes(e.category);
  return e;
}
// Fee object: actual when you provide it, estimated from the production fee model otherwise, unknown when
// it cannot be computed. NEVER silently treats an estimate as exact — the `basis` field records which.
function feeObject(provided, contracts, price) {
  if (provided != null && Number.isFinite(Number(provided))) return { amount: r2(provided), basis: "actual", feeModelVersion: null };
  const est = (Number.isFinite(contracts) && Number.isFinite(price)) ? C.tradingFee(contracts, price) : null;
  if (est != null) return { amount: r2(est), basis: "estimated", feeModelVersion: C.FEES?.verifiedScope?.asOf || null };
  return { amount: null, basis: "unknown", feeModelVersion: null };
}

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); return { bankroll: j.bankroll || BANKROLL, entries: j.entries || {}, meta: j.meta || {} }; }
  catch (e) { if (e.code === "ENOENT") return { bankroll: BANKROLL, entries: {}, meta: {} }; throw e; }
}
function save(state) {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2));
  fs.renameSync(tmp, FILE);
}

function transition(p, to, reason, extra = {}) {
  p.history = p.history || [];
  p.history.push({ from: p.status, to, reason: reason || null, at: nowIso(), ...extra });
  p.status = to;
}

// Record (or refresh) a RECOMMENDATION when Telegram sent a buy instruction. Idempotent per key: a
// re-send of the same recommendation does not create a duplicate and NEVER downgrades a MANUALLY_PLACED
// entry back to a recommendation. Actual stake is always $0 here — the system did not place anything.
function recordRecommendation(state, rec) {
  const key = rec.key || `${rec.boutId}|${rec.ticker}`;
  const existing = state.entries[key];
  // Never overwrite a confirmed placement or a decline with a fresh recommendation.
  if (existing && [STATUS.MANUALLY_PLACED, STATUS.SETTLED, STATUS.DECLINED].includes(existing.status)) {
    existing.latestRecommendation = { ...recFields(rec), at: nowIso() };
    return existing;
  }
  if (existing && existing.status === STATUS.RECOMMENDED_NOT_CONFIRMED) {
    Object.assign(existing, recFields(rec), { lastRecommendedAt: nowIso() });
    existing.recommendationCount = (existing.recommendationCount || 1) + 1;
    return stampCategory(existing);
  }
  const entry = {
    key, positionId: key, recommendationId: rec.recommendationId || key, ...recFields(rec),
    status: STATUS.RECOMMENDED_NOT_CONFIRMED,
    actualStake: 0, executionPrice: null, actualContracts: null, fees: null,   // nothing placed
    includedInRealPnl: false,
    firstRecommendedAt: nowIso(), lastRecommendedAt: nowIso(), recommendationCount: 1,
    history: [{ from: null, to: STATUS.RECOMMENDED_NOT_CONFIRMED, reason: "Telegram sent a buy instruction", at: nowIso() }],
  };
  stampCategory(entry);
  state.entries[key] = entry;
  return entry;
}
function recFields(rec) {
  return {
    ticker: rec.ticker, market: rec.ticker, side: rec.side || "YES", source: rec.source || "SYSTEM",
    boutId: rec.boutId, fight: rec.fight, lane: rec.lane || "core",
    classification: rec.classification,
    recommendedStakeDollars: rec.recommendedStakeDollars ?? rec.stake ?? null,
    recommendedFraction: rec.recommendedFraction ?? null,
    maximumAcceptablePrice: rec.maximumAcceptablePrice ?? null,
    askAtRecommendation: rec.ask ?? null,
    approxContracts: rec.approxContracts ?? rec.contracts ?? null,
    forecastHash: rec.forecastHash ?? null,
  };
}

// YOU confirm you placed the bet, at the price you actually got. Only a prior recommendation can be
// confirmed — you cannot manually place something the system never recommended (that would be an
// untracked bet the system has no basis to reason about).
function confirmPlacement(state, key, { executionPrice, actualStake, actualContracts, fees, note } = {}) {
  const p = state.entries[key] || Object.values(state.entries).find((e) => e.ticker === key);
  if (!p) throw new Error(`no recommendation found for "${key}" — cannot confirm a placement the system never recommended`);
  if (p.status === STATUS.MANUALLY_PLACED) throw new Error(`${p.key} is already MANUALLY_PLACED — refusing to double-record`);
  if (!(executionPrice > 0 && executionPrice < 1)) throw new Error("executionPrice must be a real fill price in (0,1) — absence is not a value");
  if (!(actualStake > 0)) throw new Error("actualStake must be the real dollars you put down (> 0)");
  transition(p, STATUS.MANUALLY_PLACED, note || "human-confirmed placement", { executionPrice, actualStake });
  p.executionPrice = +Number(executionPrice).toFixed(4);
  p.actualStake = +Number(actualStake).toFixed(2);
  p.actualContracts = actualContracts != null ? Number(actualContracts) : (p.executionPrice ? Math.floor(p.actualStake / p.executionPrice) : null);
  // Fee: actual when supplied, else estimated from the fee model, else unknown — basis recorded, never faked.
  p.fees = feeObject(fees, p.actualContracts, p.executionPrice);
  p.includedInRealPnl = true;
  p.placedAt = nowIso();
  return p;
}

// YOU tell the system you did NOT place it (or cancelled). Kept in the ledger for the audit trail;
// contributes $0 to the real P&L.
function declinePlacement(state, key, reason) {
  const p = state.entries[key] || Object.values(state.entries).find((e) => e.ticker === key);
  if (!p) throw new Error(`no recommendation found for "${key}"`);
  if (p.status === STATUS.MANUALLY_PLACED || p.status === STATUS.SETTLED) throw new Error(`${p.key} is already placed/settled — decline does not apply`);
  transition(p, STATUS.DECLINED, reason || "human declined to place");
  p.includedInRealPnl = false;
  return p;
}

// Settle a MANUALLY_PLACED position from the real outcome. result: 1 win / 0 loss / null void.
// Real P&L is computed from the ACTUAL stake and the ACTUAL execution price — not the recommended ones.
function settle(state, key, result) {
  const p = state.entries[key] || Object.values(state.entries).find((e) => e.ticker === key);
  if (!p) return null;
  if (p.status !== STATUS.MANUALLY_PLACED) return null;   // only real placements settle to real P&L
  p.wasManuallyPlaced = true;
  transition(p, STATUS.SETTLED, `settled: ${result === 1 ? "won" : result === 0 ? "lost" : "void"}`, { result });
  p.result = result;
  const c = p.executionPrice;
  if (result === 1 && c > 0) p.realPnlDollars = +((p.actualStake * (1 - c) / c)).toFixed(2);   // YES pays $1
  else if (result === 0) p.realPnlDollars = +(-p.actualStake).toFixed(2);
  else p.realPnlDollars = 0;   // void
  // payout (gross, YES pays $1/contract) + settlement timestamp. realPnl stays GROSS of fees; fees are a
  // separate line the summary subtracts from available cash (only when actual), per the bankroll formula.
  p.payout = result === 1 ? (p.actualContracts || 0) : result === 0 ? 0 : p.actualStake;
  p.settlementTimestamp = nowIso();
  return p;
}

// A DISCRETIONARY real placement — a bet you placed that the system NEVER recommended. Enters the real
// ledger directly as MANUALLY_PLACED, source DISCRETIONARY, and is ALWAYS paper-ineligible. No prior
// recommendation, so no recommendationId and never a paper position.
function recordDiscretionary(state, d = {}) {
  const executionPrice = Number(d.executionPrice);
  if (!(executionPrice > 0 && executionPrice < 1)) throw new Error("executionPrice must be a real fill price in (0,1)");
  const kind = d.kind === "combo" ? "combo" : "single";
  const actualStake = d.stake != null ? Number(d.stake) : (d.contracts != null ? r2(Number(d.contracts) * executionPrice) : null);
  if (!(actualStake > 0)) throw new Error("provide a stake (>0) or a contract count");
  const actualContracts = d.contracts != null ? Number(d.contracts) : Math.floor(actualStake / executionPrice);
  const at = d.timestamp || nowIso();
  const key = d.key || `discretionary|${d.ticker}|${at}`;
  if (state.entries[key]) throw new Error(`a discretionary entry with key "${key}" already exists`);
  const entry = stampCategory({
    key, positionId: key, recommendationId: null,
    ticker: d.ticker, market: d.ticker, side: d.side || "YES", source: "DISCRETIONARY",
    boutId: d.boutId || null, fight: d.fight || d.ticker,
    lane: kind === "combo" ? "combo" : "discretionary",
    classification: d.classification || (kind === "combo" ? "MANUAL COMBO" : "DISCRETIONARY"),
    kind,
    recommendedStakeDollars: null, recommendedFraction: null, maximumAcceptablePrice: null,
    askAtRecommendation: null, approxContracts: null, forecastHash: null,
    status: STATUS.MANUALLY_PLACED, actualStake: r2(actualStake), executionPrice: +executionPrice.toFixed(4),
    actualContracts, fees: feeObject(d.fees, actualContracts, executionPrice),
    includedInRealPnl: true, placedAt: at, note: d.note || null,
    history: [{ from: null, to: STATUS.MANUALLY_PLACED, reason: "discretionary placement (never system-recommended)", at }],
  });
  state.entries[key] = entry;
  return entry;
}

// ONE-TIME migration: stamp category/source/paperEligible/positionId/recommendationId/market/side onto
// legacy entries that predate them, and backfill fees (estimated) + payout/settlementTimestamp for already
// SETTLED entries. Idempotent. Never rewrites realPnlDollars (historical real P&L is preserved as-is).
function migrateEntries(state) {
  let changed = 0;
  for (const [key, e] of Object.entries(state.entries)) {
    const before = JSON.stringify(e);
    e.positionId = e.positionId || key;
    if (e.recommendationId === undefined) e.recommendationId = e.source === "DISCRETIONARY" ? null : key;
    e.market = e.market || e.ticker;
    e.side = e.side || "YES";
    e.kind = e.kind || (e.lane === "combo" ? "combo" : "single");
    stampCategory(e);
    if ((e.status === STATUS.MANUALLY_PLACED || e.status === STATUS.SETTLED) && (e.fees == null)) {
      e.fees = feeObject(undefined, e.actualContracts, e.executionPrice);   // estimated (never faked)
    }
    if (e.status === STATUS.SETTLED && e.payout === undefined) {
      e.payout = e.result === 1 ? (e.actualContracts || 0) : e.result === 0 ? 0 : e.actualStake;
      e.settlementTimestamp = e.settlementTimestamp || (e.history && e.history[e.history.length - 1] && e.history[e.history.length - 1].at) || null;
    }
    if (JSON.stringify(e) !== before) changed++;
  }
  return changed;
}

// The three statuses, grouped for the dashboard. PAPER positions are passed in from lib/positions.js.
function byStatus(state, paperPositions = []) {
  const entries = Object.values(state.entries);
  return {
    PAPER_ONLY: paperPositions.map((pp) => ({
      ticker: pp.ticker, fight: `${pp.fighter} vs ${pp.opponent || "?"}`, status: STATUS.PAPER_ONLY,
      actualStake: 0, includedInRealPnl: false, paperStakePct: pp.stakePct, paperStatus: pp.status,
      note: "research paper tracking — DO NOT PLACE, excluded from real bankroll P&L",
    })),
    RECOMMENDED_NOT_CONFIRMED: entries.filter((e) => e.status === STATUS.RECOMMENDED_NOT_CONFIRMED),
    MANUALLY_PLACED: entries.filter((e) => e.status === STATUS.MANUALLY_PLACED || e.status === STATUS.SETTLED),
    DECLINED: entries.filter((e) => e.status === STATUS.DECLINED),
  };
}

// The REAL $100 bankroll P&L — from MANUALLY_PLACED positions ONLY. A recommendation you never confirmed
// contributes exactly $0.
function realBankrollPnl(state) {
  const placed = Object.values(state.entries).filter(isRealMoney);
  const deployed = placed.reduce((s, p) => s + (p.actualStake || 0), 0);
  const booked = placed.filter((p) => p.status === STATUS.SETTLED).reduce((s, p) => s + (p.realPnlDollars || 0), 0);
  return {
    bankroll: state.bankroll || BANKROLL,
    positionsManuallyPlaced: placed.length,
    realDollarsDeployed: +deployed.toFixed(2),
    realPnlDollars: +booked.toFixed(2),
    note: "Real P&L counts ONLY positions you confirmed placing. Recommendations you did not confirm contribute $0.",
  };
}

// The CANONICAL Real Entertainment Bankroll summary — the ONE object both dashboards read for real money.
// available cash = starting + realized profits − realized losses − cost of open positions − fees paid
// (only ACTUAL/known fees are deducted; estimated fees are shown separately, never silently treated as
// exact). Recommended-but-unconfirmed positions are shown separately and NEVER count as real exposure.
function summary(state) {
  const s = state || load();
  const entries = Object.values(s.entries || {});
  const openReal = entries.filter((e) => e.status === STATUS.MANUALLY_PLACED);            // placed, not settled
  const settled = entries.filter((e) => e.status === STATUS.SETTLED && e.wasManuallyPlaced);
  const unconfirmed = entries.filter((e) => e.status === STATUS.RECOMMENDED_NOT_CONFIRMED);
  const placed = entries.filter(isRealMoney);
  const starting = s.bankroll || BANKROLL;

  const realizedPnl = r2(settled.reduce((a, e) => a + (e.realPnlDollars || 0), 0));
  const openExposure = r2(openReal.reduce((a, e) => a + (e.actualStake || 0), 0));         // real cash at risk
  const feeAmt = (e, basis) => (e.fees && e.fees.basis === basis ? Number(e.fees.amount) || 0 : 0);
  const feesActual = r2(placed.reduce((a, e) => a + feeAmt(e, "actual"), 0));
  const feesEstimated = r2(placed.reduce((a, e) => a + feeAmt(e, "estimated"), 0));
  const availableCash = r2(starting + realizedPnl - openExposure - feesActual);            // per the formula
  const accountValue = r2(availableCash + openExposure);                                   // open marked at cost
  const maxPendingPayout = r2(openReal.reduce((a, e) => a + (e.actualContracts || 0), 0));
  const unconfirmedExposure = r2(unconfirmed.reduce((a, e) => a + (e.recommendedStakeDollars || 0), 0));

  const realStatusLabel = (e) => e.status === STATUS.SETTLED ? "SETTLED"
    : e.status === STATUS.MANUALLY_PLACED ? "CONFIRMED PLACED"
    : e.status === STATUS.DECLINED ? "DECLINED" : "NOT PLACED";
  // Real Activity list — every real position, normalized for the dashboards (both read this, not the raw file).
  const positions = entries.map((e) => ({
    positionId: e.positionId || e.key, recommendationId: e.recommendationId ?? null,
    market: e.market || e.ticker, ticker: e.ticker, side: e.side || "YES",
    category: e.category || deriveCategory(e), source: e.source || "SYSTEM",
    fight: e.fight || e.ticker, status: e.status, realStatus: realStatusLabel(e),
    stake: e.actualStake || 0, recommendedStake: e.recommendedStakeDollars ?? null,
    contracts: e.actualContracts ?? null, entryPrice: e.executionPrice ?? null,
    fees: e.fees || null, payout: e.payout ?? null,
    realizedPnl: e.status === STATUS.SETTLED ? (e.realPnlDollars ?? null) : null,
    paperEligible: !!e.paperEligible, placedAt: e.placedAt ?? null, settlementTimestamp: e.settlementTimestamp ?? null,
  }));

  const byCategory = {};
  for (const e of [...openReal, ...settled]) {
    const c = e.category || deriveCategory(e);
    (byCategory[c] = byCategory[c] || { n: 0, realizedPnl: 0, openExposure: 0 });
    byCategory[c].n++;
    if (e.status === STATUS.SETTLED) byCategory[c].realizedPnl = r2(byCategory[c].realizedPnl + (e.realPnlDollars || 0));
    else byCategory[c].openExposure = r2(byCategory[c].openExposure + (e.actualStake || 0));
  }

  return {
    label: "Real Entertainment Bankroll",
    startingDollars: starting,
    realizedPnl, openExposure, availableCash, accountValue, maxPendingPayout,
    fees: { paidActual: feesActual, estimated: feesEstimated, note: "Only actual (confirmed) fees reduce available cash; estimated fees are shown but not deducted." },
    unconfirmed: {
      count: unconfirmed.length, recommendedExposure: unconfirmedExposure,
      note: "Recommended but NOT confirmed — excluded from real exposure and available cash.",
    },
    counts: { open: openReal.length, settled: settled.length, unconfirmed: unconfirmed.length },
    byCategory,
    positions,
  };
}

module.exports = {
  STATUS, FILE, BANKROLL, load, save,
  recordRecommendation, confirmPlacement, declinePlacement, settle, recordDiscretionary,
  byStatus, realBankrollPnl, isRealMoney, summary, migrateEntries,
  deriveCategory, stampCategory, feeObject, PAPER_ELIGIBLE_CATEGORIES,
};
