# SharpSignals — for Claude Code sessions

UFC betting research. **It has never demonstrated a predictive edge.** The one evaluation that showed
one is void (contaminated baseline — it compared a backdated closing line to itself). Everything here
is built so that fact stays visible rather than getting sanded off.

## What this repo may and may not do

- **Alerts: ARMED.** Telegram sends manual instructions a human types into Kalshi themselves.
- **Trading: does not exist.** There is no Kalshi write call. `lib/kalshi.js` exports `orderbook`,
  which reads. `lib/arming.js` `assertNoTradingPath()` throws if `createOrder`/`placeOrder`/
  `submitOrder`/`cancelOrder` ever appear. **Do not add one.** `TRADING_ENABLED: false` is
  documentation, not a switch — flipping it changes nothing because nothing reads it to place an
  order.
- **Numerical rules are frozen at v7.0.0.** Do not tune them. Especially do not tune them because a
  card produced no bets.

## The rule that governs everything

**Origins, not voices.** Ten channels repeating one injury rumour is ONE origin with ten amplifiers,
not ten confirmations. The magnitude rules key on independent origin count: 2 → MINOR, 3 → MODERATE,
5 → MAJOR, **1 → moves the forecast by exactly zero**. This is the rule most likely to be violated by
accident, because search results and YouTube channels both naturally return the same story many times.

## Current state, so you don't rediscover it

- The system says **NO BET on everything** and applies an adjustment on ~1 of 12 bouts. That is the
  system working, not a bug. Do not go looking for a way around it.
- The binding constraint is **evidence**, not baselines or fees: ~4 videos across 13 bouts, ~47
  claims. Live multi-book baselines and the fee model are solved.
- Fees are **verified in scope only**: KXUFCFIGHT, YES side, single-price taker, price 0.59–0.89,
  size 3.28–823.81 contracts, as of 2026-07-16. Maker, NO, multi-fill and other series fail closed.
- The V1 guru track-record board is **archived research, not a signal** — a 24-month backfill graded
  12,597 picks and found no source with an edge that generalises.

## Things that have gone wrong here before

Read these before writing code; each cost real time and two of them were the same bug twice.

- **A synthetic timestamp.** A closing line stamped `sealTs - 2h` passed the leakage guard because the
  guard checked the fabricated time. Never invent a timestamp. Absence is the truthful value.
- **A hash computed before its lineage.** `supersedes` attached *after* hashing, so the hash could not
  cover it. Happened in Phase 7, then I repeated it in Phase 8. Hash last, over everything.
- **A denominator incremented without rechecking the numerator.** A provenance string said
  "round-half-up fits 1/5" when it fit 2/5; later "2/7" when it fit 4/7. Both shipped to callers.
  Recompute tallies, never edit them by hand.
- **A gate that failed open.** Every check truthiness-guarded, so a missing field skipped its check and
  returned "verified". Missing data must be a refusal.
- **A deny-list of one string.** `treatment === "maker"` refused exactly `"maker"`; `"Maker"`,
  `"limit"`, `"post_only"` all priced at the taker rate. Allowlist, don't deny-list.
- **Dead config.** `makerRate: 0.0` sat in the fee object and `tradingFee` never read it, so maker
  orders were charged the full taker rate while the config looked handled.
- **A tool that couldn't catch its own case.** `verify-fees.js` scored maker examples against the taker
  formula, and its one maker guard was unreachable.
- **Git Bash path mangling.** `--live-event=/events/x` arrives as `C:/Program Files/Git/events/x`. A
  shell artifact that looked exactly like a data outage.

## Verifying news

`/verify-news` — paste a HUMAN REVIEW alert. (Named to avoid colliding with Claude Code's built-in `verify` skill, which verifies code changes.) It searches for real sources, counts origins (not headlines),
and runs `run-inject-verified.js` in dry run. Verification **adds** origins; it cannot assert them.
A block declaring `"origins": 5` is ignored and counted from the sources actually supplied.

Check the market first: if the bout is gone from Kalshi and the sportsbook board, the market already
acted and there is nothing to bet on. Kalshi's rules — cancelled or rescheduled >2 weeks → *resolves
to a fair price*. Being right about a withdrawal pays nothing.

## House style

- Tests assert **refusals**, not just happy paths. 792 across 11 suites; keep them green.
- A script that exits 0 without producing its artifact is a **failure**.
- Comments explain the constraint or the bug that forced the code, never what the next line does.
- Report outcomes faithfully. If it found nothing, say it found nothing.
