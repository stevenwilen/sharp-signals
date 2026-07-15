// The list of picks we are actively watching — written down ONCE and kept, instead of
// re-derived from a 10-day video re-scan every single hour.
//
// The problem it fixes: the pipeline used to rebuild its whole picture each run. It re-scanned
// the last 10 days of videos, re-read every cached pick, and re-matched all ~700 of them to
// Kalshi from scratch — including picks for fights that had already happened. Worse, it was
// LOSSY: a pick fell off the edge of the world after 10 days, so a pundit who called a fight
// three weeks out (before Kalshi even listed it) was silently dropped before we could act.
//
// This ledger holds each pick from the moment it is spoken until its fight resolves, with a
// status. A pick that has no market yet just WAITS — however long that takes — and the hour its
// market opens (the softest, most-beatable line) it flips to live. Settled picks drop off so we
// stop re-matching finished fights. This is also the infrastructure the "be fast at the open"
// strategy needs: we hold the pick and pounce the instant the market exists.
const fs = require("fs");
const path = require("path");
const names = require("./names");

// Repo-rooted so it is committed and shared with the cloud (like the caches). Only the pipeline
// writes it; the backfill never touches it, so there is no cross-job git conflict.
const FILE = path.join(__dirname, "..", "data", "pick-ledger.json");

const DAY = 86400000;
const SETTLED_KEEP_DAYS = 30;    // keep settled entries this long (audit), then prune
// 120 not 45: fights are announced 6-8 weeks out and Kalshi often lists a market only during
// fight week, so a shorter clock would retire a still-valid early call BEFORE its market ever
// opens — the exact early-line edge the ledger exists to hold. The only cost of a longer clock
// is that a genuinely dead pick lingers a few extra months as one cheap match attempt per run.
const WAITING_EXPIRE_DAYS = 120; // a pick whose market never opened (cancelled fight) expires

// key = source + canonical fighter. One active pick per (source, fighter). Two upcoming fights
// for the same fighter by the same source is rare enough to collapse; a rematch months later is
// fine because the earlier entry is settled-and-pruned by then.
const keyOf = (source, pick) => `${source}|${names.canonical(pick)}`;

// A MISSING file is a legitimate first run -> empty ledger. A PRESENT-but-corrupt file (a crash
// truncated it mid-write, or a bad git merge left conflict markers) must NOT be silently treated
// as empty: doing so would rebuild the ledger from only the 10-day scan and then save() would
// overwrite the committed-but-good file with that tiny map, permanently and silently losing every
// long-waiting early call. So we THROW on corruption, which routes to run()'s failure handler
// (the "cannot die quietly" Telegram) and exits BEFORE prune()/save() can clobber the good file.
function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { throw new Error(`pick-ledger.json is corrupt (${e.message}); refusing to rebuild over it`); }
  return j && typeof j === "object" && j.picks ? j.picks : {};
}
// Atomic write: to a temp file, then rename over the real one (rename on the same filesystem is
// atomic). A crash/OOM/timeout can now only ever leave the OLD file fully intact or the NEW file
// fully written — never a truncated half-file. This mirrors lib/store.js writeJson; the ledger
// had regressed from that pattern, which was finding #1 of the review.
function save(map) {
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ picks: map, updatedAt: nowIso() }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (_) {}
}

// Date.now is available at runtime here (this is not a workflow script).
const nowMs = () => Date.now();
const nowIso = () => new Date(nowMs()).toISOString();

// Add a freshly-seen pick, or refresh an existing one. NEVER resurrects a settled entry (a
// lingering video that keeps re-surfacing a pick for a fight that already happened must not
// re-activate it). Returns the ledger key.
function upsert(map, p) {
  const key = keyOf(p.source, p.pick);
  const e = map[key];
  if (e) {
    if (e.status !== "settled") {
      e.lastSeen = nowIso();
      if (p.quote) e.quote = p.quote;
      if (p.opponent) {
        // A change of opponent on the SAME (source, fighter) key means two different fights (or
        // two different humans sharing a name) collapsed onto one entry. That is rare, but the
        // collapse must not be silent — one of the two fights ends up untracked. Log it so a
        // human can see it, then keep the newer opponent.
        if (e.opponent && names.nameScore(e.opponent, p.opponent) < 2) {
          console.log(`[ledger] WARN key ${key} now names a different opponent: ` +
            `"${e.opponent}" -> "${p.opponent}" — possible name collision, one fight may be untracked`);
        }
        e.opponent = p.opponent;
      }
      return key;
    }
    // The entry is SETTLED. Only revive it for a GENUINELY NEW pick — one whose video postdates
    // the settlement, i.e. a later fight for the same fighter (a rebooking, a rematch). A pick
    // that is the same-or-older than the settled fight is just a lingering video re-surfacing a
    // finished fight; leave it settled (the anti-zombie guard). Without this, a fighter who fights
    // twice inside the 30-day settled-retention window has the second fight silently dropped.
    const t = Date.parse(p.timestamp || 0);
    if (!(t && e.settledAt && t > Date.parse(e.settledAt))) return key;
    // fall through: overwrite the settled entry with a fresh waiting lifecycle for the new fight
  }
  map[key] = {
    key, source: p.source, domain: p.domain,
    pick: p.pick, opponent: p.opponent || null, quote: p.quote || "",
    pickTime: p.timestamp || nowIso(),   // when the pick was actually made (video publish time)
    url: p.url || null,
    status: "waiting",                   // no market matched yet
    ticker: null, fightDate: null,
    firstSeen: nowIso(), lastSeen: nowIso(), settledAt: null, settledReason: null,
  };
  return key;
}

const active = (map) => Object.values(map).filter((e) => e.status !== "settled");

function setMatched(map, key, ticker, fightDate) {
  const e = map[key];
  if (!e || e.status === "settled") return;
  e.status = "live";
  e.ticker = ticker;
  e.fightDate = fightDate;
  e.lastSeen = nowIso();
}

function settle(map, key, reason) {
  const e = map[key];
  if (!e) return;
  e.status = "settled";
  e.settledAt = nowIso();
  e.settledReason = reason || "settled";
}

// Housekeeping: drop old settled entries; expire picks whose market never opened.
function prune(map) {
  const t = nowMs();
  for (const [key, e] of Object.entries(map)) {
    if (e.status === "settled") {
      if (t - Date.parse(e.settledAt || e.lastSeen || 0) > SETTLED_KEEP_DAYS * DAY) delete map[key];
    } else if (e.status === "waiting") {
      if (t - Date.parse(e.firstSeen || 0) > WAITING_EXPIRE_DAYS * DAY) {
        e.status = "settled"; e.settledAt = nowIso(); e.settledReason = "expired: no market ever opened";
      }
    }
  }
}

const counts = (map) => {
  const c = { waiting: 0, live: 0, settled: 0 };
  for (const e of Object.values(map)) c[e.status] = (c[e.status] || 0) + 1;
  return c;
};

module.exports = { FILE, keyOf, load, save, upsert, active, setMatched, settle, prune, counts };
