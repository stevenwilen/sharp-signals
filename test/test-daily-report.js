// DAILY REPORT — refusal-first. The verdict must REFUSE "HEALTHY" whenever an expected stage did not run,
// an artifact is stale, a source failed silently, or required data is missing. Missing data can only ever
// LOWER the status, never raise it. The day window must be timezone-correct so yesterday's work is excluded.
const DR = require("../lib/daily-report");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const NOW = Date.parse("2026-07-21T23:30:00-04:00");   // 23:30 America/New_York
const tz = "America/New_York";
const reportDate = "2026-07-21";
const ago = (h) => new Date(NOW - h * 3.6e6).toISOString();   // h hours before "now" (same ET day if h small)

function base(over = {}) {
  return {
    now: NOW, tz, reportDate, cardActive: true, expectedRunsToday: 138,
    receipts: { lastCard: { eventId: "UFC-2026-07-25", eventDate: "2026-07-25" },
      collect: { ranAt: ago(1), card: "UFC-2026-07-25" }, forecast: { ranAt: ago(1), card: "UFC-2026-07-25" }, alerts: { ranAt: ago(1) } },
    forecast: { sealedAt: ago(1), forecasts: [] },
    intelligence: { updatedAt: ago(1), records: {
      a: { firstSeenAt: ago(2), independentOrigins: 2, amplifierCount: 1, actionStatus: "DASHBOARD_ONLY", boutId: "B01",
        forecastImpact: { lane: "exploration", verificationStatus: "VERIFIED" }, truthStatus: "UNCERTAIN", contradictions: [], actionHistory: [] } } },
    entertainment: { ranAt: ago(1), decisions: [{ classification: "NO BET" }], buyInstructions: [], delivery: { delivered: 0 } },
    bankrolls: { real: { realizedPnl: 0, openExposure: 0 } },
    manualBankroll: { bankroll: 100, entries: {} },
    candidateIndex: { channelsTotal: 70, newestSourceTs: ago(3), liveUnreadable: 0, corpusFreshness: { status: "CURRENT" } },
    coverage: null,
    cardEvidence: { builtAt: ago(1), integrity: { droppedVideos: [] }, selection: { videos: [1, 2, 3] } },
    alertLedger: {},
    geminiUsage: { rows: [{ at: ago(2), ok: true, inputTokens: 100, outputTokens: 50, estCostUsd: 0.001 }] },
    runs: [{ conclusion: "success", createdAt: ago(1) }],
    telegramSends: 0,
    ...over,
  };
}
const status = (over) => DR.buildReport(base(over)).status;

// 1. A clean, fresh, fully-present day on an active card is HEALTHY.
ok(status() === "SYSTEM HEALTHY", "1. fresh + complete + on-cadence -> SYSTEM HEALTHY");

// 2. MISSING required data is a refusal, never a pass.
ok(status({ bankrolls: null }) === "SYSTEM FAILED", "2. missing bankrolls -> FAILED (missing data refuses HEALTHY)");
ok(status({ receipts: null }) === "SYSTEM FAILED", "2b. missing dispatch-receipts -> FAILED");

// 3. An expected stage that did not run today = FAILED (active card).
ok(status({ receipts: { lastCard: { eventId: "X", eventDate: "2026-07-25" },
  collect: { ranAt: ago(30) }, forecast: { ranAt: ago(1) } } }) === "SYSTEM FAILED", "3. collect did not run today -> FAILED");

// 4. A stale artifact refuses HEALTHY (DEGRADED).
ok(status({ forecast: { sealedAt: ago(10) } }) === "SYSTEM DEGRADED", "4. stale forecast (10h) -> DEGRADED");
ok(status({ intelligence: { updatedAt: ago(9), records: {} } }) === "SYSTEM DEGRADED", "4b. stale intelligence -> DEGRADED");

// 5. A silently-failing source refuses HEALTHY.
ok(status({ candidateIndex: { channelsTotal: 70, newestSourceTs: ago(3), liveUnreadable: 4, corpusFreshness: { status: "CURRENT" } } })
  === "SYSTEM DEGRADED", "5. unreadable source files -> DEGRADED");
