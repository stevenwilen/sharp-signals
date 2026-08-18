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
- **`evidenceBalance` + `watchFor` + `liveWatchProtocol` (2026-08-17)** — the operator WATCHES the fights,
  and sees things the corpus cannot. `evidenceBalance.oneSided` flags a read where nobody argued the other
  side (UFC 330's 92% Njokuani/Alvarez had four reasons FOR and an empty counterpoint, and lost);
  `watchFor` turns each counter-claim into an observable cue via a fixed topic→cue table; the card-level
  `liveWatchProtocol` carries the standing checks the pick corpus structurally cannot supply. **None of
  it feeds a confidence number and none of it mentions stakes or trading** — it exists so what the
  operator sees live has something concrete to be checked against.
- **Channel weight = track record.** `lib/channel-weights.js` turns the graded record
  (`data/sources_graded.json`) into a per-channel weight (tier A/B/C/D, shrunk by sample). Honest: below
  tier A the edge signal is mostly noise, so weights are coarse and a thin sample can never dominate.
  The record is rebuilt by `run-grade-channels.js` after every settled card (2026-08-17): a channel is
  scored on **edge vs the FIELD** — `mean(won - fieldShare)`, where fieldShare is the share of the OTHER
  channels on that fight who took the same side (`lib/channel-grade.js`). Echoing the crowd scores 0;
  being wrong about an obvious favourite is expensive. Bounded to [-1,+1], so no single lucky longshot
  can buy a tier the way ROI-vs-the-line once did. **Tier A is currently EMPTY and that is the correct
  answer** — a tier requires the whole confidence interval to clear the field, and nobody's does.
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
  `alerts`). The **grade stage does three things, and all three are now wired**: grade the forecast
  (`run-grade-card`), re-rank the channels (`run-grade-channels`), refit the calibration
  (`run-fit-calibration`). The forecast pipeline still runs — the confidence engine reads its sealed
  bouts + `evidence-eval-<date>.json` (for the `why`). `config/exploration-rules.json` still feeds the
  forecast's creative read; it no longer sizes anything.
- `data/channel-results.json` is the **outcome ledger**: every settled fight, who won, and which side
  each channel took. It exists because Kalshi only serves ~2 months of settled markets — grading off
  that window alone caps everyone below the tier bar forever. Append-only; votes stored raw so shares
  are recomputed (and improve) as coverage grows. Do not regenerate it from scratch, and do not gitignore
  it — it IS the channel history now.

## What was torn out (do not re-add)

- **Bet sizing, bankroll, settlement, P&L** — manual-bankroll, bankrolls, settle-grader, contract-value,
  the entertainment/exploration SIZING, apply/confirm-placement. The operator sizes bets themselves now.
- **The entire Telegram layer** — notify, notification, telegram-messages, the daily report, the fight-day
  sentinel, the intel lifecycle. The system sends nothing; the dashboard is the only output.
- **The market-beating machinery** — CLV/closing-line grading as a driver, the priced-out gate. The market
  is not even a sanity check anymore; confidence comes purely from the ranked consensus.
- **Paper Strategy + Research portfolio + Combo engine + the laptop dashboard** — deleted earlier, stay gone.
  The laptop dashboard (`server.js` on localhost:4400) went in `89069e57`; its launcher `Start-Dashboard.cmd`
  and crash log lingered as gitignored local files until 2026-08-17. There is ONE dashboard: the web app.

## Things that have gone wrong here before

Read these before writing code; each cost real time.

- **Pick→bout name matching.** The confidence engine joins a channel's pick to a card bout by a fuzzy
  surname-**PAIR** match (`lib/confidence.js` `whichSide`). Two real traps: (1) both names can drift —
  "Yair del Valle" (channel) vs "Yadier Delvalle" (forecast) — so a naive surname compare DROPS the pick;
  the `surnameEq` substring test catches it. (2) The card can list two same-surname fights (Ty **Miller** vs
  Goff AND Juliana **Miller** vs Oliveira); a single-name match would collide, so the PAIR is required. Do
  not loosen it to a single-name match, and keep `surnameEq` fuzzy.
- **Confidence must never over-promise.** A lopsided consensus among FEW channels is not high confidence.
  `lib/confidence-calibration.js` shrinks the share by coverage and caps at 0.92, and the tier label tracks
  the calibrated %, not the raw share. If you touch calibration, keep the coverage shrink + the cap, and
  check `data/confidence-history.json` — a "%" has to mean "won ~that often".
- **The scoreboard must show every read.** The bucket table in `run-fit-calibration.js` once ended at
  `[70, 86)`, written when the cap was 0.85. Raising the cap to 0.92 left 24 of 71 graded reads — the
  ENTIRE high-confidence band — in no bucket at all, still counted in `accuracy`/`brier` but invisible
  on the dashboard, exactly where the operator most needs to check the number. The top bucket is now
  open-ended and an invariant exits 1 if any read falls outside the table. Do not close it again.
