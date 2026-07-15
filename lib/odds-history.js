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
const names = require("./names");

const HOST = "www.bestfightodds.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

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

// Resolve a fighter name to a BFO fighter page. Requires all name tokens to match (score >= 2) so
// we never grade against the wrong human; returns null rather than guess.
async function resolveFighter(name, { html } = {}) {
  const page = html || await fetchText(`https://${HOST}/search?query=${encodeURIComponent(name)}`);
  const cands = [...page.matchAll(/<a href="(\/fighters\/[a-z0-9-]+)"[^>]*>([^<]+)<\/a>/gi)]
    .map((m) => ({ path: m[1], text: m[2].trim() }));
  let best = null, bestScore = 0;
  for (const c of cands) {
    const s = names.nameScore(name, c.text);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (!best || bestScore < 2) return null;
  return { path: best.path, name: best.text, url: `https://${HOST}${best.path}` };
}

// High-level: the de-vigged CLOSING probability of `pick` in his fight vs `opponent` around
// `fightDateIso`. Returns { ok:true, prob, overround, priceSource, ... } or { ok:false, reason }.
// `opts.fighterHtml` / `opts.searchHtml` let tests/caches supply pages instead of fetching.
async function closingLine(pick, opponent, fightDateIso, opts = {}) {
  const f = await resolveFighter(pick, { html: opts.searchHtml });
  if (!f) return { ok: false, reason: `no BFO fighter page for "${pick}"` };
  const html = opts.fighterHtml || await fetchText(f.url);
  const fights = parseHistory(html);
  const want = fightDateIso ? Date.parse(fightDateIso) : null;

  // Choose the fight by DATE closeness (a fighter can appear in many bouts); opponent is reported
  // but not required to match, so a name-spelling difference can't drop a valid fight.
  let match = null, bestGap = Infinity;
  for (const ft of fights) {
    const me = ft.sides.find((s) => names.nameScore(pick, s.name) >= 2);
    if (!me) continue;
    const opp = ft.sides.find((s) => s !== me);
    if (!opp) continue;
    const gap = want && ft.date ? Math.abs(Date.parse(ft.date) - want) : 0;
    if (gap < bestGap) { bestGap = gap; match = { ft, me, opp }; }
  }
  if (!match) return { ok: false, reason: `no BFO fight found for ${pick}` };
  if (want && match.ft.date && Math.abs(Date.parse(match.ft.date) - want) > 10 * 86400000)
    return { ok: false, reason: `closest BFO fight is ${match.ft.date}, too far from ${fightDateIso}` };

  const dv = deVigProbs(match.me.closeProb, match.opp.closeProb);
  if (!dv) return { ok: false, reason: "could not de-vig (missing closing lines)" };
  if (!(dv.overround >= 1.01 && dv.overround <= 1.12))
    return { ok: false, reason: `overround ${dv.overround.toFixed(3)} out of sane range — bad scrape` };

  return {
    ok: true, priceSource: "bfo",
    prob: +dv.probA.toFixed(4), overround: +dv.overround.toFixed(4),
    fighter: match.me.name, opponent: match.opp.name, date: match.ft.date, event: match.ft.event,
    rawProb: +match.me.closeProb.toFixed(4),
  };
}

module.exports = { fetchText, mlToProb, deVigProbs, parseHistory, resolveFighter, closingLine, HOST };
