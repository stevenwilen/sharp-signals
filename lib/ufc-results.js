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
    // FAIL FAST. The old 4-attempt backoff (0.8+1.6+3.2+6.4 = ~12s) was the grade's killer: a
    // 34k-pick corpus has thousands of dead-end names (surnames, nicknames, misspellings) that
    // rate-limit, and burning 12s on each turned the grade into a multi-hour crawl. 2 attempts
    // (max ~1.5s) still recovers a transient 429 but caps the dead-end cost ~8x lower. A name that
    // truly won't resolve is dropped (fail-safe), which is correct — we don't guess outcomes.
    if (attempt < 2) { await sleep(500 * (attempt + 1)); return apiGet(params, attempt + 1); }
    throw new Error(`Wikipedia API non-JSON (status ${status}): ${body.slice(0, 60)}`);
  }
}

// Candidate Wikipedia titles for a fighter, best first. A bare name often resolves to a
// disambiguation or a different person (there is a "Robert Whittaker (ecologist)"), so we prefer
// fighter-qualified titles and let recordFor try each until one actually has an MMA record table.
//
// CACHED per name. opensearch is the one Wikipedia call that isn't page-cached, and a backfill
// looks the same fighter up dozens of times (many videos preview the same card). Without this the
// deep run re-searches every fighter for every pick — thousands of throttled calls. An empty
// result is cached too, so a page-less prelim fighter is searched once, not repeatedly.
async function resolveTitles(name) {
  const cp = path.join(CACHE_DIR, "search_" + name.replace(/[^a-z0-9]+/gi, "_").slice(0, 100) + ".json");
  try { return JSON.parse(fs.readFileSync(cp, "utf8")); } catch (_) {}
  const j = await apiGet({ action: "opensearch", search: name, limit: 5, namespace: 0 });
  const titles = (Array.isArray(j) && j[1]) || [];
  const isFighter = (t) => /\((fighter|mixed martial artist|.*martial.*)\)/i.test(t) ? 1 : 0;
  const sorted = titles.slice().sort((a, b) => isFighter(b) - isFighter(a));
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cp, JSON.stringify(sorted)); } catch (_) {}
  return sorted;
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

// MEMOISED, and safely so: a fighter's record is a property of the FIGHTER — it does not depend on
// who predicted the fight or when. (Contrast the RESOLVED fight, which is pick-time-dependent
// because of the hindsight guard above. Memoising that across timestamps is precisely the bug that
// let 1,145 post-fight "predictions" into the corpus — see lib/results.js.) Memoising here keeps the
// per-pick cost to a row-scan while the guard stays honest.
const recordMemo = new Map();
async function recordFor(name) {
  if (recordMemo.has(name)) return recordMemo.get(name);
  let out = null;
  const titles = await resolveTitles(name);
  for (const title of titles.slice(0, 4)) {
    const wt = await fetchWikitext(title);
    const rows = parseRecord(wt);
    if (rows.length) { out = { title, rows }; break; } // first candidate with a real MMA record table wins
  }
  recordMemo.set(name, out);
  return out;
}

// Within a parsed record, the row where `opponent` (score >= 2) is faced. Two modes:
//   nearMs  — nearest fight within 10 days of a KNOWN date (validation, Kalshi close_time).
//   afterMs — the fighter's next fight AFTER a prediction was made (backfill): must postdate the
//             pick (2-day grace) and fall within ~4 months (a plausible prediction horizon). This
//             both selects the right bout and enforces the hindsight guard for the historical path.
function findRow(rows, opponent, { nearMs = null, afterMs = null } = {}) {
  let best = null, bestKey = Infinity;
  for (const r of rows) {
    if (!r.opponent || names.nameScore(opponent, r.opponent) < 2) continue;
    const dm = r.date ? Date.parse(r.date) : null;
    let key;
    if (afterMs != null) {
      // STRICT: a prediction must PRECEDE its fight. Two leaks lived here and both graded
      // post-fight reactions as predictions:
      //   1. a 2-day "grace" for timestamp slop, which also admitted any fight up to 2 days AFTER
      //      it had already been decided;
      //   2. undated rows waved through with NO date check at all — that is how a fight 178 days
      //      BEFORE the pick got matched.
      // A "told you so" is maximally confident, always on the shocking underdog, and always right:
      // together these fabricated a +52% high-conviction-underdog "edge" that evaporated the moment
      // the rows were dated. The Kalshi path has always enforced this with no tolerance; so does
      // this one now. If we cannot prove the fight postdates the pick, it is NOT gradeable.
      if (dm == null) continue;
      if (dm < afterMs || dm > afterMs + 120 * 86400000) continue;
      key = dm - afterMs;
    } else if (nearMs != null) {
      if (dm == null) key = 6e11;
      else { const g = Math.abs(dm - nearMs); if (g > 10 * 86400000) continue; key = g; }
    } else key = 0;
    if (key < bestKey) { bestKey = key; best = r; }
  }
  return best;
}

// Core: find pick's fight vs opponent (per `match` mode) on the pick's record, else on the
// opponent's record (inverting the result there). -> { ok, result:1|0, date, source } / { ok:false }.
async function resolveOutcome(pick, opponent, match, opts = {}) {
  const rp = opts.pickRows ? { rows: opts.pickRows, title: "(supplied)" } : await recordFor(pick).catch(() => null);
  if (rp) {
    const row = findRow(rp.rows, opponent, match);
    if (row && row.result != null) return { ok: true, result: row.result, source: "wikipedia", via: rp.title, date: row.date };
  }
  if (opponent) {
    const ro = await recordFor(opponent).catch(() => null);
    if (ro) {
      const row = findRow(ro.rows, pick, match);
      if (row && row.result != null) return { ok: true, result: row.result === 1 ? 0 : 1, source: "wikipedia", via: ro.title, date: row.date };
    }
  }
  return { ok: false, reason: `no Wikipedia result for ${pick} vs ${opponent || "?"}` };
}

// Known-date use (validation): did `pick` win vs `opponent` around `dateIso`?
async function didWin(pick, opponent, dateIso, opts = {}) {
  return resolveOutcome(pick, opponent, { nearMs: dateIso ? Date.parse(dateIso) : null }, opts);
}
// Backfill use: `pick`'s NEXT fight vs `opponent` AFTER the prediction `afterIso`. Returns the
// result AND the fight date (which the odds lookup then uses to price the same fight on BFO).
async function outcome(pick, opponent, afterIso, opts = {}) {
  return resolveOutcome(pick, opponent, { afterMs: afterIso ? Date.parse(afterIso) : null }, opts);
}

module.exports = { apiGet, resolveTitles, fetchWikitext, parseRecord, recordFor, findRow, didWin, outcome, CACHE_DIR };
