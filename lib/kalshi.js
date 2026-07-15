// Kalshi API adapter (trade-api/v2).
// Public market reads need no auth. Authenticated calls (portfolio, orders)
// use RSA-PSS request signing — wired here, activated once an API key exists.
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");

// NOTE: the live/active host is api.elections.kalshi.com (docs list api.kalshi.com,
// but that does not resolve; the legacy trading-api host redirects here).
const HOST = process.env.KALSHI_HOST || "api.elections.kalshi.com";
const BASE = "/trade-api/v2";

// Optional auth: set KALSHI_KEY_ID + KALSHI_PRIVATE_KEY_PATH in env or config.
function loadAuth() {
  const id = process.env.KALSHI_KEY_ID;
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!id || !keyPath) return null;
  try {
    return { id, privateKey: fs.readFileSync(keyPath, "utf8") };
  } catch (_) {
    return null;
  }
}

function sign(privateKey, timestamp, method, path) {
  const msg = `${timestamp}${method}${path}`;
  const sig = crypto.sign("sha256", Buffer.from(msg), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Low-level request WITH retry on 429/5xx. This is not optional politeness — without it,
// resolveAll fires ~1,700 candlestick calls in a tight loop, Kalshi 429s most of them, and
// lineAtCall swallows the error as "no line". That silently dropped ~1,000 gradeable picks
// (70% of the in-window sample), grading every source on a random quarter of their record and
// crushing every real edge into the noise. A 429 means "wait", so we wait.
async function request(method, path, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await requestOnce(method, path, opts);
    } catch (e) {
      lastErr = e;
      const m = String(e.message);
      const retriable = /HTTP 429/.test(m) || /HTTP 5\d\d/.test(m) || /timeout/i.test(m)
        || /ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up/i.test(m);
      if (!retriable) throw e;
      // exponential backoff + jitter: ~0.5s, 1s, 2s, 4s, 8s, capped
      await sleep(Math.min(8000, 500 * Math.pow(2, attempt)) + Math.random() * 300);
    }
  }
  throw lastErr;
}

// One HTTP attempt. Returns parsed JSON. Adds auth headers if creds present.
function requestOnce(method, path, { query, body, auth } = {}) {
  let fullPath = BASE + path;
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (qs) fullPath += "?" + qs;
  }
  const headers = { Accept: "application/json" };
  const creds = auth ? loadAuth() : null;
  if (creds) {
    const ts = Date.now().toString();
    // signature covers the path WITHOUT query string
    headers["KALSHI-ACCESS-KEY"] = creds.id;
    headers["KALSHI-ACCESS-TIMESTAMP"] = ts;
    headers["KALSHI-ACCESS-SIGNATURE"] = sign(creds.privateKey, ts, method, BASE + path);
  }
  let payload;
  if (body) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = https.request({ host: HOST, path: fullPath, method, headers, timeout: 30000 },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (path, query, auth = false) => request("GET", path, { query, auth });

// Auto-paginate a list endpoint that returns { <key>: [...], cursor }.
async function getAll(path, key, query = {}) {
  const out = [];
  let cursor;
  do {
    const page = await get(path, { ...query, cursor, limit: 200 });
    if (page && Array.isArray(page[key])) out.push(...page[key]);
    cursor = page && page.cursor;
  } while (cursor && out.length < 2000);
  return out;
}

// ---- convenience wrappers ----
const status = () => get("/exchange/status");
const events = (q) => get("/events", q);                       // {events, cursor}
const eventsAll = (q) => getAll("/events", "events", q);
const markets = (q) => get("/markets", q);                     // {markets, cursor}
const marketsAll = (q) => getAll("/markets", "markets", q);
const market = (ticker) => get(`/markets/${ticker}`);
const eventDetail = (ticker) => get(`/events/${ticker}`, { with_nested_markets: true });

// Settlement of a single market: { status, result } where result is "yes" | "no" | "" (void).
// The paper-position ledger uses this to resolve a finished fight: for a fighter's YES market,
// result "yes" means that fighter won. Returns nulls if the market can't be read (caller then
// leaves the position open and retries next run — never guesses an outcome).
async function settlement(ticker) {
  const r = await market(ticker);
  const m = (r && (r.market || r)) || {};
  return { status: m.status || null, result: m.result != null ? m.result : null };
}
// Candlesticks are the hot path: one call per pick during a backfill. Gate them so we approach
// Kalshi's limit instead of blowing through it — retries recover from a 429, but not tripping
// it in the first place is faster and kinder. Serial-ish with a small minimum gap.
let lastCandle = 0;
async function candlesticks(seriesTicker, ticker, q) {
  const gap = Date.now() - lastCandle;
  if (gap < 120) await sleep(120 - gap);
  lastCandle = Date.now();
  return get(`/series/${seriesTicker}/markets/${ticker}/candlesticks`, q);
}
const orderbook = (ticker) => get(`/markets/${ticker}/orderbook`);

// Best (highest-priced) resting bid from a [ [priceStr,sizeStr], ... ] book.
function bestBid(book) {
  if (!Array.isArray(book) || !book.length) return null;
  let hi = -1;
  for (const lvl of book) hi = Math.max(hi, parseFloat(lvl[0]));
  return hi < 0 ? null : hi;
}

// Implied YES probability for a market, from its live order book.
// Returns { yesBid, yesAsk, mid } in 0..1, or nulls if the book is empty.
async function impliedYes(ticker) {
  const o = await orderbook(ticker);
  const fp = (o && (o.orderbook_fp || o.orderbook)) || {};
  const yesBid = bestBid(fp.yes_dollars || fp.yes);
  const noBid = bestBid(fp.no_dollars || fp.no);
  const yesAsk = noBid == null ? null : +(1 - noBid).toFixed(4);
  let mid = null;
  if (yesBid != null && yesAsk != null) mid = +((yesBid + yesAsk) / 2).toFixed(4);
  else mid = yesBid != null ? yesBid : yesAsk;
  return { yesBid, yesAsk, mid };
}

module.exports = {
  request, get, getAll,
  status, events, eventsAll, markets, marketsAll, market, eventDetail, candlesticks,
  settlement, orderbook, impliedYes, bestBid, loadAuth,
};
