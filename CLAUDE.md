# SharpSignals — for Claude Code sessions

UFC prediction research, **re-pointed 2026-08-09 from an "educated gambler" that placed sized bets to a
CONFIDENCE ENGINE.** The operator no longer wants the machine to size bets or chase a market edge — they
place their own bets on Kalshi and control the stakes. All the system does now is answer, for each fight
on the card, **who wins and how confident we should be** — a rank-weighted consensus of the UFC channels
they don't have time to watch. No prices, no bet sizes, no profit/loss, no Telegram.

**It does not try to beat the market.** A consensus of good analysts mostly agrees with the betting
favourite, and that is fine — it is a "who wins" aid the operator uses to decide their own bets (and to
build parlays), not an edge. The old market-beating machinery is gone; do not re-add it.

## What this system is now

- **Scrape → rank-weighted consensus → calibrated confidence.** Discovery pulls fight-week videos →
  extraction turns them into each channel's explicit pick per fight (`data/picks/*.json`) → the confidence
  engine tallies who each ranked channel picked, weighted by the channel's track record, and calibrates the
  consensus into an honest win-%.
- **The output is one file per card:** `data/card-confidence-<date>.json` — per fight: the pick, a
  calibrated `confidencePct`, a tier `label` (STRONG/LEAN/SLIGHT/TOSS-UP/UNDER-COVERED/NO-READ), `coverage`
  (how many ranked channels), the `why` (reasons the pick wins) + an honest `counterpoint`, and the `who`
  (the ranked channels behind it, with their tier). `run-confidence.js` writes it; the dashboard renders it.
- **Channel weight = track record.** `lib/channel-weights.js` turns the graded record
  (`data/sources_graded.json`) into a per-channel weight (tier A/B/C/D, shrunk by sample). Honest: below
  tier A the edge signal is mostly noise, so weights are coarse and a thin sample can never dominate.
- **Calibration is fitted to outcomes.** `lib/confidence-calibration.js` shrinks the consensus share to a
  real win-% (a lopsided but thinly-covered read is NOT "certain"; capped at 0.85). `run-fit-calibration.js`
  rebuilds past cards' consensus, looks up who actually won (Kalshi, read-only), fits the shrink slope, and
  writes `data/confidence-history.json` — the calibration scoreboard that REPLACED profit/loss.
- **The dashboard is the ONLY surface.** Separate Next.js repo `sharp-signals-dashboard`, reads `data/*.json`
  from GitHub raw. It shows the per-fight confidence (%, tier, coverage, why, who), a parlay helper (true
  combined odds), the calibration scoreboard, and a health card (is it running + next fight time). No
  Telegram, no notifications — the operator looks when they want.
- **Trading does not exist, and neither does bet sizing.** There is no Kalshi write call. `lib/arming.js`
  `assertNoTradingPath()` throws if `createOrder`/`placeOrder`/`submitOrder`/`cancelOrder` ever appear.
  **Do not add one, and do not re-add stake sizing** — the operator sizes their own bets.

## The confidence engine (the heart of it)

- `lib/confidence.js` — per bout, a rank-weighted consensus over the whole pick corpus (windowed to the
  card so a fighter's PRIOR fights don't leak in). Picks are matched to bouts by a fuzzy surname-PAIR match
  (`del Valle`/`Delvalle` joins; the pair disambiguates two same-surname fights on one card) so a pick is
  neither dropped nor mis-joined. Yields pick + share + coverage; refuses (NO-READ) when nothing covers it.
- `lib/channel-weights.js` — the weighting, from the graded track record (not a tunable config).
- `lib/confidence-calibration.js` — share → honest win-%, fitted when there are ≥40 graded fights.
- `dispatch.js` runs `run-confidence.js` on the forecast cadence (the `confidence` stage, formerly
  `alerts`); the grade stage refits calibration. The forecast pipeline still runs — the confidence engine
  reads its sealed bouts + `evidence-eval-<date>.json` (for the `why`). `config/exploration-rules.json`
  still feeds the forecast's creative read; it no longer sizes anything.

## What was torn out (do not re-add)

- **Bet sizing, bankroll, settlement, P&L** — manual-bankroll, bankrolls, settle-grader, contract-value,
  the entertainment/exploration SIZING, apply/confirm-placement. The operator sizes bets themselves now.
- **The entire Telegram layer** — notify, notification, telegram-messages, the daily report, the fight-day
  sentinel, the intel lifecycle. The system sends nothing; the dashboard is the only output.
- **The market-beating machinery** — CLV/closing-line grading as a driver, the priced-out gate. The market
  is not even a sanity check anymore; confidence comes purely from the ranked consensus.
- **Paper Strategy + Research portfolio + Combo engine + the laptop dashboard** — deleted earlier, stay gone.

## Things that have gone wrong here before

Read these before writing code; each cost real time.

- **Pick→bout name matching.** The confidence engine joins a channel's pick to a card bout by a fuzzy
  surname-**PAIR** match (`lib/confidence.js` `whichSide`). Two real traps: (1) both names can drift —
  "Yair del Valle" (channel) vs "Yadier Delvalle" (forecast) — so a naive surname compare DROPS the pick;
  the `surnameEq` substring test catches it. (2) The card can list two same-surname fights (Ty **Miller** vs
  Goff AND Juliana **Miller** vs Oliveira); a single-name match would collide, so the PAIR is required. Do
  not loosen it to a single-name match, and keep `surnameEq` fuzzy.
- **Confidence must never over-promise.** A lopsided consensus among FEW channels is not high confidence.
  `lib/confidence-calibration.js` shrinks the share by coverage and caps at 0.85, and the tier label tracks
  the calibrated %, not the raw share. If you touch calibration, keep the coverage shrink + the cap, and
  check `data/confidence-history.json` — a "%" has to mean "won ~that often".
- **Window the pick corpus.** `gatherAllPicks` scans the WHOLE corpus but filters picks to a window around
  the card. Without it, a fighter's PRIOR-fight picks (a rematch, or a coincidental same-surname pair months
  back) leak into this card's consensus. Keep the window.
- **Rebase-race on data files.** The cloud commits `data/` every run. A local commit that stages data
  files (`git add -A`) conflicts on every rebase. Commit CODE only; `git checkout origin/main -- data/`
  before pushing (data files the confidence engine writes — `card-confidence-*`, `confidence-history` — are
  regenerated by the cloud, so let it own them).
- **The 22:00 bell was a guess.** Cards run at different times; the health card's "next fight" uses Kalshi's
  `occurrence_datetime` (`dispatch-receipts.lastCard.startTime`), falling back to 22:00 only if absent.

## Still-open cleanup (the re-point is functionally done; this is tidying)

- **`sources_graded.json` (the channel ranking the weights read) can go stale.** It is refreshed by the
  grading path; if the weights look wrong, check its `fittedAt`/recency and that grading is running.
- **Vestigial bet-sizing in `lib/exploration.js`** (`classifyAndSize`, `applyExposureCaps`) is dead — the
  forecast uses only `creativeAdjustment`/`creativeCentral`. Safe to trim; leave the read-synthesis alone.
- The transcript/evidence cache (`data/transcripts`, `data/evidence`) is committed on purpose to keep
  cloud runs cheap; it CANNOT be gitignored without forcing re-extraction every run.

## House style

- Tests assert **refusals**, not just happy paths (`test/test-*.js`); keep them green.
- A script that exits 0 without producing its artifact is a **failure**.
- Comments explain the constraint or the bug that forced the code, never what the next line does.
- Report outcomes faithfully. If it found nothing, say it found nothing. If a bet is a gamble, say so.
