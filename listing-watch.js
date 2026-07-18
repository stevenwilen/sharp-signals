// LISTING WATCHER — the last live structural hypothesis, and the only one still standing.
//
// What is already dead, by measurement rather than assumption:
//   - "our pundits beat the line"      -> 12,597 graded picks; the average source returns -0.4% vs
//                                         the close, and 0 of 50 survive an out-of-sample test.
//   - "Kalshi lags the sharp book"     -> 20 live markets 2 days out; mean |gap| 1.15%, two-sided,
//                                         19/20 negative after fees. The book is priced tight.
//   - "two-sided arb on thin books"    -> every fight's asks summed to >= 100c. Coherent.
//
// What was never tested: the price a market is BORN with. Kalshi lists a UFC fight days-to-weeks
// out, and before real money arrives that first quote may be naive. If so, the gap vs the sharp
// consensus is WIDE at birth and closes as the fight nears. The decisive question is not "is there
// a gap" but WHO MOVES:
//
//     Kalshi walks to the sharp line  -> the birth price was stale     -> a real edge existed
//     the sharp line walks to Kalshi  -> Kalshi knew something first   -> we'd have been the sucker
//
// So this snapshots every market the moment it appears and then tracks BOTH prices until the fight.
// It RECORDS. It never bets, never alerts a bet, and never calls anything an edge — that verdict is
// only earned once the convergence data exists.
//
//   node listing-watch.js
require("./lib/env");
const path = require("path");
const k = require("./lib/kalshi");
const oh = require("./lib/odds-history");
const { paths, readJson, writeJson } = require("./lib/store");
const { notify } = require("./lib/notify");

const STATE = path.join(paths.root, "data", "listing-watch.json");
// Kalshi asks are cheap (their API); BFO is a scrape we must stay polite to. So poll Kalshi every
// run and re-read the sharp line only every few hours — except at BIRTH, where it is the point.
const SHARP_EVERY_H = Number(process.env.SHARP_EVERY_H || 6);
const MAX_SAMPLES = 400;

