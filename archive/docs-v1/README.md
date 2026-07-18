# Sharp Signals — edge-research on Kalshi (UFC + World Cup)

Finds trades where a **proven-sharp voice disagrees with the market**. It tracks
credible predictors, scores who actually *beats the Kalshi line* (not just
"who's usually right"), and surfaces markets where a trusted voice's probability
diverges from the current price. You act on the signals — it doesn't trade.

Graded strategy domains: **UFC/MMA** (`card.js`) and **Boxing** (`boxing.js`) — both
structurally inefficient (emotional crowds, thin sharps, real insider edge; incl.
influencer-boxing cards). **World Cup** (`worldcup.js`) is kept as an opportunistic
viewer only — soccer markets are too efficient to grade voices against. The adapter +
grading engine are domain-agnostic; adding a domain = a series ticker + a source roster.

Series tickers: UFC `KXUFCFIGHT` · Boxing `KXBOXING` · WC winner `KXMENWORLDCUP` · WC match `KXWCGAME`.
Discover more inefficient domains with `node domains.js`.

## Status
| Piece | State |
|---|---|
| **Kalshi market adapter** (`lib/kalshi.js`) | ✅ live |
| Viewers: `card.js` (UFC), `boxing.js`, `worldcup.js` | ✅ live |
| Source roster (`sources.json`) — MMA + Boxing | ✅ seeded |
| **Grading engine** (`lib/grade.js`) — beat-the-line + shrinkage | ✅ built + tested |
| **Matcher** (`lib/match.js`) — pick → live Kalshi market | ✅ built + tested |
| **Extractor** (`lib/extractor.js`) — posts → picks | ✅ built (needs `GEMINI_API_KEY` **free**, or Claude) |
| **Social pull** (`lib/sources.js`) — X + YouTube | ✅ built (needs feed keys) |
| **Pipeline** (`pipeline.js`) + **dashboard** (`server.js`) | ✅ built + tested (mock) |

The whole pipeline runs today with `--mock` (proves grade→match→signal against live
Kalshi prices). Add keys to `.env` and the same pipeline runs on real social data.

## Run it
```bash
node pipeline.js --mock   # full pipeline, no keys — grades sources + live signals
node server.js            # dashboard at http://localhost:4400 (Demo button = mock)
node pipeline.js          # LIVE (needs keys in .env)
```
Every stage prints ✅ / ⛔ so you always see which keys unlock what.

## The market layer works now (no key, no money)
```bash
cd ~/sharp-signals
node card.js 26JUL18     # live Kalshi win probabilities for the July 18 card
node probe.js            # list UFC events + markets
```
Live host is `api.elections.kalshi.com` (the docs' `api.kalshi.com` doesn't resolve).
Implied probability = mid of each fighter's YES order book.

## Architecture
1. **Listen** — pull posts/transcripts from `sources.json` handles (X, YouTube, podcasts).
2. **Extract** — Claude turns each into a structured pick: {fighter, confidence, timestamp}.
3. **Grade** — for each past pick, compare the result AND the Kalshi price at the time:
   - **edge vs line** (the metric that matters), **Brier** calibration, **sample size**
   - shrinkage toward baseline so small samples don't crown anyone
   - a source becomes `trusted` only after beating the line out-of-sample.
4. **Match** — map a fresh pick to its Kalshi market (adapter does this).
5. **Rank** — surface `trusted voice × price gap`, ranked by edge, into the dashboard.

## Keys (see `.env.example`)
- Market reads: **none** (public).
- Research layer: a Twitter/X data key + YouTube key + Claude key.
- Trading (optional, later): Kalshi API key — build on the **demo sandbox** first.

## Next step
Wire the extractor + grading engine once the social + Claude keys are in `.env`.
Then a first graded signal pass on the July 18 Du Plessis–Usman card.
