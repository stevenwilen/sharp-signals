// FIT CALIBRATION — teach the confidence engine what its consensus SHARE is really worth, and produce
// the honest scoreboard that replaces the old P&L chart.
//
// For every past, settled card it rebuilds the same rank-weighted consensus, looks up who actually won
// (Kalshi settlement, read-only), and pairs (share, coverage) with the outcome. It fits the shrink slope
// so "74%" comes to mean "won ~74% of the time", and writes:
//   - data/confidence-calibration.json   the fitted params the engine uses (or the conservative default)
//   - data/confidence-history.json       every graded read + a bucketed hit-rate table (the scoreboard)
//
//   node run-fit-calibration.js
//
// Best-effort and read-only: a Kalshi hiccup leaves the conservative default in place, never a bet path.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const C = require("./lib/confidence");
const CAL = require("./lib/confidence-calibration");
const CG = require("./lib/channel-grade");
const W = require("./lib/channel-weights");
const R = require("./lib/results");
const N = require("./lib/names");

const DATA = path.join(__dirname, "data");
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const tickerDate = (d) => { const [y, m, day] = d.split("-"); return `${y.slice(2)}${MONTHS[+m - 1]}${day}`; };

// Which past cards do we have a forecast for? (canonical files only, not the .v<ts> seals.)
function settledCards() {
  return fs.readdirSync(DATA)
    .map((f) => (f.match(/^forecast-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1])
    .filter(Boolean).sort();
}

(async () => {
  let settled = [];
  try { settled = await R.settledFor("mma"); }
  catch (e) { console.error(`kalshi settled fetch failed (${e.message}) — keeping current calibration`); process.exit(0); }
  if (!settled.length) { console.error("no settled markets returned — keeping current calibration"); process.exit(0); }

  // WALK-FORWARD WEIGHTS. Rebuilding a past card with TODAY's channel weights is in-sample: those
  // weights were graded on this very card, so they already know who won and the scoreboard reports an
  // accuracy the engine never actually had live. For each card we therefore rebuild the weight table
  // from ONLY the fights that had settled before it — what the engine genuinely had at the time. If
  // there is no ledger yet, weights fall back to the current record and the scoreboard says so.
  const ledger = readJson(path.join(DATA, "channel-results.json"), null);
  const cfg = readJson(path.join(__dirname, "config.json"), {});
  const gcfg = cfg.grading || {};
  const weightsAsOf = (cardDate) => {
    if (!ledger) return null;
    const before = Date.parse(`${cardDate}T00:00:00Z`);
    const rows = CG.rowsFromLedger(ledger, { before });
    if (!rows.length) return null;
    return W.buildFrom(CG.gradeAll(rows, {
      halfLifeDays: gcfg.recencyHalfLifeDays || 365,
      priorWeight: gcfg.shrinkagePriorWeight ?? 10,
      now: before,
    }));
  };

  const cards = settledCards();
  const samples = [];   // { card, fight, pick, confidencePct, share, coverage, label, won }
  let walkForward = 0, cardsScored = 0;
  for (const card of cards) {
    const td = tickerDate(card);
    const cardMkts = settled.filter((m) => String(m.ticker || "").includes(`-${td}`));
    if (!cardMkts.length) continue;   // not settled yet (e.g. the upcoming card)
    cardsScored++;
    const weights = weightsAsOf(card);
    if (weights) walkForward++;
    const conf = C.buildCard(card, { weights });
    const cardMs = Date.parse(`${card}T00:00:00Z`);
    const seen = new Set();
    for (const f of conf.fights) {
      if (!f.pick) continue;
      // Kalshi lists some bouts twice under different event tickers (2026-08-22 carried Dolidze/de Ridder
      // and Wint/Chatman as two events each), and the sealed card carries the duplicates through. Scoring
      // both counts one fight twice in the record. First occurrence wins.
      const key = [N.surname(f.a), N.surname(f.b)].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      // THE LEDGER FIRST, Kalshi second. The ledger keeps every winner permanently; Kalshi's settled list
      // is a rolling ~63-day window, so resolving only against it meant the oldest card silently fell out
      // of the scoreboard every week (2026-07-11's 14 reads were 20 days from vanishing) and the record
      // could never grow past ~8 cards. Kalshi still covers anything the ledger has not recorded yet —
      // a late-settling main event graded before it closed, which is how UFC 330's Makhachev read went
      // ungraded for a week.
      let won = CG.winnerFromLedger(ledger, f.pick, f.opponent || (f.pick === f.a ? f.b : f.a), cardMs, N.surname, C.surnameEq);
      if (won !== 0 && won !== 1) {
        const mkt = cardMkts.find((m) => N.surname(m.yes_sub_title) && C.surnameEq(N.surname(m.yes_sub_title), N.surname(f.pick)));
        won = mkt ? R.wonFromMarket(mkt) : null;
      }
      if (won !== 0 && won !== 1) continue;   // void / unresolved -> not a calibration point
      samples.push({ card, fight: f.fight, pick: f.pick, confidencePct: f.confidencePct,
        share: f.share, coverage: f.coverage, label: f.label, won });
    }
  }

  const fitted = CAL.fit(samples.map((s) => ({ share: s.share, coverage: s.coverage, won: s.won })));
  CAL.save(fitted);
  // Recompute each read's % with the JUST-FITTED calibration so the scoreboard is self-consistent
  // (buildCard above used whatever calibration was loaded before this fit).
  for (const s of samples) s.confidencePct = Math.round(100 * CAL.toProbability(s.share, s.coverage));

  // Scoreboard: overall + by confidence bucket (was the high-confidence pick actually right?).
  //
  // THE TOP BUCKET IS OPEN-ENDED, ON PURPOSE. It used to be the closed range [70, 86), written when the
  // calibration cap was 0.85. When the cap was raised to 0.92 the bucket was not, so every read from 86%
  // up — 24 of 71 graded reads, the entire high-confidence band, the one place the operator most needs
  // to see whether the number is honest — silently fell into NO bucket and vanished from the scoreboard
  // while still counting in `graded`/`accuracy`/`brier`. An open top bucket cannot drift out of step
  // with the cap again. The invariant below is the belt to that braces.
  const EDGES = [50, 56, 62, 70, 80];
  const buckets = EDGES.map((lo, i) => {
    const hi = EDGES[i + 1] ?? Infinity;
    const inB = samples.filter((s) => s.confidencePct >= lo && s.confidencePct < hi);
    const won = inB.filter((s) => s.won === 1).length;
    const capPct = Math.round(100 * (fitted.cap ?? 1));
    return { range: hi === Infinity ? `${lo}-${capPct}%` : `${lo}-${hi - 1}%`,
      n: inB.length, won, hitRate: inB.length ? +(won / inB.length).toFixed(3) : null };
  });
  // Every graded read must appear in exactly one bucket. A scoreboard that quietly drops reads is worse
  // than no scoreboard — it reads as "we checked" when the band in question was never shown.
  const bucketed = buckets.reduce((a, b) => a + b.n, 0);
  if (bucketed !== samples.length) {
    console.error(`FATAL: ${samples.length - bucketed} of ${samples.length} graded reads fell outside every confidence bucket`);
    process.exit(1);
  }
  const total = samples.length, wins = samples.filter((s) => s.won === 1).length;
  const brier = total ? +(samples.reduce((a, s) => a + ((s.confidencePct / 100) - s.won) ** 2, 0) / total).toFixed(4) : null;

  // SPLIT OUT THE READS THE ENGINE ITSELF DISTRUSTS. A read below MIN_COVERAGE channels is labelled
  // UNDER-COVERED on the board — the system saying out loud "too few voices to trust this" — and then
  // it was folded into one blended accuracy anyway. It is not a small effect: those reads run 5/10 while
  // everything with real coverage runs 59/73 (81%), so the blended headline understates the engine on
  // the fights it actually has an opinion about AND hides that the thin ones are close to coin-flips.
  // Both numbers are reported; neither is dropped, because dropping them would flatter the record.
  const MIN_COVERAGE = 3;
  const slice = (rows) => {
    const w = rows.filter((s) => s.won === 1).length;
    return { n: rows.length, correct: w, accuracy: rows.length ? +(w / rows.length).toFixed(3) : null,
      brier: rows.length ? +(rows.reduce((a, s) => a + ((s.confidencePct / 100) - s.won) ** 2, 0) / rows.length).toFixed(4) : null };
  };
  const covered = slice(samples.filter((s) => (s.coverage || 0) >= MIN_COVERAGE));
  const underCovered = slice(samples.filter((s) => (s.coverage || 0) < MIN_COVERAGE));

  const scoreboard = {
    generatedAt: new Date().toISOString(),
    calibration: fitted,
    graded: total, correct: wins, accuracy: total ? +(wins / total).toFixed(3) : null,
    brier,
    // The headline split by whether the engine had enough voices to have an opinion at all.
    byCoverage: { minCoverage: MIN_COVERAGE, covered, underCovered },
    // How the numbers above were produced, stated on the artifact itself. "walk-forward" means each
    // card was rebuilt with only the channel weights that existed before it — the honest reading. If a
    // card could not be walked forward it was scored with today's weights, which flatters it, and the
    // count says so rather than leaving the operator to assume the clean case.
    evaluation: { method: walkForward === cardsScored ? "walk-forward" : "mixed",
      walkForwardCards: walkForward, scoredCards: cardsScored },
    byConfidence: buckets,
    reads: samples.sort((a, b) => (b.confidencePct - a.confidencePct)),
  };
  fs.writeFileSync(path.join(DATA, "confidence-history.json"), JSON.stringify(scoreboard, null, 2));

  console.log(`calibration: ${fitted.method} slope=${fitted.slope} — ${fitted.reliability}`);
  console.log(`evaluation: ${walkForward}/${cardsScored} cards scored walk-forward (weights as of that card, not today's)`);
  console.log(`scoreboard: ${total} graded reads · ${wins} correct (${total ? Math.round(100 * wins / total) : 0}%) · Brier ${brier}`);
  console.log(`  covered (>=${MIN_COVERAGE} channels): ${covered.correct}/${covered.n} (${covered.n ? Math.round(100 * covered.accuracy) : 0}%) · Brier ${covered.brier}`);
  console.log(`  under-covered            : ${underCovered.correct}/${underCovered.n}${underCovered.n ? ` (${Math.round(100 * underCovered.accuracy)}%)` : ""} — labelled UNDER-COVERED on the board`);
  for (const b of buckets) console.log(`  ${b.range.padStart(7)}: ${String(b.n).padStart(3)} reads · ${b.hitRate == null ? "—" : Math.round(100 * b.hitRate) + "% won"}`);
  process.exit(0);
})().catch((e) => { console.error("fit-calibration error:", e.message); process.exit(1); });