const MON = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
// An OPEN market's close_time is a far-future placeholder (Aug 2 for a Jul 18 fight) and only snaps
// to reality once settled — reading it as the fight date silently misdates every upcoming fight by
// ~2 weeks. The ticker carries the real event date: KXUFCFIGHT-26JUL18... -> 2026-07-18.
const fightDateOf = (ticker) => {
  const t = /KXUFCFIGHT-(\d{2})([A-Z]{3})(\d{2})/.exec(ticker || "");
  return t ? Date.UTC(2000 + +t[1], MON[t[2]], +t[3]) : null;
};
const fee = (p) => 0.07 * p * (1 - p); // Kalshi's fee shape: maximal at 50c, cheapest at the extremes
const num = (v) => (v == null ? null : Number(String(v)));
const hoursSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 3600000 : Infinity);
const pc = (v) => (v == null ? "?" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");

async function main() {
  const st = readJson(STATE, { seededAt: null, markets: {} });
  // THE HONESTY HINGE. Markets already open on the first run were listed before we were watching —
  // we did not see them born, so their first sighting is NOT a birth price and must never be
  // analysed as one. Seed them, flag them, and exclude them forever.
  const seeding = !st.seededAt;
  if (seeding) st.seededAt = new Date().toISOString();

  const ms = await k.marketsAll({ series_ticker: "KXUFCFIGHT", status: "open" });
  const byEvent = {};
  for (const m of ms) if (m.event_ticker) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);
  const pairs = Object.values(byEvent).filter((a) => a.length === 2);
  console.log(`[listing-watch] ${ms.length} open markets -> ${pairs.length} two-sided fights${seeding ? "  (SEEDING: these count as pre-existing, not births)" : ""}`);

  const births = [], misses = [];
  for (const [a, b] of pairs) {
    const wantMs = fightDateOf(a.ticker);
    const isNew = (m) => !st.markets[m.ticker];
    // Fetch the sharp line if either side is newly seen (birth = the whole point) or our last ATTEMPT
    // has gone stale. Gate on the attempt time, not the last SUCCESS: sharpAt was only stamped on a
    // resolved line, so a fight BFO cannot price (name mismatch, no line yet) had sharpAt=undefined ->
    // hoursSince=Infinity -> a BFO scrape on EVERY run, the opposite of the politeness the cadence buys.
    const lastAttempt = (st.markets[a.ticker] || {}).sharpAttemptedAt || (st.markets[b.ticker] || {}).sharpAttemptedAt;
    const staleSharp = hoursSince(lastAttempt) >= SHARP_EVERY_H;
    let line = null, attemptIso = null;
    if (isNew(a) || isNew(b) || staleSharp) {
      line = await oh.liveLine(a.yes_sub_title, b.yes_sub_title, wantMs);
      if (!line.ok) misses.push(`${a.yes_sub_title} vs ${b.yes_sub_title}: ${line.reason}`);
      attemptIso = new Date().toISOString();   // stamped on each side's record below, success or not
    }

    for (const [m, sharpProb, opp] of [[a, line && line.ok ? line.prob : null, b.yes_sub_title],
                                       [b, line && line.ok ? line.oppProb : null, a.yes_sub_title]]) {
      const ask = num(m.yes_ask_dollars), bid = num(m.yes_bid_dollars);
      if (!(ask > 0 && ask < 1)) continue;
      const sz = num(m.yes_ask_size_fp);
      const depth = sz != null ? Math.round(sz * ask) : null;
      const gap = sharpProb != null ? +(sharpProb - ask).toFixed(4) : null;
      const sample = { t: new Date().toISOString(), ask, bid, depth, sharp: sharpProb, gap };

      let rec = st.markets[m.ticker];
      if (!rec) {
        // The TRUE birth is Kalshi's own open_time, not our first sighting. Cron fires unreliably, so
        // firstSeen can lag the real listing by hours; recording open_time and the latency lets the
        // convergence evaluator exclude a "birth" we caught too late to trust. Absent open_time -> null,
        // never invented.
        const openMs = m.open_time ? Date.parse(m.open_time) : null;
        const birthLatencyMs = Number.isFinite(openMs) ? Date.parse(sample.t) - openMs : null;
        rec = st.markets[m.ticker] = {
          ticker: m.ticker, fighter: m.yes_sub_title, opponent: opp,
          fightDate: wantMs ? new Date(wantMs).toISOString().slice(0, 10) : null,
          firstSeen: sample.t,
          kalshiOpenTime: m.open_time || null,
          birthLatencyMs,
          preExisting: seeding, // <- listed before we watched: never analysed as a birth
          birth: seeding ? null : { ...sample, feeAtAsk: +fee(ask).toFixed(4) },
          samples: [],
        };
        if (!seeding) births.push(rec);
      }
      if (sharpProb != null) rec.sharpAt = sample.t;
      if (attemptIso) rec.sharpAttemptedAt = attemptIso;   // gate re-fetch on attempt, not success
      rec.samples.push(sample);
      // Truncation must KEEP THE BIRTH WINDOW, not drop it. slice(-MAX) discarded the oldest samples
      // first — exactly the birth-to-week-1 trajectory the whole experiment is about. Keep the first
      // 40 (the birth window) and the most recent (MAX-40).
      if (rec.samples.length > MAX_SAMPLES) {
        const head = rec.samples.slice(0, 40);
        const tail = rec.samples.slice(-(MAX_SAMPLES - 40));
        rec.samples = head.concat(tail);
      }
      rec.last = sample;
    }
  }

  writeJson(STATE, st);
  const tracked = Object.values(st.markets);
  const real = tracked.filter((r) => !r.preExisting);
  console.log(`[listing-watch] tracking ${tracked.length} markets (${real.length} caught at birth, ${tracked.length - real.length} pre-existing/excluded)`);
  if (misses.length) {
    console.log(`[listing-watch] no sharp line for ${misses.length} fight(s) — stated, not hidden:`);
    for (const x of misses.slice(0, 10)) console.log(`   - ${x}`);
  }

  // Report BIRTHS only. This is a measurement, not a signal: no "edge", no bet, no arming.
  if (births.length) {
    console.log(`\n[listing-watch] ${births.length} NEW market(s) caught at listing:`);
    for (const r of births) {
      const g = r.birth && r.birth.gap;
      console.log(`   ${r.fighter} vs ${r.opponent} (${r.fightDate}) born at ${Math.round(r.birth.ask*100)}c` +
        `${g != null ? `, sharp ${(r.birth.sharp*100).toFixed(1)}%, gap ${pc(g)}` : ", sharp unavailable"}` +
        `${r.birth.depth != null ? `, depth $${r.birth.depth}` : ""}`);
    }
    const withGap = births.filter((r) => r.birth && r.birth.gap != null);
    if (withGap.length) {
      const absMean = withGap.reduce((s, r) => s + Math.abs(r.birth.gap), 0) / withGap.length;
      const msg = `🔬 Listing watch: caught ${withGap.length} market(s) at birth. ` +
        `Median |gap| vs sharp: ${(absMean * 100).toFixed(1)}%. ` +
        `Research only — convergence decides whether this means anything.`;
      await notify(msg).catch(() => {});
      console.log(`\n[listing-watch] ${msg}`);
    }
  } else if (!seeding) {
    console.log("[listing-watch] no new listings this run.");
  }
}

main().catch((e) => { console.error("[listing-watch] FAILED:", e.message); process.exit(1); });
