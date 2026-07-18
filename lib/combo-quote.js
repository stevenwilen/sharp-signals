// COMBO QUOTE PROVIDER — READ-ONLY. This is the boundary the whole safety guarantee rests on.
//
// Kalshi prices a combo (a multivariate event collection) by MATERIALIZING the specific leg market via
// a collection *lookup* (POST) or by an RFQ *creation* (POST) — both mutate server state and are
// exactly the write requests lib/kalshi.js refuses and lib/arming.assertNoTradingPath forbids. This
// build does NOT add a write path (that would change what the system IS). So this provider is
// STRICTLY read-only: it can only quote a combo that ALREADY exists as a GET-readable market with an
// order book. When it does not, it returns { available:false } and the engine emits COMBO_UNAVAILABLE
// — never a fabricated price, never a claim that a fill is possible.
//
// Providers are injectable so the full COMBO_BUY path is testable with a synthetic quote without ever
// touching the network — but the DEFAULT provider will never POST.
require("./env");
const k = require("./kalshi");

// Attempt to read a live combo quote for a set of legs, read-only. `legs` carry their single tickers.
// opts.comboTicker lets a caller name an already-listed combo market to GET directly.
async function readOnlyKalshiQuote(legs, opts = {}) {
  const nowTs = new Date().toISOString();
  // If a caller supplied a concrete, already-listed combo market ticker, we may GET its order book.
  const comboTicker = opts.comboTicker || null;
  if (!comboTicker) {
    return {
      available: false,
      reason: "no live combo quote: Kalshi combo/RFQ pricing requires a collection lookup or RFQ request " +
        "(a write call) that this read-only build does not make. A combo is quotable here only if it is " +
        "already listed as a readable market. No such market was supplied.",
      requiresWritePath: true, ts: nowTs,
    };
  }
  try {
    const m = await k.market(comboTicker).catch(() => null);
    const market = m && (m.market || m);
    if (!market || market.status !== "active") return { available: false, reason: `combo market ${comboTicker} is not open`, marketOpen: false, ts: nowTs };
    const p = await k.impliedYes(comboTicker);
    if (p.yesAsk == null) return { available: false, reason: `combo market ${comboTicker} has no readable YES ask`, marketOpen: true, ts: nowTs };
    return { available: true, yesAsk: p.yesAsk, ticker: comboTicker, marketOpen: true, ts: nowTs, ageSec: 0 };
  } catch (e) {
    return { available: false, reason: `combo quote read failed: ${e.message}`, ts: nowTs };
  }
}

// Get a quote through the chosen provider, stamping age from its ts.
async function getComboQuote(legs, opts = {}) {
  const provider = opts.provider || readOnlyKalshiQuote;
  const q = await provider(legs, opts) || { available: false, reason: "provider returned nothing" };
  if (q.available && q.ts && q.ageSec == null) q.ageSec = Math.max(0, Math.round((Date.now() - Date.parse(q.ts)) / 1000));
  return q;
}

module.exports = { getComboQuote, readOnlyKalshiQuote };
