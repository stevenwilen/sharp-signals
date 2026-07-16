// TARGET CARD — canonical identity + auditable video/range selection.
//
// WHY THIS EXISTS: the first full-card run extracted 1,989 claims of which 70 (3.5%) were about the
// target card. The extractor was fine; the SELECTION was garbage. Videos qualified by mentioning
// ">= 2 card surnames anywhere", so a 359k podcast about the PREVIOUS card qualified because it said
// "Duncan" once and "Harris" once, 200k characters apart. 96.5% of the spend described other fights.
//
// The fix is not a better prompt. It is: know exactly which bouts we mean, refuse to match a common
// surname without a first name, require the two scheduled opponents to appear NEAR EACH OTHER, and
// select transcript RANGES rather than whole videos.
require("./env");
const fs = require("fs");
const path = require("path");
const { paths, readJson } = require("./store");

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);
const surnameOf = (n) => { const w = words(n); return w.length > 1 ? w[w.length - 1] : w[0] || ""; };
const firstOf = (n) => words(n)[0] || "";

// ---- AMBIGUITY, measured from our own corpus rather than guessed -------------------------------
// "Do not match on a surname alone when the surname is common." Which surnames are common is a
// question about the data, not a hardcoded list — so count how many DISTINCT fighters in the corpus
// share each surname. Green/Harris/Silva/Anderson fall out of this automatically, and so do the ones
// nobody would have thought to list.
function surnameIndex() {
  const idx = {};
  const add = (n) => {
    if (!n) return;
    const s = surnameOf(n);
    if (!s || s.length < 3) return;
    (idx[s] = idx[s] || new Set()).add(norm(n));
  };
  for (const p of readJson(paths.predictions, [])) { add(p.pick); add(p.opponent); }
  try {
    for (const f of fs.readdirSync(path.join("data", "wiki"))) {
      if (!f.endsWith(".txt")) continue;
      add(f.replace(/_/g, " ").replace(/\.txt$/, ""));
    }
  } catch (_) {}
  return idx;
}

// Build the canonical card. Aliases come from the name itself plus any spelling the corpus actually
// uses for that fighter (Kalshi says "Christian Duncan"; BFO says "Christian Leroy Duncan").
function buildCard(eventId, eventDate, pairs) {
  const idx = surnameIndex();
  const corpusNames = new Set();
  for (const p of readJson(paths.predictions, [])) { if (p.pick) corpusNames.add(p.pick); if (p.opponent) corpusNames.add(p.opponent); }

  const fighter = (name) => {
    const sn = surnameOf(name), fn = firstOf(name);
    const sharers = idx[sn] ? [...idx[sn]] : [];
    // a surname is AMBIGUOUS if more than one distinct fighter in the corpus carries it
    const ambiguous = sharers.filter((x) => x !== norm(name)).length > 0;
    // aliases: corpus spellings whose surname matches AND whose first name matches or extends
    const aliases = [...corpusNames].filter((c) => {
      const cn = norm(c);
      if (cn === norm(name)) return false;
      return surnameOf(c) === sn && (firstOf(c) === fn || cn.includes(fn));
    });
    return { name, norm: norm(name), first: fn, surname: sn, ambiguous,
      ambiguousWith: sharers.filter((x) => x !== norm(name)).slice(0, 4), aliases: aliases.slice(0, 6) };
  };

  const bouts = pairs.map((p, i) => ({
    boutId: `${eventId}-B${String(i + 1).padStart(2, "0")}`,
    a: fighter(p.a), b: fighter(p.b), date: p.date || eventDate,
  }));
  return { eventId, eventDate, bouts };
}

// ---- MENTION FINDING --------------------------------------------------------------------------
// A mention is FULL-NAME ("jared cannonier") or, only when the surname is unambiguous, surname-alone.
// For an ambiguous surname we require the first name nearby — "Duncan" alone is not evidence that
// Christian Duncan is being discussed.
const NEAR_FIRST = 60; // chars within which a first name confirms an ambiguous surname

