// Remembers which bets we have already told the human about.
//
// Without this, the pipeline re-sent the SAME bet on every run. The picks-cache guarantees
// the inputs are identical run to run, so the alert is deterministic: 6 runs/day for the ~10
// days a pick stays in the window is ~18 byte-identical "BET: Du Plessis, 5% of bankroll"
// messages, with nothing to indicate it is the same bet. If the human acts on each one, he is
// 90% of bankroll on a single fight — which defeats the "never more than 5% on one fight"
// cap by pure repetition. The cap is worthless if the message repeats.
//
// Re-alerting IS allowed when the recommendation MATERIALLY changes: a new trusted source
// joins the call, or the stake moves by more than a percentage point (the market moved).
// Everything else stays quiet.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "alerts_sent.json");

const load = () => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return {}; }
};
const save = (o) => {
  try { fs.writeFileSync(FILE, JSON.stringify(o, null, 2)); } catch (_) {}
};

// Should we send this one? `sources` = names backing it, `pct` = the stake we'd recommend.
function shouldSend(ticker, sources, pct) {
  const sent = load()[ticker];
  if (!sent) return { send: true, why: "new" };

  const known = new Set(sent.sources || []);
  const fresh = (sources || []).filter((s) => !known.has(s));
  if (fresh.length) return { send: true, why: `new source: ${fresh.join(", ")}` };

  if (Math.abs((pct || 0) - (sent.pct || 0)) >= 1) {
    return { send: true, why: `stake moved ${sent.pct}% -> ${pct}%` };
  }
  return { send: false, why: "already sent" };
}

function record(ticker, sources, pct) {
  const all = load();
  const prev = all[ticker] || {};
  all[ticker] = {
    sources: Array.from(new Set([...(prev.sources || []), ...(sources || [])])),
    pct,
    firstSentAt: prev.firstSentAt || new Date().toISOString(),
    lastSentAt: new Date().toISOString(),
  };
  save(all);
}

// Drop entries for fights that have happened, so the file does not grow forever.
function prune(openTickers) {
  const open = new Set(openTickers || []);
  const all = load();
  let dropped = 0;
  for (const t of Object.keys(all)) if (!open.has(t)) { delete all[t]; dropped++; }
  if (dropped) save(all);
  return dropped;
}

// Age-based prune: drop entries not touched in `days` days. A fight's whole alert lifecycle is
// far shorter than this, so unlike prune() it needs no complete open-ticker snapshot (passing a
// partial one would wrongly evict still-valid entries and re-arm duplicate alerts) and is safe to
// call unconditionally every run. Since a Kalshi ticker is unique per fight, an over-old entry can
// never cause a wrong suppression anyway — this is purely to stop unbounded growth.
function pruneOld(days = 45) {
  const all = load();
  const cutoff = Date.now() - days * 86400000;
  let dropped = 0;
  for (const [t, e] of Object.entries(all)) {
    if (Date.parse(e.lastSentAt || e.firstSentAt || 0) < cutoff) { delete all[t]; dropped++; }
  }
  if (dropped) save(all);
  return dropped;
}

module.exports = { shouldSend, record, prune, pruneOld, FILE };
