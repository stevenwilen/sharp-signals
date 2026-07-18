---
description: Verify a HUMAN REVIEW alert (unverified fight news) against real sources and count independent origins
---

You are verifying an unverified claim that this repo's pipeline surfaced from a YouTube preview
transcript. The alert is below.

## Your job is to find sources. It is not to decide a bet.

You have the repo, so you can run the injection and the forecast yourself. **The gates still apply
and they are in the code, not in your judgement.** Do not compute a stake, suggest a size, or tell
the operator to buy. If asked, decline: you have no forecast, no calibration and no fee model, and
this repo already contains a system that does have those and has said NO BET on everything.

## Read this first — it changes what you are looking for

The pipeline does not care whether you believe the claim. It counts **independent origins**:

- 2 origins → MINOR · 3 → MODERATE · 5 → MAJOR · **1 origin → moves the forecast by exactly zero**

So the useful work is finding **genuinely separate people who know this**, not deciding how
convincing it sounds. That is the entire job.

**Ten outlets citing one reporter is ONE origin.** MMA Junkie, ESPN and Sherdog all writing "per
Ariel Helwani" is one origin called `helwani` with three amplifiers. A search will naturally hand
you the same story ten times and it will look like corroboration. It is not, and the injector will
catch it and count 1 — so inflating it wastes both our time.

## Steps

1. **Check the market first.** It is the cheapest answer and it usually settles the matter:
   ```
   node -e 'const k=require("./lib/kalshi");const E=require("./lib/evidence-eval");(async()=>{const ms=await k.marketsAll({series_ticker:"KXUFCFIGHT",status:"open"});const hit=ms.filter(m=>/FIGHTER/i.test(m.yes_sub_title||""));console.log(hit.length?hit.map(m=>m.ticker+" ask="+m.yes_ask_dollars).join("\n"):"NOT LISTED");})()'
   ```
   - **Bout gone from Kalshi and the sportsbook board** → the market already acted. There is nothing
     to bet on. Kalshi's own rules: cancelled or rescheduled >2 weeks → *resolves to a fair price*;
     postponed inside two weeks → *the market waits*. Being right pays nothing. Say so and stop.
   - **Still listed at a normal price days later** → the market has seen this and disagrees, or it is
     false. Say which.
2. **Search for primary sources.** UFC announcements, the promotion, the athletic commission, then
   established reporters (Helwani, Okamoto, MMA Junkie, MMA Fighting). Aggregators and fan accounts
   are weak; a screenshot of a screenshot is nothing.
3. **Check every date.** A withdrawal report about a *previous* booking of the same two fighters is
   identical in wording to a current one. This is the easiest way to be confidently wrong.
4. **Look for the disconfirming version.** If a fighter is reported out, search specifically for
   evidence they are still in — a fight-week appearance, a weigh-in, a fresh promo. Absence of a
   denial is not confirmation.
5. **Trace each source to its origin.** For every article, ask: who actually knew this? That name is
   the `origin`, not the outlet.

## Then report, in this order

**VERDICT** — `CONFIRMED` / `LIKELY TRUE` / `CONTRADICTED` / `STALE` / `UNVERIFIABLE`.
`UNVERIFIABLE` is a good answer and I expect it often. Do not upgrade it to fill silence.

**MARKET STATE** — listed or not, at what price, what the settlement rules mean for it.

**ORIGINS** — how many genuinely independent, named. Show your reasoning where outlets collapse into
one origin.

**EVIDENCE** — quotes, links, dates. If you found nothing, say nothing.

**WHAT WOULD CHANGE IT** — the specific thing you'd need to see.

## If and only if CONFIRMED or LIKELY TRUE

Write the block to `/c/tmp/verified-block.json` and run the injector in **dry run** (no `--write`):

```bash
node run-inject-verified.js data/evidence-eval-<CARD>.json /c/tmp/verified-block.json --seal=<ISO>
```

Block shape — `origin` is who KNEW it, not who printed it. Do not include an `origins` count; it is
ignored and the injector counts from what you actually supply. A source without a real URL and a real
quote is discarded:

```json
[{
  "boutId": "<from the alert>",
  "about": "<fighter the claim is about>",
  "opponent": "<other fighter>",
  "claim": "<one sentence>",
  "topic": "<from the alert>",
  "direction": "against_about",
  "verdict": "CONFIRMED",
  "sources": [
    { "outlet": "MMA Fighting", "origin": "okamoto", "url": "https://...", "quote": "<actual words>", "publishedAt": "2026-07-14T10:00:00Z" }
  ]
}]
```

Show the operator what the dry run said — especially the counted origin number and what it clears.
**Then stop and ask** before `--write`. If it counted 1 origin, say plainly that this moves the
forecast by zero and there is nothing further to do.

## If they say go

```bash
node run-inject-verified.js data/evidence-eval-<CARD>.json /c/tmp/verified-block.json --seal=<ISO> --write
node run-forecast.js data/evidence-eval-<CARD>.with-verified.json --seal=<ISO> --live
node run-entertainment-alerts.js data/forecast-<CARD>.json --eval=data/evidence-eval-<CARD>.with-verified.json
```

Report what the forecast did and what the gates decided. **If it still says NO BET, that is the
answer** — do not go looking for a way around it. If it produces a buy instruction, the operator
places it manually; you have no order path and this repo has none.

---

The alert to verify:

$ARGUMENTS
