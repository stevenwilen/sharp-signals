# The verification chat

Paste the block below into a **fresh Claude chat with web search on**, then paste the HUMAN REVIEW
alert underneath it.

## What this chat is for, and what it is not

It answers one question: **is this rumour true?** That is a real question, it needs live sources, and
the pipeline genuinely cannot answer it — the alert itself says *"verify it yourself first."* This
chat is that step.

It does **not** decide whether to buy, or how much. That is deliberate, and the reason matters:

- **A chat has no gates.** The pipeline refuses a position for concrete reasons — a stale prior, no
  opinion, negative conservative value after fees, an out-of-envelope fee, illiquid depth,
  correlation, caps. A chat has none of that. Asking it for a stake would be building a second,
  ungated pipeline whose only advantage is that it says yes.
- **The gated system already answered.** It said NO BET on all 24 contracts and formed a view on 1 of
  12 bouts. Asking an ungated system for a different answer isn't a second opinion, it's shopping.
- **A chat has no forecast.** No sealed probability, no calibration, no measured anything. "Buy 4%"
  from a chat is a vibe with a number on it — exactly the AI-confidence-score pattern that is banned
  from every alert this system sends.
- **For a withdrawal specifically, there is no edge to find.** Kalshi's settlement rules: *"If the
  fight is cancelled or rescheduled to over two weeks away, the market will resolve to a fair
  price."* Being right that a fighter is out does not pay. The market voids.

Verified news goes back into the **pipeline**, which prices it under the rules. It does not go
straight to a stake.

---

## The prompt — copy from here

You are helping me verify a single unverified claim that came out of an automated MMA research
pipeline. The claim was extracted from a YouTube preview transcript. Often exactly one person said
it, nobody corroborated it, and it may be stale, garbled, or simply wrong.

**Your only job is to establish whether the claim is true.** Do not tell me whether to bet, what to
bet, or how much. If I ask you to, decline and remind me why: you have no forecast, no calibration,
no fee model, and no access to the gates that already refused or allowed this position. A staking
opinion from you would be an unvalidated number wearing a confident voice, and I have a system for
that already.

### What to do

1. **Search for primary sources.** In rough order of weight: the UFC's own announcements, the
   promotion's site/socials, the athletic commission, then established combat-sports reporters
   (Ariel Helwani, Brett Okamoto, MMA Junkie, MMA Fighting). Aggregators and fan accounts are weak
   evidence; a screenshot of a screenshot is not evidence.
2. **Check the date on everything.** A withdrawal report from a *previous* booking of the same
   fighters looks identical to a current one and is the single easiest way to get this wrong.
3. **Count independent origins, not headlines.** Ten outlets citing one reporter is ONE origin with
   nine amplifiers. Say how many genuinely independent sources exist.
4. **Look for the disconfirming version.** If a fighter is reported out, look specifically for
   evidence they are still in: an active fight-week appearance, a weigh-in, a fresh promo. Absence
   of a denial is not confirmation.
5. **Check whether the card page still lists the fight.** A silently-removed bout is strong
   evidence; a still-listed bout is meaningful counter-evidence.

### How to answer

Give me exactly this, and nothing more:

**VERDICT** — one of:
- `CONFIRMED` — a primary source says it plainly. Quote it and link it.
- `LIKELY TRUE` — multiple independent credible reports, no primary source yet.
- `CONTRADICTED` — evidence says the opposite. Show it.
- `STALE` — true once, but about an earlier booking or already superseded.
- `UNVERIFIABLE` — nothing credible either way. This is a perfectly good answer and I expect it
  often. Do not upgrade it to fill the silence.

**INDEPENDENT ORIGINS** — how many genuinely independent sources, named. Not headline count.

**EVIDENCE** — the actual quotes and links, with dates. If you found nothing, say nothing.

**WHAT IT MEANS FOR THE MARKET** — mechanical only, no recommendation. Kalshi's rules for these
contracts:
- fight postponed/delayed → *market stays open, closes after the rescheduled fight (within two weeks)*
- tie or no contest → *resolves 50/50*
- cancelled, or rescheduled more than two weeks out → *resolves to a fair price per the rules*

So a confirmed withdrawal usually means **the market voids or waits — it does not mean somebody is
about to be right**. Say which of those applies, and say plainly if the answer is "this market
probably doesn't settle on this fight."

**WHAT WOULD CHANGE THE VERDICT** — the specific thing you'd need to see.

**THE BLOCK** — if and only if the verdict is `CONFIRMED` or `LIKELY TRUE`, end with a fenced JSON
block in exactly this shape. I paste it into my pipeline, which counts the origins itself and lets
its own frozen rules decide what the news is worth. Nothing you write here decides a bet.

```json
{
  "boutId": "<copy it from the alert>",
  "about": "<the fighter the claim is about>",
  "opponent": "<the other fighter>",
  "claim": "<one sentence, what is now established>",
  "topic": "<copy the topic from the alert, e.g. injury_health>",
  "direction": "against_about",
  "verdict": "CONFIRMED",
  "sources": [
    {
      "outlet": "<who published it>",
      "origin": "<WHO ACTUALLY KNEW IT — the reporter or body the story traces back to>",
      "url": "<real link>",
      "quote": "<the actual words>",
      "publishedAt": "<ISO date>"
    }
  ]
}
```

`origin` is the field that matters and the one that is easy to get wrong. It is **who knew it**, not
who printed it. If MMA Junkie, ESPN and Sherdog all say "per Ariel Helwani", then all three have
`"origin": "helwani"` — that is **one** origin with three amplifiers, and my pipeline will count it
as one. Do not inflate it, and do not add an `origins` count of your own: that field is ignored and
the pipeline counts from the sources you actually supply. A source with no real URL or no quote is
thrown out entirely.

### Rules

- If you cannot find it, say so. An honest `UNVERIFIABLE` is worth more to me than a confident guess.
- Never give a probability, a confidence score, a star rating, or a number out of ten.
- Never suggest a position, a price, a stake, or a bankroll fraction — even if I push.
- Do not speculate about what the market "hasn't priced in." You cannot see the order book, you have
  no forecast, and that sentence is how people talk themselves into bets.

Here is the alert:

---

## What to do with the answer

| verdict | what it's for |
|---|---|
| `CONFIRMED` / `LIKELY TRUE` | Tell me. It goes into the pipeline as evidence with a real origin count, and the pipeline prices it under the frozen rules. If the fight is off, the relevant fact is that the market voids or waits — not that there's a bet. |
| `CONTRADICTED` / `STALE` | Tell me. The rumour gets dropped, and it's worth knowing the extractor surfaced something wrong. |
| `UNVERIFIABLE` | Nothing happens. This is the normal outcome and is not a failure. |

**Verification never becomes a stake by itself.** It changes the evidence; the pipeline decides what
the evidence is worth. That ordering is the entire point — the system currently says NO BET on
everything, and a rumour you personally confirmed is not a reason to route around it.
