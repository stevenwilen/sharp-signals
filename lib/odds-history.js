// Historical UFC fight odds from BestFightOdds (BFO) — the SEPARATE, non-Kalshi source used to
// grade picks for fights that predate Kalshi's markets.
//
// SEPARATION IS THE WHOLE POINT: everything here is tagged priceSource:"bfo" by the resolver that
// calls it, so a bad BFO scrape can be filtered or deleted without ever touching the trusted Kalshi
// corpus. Two internal guards stop garbage at the source: (1) a fighter is only accepted if the
// name matches (never guess which fighter), and (2) the de-vig OVERROUND must land in a sane range
// (1.01–1.12) — a parse that grabbed the wrong cells produces a wild overround and is rejected.
//
// BFO is a scrape (no API): search a name -> fighter page -> parse the fight-history table, which
// lists both fighters' Open and Closing-range moneylines per fight. We de-vig the two CLOSING
// lines into a fair probability. Closing (not opening) on purpose: the efficient closing line is
// the honest bar for "did this pundit beat the market", the same standard the Kalshi close uses.
const https = require("https");
const fs = require("fs");
const path = require("path");
const names = require("./names");

const HOST = "www.bestfightodds.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const CACHE_DIR = path.join(__dirname, "..", "data", "bfo"); // local page cache (gitignored)

function fetchText(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, Accept: "text/html" }, timeout: 25000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const loc = res.headers.location.startsWith("http") ? res.headers.location : `https://${HOST}${res.headers.location}`;
        return resolve(fetchText(loc, redirectsLeft - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

// Fetch with a disk cache. BFO pages for settled fights never change, and a backfill hits the same
// fighters many times, so caching turns thousands of requests into a few hundred (and is polite).
async function fetchCached(url) {
  const key = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 120);
  const cp = path.join(CACHE_DIR, key + ".html");
  try { return fs.readFileSync(cp, "utf8"); } catch (_) {}
  const html = await fetchText(url);
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cp, html); } catch (_) {}
  return html;
}

