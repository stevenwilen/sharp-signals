# Sharp Signals — Handoff Brief

You are taking over an autonomous prediction-market edge system. Read this fully before touching anything.

## What it does
Finds bets where a **proven-sharp voice disagrees with the market**.

It tracks combat-sports predictors (UFC/boxing), scores who actually **beats the Kalshi line**
(not merely "who is often right"), and surfaces fights where a *trusted* voice's probability
diverges from the live Kalshi price. It does **not** place trades. It alerts a human.

**Core thesis (already validated on real data):** being right ≠ making money.
Example from the real backfill: *The MMA Guru* picks winners **68%** of the time and returns
**−1.8%** — he picks favorites the market already priced. *Dan Tom* hits **82%** and returns
**+56%** vs the line — that's genuine edge. Only the second kind matters.

## Architecture (all API-based; no local dependencies)
```
YouTube Data API  -> find each source's prediction videos
Blotato API       -> pull the video TRANSCRIPT   (the high-yield path: ~14 picks/video)
twitterapi.io     -> pull each source's tweets   (low-yield: ~3 picks per 500 tweets)
Gemini            -> transcript/tweet -> structured picks {pick, confidence, quote}
Kalshi (public)   -> settled results + candlestick price AT THE MOMENT of each call
grade.js          -> ROI vs line, recency-weighted, small-sample shrinkage -> `trusted` flag
Telegram          -> alert the human
```

## Files
| File | Role |
|---|---|
| `pipeline.js` | Live run: fresh picks -> match to Kalshi -> rank signals. **Run this on a schedule.** |
| `backfill.js` | Rebuild track records from history. Run occasionally (e.g. weekly). |
| `lib/kalshi.js` | Kalshi markets/orderbook/candlesticks. `impliedYes(ticker)` = live probability. |
| `lib/blotato.js` | Transcripts. |
| `lib/extractor.js` | Gemini extraction. |
| `lib/results.js` | Resolve a pick: did it win + what was the line when called. |
| `lib/grade.js` | The grading math (beat-the-line + shrinkage). |
| `lib/notify.js` | Telegram. |
| `sources.json` | The roster (X + YouTube). |
| `config.json` | Thresholds. |
| `server.js` | Dashboard on :4400. |

## Run
```bash
npm --version            # needs Node 18+
cp .env.example .env     # fill in keys (see below)
node backfill.js         # build track records (slow; ~40 min)
node pipeline.js         # live signals  <-- schedule this 1-2x/day
node server.js           # dashboard at http://localhost:4400
```

