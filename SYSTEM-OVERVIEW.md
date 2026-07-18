# Sharp Signals — System Overview

UFC betting **research**. It has never demonstrated a predictive edge, and it is built so that fact
stays visible. It watches for uncertain fight information, forms a market-anchored forecast, compares
that forecast with live Kalshi contracts, and sends a human concise Telegram intelligence or a manual
betting instruction. **It never places a trade.**

This is the current, deployed system. Older design/phase documents live under
[archive/docs-v1/](archive/docs-v1/) and describe an earlier version — do not follow them.

## What it does

1. **Collect** new fight information — YouTube video/transcript sensing (V1 collection layer) plus the
   card's Kalshi listing.
2. **Assess & organize** it — evidence extraction (Gemini) → evaluation → leakage admission →
   information-origin vs amplifier separation → the **fight-intelligence lifecycle** (one persistent
   record per material report) with automatic collected-source research.
3. **Forecast** — a market-anchored core forecast (**frozen v7.0.0**) with a separate, capped **creative
   exploration** adjustment, plus a live multi-book sportsbook prior.
4. **Compare** the forecast with the Kalshi contracts Kalshi actually lists, through executable-price,
   fee, freshness, liquidity and settlement gates.
5. **Send** one concise Telegram message — a fight-intelligence WATCH, a combined speculative-intel bet,
   or a short confirmation/disproof/price/withdrawal update — or **nothing** (NO BET is a valid, common
   outcome). Full detail stays on the dashboard and in the sealed artifacts.
6. **Grade** forecasts, hypotheses, sources and market reactions after the fight (prospective learning).
7. **Persist** everything automatically in the cloud (git-committed `data/`).

## What reaches Telegram

Only the unified lifecycle: `🛰️ FIGHT INTEL — WATCH`, `🧪 SPECULATIVE INTEL BET`, the entertainment buy
tiers (CREATIVE $3 / STRONG $4 / BEST $5), and short updates (`REPORT CONFIRMED`, `REPORT DISPROVED`,
`MARKET ALREADY MOVED`, `PRICE TOO HIGH`, `BET AVAILABLE AGAIN`, `POSITION WITHDRAWN`, `FORECAST
SUPERSEDED`, `PIPELINE FAILURE`, `DAILY SUMMARY`). One short footer: *"For entertainment use. Manual
placement only."* No repeated methodological disclaimers.

## What it does NOT do

- **No trading.** There is no `createOrder`/`placeOrder`/`submitOrder`, no Kalshi write credentials, no
  order path anywhere. `lib/kalshi.js` refuses any non-GET/HEAD request; `lib/arming.js`
  `assertNoTradingPath()` allowlists the read-only surface and live-tests a POST refusal. Every bet is
  placed **manually by a human**.
- **No tuning.** The numerical forecasting rules, bankroll rules, evidence thresholds, fee rules and
  betting classifications are frozen. See `config/forecast-rules.json` (v7.0.0) and
  `config/bankroll.json`.

## The rules that govern everything

- **Origins, not voices.** Ten channels repeating one report are **one origin with ten amplifiers**, not
  ten confirmations. Magnitudes key on independent-origin count: 2 → MINOR, 3 → MODERATE, 5 → MAJOR,
  **1 → moves the forecast by zero** (the creative lane may make a small, capped move on one credible
  origin, kept separate from the core).
- **Fail closed.** Wrong fighter identity, wrong bout mapping, wrong contract mapping, stale or
  asynchronous prices, and post-fight information all fail closed — they never produce a forecast or a
  bet.
- **Manual only, sealed, separated.** Sealed artifacts are immutable. Paper positions, unconfirmed
  manual recommendations, and confirmed placements are kept structurally separate; a recommendation
  never enters real-bankroll P&L on its own.

## Money

A **$100 entertainment bankroll** (money the human is content to lose — not Kelly, not a validated
edge). Speculative stakes $3 / $4 / $5, capped at **$5 per fight** and **$10 per card**. All constants
live in one file, `config/bankroll.json`.

## Where to look

- **Run it / operate it:** [docs/OPERATIONS.md](docs/OPERATIONS.md)
- **How data flows:** [docs/DATA-FLOW.md](docs/DATA-FLOW.md)
- **When something breaks:** [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- **Rejected experiments (guru track record, etc.):** [docs/ARCHIVED-EXPERIMENTS.md](docs/ARCHIVED-EXPERIMENTS.md)
- **Working agreement for this repo:** [CLAUDE.md](CLAUDE.md)
