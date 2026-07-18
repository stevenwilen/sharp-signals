// BOUNDED GEMINI USAGE LEDGER — every model call is recorded with tokens and an ESTIMATED cost, so
// spend is observable per day / per card instead of discovered on an invoice. Estimates are labeled
// estimates: prices change and cached-token discounts vary; the token counts are the ground truth.
//
// The ledger is capped (newest MAX_ROWS kept) — observability, not an archive. Atomic writes via the
// same temp+rename pattern as every operational store. A ledger failure NEVER fails the model call:
// losing one usage row is noise; killing an extraction over bookkeeping would be the tail wagging.
require("./env");
const path = require("path");
const { paths, readJson, writeJson } = require("./store");

const FILE = () => path.join(path.dirname(paths.predictions), "gemini-usage.json");
const MAX_ROWS = 2000;

// USD per 1M tokens — ESTIMATES for the cost column only (as of 2026-07; adjust when pricing moves).
const PRICE_PER_M = {
  "gemini-flash-lite-latest": { in: 0.10, out: 0.40 },
  "gemini-flash-latest": { in: 0.30, out: 2.50 },
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  default: { in: 0.30, out: 2.50 },
};
const estCost = (model, inTok, outTok) => {
  const p = PRICE_PER_M[model] || PRICE_PER_M.default;
  return +(((inTok || 0) * p.in + (outTok || 0) * p.out) / 1e6).toFixed(6);
};

// Record one call. row: { model, purpose, ok, inputTokens, outputTokens, cachedTokens?, ref?, error? }
function record(row) {
  try {
    const led = readJson(FILE(), { schemaVersion: 1, rows: [] });
    led.rows.push({
      at: new Date().toISOString(),
      model: row.model || null, purpose: row.purpose || "extract", ok: row.ok !== false,
      inputTokens: row.inputTokens ?? null, outputTokens: row.outputTokens ?? null,
      cachedTokens: row.cachedTokens ?? null,
      estCostUsd: estCost(row.model, row.inputTokens, row.outputTokens),
      ref: row.ref || null, error: row.error || null,
    });
    if (led.rows.length > MAX_ROWS) led.rows = led.rows.slice(-MAX_ROWS);
    writeJson(FILE(), led);
  } catch (_) { /* never fail the model call over bookkeeping */ }
}

// Summaries for the system-health view. All costs are estimates.
function summary(now = new Date()) {
  const led = readJson(FILE(), { rows: [] });
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const sum = (rows) => rows.reduce((a, r) => ({
    calls: a.calls + 1, inTok: a.inTok + (r.inputTokens || 0), outTok: a.outTok + (r.outputTokens || 0),
    cost: +(a.cost + (r.estCostUsd || 0)).toFixed(4), failed: a.failed + (r.ok ? 0 : 1),
  }), { calls: 0, inTok: 0, outTok: 0, cost: 0, failed: 0 });
  return {
    today: sum(led.rows.filter((r) => (r.at || "").startsWith(day))),
    month: sum(led.rows.filter((r) => (r.at || "").startsWith(month))),
    total: sum(led.rows),
    note: "costs are ESTIMATES from a static price table; token counts are ground truth",
    rowsKept: led.rows.length, cap: MAX_ROWS,
  };
}

module.exports = { record, summary, FILE, estCost, PRICE_PER_M };