## Keys required (.env)
`GEMINI_API_KEY` (paid tier), `EXTRACT_MODEL=gemini-flash-latest`, `TWITTERAPI_KEY` (paid),
`YOUTUBE_API_KEY`, `BLOTATO_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

### DATA_DIR — this is how your runs update the owner's dashboard (IMPORTANT)
Results are written to `DATA_DIR`. Point it at the **shared OneDrive folder** so the owner's
dashboard (on his machine) picks up everything you produce:

```
DATA_DIR=C:\Users\<you>\OneDrive\SharpSignals-data       # native Windows
DATA_DIR=/mnt/c/Users/<you>/OneDrive/SharpSignals-data   # if you run under WSL
```

You must have that OneDrive folder synced to your PC (shared account, or "Add shortcut to My files"
from a share link). When `backfill.js` / `pipeline.js` finish, they write `sources_graded.json` and
`signals.json` there; OneDrive syncs; his dashboard auto-refreshes within ~8 seconds.

If `DATA_DIR` is unset, results go to the local `./data` folder and **the owner will never see them.**

### Telegram: add yourself as a recipient (do this FIRST)
The bot is `@claude3k_bot`. Alerts go to whoever is listed in `TELEGRAM_CHAT_ID`
(comma-separated — several people can receive them).
1. Send any message to **@claude3k_bot** from your Telegram.
2. `node chats.js` — it prints every chat id that has messaged the bot.
3. Put the id(s) in `.env`, e.g. `TELEGRAM_CHAT_ID=8906223785,<your id>`.

Without this, alerts go only to the original owner's phone and you will see nothing.

## YOUR JOB
1. Run `pipeline.js` on a schedule (daily; twice daily on fight week — cards are usually Saturday).
2. When a **trusted** source's pick diverges from the Kalshi line by >= `config.signals.minTrustedEdge`,
   **Telegram the human**: fight, source, their ROI/sample, market price vs source probability.
3. Re-run `backfill.js` weekly so track records grow as new cards resolve.
4. If something breaks, fix it and report. Do not silently degrade.

## Explicit vs implicit signals (read this)
Sharp people often reveal their view SIDEWAYS rather than saying "I pick X":
"+250 is free money", "the market is sleeping on his wrestling", "I don't see how he gets out of R2",
"he looked awful in camp". The extractor captures these as `directness: "implicit"` alongside
`"explicit"` picks, and `lib/grade.js` reports ROI for each kind **separately** (`explicit` / `implicit`
fields on every source).

**Use that to decide, empirically, whether implicit leans carry edge — do not assume.** If a source's
implicit ROI is strong, keep them. If it is noise, weight them down.

⚠️ **The failure mode is DIRECTION INVERSION.** Naive "capture implicit leans" prompting sees negative
talk ABOUT fighter A and tags A as the pick, when the author actually favours A's OPPONENT. That is worse
than missing data — it silently corrupts every track record. `DIRECTION_RULE` in `lib/extractor.js` guards
this and is verified. **Do not weaken it.** If you change the prompt, re-test with inverting examples
("his body is gone", "I don't see how he gets out of round 2") and confirm the pick is the OPPONENT.

## HARD RULES — do not violate
- **NEVER invent or upgrade a signal.** If no trusted source has an edge, report "no signals." That is a
  correct, valuable answer. The system's value is that it refuses to manufacture confidence.
- **Sample size is sacred.** A source is not sharp because of 3 lucky picks. The shrinkage + `minSampleForTrust`
  gate exists to stop that. Do NOT lower the threshold to produce results.
- **Never grade a pick made AFTER the fight.** Post-fight "recap" videos are hindsight and would fake a
  perfect record. `lib/youtube.js` excludes them (POST_RE) and `lib/results.js` requires the fight to occur
  after the pick. Do not weaken either guard.
- **Do not place trades.** Alert only. A human decides.
- **Blotato key is read-only in scope of this project.** Use it ONLY for transcripts
  (`source-resolutions-v3`). It belongs to an account with the owner's family social media connected —
  never post, publish, or touch any other Blotato endpoint.

## Known state / gaps (as of 2026-07-13)
- Track records are built on a **~2-month Kalshi window** (settled markets only go back to ~May 2026).
  Samples are therefore SMALL. Dan Tom is "trusted" on **n=17** — that is promising, **not proven**.
  Tell the human this. Raise `minSampleForTrust` as data accumulates.
- **Dan Tom is the only trusted source, and his sample cannot easily be grown.** His YouTube is dormant
  and his per-card picks are behind a **Substack paywall** — only his *tweets* are gradeable. Don't burn
  time trying to scrape him; the sample grows naturally as new cards resolve.
- Removed as YouTube sources after verification (channels are valid but publish **no prediction videos**):
  Firas Zahabi (technique only), FightCourt/Din Thomas (news), Gareth A Davies (interviews), Dan Tom (dormant).
  Do not re-add without confirming they actually post prediction videos.
- **Highest-yield sources** (they post picks for *every* card, so their samples grow fastest):
  MMA Gambling Podcast (+75% ROI on n=9), Show Me The Money, Michael Bisping, The MMA Guru.
- `pipeline.js` tweet-extraction has no progress logging (looks stalled; it isn't).
- Only the **July 18 Du Plessis vs Usman** card is currently open on Kalshi. Predictors post their picks
  during fight week (Thu/Fri), so signals appear then — not earlier.
