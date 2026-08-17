// GRADE CHANNELS — rebuild the channel track record the confidence engine weights by.
//
//   node run-grade-channels.js [--dry]
//
// THE WIRING THIS FIXES. data/sources_graded.json is what lib/channel-weights.js turns into each
// channel's A/B/C/D tier, and therefore how much that channel's vote moves a confidence number. It was
// last written on 2026-07-16 by a backfill that belonged to the torn-out market pipeline. Six cards
// settled after that — including a 6/10 card where 17 channels piled onto a 92% pick that lost — and
// not one of them changed a single channel's weight. The grade stage graded the FORECAST and refit the
// CALIBRATION, but nothing re-graded the CHANNELS. This closes that loop; dispatch.js runs it whenever
// a card settles.
//
// WHAT IT MEASURES: on the fights a channel called, did it pick winners more often than the REST OF THE
// FIELD did on those same fights (lib/channel-grade.js)? No price, no line, no bet — the field's own
// consensus is the yardstick, so the torn-out market machinery stays torn out.
//
// WHY THERE IS A LEDGER (data/channel-results.json). Kalshi only serves ~2 months of settled markets
// (122 fights today). Grading off that window alone caps every channel at effN ~15, which is below the
// tier bar, so EVERY channel would sit at tier D forever and the weights would be uniformly flat — a
// silent no-op dressed up as a fix. So each run MERGES what it can see into an append-only ledger of
// fight outcomes + who voted which way. The window rolls forward, the ledger keeps the history.
// Votes are stored raw (not as a derived share) so a fight re-seen later with better channel coverage
// simply improves, and the shares are recomputed at grade time.
//
// A run that resolves no fights FAILS (exit 1) rather than writing an empty record: an empty
// sources_graded.json flattens every channel to the unranked prior, which is exactly the kind of quiet
// degradation that let the fossil sit unnoticed for a month.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const CG = require("./lib/channel-grade");
const W = require("./lib/channel-weights");
const C = require("./lib/confidence");
const N = require("./lib/names");
const R = require("./lib/results");
const { paths, readJson, writeJson } = require("./lib/store");

const DATA = paths.data;
const LEDGER = path.join(DATA, "channel-results.json");
const DRY = process.argv.includes("--dry");
const say = (s) => process.stdout.write(s + "\n");

// A pick is about the fight it PRECEDES, within the same window the confidence engine gathers picks
// over. Anything at or after the bell is not a prediction (see lib/results.js — post-fight "picks"
// once fabricated an entire edge out of hindsight).
const WINDOW_BEFORE_MS = 28 * 24 * 3600e3;
const MIN_FIELD = 3;        // below this, "the rest of the field" is too thin to be a yardstick
const SAME_FIGHT_DAYS = 2;  // Kalshi close_time (UTC, often past midnight) vs a Wikipedia event date

const dayOf = (t) => String(new Date(t).toISOString()).slice(0, 10);
const pairKey = (x, y) => [N.surname(x), N.surname(y)].filter(Boolean).sort().join("|");

// ---------------------------------------------------------------------------------------------
// THE LEDGER: { fights: { key: { fight, a, b, fightTime, winner: "a"|"b", votes: { source: "a"|"b" } } } }
// Keyed by surname-pair + date. The same fight reached from two sources can carry dates a day apart
// (Kalshi settles after midnight UTC; the historical rows use the local event date), so an incoming
// fight SNAPS onto an existing key for the same pair within SAME_FIGHT_DAYS instead of forking it.
// ---------------------------------------------------------------------------------------------
function loadLedger() {
  const l = readJson(LEDGER, null);
  return l && l.fights ? l : { fights: {} };
}

function findKey(ledger, pair, timeMs) {
  const exact = `${pair}@${dayOf(timeMs)}`;
  if (ledger.fights[exact]) return exact;
  for (const k of Object.keys(ledger.fights)) {
    if (!k.startsWith(`${pair}@`)) continue;
    const t = Date.parse(ledger.fights[k].fightTime || 0);
    if (Number.isFinite(t) && Math.abs(t - timeMs) <= SAME_FIGHT_DAYS * 86400e3) return k;
  }
  return exact;
}

