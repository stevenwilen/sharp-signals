// FIGHT INTELLIGENCE → TELEGRAM. Turns one lifecycle record + its run context into ONE message, or a
// short state-change update, or nothing. This is the layer that keeps §6 (combine, don't spam), §7
// (alert only on material change; thread updates under the original), and §10 (a bet still passes the
// mechanical invariants — uncertain intel loosens the EVIDENCE threshold, never the price gate).
//
// It speaks HUMAN. No internal topic slug, no lane name, no origin-taxonomy jargon reaches the phone —
// those live on the dashboard. The assessment is stated once, in plain words.
require("./env");
const TM = require("./telegram-messages");
const MI = require("./message-invariants");
const I = require("./intelligence");

const c = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}¢`);
const A = I.ACTION_STATUS, S = I.TRUTH_STATUS, ACCESS = I.ACCESS;

const STATUS_PHRASE = {
  CONFIRMED: "Confirmed", LIKELY_TRUE: "Likely true", PLAUSIBLE: "Plausible", UNCERTAIN: "Uncertain",
  CONFLICTING: "Conflicting reports", LIKELY_FALSE: "Likely false", DISPROVED: "Disproved",
  STALE: "Stale", WIDELY_KNOWN: "Widely known", PROBABLY_ALREADY_PRICED: "Probably already priced",
};

// "Plausible, 1 access-relevant origin" — status + how many genuinely independent origins, and whether
// any of them plausibly has direct access. Never the raw topic slug or kind names.
function assessmentLine(record) {
  const n = Number.isFinite(record.independentOrigins) ? record.independentOrigins : 0;
  const access = [ACCESS.FIRSTHAND, ACCESS.INSIDER_REPORT].includes(record.accessRelevance) ? "access-relevant" : "relevant";
  return `${STATUS_PHRASE[record.truthStatus] || record.truthStatus}, ${n} ${access} origin${n === 1 ? "" : "s"}`;
}
// The plain claim, no slug. What was reported, in words a human reads.
function reportLine(record) {
  return record.claim || record.rawWording || "an uncertain fight report";
}
function forecastImpactLine(ctx) {
  const pts = ctx.forecastImpactPoints || 0;
  if (Math.abs(pts) < I.MATERIAL) return "None yet";
  return `${ctx.helps || "the favored side"} ${pts > 0 ? "+" : ""}${(pts * 100).toFixed(1)} points`;
}
function marketReactionLine(ctx) {
  const m = ctx.marketReaction;
  if (!m || !m.moved) return "No meaningful move";
  return `${m.subject ? m.subject + " " : ""}${c(m.beforeAsk)} → ${c(m.afterAsk)}`;
}

// (§7) SHOULD THIS STATE CHANGE ALERT? Alert on a material change only; never after the fight begins;
// never when nothing changed. `prev` is the record BEFORE this run (or null on first sight).
function shouldAlert(prev, record, ctx = {}) {
  if (ctx.fightStarted || ctx.marketSuspendedFinal) return { alert: false, reason: "fight has begun / market settled — no further alerts" };
  // Never alert on non-material lifecycle stages.
  if ([A.IGNORE, A.DASHBOARD_ONLY].includes(record.actionStatus)) return { alert: false, reason: "dashboard-only, no phone interruption" };
  if (!prev) return { alert: true, reason: "first material sighting" };
  if (prev.actionStatus !== record.actionStatus) return { alert: true, reason: `action ${prev.actionStatus} → ${record.actionStatus}` };
  if (prev.truthStatus !== record.truthStatus) return { alert: true, reason: `status ${prev.truthStatus} → ${record.truthStatus}` };
  const po = prev.independentOrigins || 0, no = record.independentOrigins || 0;
  if (no !== po) return { alert: true, reason: `origins ${po} → ${no}` };
  // an access-relevant origin newly appears
  if ([ACCESS.FIRSTHAND, ACCESS.INSIDER_REPORT].includes(record.accessRelevance) && ![ACCESS.FIRSTHAND, ACCESS.INSIDER_REPORT].includes(prev.accessRelevance))
    return { alert: true, reason: "an access-relevant source appeared" };
  return { alert: false, reason: "nothing material changed since the last message" };
}

// BUILD THE MESSAGE for a record given its action + context. Returns:
//   { text, threadKind, verdict? }  — text null means "no Telegram" (dashboard only / ignored).
// ctx (all optional): forecastImpactPoints, helps, marketReaction, bankroll, dashboard, and for a bet:
//   bet = { recommendedSide, fighterA, fighterB, buyLine, stake, ask, allInPrice,
//           maximumAcceptablePrice, centralProb, rangeLow, rangeHigh, centralEV, conservativeEV }
function buildIntelMessage(record, ctx = {}) {
  const bankroll = ctx.bankroll || 100;
  const recommendedFirst = ctx.recommendedFirst || record.fight;
  const dashboard = ctx.dashboard;

  switch (record.actionStatus) {
    case A.SPECULATIVE_BET: {
      // §10: a bet still runs the mechanical invariants. Uncertain intel loosened the evidence gate to
      // get here; it may NOT bypass the price/side/consistency checks.
      const bet = ctx.bet || {};
      const evalResult = MI.evaluateRecommendation({
        recommendedSide: bet.recommendedSide, fighterA: bet.fighterA, fighterB: bet.fighterB,
        centralProb: bet.centralProb, rangeLow: bet.rangeLow, rangeHigh: bet.rangeHigh,
        ask: bet.ask, allInPrice: bet.allInPrice, maximumAcceptablePrice: bet.maximumAcceptablePrice,
        centralEV: bet.centralEV, conservativeEV: bet.conservativeEV,
      });
      if (evalResult.verdict === "FAIL_CLOSED")
        return { text: null, threadKind: "FAIL_CLOSED", verdict: evalResult.verdict, violations: evalResult.violations };
      if (evalResult.verdict === "PRICE_TOO_HIGH")
        return {
          text: TM.intelUpdate({ kind: "PRICED_OUT", fight: recommendedFirst,
            detail: `Current ${c(bet.ask)} is above the maximum ${c(bet.maximumAcceptablePrice)}.`,
            whatToDo: `Wait for ${c(bet.maximumAcceptablePrice)} or lower.` }),
          threadKind: "PRICED_OUT", verdict: evalResult.verdict,
        };
      return {
        text: TM.speculativeIntelBet({
          stake: bet.stake, bankroll, recommendedFirst, buyLine: bet.buyLine,
          reportLine: reportLine(record), assessmentLine: assessmentLine(record),
          forecastImpactLine: forecastImpactLine(ctx),
          ask: bet.ask, maximumAcceptablePrice: bet.maximumAcceptablePrice,
          whyMatters: ctx.whyMatters, mainRisk: ctx.mainRisk || "The report is not officially confirmed.",
          dashboard,
        }),
        threadKind: "SPECULATIVE_BET", verdict: "BUY",
      };
    }
    case A.WATCH:
    case A.FORECAST_UPDATED:
      return {
        text: TM.fightIntelWatch({
          fight: record.fight, reportLine: reportLine(record), assessmentLine: assessmentLine(record),
          forecastImpactLine: forecastImpactLine(ctx), marketReactionLine: marketReactionLine(ctx),
          dashboard,
        }),
        threadKind: "WATCH",
      };
    case A.MARKET_ALREADY_MOVED:
      return {
        text: TM.intelUpdate({ kind: "MARKET_MOVED", fight: record.fight,
          detail: `The report gained support, but the price already moved: ${marketReactionLine(ctx)}.`,
          whatToDo: "No remaining value. Do not chase." }),
        threadKind: "MARKET_MOVED",
      };
    case A.REPORT_CONFIRMED:
      return {
        text: TM.intelUpdate({ kind: "CONFIRMED", fight: record.fight,
          detail: `Now confirmed: ${reportLine(record)}`, previousStatus: ctx.previousActionLabel,
          systemAction: record.reportType === I.REPORT_TYPE.EVENT_STATUS ? "Fight market suspended. No bet." : "Forecast updated where applicable." }),
        threadKind: "CONFIRMED",
      };
    case A.REPORT_DISPROVED:
      return {
        text: TM.intelUpdate({ kind: "DISPROVED", fight: record.fight,
          detail: `The report was disproved: ${reportLine(record)}`,
          systemAction: "Any related forecast impact and recommendation are withdrawn." }),
        threadKind: "DISPROVED",
      };
    case A.POSITION_WITHDRAWN:
      return {
        text: TM.intelUpdate({ kind: "WITHDRAWN", fight: recommendedFirst,
          detail: ctx.reason ? `Reason: ${ctx.reason}` : "The prior recommendation is no longer valid.",
          whatToDo: "Do not place the previous recommendation." }),
        threadKind: "WITHDRAWN",
      };
    case A.HUMAN_ACTION_REQUIRED:
      return {
        text: TM.intelUpdate({ kind: "MARKET_MOVED", fight: record.fight,
          detail: ctx.inaccessible ? `Could not resolve automatically: ${ctx.inaccessible}` : "A material source could not be reached automatically.",
          whatToDo: "Manual check needed." }),
        threadKind: "HUMAN_ACTION_REQUIRED",
      };
    default:
      return { text: null, threadKind: null };   // DASHBOARD_ONLY / IGNORE — no Telegram
  }
}

module.exports = { buildIntelMessage, shouldAlert, assessmentLine, reportLine, forecastImpactLine, marketReactionLine, STATUS_PHRASE };