function mentions(hay, f) {
  const out = [];
  const push = (i, kind) => out.push({ at: i, kind });
  // full name
  let i = 0;
  while ((i = hay.indexOf(f.norm, i)) !== -1) { push(i, "full"); i += f.norm.length; }
  for (const al of f.aliases) {
    const a = norm(al);
    let j = 0;
    while ((j = hay.indexOf(a, j)) !== -1) { push(j, "alias"); j += a.length; }
  }
  // surname
  const re = new RegExp(`\\b${f.surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  let m;
  while ((m = re.exec(hay))) {
    if (out.some((o) => Math.abs(o.at - m.index) < 40)) continue; // already counted as full/alias
    if (!f.ambiguous) { push(m.index, "surname"); continue; }
    const win = hay.slice(Math.max(0, m.index - NEAR_FIRST), m.index + NEAR_FIRST);
    if (f.first && win.includes(f.first)) push(m.index, "surname+first"); // confirmed by context
    // otherwise: an ambiguous bare surname -> NOT a mention. This is the whole point.
  }
  return out.sort((x, y) => x.at - y.at);
}

// ---- LOCAL CO-OCCURRENCE ----------------------------------------------------------------------
// The two scheduled opponents must appear NEAR each other. Both names existing somewhere in 359k
// chars is not evidence they were discussed as a matchup.
const WINDOW = 3000; // ~3 minutes of speech

function coOccurrences(ma, mb, win = WINDOW) {
  const hits = [];
  for (const x of ma) {
    for (const y of mb) {
      const d = Math.abs(x.at - y.at);
      if (d <= win) hits.push({ at: Math.min(x.at, y.at), dist: d, aKind: x.kind, bKind: y.kind });
    }
  }
  hits.sort((p, q) => p.at - q.at);
  // collapse hits that describe the same passage
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.at - last.at < win) { last.count++; last.dist = Math.min(last.dist, h.dist); continue; }
    merged.push({ ...h, count: 1 });
  }
  return merged;
}

const VS = /\b(vs|versus|against|fights?|faces?|matchup|takes on)\b/;
function vsPhrase(hay, a, b, at) {
  const w = hay.slice(Math.max(0, at - 200), at + 200);
  return VS.test(w) && (w.includes(a.surname) && w.includes(b.surname));
}
// Language that means the fight ALREADY happened — a recap is not pre-fight evidence.
const RECAP = /\b(last night|recap|post fight|post-fight|aftermath|won by|defeated|knocked out|beat him|results|reaction)\b/;

// ---- RELEVANCE SCORE (auditable: every component is returned) ----------------------------------
function scoreBout(hay, bout, meta = {}) {
  const ma = mentions(hay, bout.a), mb = mentions(hay, bout.b);
  const co = coOccurrences(ma, mb);
  const fullA = ma.filter((m) => m.kind !== "surname").length;
  const fullB = mb.filter((m) => m.kind !== "surname").length;
  const closest = co.length ? Math.min(...co.map((c) => c.dist)) : Infinity;
  const vs = co.filter((c) => vsPhrase(hay, bout.a, bout.b, c.at)).length;
  const density = (ma.length + mb.length) / Math.max(1, hay.length / 10000);
  const ranges = co.map((c) => ({ from: Math.max(0, c.at - 1500), to: Math.min(hay.length, c.at + 4500) }));
  const recap = co.some((c) => RECAP.test(hay.slice(Math.max(0, c.at - 300), c.at + 300)));
  const pubOk = meta.timestamp && bout.date
    ? (Date.parse(bout.date) - Date.parse(meta.timestamp)) / 86400000
    : null; // days before the fight; negative = published after

  let s = 0;
  const parts = {};
  parts.coOccur = Math.min(30, co.length * 10); s += parts.coOccur;             // the core signal
  parts.vsPhrase = Math.min(20, vs * 10); s += parts.vsPhrase;                  // "X vs Y" nearby
  parts.bothNamed = (fullA > 0 && fullB > 0) ? 15 : 0; s += parts.bothNamed;    // full names, not surnames
  parts.repeat = Math.min(15, (Math.min(ma.length, mb.length) - 1) * 3); s += parts.repeat;
  parts.closeness = closest < 400 ? 10 : closest < 1200 ? 5 : 0; s += parts.closeness;
  parts.density = Math.min(10, density * 2); s += parts.density;
  parts.timing = pubOk == null ? 0 : (pubOk >= 0 && pubOk <= 21 ? 10 : pubOk > 21 ? 3 : -25);
  s += parts.timing;                                                            // published after the fight = recap
  parts.onlyOnce = (ma.length <= 1 || mb.length <= 1) ? -15 : 0; s += parts.onlyOnce;
  parts.noCoOccur = co.length === 0 ? -40 : 0; s += parts.noCoOccur;            // fatal
  parts.recapLang = recap ? -20 : 0; s += parts.recapLang;

  return { boutId: bout.boutId, a: bout.a.name, b: bout.b.name,
    fullNameMentions: { a: fullA, b: fullB }, totalMentions: { a: ma.length, b: mb.length },
    coOccurrences: co.length, closestDistance: closest === Infinity ? null : closest,
    vsPhrases: vs, mentionDensity: +density.toFixed(2), daysBeforeFight: pubOk == null ? null : Math.round(pubOk),
    recapLanguage: recap, ranges, score: Math.round(s), parts };
}

// ---- DOMINANT EVENT ---------------------------------------------------------------------------
// Which fighters actually own this transcript? If the discussion belongs to another card, the video
// is either rejected or read only in its relevant ranges.
function dominance(hay, card, corpusFighters) {
  const counts = {};
  for (const n of corpusFighters) {
    const s = surnameOf(n);
    if (!s || s.length < 4) continue;
    const c = (hay.match(new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")) || []).length;
    if (c > 0) counts[n] = (counts[n] || 0) + c;
  }
  const onCard = new Set(card.bouts.flatMap((b) => [b.a.norm, b.b.norm]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const onCardCount = Object.entries(counts).filter(([n]) => onCard.has(norm(n))).reduce((a, [, c]) => a + c, 0);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => ({ name: n, mentions: c }));
  return { onCardShare: +(onCardCount / total).toFixed(3), topFighters: top, totalFighterMentions: total };
}

module.exports = { buildCard, scoreBout, mentions, coOccurrences, dominance, surnameIndex,
  norm, surnameOf, firstOf, WINDOW };