ok(status({ cardEvidence: { builtAt: ago(1), integrity: { droppedVideos: [{ videoId: "x" }] }, selection: { videos: [1] } } })
  === "SYSTEM DEGRADED", "5b. dropped/failed transcript -> DEGRADED");
ok(status({ coverage: { ranAt: ago(1), quotaAborted: true, boutsSearched: 2, totalIngested: 0, discoveredChannels: {} } })
  === "SYSTEM DEGRADED", "5c. coverage quota abort (silent source failure) -> DEGRADED");

// 6. Gemini: all-failed is an outage (FAILED); some-failed is DEGRADED.
ok(status({ geminiUsage: { rows: [{ at: ago(2), ok: false, error: "x" }, { at: ago(2), ok: false, error: "y" }] } })
  === "SYSTEM FAILED", "6. every Gemini call failed -> FAILED (extraction outage)");
ok(status({ geminiUsage: { rows: [{ at: ago(2), ok: true }, { at: ago(2), ok: false, error: "y" }] } })
  === "SYSTEM DEGRADED", "6b. some Gemini calls failed -> DEGRADED");

// 7. Failed workflow runs today refuse HEALTHY.
ok(status({ runs: [{ conclusion: "success", createdAt: ago(1) }, { conclusion: "failure", createdAt: ago(1) }] })
  === "SYSTEM DEGRADED", "7. a failed workflow run today -> DEGRADED");

// 8. TIMEZONE day window: an intel claim from the PREVIOUS ET day is not counted as today's.
{
  const r = DR.buildReport(base({ intelligence: { updatedAt: ago(1), records: {
    a: { firstSeenAt: ago(2), independentOrigins: 1, amplifierCount: 0, actionStatus: "DASHBOARD_ONLY", boutId: "B01", forecastImpact: {}, truthStatus: "UNCERTAIN", contradictions: [], actionHistory: [] },
    b: { firstSeenAt: ago(30), independentOrigins: 9, amplifierCount: 0, actionStatus: "DASHBOARD_ONLY", boutId: "B02", forecastImpact: {}, truthStatus: "UNCERTAIN", contradictions: [], actionHistory: [] } } } }));
  ok(r.sections.fightIntelligence.intelligenceClaimsCreated === 1, "8. yesterday's claim excluded from today's count (TZ day window)");
}

// 9. No active card: idleness (collect not running) is EXPECTED, not a failure.
ok(status({ cardActive: false, receipts: { lastCard: { eventId: "X", eventDate: "2026-07-11" }, collect: { ranAt: ago(200) }, forecast: { ranAt: ago(200) } } })
  !== "SYSTEM FAILED", "9. no active card -> not FAILED for an idle pipeline");

// 10. Slim STATUS: the phone shows status + next fight + bankroll ONLY. The full sections still live in
// the report JSON (the dashboard) — they just don't crowd Telegram anymore.
{
  const msg = DR.formatTelegram(DR.buildReport(base()));
  ok(/🩺 DAILY STATUS/.test(msg), "10. headline is the slim DAILY STATUS");
  ok(/SYSTEM (HEALTHY|DEGRADED|FAILED)/.test(msg), "10b. shows the one-word health verdict");
  ok(/🥊 Next fight:/.test(msg) && /💵 Bankroll/.test(msg), "10c. shows the next-fight and bankroll lines");
  ok(!/PICKS & SIGNALS|TODAY'S VERDICT|SYSTEM QUALITY|SOURCE COLLECTION/.test(msg), "10d. verbose sections are NOT on the phone");
  ok(/bets? found today/.test(msg), "10e. shows how many bets were found today");
  ok(!/undefined|NaN/.test(msg), "10f. no undefined/NaN leaked into the message");
}
// 10g. With a card scheduled, the next-fight line names it and shows the approx bell.
{
  const b = base(); b.card = { eventId: "UFC-2026-08-01", eventDate: "2026-08-01", bellMs: Date.parse("2026-08-01T22:00:00Z") };
  const msg = DR.formatTelegram(DR.buildReport(b));
  ok(/Next fight: UFC-2026-08-01 — 2026-08-01/.test(msg) && /first bell ~22:00 UTC/.test(msg), "10g. next-fight names the card + approx bell");
}

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