// Record one channel's vote on one fight. `a`/`b` fix the fight's orientation the first time it is
// seen; later votes are mapped onto that orientation by surname so the sides never flip.
function record(ledger, { pair, timeMs, a, b, winnerName, source, pickName }) {
  const key = findKey(ledger, pair, timeMs);
  let f = ledger.fights[key];
  if (!f) {
    const winnerIsA = C.surnameEq(N.surname(winnerName), N.surname(a));
    f = ledger.fights[key] = { fight: `${a} vs ${b}`, a, b, fightTime: new Date(timeMs).toISOString(),
      winner: winnerIsA ? "a" : "b", votes: {} };
  }
  const side = C.surnameEq(N.surname(pickName), N.surname(f.a)) ? "a"
    : C.surnameEq(N.surname(pickName), N.surname(f.b)) ? "b" : null;
  if (!side) return false;                 // pick names neither fighter of the fight we snapped onto
  if (f.votes[source]) return false;       // first opinion recorded stands; never rewritten
  f.votes[source] = side;
  return true;
}

// ---------------------------------------------------------------------------------------------
// SOURCE 1 (historical bootstrap): data/predictions.json — 11k picks whose outcomes were resolved by
// the old backfill. Only the OUTCOME is taken; its market prices are ignored entirely.
// ---------------------------------------------------------------------------------------------
function mergeHistorical(ledger) {
  const rows = readJson(paths.predictions, []);
  let added = 0;
  // Group into fights first so each fight's orientation and winner come from the same place.
  const groups = {};
  for (const r of rows) {
    if (!(r.result === 0 || r.result === 1)) continue;
    if (!r.source || !r.pick || !r.opponent || !r.fightTime) continue;
    const t = Date.parse(r.fightTime);
    if (!Number.isFinite(t)) continue;
    const pair = pairKey(r.pick, r.opponent);
    if (!pair.includes("|")) continue;                    // need BOTH surnames — the pair is the match
    (groups[`${pair}@${dayOf(t)}`] = groups[`${pair}@${dayOf(t)}`] || []).push({ ...r, t, pair });
  }
  for (const g of Object.values(groups)) {
    const win = g.find((r) => r.result === 1);
    if (!win) continue;                                   // no winner in the group -> not gradeable
    for (const r of g) {
      if (record(ledger, { pair: r.pair, timeMs: r.t, a: win.pick, b: win.opponent,
        winnerName: win.pick, source: r.source, pickName: r.pick })) added++;
    }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------
// SOURCE 2 (the ongoing path): Kalshi's settled markets x the live pick corpus. This is what keeps the
// ledger growing after every card, with no backfill and no market prices.
// ---------------------------------------------------------------------------------------------
function settledFights(markets) {
  const byEvent = {};
  for (const m of markets) if (m.event_ticker && m.yes_sub_title) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);
  const fights = [];
  for (const ms of Object.values(byEvent)) {
    if (ms.length !== 2) continue;
    const [x, y] = ms;
    const wx = R.wonFromMarket(x), wy = R.wonFromMarket(y);
    if (!((wx === 1 && wy === 0) || (wx === 0 && wy === 1))) continue;   // void / unsettled / contradictory
    const fightMs = Date.parse(x.close_time || y.close_time || 0);
    if (!Number.isFinite(fightMs)) continue;
    fights.push({ a: x.yes_sub_title, b: y.yes_sub_title, winner: wx === 1 ? x.yes_sub_title : y.yes_sub_title, fightMs });
  }
  return fights.sort((p, q) => p.fightMs - q.fightMs);
}

function allPicks() {
  const dir = path.join(DATA, "picks");
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const d = readJson(path.join(dir, fn), null);
    if (!d || !Array.isArray(d.picks)) continue;
    for (const p of d.picks) if (p && p.source && p.pick && p.opponent) out.push(p);
  }
  return out;
}