- **Never score a card with weights that already know how it ended.** `run-fit-calibration.js` rebuilds
  each past card with the channel weights as of THAT card (`CG.rowsFromLedger({before})` →
  `W.buildFrom` → `C.buildCard(date, {weights})`). Grading a channel on a fight and then scoring its
  vote on that same fight inflates the scoreboard by ~1-4 points and is how this project has twice
  convinced itself of an edge it did not have. `confidence-history.evaluation` records how many cards
  were genuinely walk-forward — if it ever says `mixed`, the headline accuracy is flattered.
- **The corpus is nearly blind to intangibles, and pretending otherwise is the trap.** Across 1,700
  evaluated claims on six cards, 21 were tagged `psychological` (~1%). A technically better favourite who
  fights reluctantly — too much respect, no urgency, countering instead of initiating — is invisible to a
  consensus of pre-fight breakdowns. Do NOT try to model it from the transcripts; the signal is not there.
  The answer is `watchFor`/`liveWatchProtocol`: hand the operator the falsifiers so their own eyes do the
  part the corpus cannot. Never let that path leak into `confidencePct`.
- **Kalshi's KXUFCFIGHT series is not only UFC cards.** Dana White's Contender Series sits in the same
  series: a 5-fight Tuesday prospect showcase that essentially no prediction channel previews. The
  dispatcher takes the SOONEST open card, so on 2026-08-18 it took DWCS, `make-card-selection` correctly
  found 0 qualifying videos and exited fatally, and every run went red for six hours while the REAL card
  four days out got no forecast at all (the dispatcher only works one card at a time) and the dashboard
  showed an empty board because `lastCard` pointed at a card that would never have a confidence file.
  Selection now exits **4** for "no coverage" (distinct from 2 = a real fault); the dispatcher records the
  card in `receipts.uncoverableCards`, rolls `lastCard` back, and stands down green. The next cycle skips
  it (`pickActiveCard`) and moves on. Do NOT special-case DWCS by name — the rule is that this system
  reads cards its channels talk about, and coverage is measured, not assumed.
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

- The transcript/evidence cache (`data/transcripts`, `data/evidence`) is committed on purpose to keep
  cloud runs cheap; it CANNOT be gitignored without forcing re-extraction every run.
- `data/predictions.json` (11k market-priced rows from the old backfill) is now read ONCE, for outcomes
  only, to bootstrap the ledger. Nothing writes it. Once the ledger has a couple more cards it is inert
  history and can go.
- The channel record has ~630 covered fights but effN tops out around 240 after recency weighting, and
  **no channel has a positive `edgeLcb`** — nobody has proven they beat the field. Do not "fix" this by
  loosening the tier bar; it is the finding, not a bug.

## Done 2026-08-17 (the unfinished wiring)

The re-point left three loops open. All three are closed; do not reopen them.

- **The grade stage never re-ranked the channels.** `sources_graded.json` was last written 2026-07-16 by
  a deleted backfill, so six settled cards (including a 6/10 one) changed no weights. `run-grade-channels.js`
  now runs in the grade stage. The old ROI-vs-the-line grading is gone with `lib/grade.js`.
- **The scoreboard hid the top confidence band** (see the bucket note above).
- **Nothing ran the tests.** There was no runner and no CI step — "keep them green" was unenforced.
  `npm test` (`test/run-all.js`) runs all 31 files in ~30s with no keys, and the workflow gates on it.

Deleted as dead in the same pass (all verified to have zero live dependents): `holdout.js`, `prune.js`,
`regrade.js`, `regrade-close.js`, `verify-fees.js`, `domains.js`, `worldcup.js`, and `lib/`
`grade` `sizing` `portfolio` `positions` `message-invariants` `pick-ledger` `mock` `history` `sources`
`contracts` `scenarios` `scenarios-ranked`. Also trimmed: `classifyAndSize`/`applyExposureCaps` from
`lib/exploration.js`, and every torn-out env var from the workflow (TELEGRAM_*, BANKROLL,
SHARP_PRODUCTION, FIGHT_INTEL_*, DAILY_REPORT_*, PRICE_WATCH_ENABLED, GH_TOKEN, TWITTERAPI_KEY) — a
Variable left behind for a system that no longer exists reads as a live feature flag.

## House style

- Tests assert **refusals**, not just happy paths (`test/test-*.js`); keep them green.
- A script that exits 0 without producing its artifact is a **failure**.
- Comments explain the constraint or the bug that forced the code, never what the next line does.
- Report outcomes faithfully. If it found nothing, say it found nothing. If a bet is a gamble, say so.
