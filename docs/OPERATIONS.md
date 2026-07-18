# Operations

## Active workflows

| Workflow | Schedule | Role |
|---|---|---|
| **unified-v2.yml** | hourly (`:05`) + manual | THE production dispatcher (`dispatch.js`): decides due stages and runs the full V2 collect→forecast→decide→alert→grade chain. The only armed decision path. |
| **fight-day-sentinel.yml** | Fri/Sat 20:00 & 23:00 UTC + manual | 15-min wall-clock price + shadow-intel loop inside one long job (reuses `run-entertainment-alerts.js`). |
| **listing-watch.yml** | every 30 min (`:10/:40`) + manual | Records Kalshi birth-price/convergence (`listing-watch.json`). Research only; never bets. |
| **pipeline.yml** | hourly + manual | V1 **sensing** layer: YouTube discovery + transcript fetch that feeds V2's evidence cache. Its daily paper-summary Telegram is OFF by default (`V1_PAPER_SUMMARY=1` to opt in). Archived paper research, no buy alert. |
| **watch.yml** | **manual only** (cron disabled) | V1 paper-book settlement pass. Feeds V2 nothing. |
| **backfill.yml** | **manual only** (cron disabled) | Re-grades the rejected guru corpus and writes `data/predictions.json` (V2's candidate-video universe). Do **not** re-enable the schedule. |

## Production variables (GitHub repo variables)

| Variable | Meaning | Current |
|---|---|---|
| `SHARP_PRODUCTION` | the single env gate that lets the armed mouth actually send | `1` |
| `EXPLORATION_ENABLED` | creative exploration lane on | `1` |
| `FIGHT_INTEL_ENABLED` | fight-intelligence lifecycle on (records + dashboard) | `1` |
| `FIGHT_INTEL_SEND` | promote intel lifecycle to production Telegram (else shadow) | `1` |
| `INTEL_WEB_SEARCH` | grounded-Gemini web research in the researcher | unset (off) |
| `BANKROLL` | V1 paper-summary display only (not the real $100 bankroll) | as set |

**Required secrets** (in `.env` locally, GitHub Secrets in cloud; never committed): `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`, `YOUTUBE_API_KEY`, `BLOTATO_API_KEY`, `TWITTERAPI_KEY`, plus the
read-only Kalshi keys. See `.env.example`.

## The arming model

Telegram sends require, together: `ALERTS_ARMED` (committed) **&&** a valid machine attestation matching
the active card + sealHash **&&** `SHARP_PRODUCTION=1` **&&** all message invariants pass **&&**
`assertNoTradingPath()`. No env var can create a Kalshi write path — the read-only guarantee is
independent of all configuration.

## Common tasks

- **Confirm a manually placed position:** `node run-confirm-placement.js confirm <ticker> --price=<0..1> --stake=<$>`
  (only this moves an entry into real-bankroll P&L). List with `node run-confirm-placement.js list`.
- **Quarantine a position:** `node run-quarantine-positions.js` (excludes it from performance + learning).
- **Investigate a private/inaccessible source (optional fallback):** `/verify-news`, then
  `node run-inject-verified.js <evidence-eval.json> <block.json> --seal=<ISO>` (dry run first). **Not
  needed in normal operation** — the cloud researches routine reports automatically.
- **Verify the fee model:** `node verify-fees.js`.
- **Disable Telegram:** set repo variable `SHARP_PRODUCTION` empty (the whole armed mouth goes silent),
  or `FIGHT_INTEL_SEND` empty (intel lifecycle returns to shadow; the old path stays off).
- **Put exploration in shadow / off:** set `FIGHT_INTEL_SEND` empty (intel records but sends nothing) or
  `EXPLORATION_ENABLED` empty (no creative adjustment).

## Rollback

A rollback tag is created before each consolidation (e.g. `rollback-2026-07-18-8558f89`). To revert:
`git checkout main && git reset --hard <tag> && git push --force-with-lease origin main` (only if truly
needed — prefer a forward revert commit). Tags are never deleted.

## Separation of money

`manual-bankroll.json` = real $100 bankroll P&L (only `MANUALLY_PLACED` entries count).
`positions.json` = paper research book ($0 real money). A Telegram recommendation is
`RECOMMENDED_NOT_CONFIRMED` until a human confirms placement — it never auto-enters real P&L.
