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
    return existing;
  }
  const entry = {
    key, ...recFields(rec),
    status: STATUS.RECOMMENDED_NOT_CONFIRMED,
    actualStake: 0, executionPrice: null, actualContracts: null,   // nothing placed
    includedInRealPnl: false,
    firstRecommendedAt: nowIso(), lastRecommendedAt: nowIso(), recommendationCount: 1,
    history: [{ from: null, to: STATUS.RECOMMENDED_NOT_CONFIRMED, reason: "Telegram sent a buy instruction", at: nowIso() }],
  };
  state.entries[key] = entry;
  return entry;
}
function recFields(rec) {
  return {
    ticker: rec.ticker, boutId: rec.boutId, fight: rec.fight, lane: rec.lane || "core",
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
function confirmPlacement(state, key, { executionPrice, actualStake, actualContracts, note } = {}) {
  const p = state.entries[key] || Object.values(state.entries).find((e) => e.ticker === key);
  if (!p) throw new Error(`no recommendation found for "${key}" — cannot confirm a placement the system never recommended`);
  if (p.status === STATUS.MANUALLY_PLACED) throw new Error(`${p.key} is already MANUALLY_PLACED — refusing to double-record`);
  if (!(executionPrice > 0 && executionPrice < 1)) throw new Error("executionPrice must be a real fill price in (0,1) — absence is not a value");
  if (!(actualStake > 0)) throw new Error("actualStake must be the real dollars you put down (> 0)");
  transition(p, STATUS.MANUALLY_PLACED, note || "human-confirmed placement", { executionPrice, actualStake });
  p.executionPrice = +Number(executionPrice).toFixed(4);
  p.actualStake = +Number(actualStake).toFixed(2);
  p.actualContracts = actualContracts != null ? Number(actualContracts) : (p.executionPrice ? Math.floor(p.actualStake / p.executionPrice) : null);
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
  return p;
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

module.exports = {
  STATUS, FILE, BANKROLL, load, save,
  recordRecommendation, confirmPlacement, declinePlacement, settle,
  byStatus, realBankrollPnl, isRealMoney,
};
