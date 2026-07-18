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
// Consequence: pre-fight discovery, intel alerts and betting messages stop.
function fightStarted(eventDate, now = Date.now()) {
  const bell = Date.parse(`${eventDate}T22:00:00Z`);
  return Number.isFinite(bell) && now >= bell;
}

module.exports = { S, corpusStatus, marketPriceStatus, consensusStatus, historicalStatus, fightStarted };
