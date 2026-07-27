// DATA-FRESHNESS POLICIES — every data class has an explicit freshness status computed from ACTUAL
// source timestamps, never from "the workflow ran". The frozen-corpus defect survived every green
// check precisely because workflow success was standing in for data currency; these policies make
// staleness a first-class, visible state with defined consequences.
//
// Statuses (never a bare dash or ABSENT):
//   CURRENT               fresh enough for its class
//   DEGRADED              usable but past its freshness target — visible, consequence applied
//   STALE                 too old to represent "now" — must not be described as current research
//   FAILED                the last check errored (distinct from "nothing new")
//   DISABLED              the source class is switched off (e.g. web research)
//   NOT_APPLICABLE        the class does not apply in this state
//   WAITING_FOR_FIRST_RUN no data yet, not an error
require("./env");

const S = {
  CURRENT: "CURRENT", DEGRADED: "DEGRADED", STALE: "STALE", FAILED: "FAILED",
  DISABLED: "DISABLED", NOT_APPLICABLE: "NOT_APPLICABLE", WAITING: "WAITING_FOR_FIRST_RUN",
};

const HOURS = 3600e3;
const age = (ts, now) => (ts ? (now - Date.parse(ts)) / HOURS : Infinity);

// ACTIVE-CARD SOURCE CORPUS. During fight week (<=7d to the event) the newest successfully ingested
// source must be recent — a candidate universe whose newest item predates fight week is exactly the
// defect this file exists to catch, and it is STALE no matter how many channels it once contained.
// Consequence: STALE/DEGRADED is displayed on the dashboard and embedded in the selection artifact;
// the system must never claim "all channels searched" over a stale corpus.
function corpusStatus({ newestSourceTs, eventDate, now = Date.now() }) {
  if (!newestSourceTs) return { status: S.WAITING, reason: "no ingested sources yet" };
  const hoursOld = age(newestSourceTs, now);
  const msToEvent = Date.parse(eventDate) - now;
  const inFightWeek = Number.isFinite(msToEvent) && msToEvent <= 7 * 24 * HOURS && msToEvent > -24 * HOURS;
  if (inFightWeek) {
    if (hoursOld <= 24) return { status: S.CURRENT, reason: `newest source ${hoursOld.toFixed(1)}h old (fight week target 24h)` };
    if (hoursOld <= 72) return { status: S.DEGRADED, reason: `newest source ${hoursOld.toFixed(1)}h old — past the 24h fight-week target` };
    return { status: S.STALE, reason: `newest source ${(hoursOld / 24).toFixed(1)}d old during fight week — NOT current research` };
  }
  if (hoursOld <= 7 * 24) return { status: S.CURRENT, reason: `newest source ${(hoursOld / 24).toFixed(1)}d old (off-week target 7d)` };
  return { status: S.DEGRADED, reason: `newest source ${(hoursOld / 24).toFixed(1)}d old` };
}

// LIVE MARKET PRICE (Kalshi executable ask). Read in-run; a BUY may only render against a price
// captured in the CURRENT cycle. Consequence: DEGRADED/STALE blocks BUY (surfaced as PRICE gate).
function marketPriceStatus({ snapshotTs, now = Date.now() }) {
  if (!snapshotTs) return { status: S.WAITING, reason: "no price snapshot" };
  const mins = (now - Date.parse(snapshotTs)) / 60000;
  if (mins <= 20) return { status: S.CURRENT, reason: `price ${mins.toFixed(0)}m old` };
  if (mins <= 90) return { status: S.DEGRADED, reason: `price ${mins.toFixed(0)}m old — too old for a BUY` };
  return { status: S.STALE, reason: `price ${(mins / 60).toFixed(1)}h old` };
}

// SPORTSBOOK CONSENSUS. Captured at forecast seal; comparisons against Kalshi need both sides close
// enough in time. Consequence: beyond the window, market-value conclusions are blocked (the forecast
// itself remains sealed and valid — it is the COMPARISON that goes stale).
function consensusStatus({ snapshotTs, now = Date.now() }) {
  if (!snapshotTs) return { status: S.WAITING, reason: "no consensus snapshot" };
  const h = age(snapshotTs, now);
  if (h <= 6) return { status: S.CURRENT, reason: `consensus ${h.toFixed(1)}h old` };
  if (h <= 24) return { status: S.DEGRADED, reason: `consensus ${h.toFixed(1)}h old` };
  return { status: S.STALE, reason: `consensus ${(h / 24).toFixed(1)}d old` };
}

// HISTORICAL TRANSCRIPTS/STATS: context, tolerant of age, but never represented as current.
function historicalStatus({ newestTs }) {
  if (!newestTs) return { status: S.WAITING, reason: "no historical data" };
  return { status: S.NOT_APPLICABLE, reason: "historical context — age-tolerant, never labeled current" };
}

// Has the event begun? (First bell 22:00 UTC on the event date — same convention as dispatch.js.)
// Consequence: pre-fight discovery, intel alerts and betting messages stop. NOTE: 22:00 is a FIXED
// convention; real cards start at different times (prelims can begin hours earlier). This is a fallback
// only — the live-status check below is the reliable lock; keep both (OR them) so betting never unlocks.
function fightStarted(eventDate, now = Date.now()) {
  const bell = Date.parse(`${eventDate}T22:00:00Z`);
  return Number.isFinite(bell) && now >= bell;
}

const MONTHS_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
// The KXUFCFIGHT ticker-date for an eventDate: "2026-07-25" -> "26JUL25" (reverse of dispatch's parser).
function tickerDateFor(eventDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(eventDate || ""));
  return m ? `${m[1].slice(2)}${MONTHS_ABBR[Number(m[2]) - 1]}${m[3]}` : null;
}

// Is the card LIVE right now? TRUE once fights are underway: the event day has arrived AND some bout on
// the card has left the tradeable set — status no longer "active"/"open" (resolving/determined/finalized/
// settled/closed). Reads REAL Kalshi status, so unlike the 22:00 bell it holds no matter when the card
// starts (fight day varies), and it locks the WHOLE card once the first result lands — the "betting off a
// market moving on fight day" accident. The event-day guard is essential: a bout can resolve WEEKS early
// (a cancellation or fighter swap finalizes its market), and that is NOT the card starting — without it,
// one scratched prelim would falsely lock an entire upcoming card. `markets` is the KXUFCFIGHT series list
// (all statuses). Fail-closed inputs (no markets / unparseable date) return false, so it only ever ADDS a
// lock, never removes one.
function cardIsLive(markets, eventDate, now = Date.now()) {
  const td = tickerDateFor(eventDate);
  if (!td || !Array.isArray(markets)) return false;
  const eventStart = Date.parse(`${eventDate}T00:00:00Z`);
  if (Number.isFinite(eventStart) && now < eventStart) return false;   // before the event day: early cancellations don't count
  const prefix = `KXUFCFIGHT-${td}`;
  return markets.some((m) => m && typeof m.ticker === "string" && m.ticker.startsWith(prefix)
    && m.status !== "active" && m.status !== "open");
}

module.exports = { S, corpusStatus, marketPriceStatus, consensusStatus, historicalStatus, fightStarted, tickerDateFor, cardIsLive };