function mergeSettled(ledger, fights, picks) {
  let added = 0;
  for (const p of picks) {
    const ts = Date.parse(p.timestamp || 0);
    if (!Number.isFinite(ts)) continue;
    for (const f of fights) {
      if (f.fightMs <= ts) continue;                       // hindsight: a prediction must precede its fight
      if (f.fightMs - ts > WINDOW_BEFORE_MS) break;        // sorted; nothing further is in window
      if (!C.whichSide(p, f)) continue;                    // the surname-PAIR match, unchanged
      if (record(ledger, { pair: pairKey(f.a, f.b), timeMs: f.fightMs, a: f.a, b: f.b,
        winnerName: f.winner, source: p.source, pickName: p.pick })) added++;
      break;                                               // a pick pair matches at most one fight
    }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------
(async () => {
  const ledger = loadLedger();
  const before = Object.keys(ledger.fights).length;

  const addedHist = mergeHistorical(ledger);

  let addedFresh = 0, settledCount = 0;
  try {
    const fights = settledFights(await R.settledFor("mma"));
    settledCount = fights.length;
    addedFresh = mergeSettled(ledger, fights, allPicks());
  } catch (e) {
    // Non-fatal: the ledger still holds everything previously merged, so a Kalshi blip costs freshness,
    // not the record. It becomes fatal below only if the ledger is empty.
    say(`[grade-channels] ⚠ kalshi settled fetch failed (${e.message}) — grading the existing ledger only`);
  }

  const fightCount = Object.keys(ledger.fights).length;
  say(`[grade-channels] ledger: ${fightCount} fights (${fightCount - before} new) · +${addedHist} historical votes · +${addedFresh} from ${settledCount} Kalshi-settled fights`);
  if (!fightCount) { say("FATAL: no fights in the ledger — refusing to write an empty channel record"); process.exit(1); }

  // Score each channel against the FIELD (lib/channel-grade builds the rows so run-fit-calibration's
  // walk-forward rebuild and this live grade can never drift apart).
  const rows = CG.rowsFromLedger(ledger, { minField: MIN_FIELD });
  if (!rows.length) { say("FATAL: no gradeable rows — refusing to write an empty channel record"); process.exit(1); }
  const covered = new Set(rows.map((r) => r.fight)).size;

  const cfg = readJson(paths.config, {});
  const g = cfg.grading || {};
  const sourceMeta = {};
  for (const s of (readJson(paths.sources, { sources: [] }).sources || [])) {
    if (s && s.name) sourceMeta[s.name] = { domain: s.domain, type: s.type, handle: s.handle, platform: s.platform };
  }

  const graded = CG.gradeAll(rows, {
    halfLifeDays: g.recencyHalfLifeDays || 365,
    priorWeight: g.shrinkagePriorWeight ?? 10,
    now: Date.now(),
  }, sourceMeta);

  const ranked = Object.values(graded).sort((x, y) => (y.edge ?? -9) - (x.edge ?? -9));
  const tiers = ranked.reduce((a, r) => { const t = W.tierOf(r); a[t] = (a[t] || 0) + 1; return a; }, {});
  say(`[grade-channels] ${rows.length} channel-fight rows over ${covered} covered fights (${fightCount - covered} too thin, <${MIN_FIELD} channels) · ${ranked.length} channels graded`);
  say(`[grade-channels] tiers: ${["A", "B", "C", "D"].map((t) => `${t}=${tiers[t] || 0}`).join(" ")}  (tier A means the whole interval beats the field — empty is an honest answer, not a bug)`);
  const show = (r) => say(`    ${String(r.source).slice(0, 30).padEnd(30)} n=${String(r.n).padStart(4)} effN=${String(r.effN).padStart(6)} edge=${String(r.edge).padStart(7)} lcb=${String(r.edgeLcb).padStart(7)}  (hit ${r.hitRate} vs field ${r.fieldHitRate})`);
  say("  best 8 vs the field:");   ranked.slice(0, 8).forEach(show);
  say("  worst 5:");               ranked.slice(-5).forEach(show);

  if (DRY) { say("[grade-channels] --dry: nothing written."); process.exit(0); }
  ledger.updatedAt = new Date().toISOString();
  writeJson(LEDGER, ledger);
  writeJson(paths.graded, graded);
  say(`[grade-channels] wrote ${paths.graded} (${ranked.length} channels) + ${LEDGER} (${fightCount} fights)`);
  process.exit(0);
})().catch((e) => { say(`FATAL: grade-channels error: ${e.message}`); process.exit(1); });
