// UFC fight RESULTS from Wikipedia (MediaWiki API).
//
// Why here: grading needs BOTH the closing line and who WON. BestFightOdds (lib/odds-history.js)
// gives the line but not the result, and UFCStats — the obvious results source — sits behind a
// JavaScript anti-bot wall that a plain fetch can't pass. Wikipedia's {{MMA record}} tables are
// standardized across fighter articles, reachable via the API, and reliable, so they are the
// result source for the historical (BFO) grading path. Recent fights still get their result from
// Kalshi; this only fills the pre-Kalshi gap, and stays tagged priceSource:"bfo" upstream.
//
// It fails SAFE: a fighter with no Wikipedia page, or a fight not in the record, returns null
// (the pick is simply dropped, never graded with a guessed outcome).
const https = require("https");
const fs = require("fs");
const path = require("path");
const names = require("./names");

const CACHE_DIR = path.join(__dirname, "..", "data", "wiki"); // gitignored local cache
// Wikipedia asks for a descriptive User-Agent identifying the tool.
const UA = "SharpSignals/1.0 (personal MMA research; github.com/stevenwilen/sharp-signals)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rawGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, Accept: "application/json" }, timeout: 25000 }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

// THROTTLED + RETRYING. Wikipedia rate-limits bursts and answers with a non-JSON error page; the
// first cut of this reader fired a burst and silently read every throttled call as "fighter not
// found". So: a minimum gap between calls, and a backoff-retry when the body isn't JSON (429/HTML).
let lastReq = 0;
const MIN_GAP_MS = 250;
async function apiGet(params, attempt = 0) {
  const gap = Date.now() - lastReq;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
  lastReq = Date.now();
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const { status, body } = await rawGet(`https://en.wikipedia.org/w/api.php?${qs}&format=json`);
  try { return JSON.parse(body); }
  catch (_) {
    if (attempt < 4) { await sleep(800 * Math.pow(2, attempt)); return apiGet(params, attempt + 1); }
    throw new Error(`Wikipedia API non-JSON (status ${status}): ${body.slice(0, 60)}`);
  }
}

// Candidate Wikipedia titles for a fighter, best first. A bare name often resolves to a
// disambiguation or a different person (there is a "Robert Whittaker (ecologist)"), so we prefer
// fighter-qualified titles and let recordFor try each until one actually has an MMA record table.
async function resolveTitles(name) {
  const j = await apiGet({ action: "opensearch", search: name, limit: 5, namespace: 0 });
  const titles = (Array.isArray(j) && j[1]) || [];
  const isFighter = (t) => /\((fighter|mixed martial artist|.*martial.*)\)/i.test(t) ? 1 : 0;
  return titles.slice().sort((a, b) => isFighter(b) - isFighter(a));
}

// Fetch a page's wikitext, cached to disk (records of past fights never change).
async function fetchWikitext(title) {
  const key = title.replace(/[^a-z0-9]+/gi, "_").slice(0, 120);
  const cp = path.join(CACHE_DIR, key + ".txt");
  try { return fs.readFileSync(cp, "utf8"); } catch (_) {}
  const j = await apiGet({ action: "parse", page: title, prop: "wikitext", formatversion: 2, redirects: 1 });
  const wt = (j.parse && j.parse.wikitext) || "";
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cp, wt); } catch (_) {}
  return wt;
}

// Parse the {{MMA record}} table -> [{ result:1|0|null, opponent, date }].
// A row starts with a {{yes2}}Win / {{no2}}Loss / {{draw2}}Draw marker, then the running record,
// then the opponent as a wikilink, method, event, and a {{dts|YYYY|Month|DD}} date.
function parseRecord(wt) {
  const out = [];
  const re = /\{\{\s*(yes2|no2|draw2|nc2)\s*\}\}\s*(Win|Loss|Draw|NC)([\s\S]*?)(?=\n\s*\|-|\n\s*\|\}|\{\{end\}\}|$)/gi;
  let m;
  while ((m = re.exec(wt))) {
    const tag = (m[1] + m[2]).toLowerCase();
    const result = /yes2|win/.test(tag) ? 1 : /no2|loss/.test(tag) ? 0 : null; // draw / no-contest -> null
    const body = m[3];
    const opp = /\[\[(?:[^\]|]+\|)?([^\]|]+)\]\]/.exec(body); // display name (piped or plain link)
    // {{dts|...}} carries year/month/day in either order relative to a format= param, e.g.
    // {{dts|2025|July|26|format=dmy}} or {{dts|format=dmy|2024|June|22}}. Strip named params, then
    // the three positional cells are year, month, day.
    let date = null;
    const dtsm = /\{\{\s*dts\s*\|([^}]*)\}\}/i.exec(body);
    if (dtsm) {
      const p = dtsm[1].split("|").map((s) => s.trim()).filter((s) => s && !s.includes("="));
      if (p.length >= 3) {
        const [y, mo, d] = p;
        const t = /^\d+$/.test(mo) ? Date.parse(`${y}-${mo}-${d}`) : Date.parse(`${mo} ${d} ${y}`);
        if (isFinite(t)) date = new Date(t).toISOString().slice(0, 10);
      }
    }
    out.push({ result, opponent: opp ? opp[1].trim() : null, date });
  }
  return out;
}

async function recordFor(name) {
  const titles = await resolveTitles(name);
  for (const title of titles.slice(0, 4)) {
    const wt = await fetchWikitext(title);
    const rows = parseRecord(wt);
    if (rows.length) return { title, rows }; // first candidate with a real MMA record table wins
  }
  return null;
}

// Within a parsed record, the row where `opponent` (score >= 2) is faced within 10 days of wantMs.
function findRow(rows, opponent, wantMs) {
  let best = null, bestGap = Infinity;
  for (const r of rows) {
    if (!r.opponent || names.nameScore(opponent, r.opponent) < 2) continue;
    const gap = wantMs && r.date ? Math.abs(Date.parse(r.date) - wantMs) : 0;
    if (wantMs && r.date && gap > 10 * 86400000) continue;
    if (gap < bestGap) { bestGap = gap; best = r; }
  }
  return best;
}

// Did `pick` win his fight vs `opponent` around `dateIso`? -> { ok, result:1|0, source } or { ok:false }.
// Tries the pick's own record; falls back to the opponent's record (invert the result there).
async function didWin(pick, opponent, dateIso, opts = {}) {
  const wantMs = dateIso ? Date.parse(dateIso) : null;
  const rp = opts.pickRows ? { rows: opts.pickRows, title: "(supplied)" } : await recordFor(pick).catch(() => null);
  if (rp) {
    const row = findRow(rp.rows, opponent, wantMs);
    if (row && row.result != null) return { ok: true, result: row.result, source: "wikipedia", via: rp.title, date: row.date };
  }
  if (opponent) {
    const ro = await recordFor(opponent).catch(() => null);
    if (ro) {
      const row = findRow(ro.rows, pick, wantMs);
      if (row && row.result != null) return { ok: true, result: row.result === 1 ? 0 : 1, source: "wikipedia", via: ro.title, date: row.date };
    }
  }
  return { ok: false, reason: `no Wikipedia result for ${pick} vs ${opponent || "?"} near ${dateIso || "?"}` };
}

module.exports = { apiGet, resolveTitles, fetchWikitext, parseRecord, recordFor, findRow, didWin, CACHE_DIR };