// American moneyline -> implied probability (vig included). +200 -> 0.333, -240 -> 0.706.
function mlToProb(ml) {
  const n = Number(String(ml).replace(/[^0-9+-]/g, ""));
  if (!isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

// De-vig two vig-included probabilities -> fair probs + overround (their sum).
function deVigProbs(pA, pB) {
  if (pA == null || pB == null) return null;
  const overround = pA + pB;
  if (!(overround > 0)) return null;
  return { probA: pA / overround, probB: pB / overround, overround };
}

const stripOrdinal = (s) => s.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
function parseDate(s) {
  const m = String(s).match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\s+\d{4}/i);
  if (!m) return null;
  const t = Date.parse(stripOrdinal(m[0]));
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

// Parse a fighter page into fights. Each fight = { date, event, sides:[{name, closeProb, mls}] }.
// Rows come in the order: event-header (name + date), then the two fighters' rows.
function parseHistory(html) {
  const rows = html.split(/<tr/i).slice(1);
  const fights = [];
  let curEvent = null, curDate = null, pending = [];
  const flush = () => {
    if (pending.length >= 2) fights.push({ date: curDate, event: curEvent, sides: pending.slice(0, 2) });
    pending = [];
  };
  for (const row of rows) {
    if (/event-header/i.test(row)) {
      flush();
      const ev = row.match(/\/events\/[a-z0-9-]+"[^>]*>([^<]+)</i);
      curEvent = ev ? ev[1].trim() : null;
      curDate = parseDate(row);
      continue;
    }
    if (/class="oppcell"/i.test(row)) {
      const nm = row.match(/\/fighters\/[a-z0-9-]+"[^>]*>([^<]+)</i);
      const mls = [...row.matchAll(/class="moneyline"[^>]*>\s*<span[^>]*>\s*([+-]?\d+)\s*<\/span>/gi)].map((m) => m[1]);
      if (nm && mls.length) {
        // mls[0]=open, mls[1]=closing-low, mls[2]=closing-high. Use the closing-range midpoint in
        // probability space; fall back to the open if the closing cells are missing.
        const cp = [mls[1], mls[2]].map(mlToProb).filter((x) => x != null);
        const closeProb = cp.length ? cp.reduce((a, x) => a + x, 0) / cp.length : mlToProb(mls[0]);
        pending.push({ name: nm[1].trim(), closeProb, mls });
        if (pending.length === 2) flush();
      }
    }
  }
  flush();
  return fights;
}

// Search a name -> RANKED list of candidate fighter pages (all tokens must match, score >= 2).
// A list, not a single hit, because two humans can share a name (two "Christian Duncan"s); the
// caller tries each until one has a fight matching the opponent + date.
async function resolveCandidates(name) {
  const page = await fetchCached(`https://${HOST}/search?query=${encodeURIComponent(name)}`);
  const seen = new Set(), out = [];
  for (const m of page.matchAll(/<a href="(\/fighters\/[a-z0-9-]+)"[^>]*>([^<]+)<\/a>/gi)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const score = names.nameScore(name, m[2].trim());
    if (score >= 2) out.push({ path: m[1], text: m[2].trim(), score });
  }
  return out.sort((a, b) => b.score - a.score);
}
// Back-compat single-best resolver (used by older callers/tests).
async function resolveFighter(name, { html } = {}) {
  if (html) { // legacy: score links in a supplied page
    let best = null, bs = 0;
    for (const m of html.matchAll(/<a href="(\/fighters\/[a-z0-9-]+)"[^>]*>([^<]+)<\/a>/gi)) {
      const s = names.nameScore(name, m[2].trim());
      if (s > bs) { bs = s; best = { path: m[1], text: m[2].trim() }; }
    }
    return best && bs >= 2 ? { path: best.path, name: best.text, url: `https://${HOST}${best.path}` } : null;
  }
  const c = (await resolveCandidates(name))[0];
  return c ? { path: c.path, name: c.text, url: `https://${HOST}${c.path}` } : null;
}

// On one parsed history, find the fight where `meName` (score >= 2) faces someone, within 10 days
// of wantMs, PREFERRING a fight whose opponent matches `oppName`. Returns { me, opp, ft } or null.
function pickFight(fights, meName, oppName, wantMs) {
  let best = null, bestKey = Infinity;
  for (const ft of fights) {
    const me = ft.sides.find((s) => names.nameScore(meName, s.name) >= 2);
    if (!me) continue;
    const opp = ft.sides.find((s) => s !== me);
    if (!opp) continue;
    const gap = wantMs && ft.date ? Math.abs(Date.parse(ft.date) - wantMs) : 0;
    if (wantMs && ft.date && gap > 10 * 86400000) continue; // must be the right bout, not an old one
    const oppMiss = oppName && names.nameScore(oppName, opp.name) >= 1 ? 0 : 1; // prefer opponent match
    const key = oppMiss * 1e12 + gap;
    if (key < bestKey) { bestKey = key; best = { me, opp, ft }; }
  }
  return best;
}

// Resolve `who` to candidate pages and return the fight where `who` faces `vs` near wantMs.
async function lookup(who, vs, wantMs, htmlOverride) {
  const cands = htmlOverride ? [{ __html: htmlOverride }] : await resolveCandidates(who);
  for (const c of cands) {
    const html = c.__html || await fetchCached(`https://${HOST}${c.path}`);
    const hit = pickFight(parseHistory(html), who, vs, wantMs);
    if (hit) return hit;
  }
  return null;
}

// High-level: the de-vigged CLOSING probability of `pick` in his fight vs `opponent` around
// `fightDateIso`. Tries the pick's own page(s); if that fails, falls back to the OPPONENT's page
// (the fight is listed there too) and reads the pick's side. Returns { ok, prob, ... } / { ok:false }.
async function closingLine(pick, opponent, fightDateIso, opts = {}) {
  const wantMs = fightDateIso ? Date.parse(fightDateIso) : null;
  let found = await lookup(pick, opponent, wantMs, opts.pickHtml);
  if (!found && opponent) {
    const viaOpp = await lookup(opponent, pick, wantMs); // opponent's page lists the same fight
    if (viaOpp) found = { me: viaOpp.opp, opp: viaOpp.me, ft: viaOpp.ft }; // swap: pick is the opp side
  }
  if (!found) return { ok: false, reason: `no BFO fight for ${pick} vs ${opponent || "?"} near ${fightDateIso || "?"}` };

  const dv = deVigProbs(found.me.closeProb, found.opp.closeProb);
  if (!dv) return { ok: false, reason: "could not de-vig (missing closing lines)" };
  if (!(dv.overround >= 1.01 && dv.overround <= 1.12))
    return { ok: false, reason: `overround ${dv.overround.toFixed(3)} out of sane range — bad scrape` };

  return {
    ok: true, priceSource: "bfo",
    prob: +dv.probA.toFixed(4), overround: +dv.overround.toFixed(4),
    fighter: found.me.name, opponent: found.opp.name, date: found.ft.date, event: found.ft.event,
    rawProb: +found.me.closeProb.toFixed(4),
  };
}

module.exports = {
  fetchText, fetchCached, mlToProb, deVigProbs, parseHistory,
  resolveCandidates, resolveFighter, pickFight, lookup, closingLine, HOST, CACHE_DIR,
};
