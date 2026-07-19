// COMPACT TELEGRAM NOTIFICATIONS — opt-in via COMPACT_NOTIFICATIONS=1. OFF BY DEFAULT.
//
// The dashboard is the canonical interface. When compact notifications are ON, Telegram stops carrying
// the full reasoning / prices / stakes / bankroll / intel write-ups and instead sends a short
// "something you might act on changed — open the dashboard" ping. The detailed artifacts are still
// computed, sealed and shown on the dashboard exactly as before; only the PHONE PRESENTATION changes.
//
// THIS LAYER NEVER DECIDES WHETHER SOMETHING CHANGED. The existing dedup ledgers already do that —
// alert-ledger-v2 (buy/price/withdrawal), combo-audit lastSentKey (combo), intel telegramLineage +
// shouldAlert (intel) — so an unchanged / duplicate / timestamp-only / health-only state still sends
// NOTHING, exactly as before. This layer only decides, for a change the caller ALREADY chose to act on,
// whether it PUSHES (and with what short text) or is DASHBOARD-ONLY (suppressed from the phone).
//
// OFF BY DEFAULT so the live armed alert path is byte-for-byte unchanged until the operator opts in.
// This is the same reversible-flag pattern the repo already uses for FIGHT_INTEL_SEND / COMBO_SEND.
require("./env");
const TM = require("./telegram-messages");

function compactEnabled() { return process.env.COMPACT_NOTIFICATIONS === "1"; }

const dashboardUrl = () => String(process.env.DASHBOARD_URL || "").trim();
const openLine = () => (dashboardUrl() ? `Open: ${dashboardUrl()}` : "Open Sharp Signals to review.");

// One short line per change kind. `null` = DASHBOARD-ONLY: shown on the dashboard, the phone is not
// interrupted. A kind ABSENT from this table is UNKNOWN and (fail toward delivery) sends the caller's
// full message rather than being silently dropped — dropping a real alert is the one outcome an
// alerting layer may never risk.
const SPECS = {
  // --- push · single recommendation (verdicts + intel bet threadKinds) ---
  BUY:                  { icon: "🟢", line: "New recommendation available." },
  SPECULATIVE_BET:      { icon: "🟢", line: "New recommendation available." },
  PRICE_TOO_HIGH:       { icon: "🟡", line: "A recommendation changed — now priced too high." },
  PRICED_OUT:           { icon: "🟡", line: "A recommendation changed — now priced too high." },
  WITHDRAWN:            { icon: "🔴", line: "A recommendation was withdrawn." },
  // --- push · combo ---
  COMBO_BUY:            { icon: "🟠", line: "A combo bet is available." },
  COMBO_PRICE_TOO_HIGH: { icon: "🟡", line: "The combo changed — now priced too high." },
  COMBO_WITHDRAWN:      { icon: "🔴", line: "The combo was withdrawn." },
  // --- push · lifecycle / health ---
  FIGHT_STARTED:        { icon: "⚪", line: "A fight has started — recommendations are locked." },
  SETTLED:              { icon: "⚪", line: "A result settled." },
  DEGRADATION:          { icon: "⚠️", line: "System issue — data may be delayed." },
  RECOMMENDATION_CHANGED: { icon: "🟡", line: "A recommendation changed — review it on the dashboard." },
  // --- dashboard-only · NO phone push (intel forecast-movement + legacy human-review news) ---
  WATCH: null, FORECAST_UPDATED: null, MARKET_MOVED: null,
  CONFIRMED: null, DISPROVED: null, HUMAN_ACTION_REQUIRED: null, HUMAN_REVIEW: null,
};

// The compact text for a change kind, or null if the kind is DASHBOARD-ONLY or unknown. Every emitted
// notification is run through the confidence-scalar guard, so a notification can never carry the one
// thing the phone channel forbids.
function compact(kind) {
  const spec = SPECS[kind];
  if (!spec) return null;
  const text = `${spec.icon} Sharp Signals Updated\n${spec.line}\n${openLine()}`;
  TM.assertNoConfidenceScore(text);
  return text;
}

// Routing for a caller holding a FULL message and a change kind. Returns the text to actually send, or
// null to SUPPRESS (dashboard-only). Legacy mode returns the full message unchanged. An unknown kind
// FAILS TOWARD DELIVERY (returns the full message) rather than dropping a real alert.
function forSend(fullText, kind) {
  if (!compactEnabled()) return fullText;
  if (!(kind in SPECS)) return fullText;   // unknown -> send the caller's original, never drop
  if (SPECS[kind] === null) return null;   // dashboard-only -> suppress the phone push
  return compact(kind);
}

// A record that has ALREADY pushed a bet to the phone must never have a later material change silently
// suppressed — a stand-down on a position the human was told to place is the one alert that may not be
// dropped (the exact failure lib/alert-ledger-v2.js exists to prevent). So when such a record reaches an
// otherwise DASHBOARD-ONLY lifecycle kind, it is PROMOTED to the closest push instead of suppressed:
// a disproval / confirmed-suspension reads as a withdrawal; a market move / manual-check / re-watch reads
// as "the recommendation changed — look".
const POST_BET_OVERRIDE = {
  DISPROVED: "WITHDRAWN", CONFIRMED: "WITHDRAWN",
  MARKET_MOVED: "RECOMMENDATION_CHANGED", HUMAN_ACTION_REQUIRED: "RECOMMENDATION_CHANGED",
  WATCH: "RECOMMENDATION_CHANGED", FORECAST_UPDATED: "RECOMMENDATION_CHANGED",
};

// Intel-lifecycle routing. `droveBet` = this record has already pushed a SPECULATIVE_BET to the phone.
// Legacy mode is an unchanged pass-through. Compact mode promotes a post-bet dashboard-only kind to a
// push so a stand-down is never dropped; otherwise it behaves exactly like forSend.
function forSendIntel(fullText, threadKind, droveBet) {
  if (!compactEnabled()) return fullText;
  if (droveBet && Object.prototype.hasOwnProperty.call(POST_BET_OVERRIDE, threadKind)) return compact(POST_BET_OVERRIDE[threadKind]);
  return forSend(fullText, threadKind);
}

// Degradation / health / error notices ALWAYS push (never dashboard-only): compact when enabled, else
// the caller's original text.
function degrade(fullText) {
  return compactEnabled() ? compact("DEGRADATION") : fullText;
}

module.exports = { compactEnabled, compact, forSend, forSendIntel, degrade, openLine, SPECS, POST_BET_OVERRIDE };
