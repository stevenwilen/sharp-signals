Verification complete. Two of the brief's load-bearing facts are wrong, one dangerously so. Writing the deliverable.

---

# PHASE B — ARCHITECTURE

**Read this box first. I re-verified the brief against disk and it is stale in three places, one of them dangerous.**

| Brief says | Disk says (verified by execution, 2026-07-17) |
|---|---|
| "`ALERTS_ARMED` at `:465` only picks the status STRING" | **FALSE AND DANGEROUS.** `pipeline.js:465` is `if (!ALERTS_ARMED) {` — it **is** V1's buy gate. The status string is `:489`. `:471` is the alert-ledger dedup. **Design 1's instruction "delete `:32` and both readers (`:465`, `:471`)" would delete the gate, leave the `else`-body unconditional, and ARM V1's buy path** — plus delete the dedup (~18 duplicate sends/week) and leave `:489` throwing `ReferenceError`. The reviewer who caught this was right; the brief seeded the error. |
| "5-NAME DENY-LIST", "no ranAt recency", "bare truthiness on `.passed`", "never checks `.card`" | **Stale.** A concurrent session rewrote `lib/arming.js` (uncommitted). `:56 checkArmingPrerequisites(cardId)`; `:64` refuses missing cardId; `:72` card mismatch; `:77` unreadable `ranAt`; `:81` age >36h; `:82` future-dating; `:87` missing `writtenBy`. `:102-106` is an **allowlist** (`KALSHI_READ_SURFACE`) + live POST probe `:122`. `assertNoTradingPath()` returns **true**. |
| "HUMAN REVIEW permanently suppressed", "boutId misbinding sends" | **Already fixed in the working tree.** `lib/alert-ledger-v2.js` now has `review-origins-changed`/`-known`/`-claim-changed`/`-verdict-changed`. `run-entertainment-alerts.js:71` refuses `f.fight !== b.fight`; `:95` carries `claimHash`. |
| "792 across 11 suites" (CLAUDE.md:38) | **21 suites, all green.** `test-phase9` = 205/205. `npm test` still `exit 1`. |

**The single most important live fact:** `node -e "require('./lib/arming').checkArmingPrerequisites('UFC-2026-07-18')"` returns `ok:false` with **exactly one blocker** — *"the fresh-run attestation has no writtenBy"*. That one string is the only thing between this repo and a live buy instruction. **The system is failing CLOSED right now, correctly.** Any change that supplies `writtenBy` — including "ship the generator" — **arms it**. Sequence accordingly.

---

## 1. Unified architecture

One production path. Both schedulers call the same `run-stage.sh`, which calls the same production scripts a human runs locally. There is no second cloud implementation and no order path.

```
config/cards.json  (hand-maintained: eventId · eventDate · firstBellUtc)
        │                    ▲ REQUIRED. Absence is a refusal, never a 22:00Z default.
        ▼
   bin/plan.js ── due-ness ONLY (reads data/receipts/) ── ONE exported dayDelta(); both gates call it
        │
        ├────────────────────────────┬───────────────────────────────┐
        ▼                            ▼                               │
 unified-v2.yml                fight-day-sentinel.yml                │
 cron "0 * * * *"              cron "0 * * * *" (self-gates)         │
 = COARSE STARTER              = loops INSIDE one job on a real      │
 phases: OUTSIDE(24h)            15-min grid; owns the WHOLE UTC     │
   FIGHT_WEEK(24h)               fight day (00:00Z→firstBell)        │
   FINAL_48(6h)                  timeout-minutes: 350                │
   POST_CARD(firstBell+8h)                                           │
        │                            │                               │
        └────────────┬───────────────┘                               │
                     ▼                                               │
        .github/run-stage.sh   ← argv/paths only, ZERO logic ────────┘
                     │
    ┌────────────────┴──────────────────────────────────────────────┐
    ▼                                                                │
 make-card-selection.js ──► data/card-selection-DATE.json            │
    ▼                                                                │
 run-card-evidence.js ──► data/card-evidence-DATE.json               │  each stage
    │  (Gemini flash-lite; chunk cache = data/evidence/  ⚠ NO HOME)  │  followed by
    ▼                                                                │  bin/receipt.js
 run-evidence-eval.js ──► data/evidence-eval-DATE.json               │  (exit 2 if the
    │  ⚠ evidence-eval.js:84→:132 mints analyst:<channel> PER        │   artifact is
    │    CHANNEL: 5 channels on 1 rumour = 5 origins = MAJOR         │   absent/stale/
    ▼                                                                │   wrong-card)
 run-forecast.js --seal=auto --live ──► data/forecast-DATE.json      │
    │  seal = runner clock, chosen AFTER collection closes           │
    │  ⚠ leakage gate INERT: :227 computes adm, :229 forecasts raw   │
    │  contentHash :318 (SUBSET) · sealHash :329 (LAST, correct)     │
    ▼                                                                │
 run-phase7-seal.js · run-phase8-shadow.js                           │
    ▼                                                                │
 run-attest-freshness.js ──► data/attestation-<card>.json ───────────┘
    │   binds to fc.sealHash + per-stage artifactSha256 (NOT mtime)
    ▼
 run-entertainment-alerts.js   ◄── THE ONLY MOUTH
    │   armingGate(card, forecastHash) → ARM.permits(sendClass, ctx)
    ▼
 lib/notify.js  ── notify(sendClass, text)  ◄══ THE AUTHORITY LIVES HERE
    │   sendClass ∈ {BUY_INSTRUCTION, HUMAN_REVIEW, POSITION_UPDATE,
    │                DAILY_SUMMARY, PIPELINE_FAILURE(exempt)}
    ▼
  Telegram → a human reads and TYPES it into Kalshi.
             ══════════════════════════════════════
             NO WRITE PATH EXISTS. lib/kalshi.js:53 READ_METHODS={GET,HEAD};
             :55 request() is SYNC and throws on POST (verified).
             lib/arming.js:102 allowlists the export surface; :122 probes it live.

V1 (pipeline.js) — PRESERVED, MOUTH REMOVED:
  scan → extract → grade → paper positions → signals.json/pick-ledger.json/positions.json
  buildAlert() :199-213 …………… DELETED (not flagged — absent)
  :464-477 buy send ………………… DELETED AS ONE BLOCK
  :492 daily summary ………………… routed through notify(DAILY_SUMMARY, …)
  :504 failure alert ………………… routed through notify(PIPELINE_FAILURE, …)  [exempt]
```

**Why the authority is in the transport, not in a `permits()` helper.** `notify()` (`lib/notify.js:41`) has **13 call sites in 6 files** — `backfill.js:58,67,122,163,170,206,227,233`, `listing-watch.js:128`, `ping.js:6`, `pipeline.js:475,492,504`, `run-entertainment-alerts.js:255,260`. A `permits()` that only the alerts runner consults is not an authority, it is a suggestion — and "one flag in two places" is the exact defect we are removing. Changing the signature to `notify(sendClass, text)` breaks all 13 call sites, and **the broken call sites enumerate the taxonomy for you** instead of a human hand-maintaining a frozen object in a second module.

**Reuse, don't re-mint.** `lib/telegram-messages.js` already has the builders — `buyInstruction:258`, `humanReview:334`, `priceUpdate:92`, `evidenceUpdate:114`, `positionWithdrawn:135`, `noBetStatusChange:154`, `dailyShadowSummary:178`, `pipelineFailure:207` — and `run-entertainment-alerts.js:255,260` already passes the literal strings `"BUY_INSTRUCTION"`/`"HUMAN_REVIEW"` to `AL.record`. Attach the class to the builder; do not type a third taxonomy. Content guards already exist: `assertNotABettingInstruction:328`, `assertNoConfidenceScore:32`, `BETTING_WORDS:327`. Do not add `assertNoMarketLanguage`/`assertNoInstruction` synonyms in a second module — that is `treatment === "maker"` waiting to happen.

---

## 2. Data-flow map

| Stage | Script | Reads | Writes | Identity carried |
|---|---|---|---|---|
| selection | `make-card-selection.js` | Kalshi `KXUFCFIGHT` only (`lib/match.js:26,50`) | `card-selection-DATE.json` | `boutId` (positional, `lib/target-card.js:68`) |
| evidence | `run-card-evidence.js` | `data/channels.json` (73), `data/transcripts/` (7,012) | `card-evidence-DATE.json` + `data/evidence/` chunks | `boutId`, `videoId#startChar` |
| eval | `run-evidence-eval.js` | card-evidence | `evidence-eval-DATE.json` | `boutId` **+ `fight`** ✅ both present |
| forecast | `run-forecast.js` | eval + live books (`lib/sportsbook-live.js`) + Kalshi | `forecast-DATE.json` | `boutId` + `fight` + `sealHash` |
| seal/shadow | `run-phase7-seal.js`, `run-phase8-shadow.js` | forecast + eval | `phase7-*`, `phase8-shadow-*` | `fight` (phase8 `decisions[]` carry **no boutId**) |
| attest | `run-attest-freshness.js` **(new)** | all of the above | `attestation-<card>.json` | `card` + `forecastHash` + per-stage `artifactSha256` |
| alert | `run-entertainment-alerts.js` | forecast + eval + attestation + Kalshi orderbook | `entertainment-alerts-DATE.json`, `alert-ledger-v2.json` | `boutId` ⚠ + `fight` ✅ |

**Three joins that must be asserted, not assumed** (`boutId` is positional over a *filtered* array — `card.bouts[0].boutId = B01` but `forecasts[0].boutId = B02`, verified; every consumer already uses `.find()`, so the index buys only display order):

1. `run-entertainment-alerts.js:60` eval-bout ↔ forecast — **already refused at `:71`**, but the guard is `if (f && b.fight && f.fight !== b.fight)`: truthiness-guarded on `b.fight`, so a **missing** `fight` skips the check. That is CLAUDE.md's "gate that failed open", one field over. **Drop the `b.fight &&` — absence is a refusal.**
2. **The check that actually catches Holland is missing entirely:** nothing verifies the review's *subject* is in the bout. `lib/contracts.js:265-268` already does exactly this for contracts (`"contract fighter X matches neither fighter in the mapped bout"`). Lift it and apply it to `r.about`. **One comparison against existing tested code.**
3. `run-inject-verified.js:70` — a human retypes "B03" off Telegram and it writes into whatever bout that index now names.

**The ledger misbinding is real but the brief's reconstruction is not.** Disk: ledger `B01→Kevin Holland`, `B03→Kamaru Usman`, `B05→Chase Hooper`. Today's eval: `B01 = Usman vs Du Plessis` (review about Usman), `B03 = Ramirez vs Hooper` (review about Hooper). **The shift is +2, not +1** — a 13→12 collapse yields +1 and cannot produce this. Holland is on no bout of this card. No surviving artifact records the eval that produced those sends. Honest statement: *the keys are re-bound by two positions; the mechanism is unreconstructed.* Do not ship a fabricated reconstruction — that is the same species as the synthetic timestamp.

---

## 3. Schedule

**15-minute cron is impossible. This is measured, not theorised.**

| workflow | cron | expected/day | **actual/day** | landing rate |
|---|---|---|---|---|
| `watch.yml:12` | `*/15 * * * *` | 96 | 13–14 | **~14%** |
| `pipeline.yml:13` | `0 * * * *` | 24 | 8–10 | **~40%** |
| `listing-watch.yml:19` | `10,40 * * * *` | 48 | 6 | **~12%** |

At 14%, `*/15` has a mean spacing of ~100 minutes. Asking for a 15-minute price check via cron asks for something GitHub will not deliver on a public repo.

**Confound I verified and the brief did not separate:** `pipeline.yml:23`, `watch.yml:21` and `listing-watch.yml:28` **all share `concurrency: group: sharp-signals`** with `cancel-in-progress: false`. GitHub keeps exactly one *pending* run per group, so a third arrival silently cancels the pending one. `backfill.yml:45-47` has its own group and its comment already documents this lesson — it was learned once and never applied to the other three. So the 12%/14% numbers are **throttling + cancellation, inseparable from `gh run list`**. Moving `listing-watch` to its own group is a cheap, measurable experiment (it writes only `data/listing-watch.json`; `pipeline.js` writes `signals.json` + positions/ledger — disjoint). Prediction: its rate rises above 12%. If it doesn't, the loss is pure throttling.

**What replaces the 15-min cron:** cron becomes a **coarse starter with a wide acceptance window**; precision comes from *inside* a job; due-ness is computed from **receipts on disk**, not from "the cron fired". A throttled hour costs **latency, never work**.

| `d` (integer UTC-date delta) | phase | stages | period |
|---|---|---|---|
| `> 7` | OUTSIDE | selection, evidence, forecast | 24h |
| `3..7` | FIGHT_WEEK | full chain + alerts | 24h |
| `1..2` | FINAL_48 | full chain + alerts | 6h |
| `0` | **FIGHT_DAY** | **sentinel owns the whole UTC day** | 15 min |
| `< 0` **and** `now > firstBell + 8h` | POST_CARD | grade | 24h |

`due(stage) = !receipt(card,stage) || now - receipt.ranAt >= period`.

**Arithmetic** (p = 0.40/hr measured): 24h stage → P(miss) = 0.6²⁴ ≈ 5e-6. 6h stage → 0.6⁶ ≈ **4.7%**, ~1 window in 21 slips one cycle, self-correcting. Hourly → mean spacing 2.5h, unachievable → hence the sentinel.

**Five objections to the reviewed schedule design, resolved:**

1. **The 14-hour fight-day blackout.** As designed, the dispatcher exited on FIGHT_DAY while the sentinel gated on `firstBell-8h` → nothing ran 00:00Z–14:00Z on the most important day, and a 14h-stale forecast would then fail the alert's own 6h freshness bound. **Fix: the sentinel's window is the whole UTC fight day** (`todayUTC == eventDate && now < firstBell`), full chain every 4th tick, price check every tick.
2. **`d == 0` is measure-zero if `d` is a float** → the dispatcher never leaves FINAL_48 and runs the chain *concurrently* with the sentinel, with no lease. **Fix: `d` is an integer UTC-date difference from ONE exported `dayDelta()` that both gates import.** Mutual exclusion must not be an emergent property of two independently-written date arithmetics agreeing.
3. **POST_CARD graded a card still being fought.** A 22:00Z first bell ends ~04:00–05:00Z *next* UTC day; `d<0` fires at 00:00Z with the main card unresolved, then writes a receipt that suppresses the real grade for 24h. **Fix: POST_CARD starts at `firstBell + 8h`.**
4. **The hardcoded 22:00Z refusal.** `run-forecast.js:69` uses `${eventDate}T22:00:00Z` for a *tolerance*; promoting it to a `fail()` makes an invented constant load-bearing. APEX cards start ~18:00Z, international ~04:00Z → refuses every forecast, or permits sealing mid-card. **Fix: `firstBellUtc` is REQUIRED in `config/cards.json`; absence is a refusal.**
5. **Self-chaining as the continuity guarantee.** Depending on the one-pending-run rule — the same behaviour `backfill.yml:41-44` calls a bug — makes fight-day coverage hostage to undocumented queue semantics, and the failure mode is silence. **Fix: accept the 4.7%; the sentinel's abnormal exit sends an (exempt) `PIPELINE_FAILURE`. Coverage is best-effort and says so.**

**The seal, in an unattended run.** `run-forecast.js:159-167` requires `--seal=<ISO>`; a human currently picks it. **The naive cloud fix breaks every tier-A bout:** `:166` parses the seal → `:180` collects live consensus with `nowTs: Date.now()` (real, *after* the parse) → `checkBaseline` → `leakage-guard.js:75 if (at >= sealTs) throw`. A job-start seal fails with `LEAKAGE in baseline` on exactly the 9/13 tier-A bouts. **Answer: `--seal=auto` — a real instant from the runner clock, chosen once, AFTER collection closes, BEFORE forecasting.** Keep `--seal=<ISO>` for replay.

Two corrections to the reviewed patch: (a) `sealTs = Math.max(Date.now(), maxObs+1)` — the `max` branch is **unreachable** (`lib/sportsbook-live.js:289` stamps `snapshotTimestamp` from *our* receipt time, `:292` records `sourceProvided: null`), and in the only world where it fires it *launders a bad clock into the seal*. **If any observation ≥ now, REFUSE** — a quote from the future is not an observation. (b) The patch leaves `run-forecast.js:173` printing `new Date(sealTs).toISOString()` with `sealTs = null` → **`1970-01-01T00:00:00.000Z` in every cloud log**. In this repo, a log line asserting a false seal is not cosmetic.

*Latent, report-only, do not retune:* `run-forecast.js:119` gives non-`LOGICAL_OPEN` baselines `timestamp: rec.forecastTimestamp`, and `market-baseline.js:263,294` sets that `= sealTs` exactly — so `at >= sealTs` is inclusive and **a wall-clock tier-B/C baseline can never pass the guard**. Never hit because the fresh run has C=0.

---

## 4. Secret requirements

Verified from `.github/workflows/*.yml`. No new secrets. **No PAT** — `GITHUB_TOKEN` cannot trigger `workflow_dispatch`/`repository_dispatch` (GitHub's recursion guard), which is why the sentinel self-gates on its own cron instead of being launched by the dispatcher. A new long-lived credential on a **public** repo is avoidable, so it is avoided.

| Secret | Used by | Needed by V2 | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | `lib/evidence.js`, `lib/extractor.js` | evidence stage | the only metered spend |
| `EXTRACT_MODEL` | `lib/evidence.js:100,277,300` | evidence stage | default `gemini-flash-lite-latest` |
| `BLOTATO_API_KEY` | transcript fetch | evidence stage | ~0 while `data/transcripts/` stays committed |
| `YOUTUBE_API_KEY` | `lib/youtube.js` | selection stage | quota-limited discovery |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | `lib/notify.js` | alerts | the only egress |
| `TWITTERAPI_KEY` | V1 only | no | leave |
| *(none)* | Kalshi | reads unauthenticated | **`lib/kalshi.js:105 loadAuth` exists but no write path does** |

`permissions: contents: write` on both V2 workflows (git-commit persistence). Nothing else.

**Env may disarm; env may never arm.** `ALERTS_ARMED` present in `process.env` at all → blocker (broader than `run-phase9-shadow.js:41`'s `=== "true"`; state the widening deliberately). `SHARP_DISARM` must be an **allowlist of the ARMED values** (`!/^(0|false|no|)$/i`), not `=== "1"` — `SHARP_DISARM=true` failing an equality check is the `treatment === "maker"` bug in a kill switch, which is worse than no kill switch because the owner believes they hit it.

---

## 5. Persistence map

**Mechanism is `git commit → main` and nothing else.** Verified: zero `upload-artifact`, zero `download-artifact`, zero `actions/cache` across all four workflows. `.github/save-data.sh:28` does `git add -A data/` (**respects `.gitignore`**), `:39-44` rebase→abort→`exit 1` on conflict, `:57` `exit 1` after 5 pushes. It fails **loud**. Reuse it; do not invent a second persister.

| Artifact | Size | Home today | Home under this plan |
|---|---|---|---|
| `data/*.json` (signals, pick-ledger, positions, listing-watch) | — | repo commit ✅ | repo commit (V1 cloud writes these now) |
| `data/transcripts/` | 7,012 files | repo commit ✅ (`.gitignore:8-13` argues *for* it) | unchanged — this is what keeps Blotato ~0 |
| `data/picks/` | one file/video | repo commit ✅ | unchanged |
| `data/predictions.json` | ~6MB | repo commit ✅ | unchanged |
| `forecast-*`, `evidence-eval-*`, `phase7-*`, `phase8-shadow-*` | ~300KB | local git only — **V2 has never been pushed** | repo commit, once pushed |
| `data/receipts/` **(new)** | tiny | — | repo commit, one file per stage |
| `data/attestation-<card>.json` **(new)** | tiny | — | repo commit |
| `data/learning/<eventId>/<recordId>.json` **(new)** | tiny | — | repo commit, **one file per record** |
| **`data/evidence/`** | **2.5M — 36 JSON + 247 chunks** | 🔴 **`.gitignore:31` — GITIGNORED. Not in `BACKUP_MANIFEST.md`. Not backed up. One laptop disk.** | 🔴 **NO HOME. Owner decision #2.** |
| `data/bfo/`, `data/wiki/` | — | gitignored, re-fetchable ✅ | fine — genuinely reconstructible |

**The blocker the schedule cannot ship without.** `data/evidence/` is the paid Gemini extraction V2 rests on, and it is the one thing with no home *at all*. `save-data.sh:28` respects `.gitignore`, so a cloud V2 run has no chunk cache, re-pays Gemini from scratch, **and then throws the result away**. The chunk cache (`lib/evidence.js:252-270`, keyed on chunk text + prompt version) is precisely what makes re-runs free — and it never round-trips. This defeats the schedule regardless of cadence.

**One-file-per-record, never one big JSON.** `save-data.sh:6-20` says conflicts are impossible *because* `data/picks/` and `data/transcripts/` are one-file-per-video and concurrent runs add disjoint files. An NDJSON append or a single `ledger.json` re-creates the conflict that once destroyed a 5-hour backfill. The learning ledger and receipts follow the existing precedent.

**Two things that make the track record unpersistable, flagged not fixed:**
- `lib/positions.js:20` `SETTLED_KEEP_DAYS = 365` with the comment *"keep settled positions ~a year — they ARE the track record"*, and `:112-115` `prune()` **deletes them**. The file header calls it the track record and then deletes it.
- `run-phase8-shadow.js:163` writes `outcomeTracking:{closingPrice:null, settlement:null, …}` — **and `:167`/`:184` hash it**. Filling that field invalidates `contentHash` *and* `decisionHash`. **The declared plan ("to be filled by a later settlement pass") is impossible as written.** The settlement pass must write a **sidecar**, not fill the field. This is a contradiction in the current design, not a preference. And `lib/dashboard-data.js:396-398` hardcodes `settledPositions: 0` / `calibration: "not computable yet"` as literals, so building the pass would not change the dashboard anyway.

---

## 6. Cost estimate

**Assumptions — stated, and one of them needs your confirmation:**
- `AVG_TOKENS = 9000` per transcript — *measured mean*, `scope-historical.js:13`.
- 73 channels (`data/channels.json`), 7,012 cached transcripts (`data/transcripts/`).
- Per-card volume from `data/phase9-fresh-run.json`: **124 videos scanned → 11 above threshold → 4 selected**.
- Output ≈ 2,000 tokens/video.
- ⚠ **`gemini-flash-lite-latest` pricing assumed ≈ $0.10/1M input, $0.40/1M output.** The repo encodes only `GEMINI_PER_M = 0.30` for **`gemini-flash-latest`** (`scope-historical.js:14`) — a *different, dearer* model. I did not verify flash-lite's rate from the repo or the network. **Confirm before treating the numbers below as budget.** Both columns shown.

| Scenario | Input tok | Output tok | **@ flash-lite** ($0.10/$0.40) | @ flash ($0.30/$0.40) |
|---|---|---|---|---|
| One card, cold (4 videos) | 36K | 8K | **$0.007** | $0.014 |
| One card, warm chunk cache | ~0 | ~0 | **~$0.00** | ~$0.00 |
| **Per card, cloud today** (no cache: 1×/day FIGHT_WEEK + 4×/day FINAL_48 + ~10 sentinel passes) | ~0.8M | ~0.2M | **≈ $0.16** | ≈ $0.31 |
| Per month, 4 cards | — | — | **≈ $0.65** | ≈ $1.25 |
| **Full corpus rebuild, cold** (7,012 × 9K) | **63.1M** | 14.0M | **≈ $11.9** | ≈ $24.5 |

**Read the last row as the real finding.** The paid corpus that has no home is worth **~$12–25 to rebuild in Gemini spend** — cheap enough that losing it is survivable in dollars. What is *not* cheap is what the dollars don't cover: 7,012 Blotato transcript fetches (only if git is lost too — the transcripts *are* committed), a 73-channel YouTube discovery scan against quota, and the wall-clock. And per `.gitignore:8-13`, committing `data/transcripts/` is *already* the precedent for exactly this trade.

**Steady-state cost is not the problem; cache amnesia is.** With `data/evidence/` committed, near-zero after the first pass. Without it, you pay ~$0.16/card forever to regenerate something you already own — and the 15-min sentinel multiplies the re-extraction count, not the alert quality.

---

## 7. Failure behavior

**Fails CLOSED (silence is correct):**
- Arming: **today, right now** — missing `writtenBy` blocks every non-exempt send (`lib/arming.js:87`). Card mismatch (`:72`), age >36h (`:81`), future-dating (`:82`), missing cardId (`:64`).
- `assertNoTradingPath()` (`:108`) — allowlist over the export surface; **any** new export trips it, whatever it is named. Plus a live `k.request("POST","/portfolio/orders")` probe (`:122`) that must observe its own failure mode. `lib/kalshi.js:55` `request` is **deliberately not `async`** — an async throw becomes a rejected promise and the sync probe sails past it. **Keep it sync; pin it with a test.**
- `withinVerifiedEnvelope` (`lib/contracts.js:113-122`) — exact series *segment* match (`startsWith` once let `KXUFCFIGHTNIGHT` squat the prefix). Scope: `KXUFCFIGHT`/`yes`/taker/`[0.59,0.89]`/≥3.28 contracts. Everything else priced by extrapolation and says so.
- `bin/receipt.js` — artifact absent/empty/unparseable/wrong-card → exit 2.
- `bin/plan.js` on an empty or fully-past `config/cards.json` → **exit nonzero**, never "nothing due".
- Missing `firstBellUtc` → refusal, never a 22:00Z default.
- `save-data.sh:39-44` rebase conflict → `exit 1`, never a guess about which side to keep.

**Fails LOUD (must reach the human):**
- `PIPELINE_FAILURE` — the **only** exempt class. `EXEMPT = [PIPELINE_FAILURE]`. **Cut `HEARTBEAT`**: grep shows the only "heartbeat" in the repo is `FORCE_HEARTBEAT` (`pipeline.js:486`, an env override on the summary window) and a comment in `pipeline.yml:47`. There is no heartbeat message and no heartbeat sender. Inventing an exempt class with no caller — one that by construction `SHARP_DISARM` cannot stop — is a permanent hole waiting for a caller.
- An order path appearing must be a **blocker string inside a `PIPELINE_FAILURE`**, not an uncaught throw. Today `run-entertainment-alerts.js:46` throws out of `armingGate()` and `main().catch` prints to a machine nobody is watching. The discovery "an order path appeared" must not be the thing that kills the messenger.
- Sentinel: 3 consecutive price-check failures → exit nonzero. Abnormal exit → `PIPELINE_FAILURE`.
- Any stage exiting 0 without its artifact → receipt exit 2 → job fails (house style).

**⚠ The exempt lane's content guard must REDACT, not throw — verified by execution.** Design 1 proposed `assertNoMarketLanguage` as an `assert*` on the exempt path. I ran the repo's existing equivalent:

```
TM.pipelineFailure({stage:'kalshi snapshot', why:'orderbook fetch failed for KXUFCFIGHT: no price returned'})
  → BETTING_WORDS (lib/telegram-messages.js:327) MATCHES on "price"
  → assertNotABettingInstruction THREW
```

So the guard fires *precisely* when the failure is a market-data failure — this pipeline's most likely failure. `pipeline.js:504` sends an arbitrary `e.message`. A content guard that throws on the exempt lane **destroys the failure alert**, which is the one outcome exemption exists to prevent. **`sendExempt` must catch its own guard, fall back to a fixed safe template (`"Sharp Signals: a run failed; see the logs"`), and send that.** Never let the content guard silence the failure alert.

**Must never fail silently — and four things currently do:**

| Defect | Verified at | Status |
|---|---|---|
| Leakage gate is **inert** — `adm` computed, only `adm.rejected.length` counted, **`adm.admitted` never read repo-wide** (grep: empty), `:229` forecasts from raw `be` | `run-forecast.js:227-229` | ⚠ A claim saying *"he defeated X last night"* increments the counter and still moves the number |
| Fabricated timestamp substitution — inert **only** because the borrowed value is also `undefined`. **Fixing `publishedAt` ACTIVATES the bug.** | `run-forecast.js:226` | ⚠ Fix the gate *before* anyone fixes `publishedAt` |
| Fee envelope blocks nothing — `productionAlertAllowed` set at `lib/entertainment.js:101`, **read only by tests** | — | ⚠ no production reader |
| 4 v2 triggers unreachable — `shouldSend` (`:228`) is inside a loop over `byBout`, built from `eligible` (`:174,189`); a withdrawn/stale position **drops out of `eligible` before `shouldSend` is reached**. `TM.positionWithdrawn` (`:135`) is defined, exported, tested, and wired **only** to `run-phase9-shadow.js:98` (Telegram → disk) | — | ⚠ **No path tells a human the system disowned their bet** |

---

## 8. Rollback plan

Every step is a `git revert` of a single commit, in reverse order. Nothing here is a migration that cannot be undone, **because no sealed byte is rewritten**.

| # | Change | Rollback | Blast radius if wrong |
|---|---|---|---|
| 1 | `test/` additions (all red first) | revert | none — tests only |
| 2 | `lib/notify.js` → `notify(sendClass, text)` + 13 call sites | revert | **all Telegram**. Land alone, verify with `ping.js`. |
| 3 | `lib/arming.js` `SEND_CLASS`/`EXEMPT`/`permits` | revert | fails closed → silence, not sends |
| 4 | `bin/receipt.js`, `bin/plan.js`, `config/cards.json` | revert | dispatcher idles; V1 unaffected |
| 5 | `run-forecast.js --seal=auto` | revert (`--seal=<ISO>` retained) | **touches the leakage boundary — two shipped bugs live here.** Refusal test first. |
| 6 | `run-attest-freshness.js` | revert | 🔴 **ARMS the system** (supplies `writtenBy`). See §12. |
| 7 | `pipeline.js` mouth removal | revert | 🔴 **V1 cloud code — the only file the remote runs.** Sequence against §9. |
| 8 | `unified-v2.yml`, `fight-day-sentinel.yml` | delete the file | cron stops; V1 untouched |
| 9 | `listing-watch.yml` group split | revert one line | reverts to today's ~12% |

**Kill switch, no deploy needed:** `SHARP_DISARM=<anything not in {0,false,no,""}}` → every non-exempt send refused; `PIPELINE_FAILURE` still lands. **Nuclear:** `lib/arming.js:20 ALERTS_ARMED: false` — one line, one commit.

**Do not roll back into a worse state.** Reverting #3 while #2 is landed leaves `notify` demanding a class nothing supplies. **#2 and #3 revert together or not at all.**

---

## 9. Migration plan

**State, verified:** `main` ahead **16**, `origin/main` ahead **7**, diverged, **merge is clean (0 conflicts)**. The entire V2 build has never been pushed — the cloud *physically cannot* run V2, because the code is not there. The 7 remote commits are the bot's hourly data commits (`listing-watch.json`, `pick-ledger.json`, `positions.json`, `signals.json`, `picks/*`, `transcripts/*`). **V1 cloud writes and V2 local writes are disjoint file sets — that disjointness is the whole reason the merge is clean, and it is a seam to be protected, not spent.**

```
PHASE 0 — merge, push nothing new              ← V2 code lands in the cloud but nothing schedules it
  git fetch origin && git merge origin/main    (clean; verify with --no-commit --no-ff first)
  run all 21 suites → green
  git push origin main
  ⇒ The cloud now HAS V2 and still RUNS only V1. Zero behaviour change. This is the safe checkpoint.

PHASE 1 — persistence (BLOCKS everything downstream)
  .gitignore: un-ignore data/evidence/  [OWNER DECISION #2 — public repo]
  add to BACKUP_MANIFEST.md; commit 2.5M
  ⇒ without this, every cloud V2 run re-pays Gemini and discards the result.

PHASE 2 — transport authority (touches NO V1 logic, only V1's imports)
  lib/notify.js → notify(sendClass, text); fix 13 call sites; EXEMPT=[PIPELINE_FAILURE]
  exempt content guard REDACTS (never throws)
  ⇒ V1 keeps sending exactly what it sends today, now classified.

PHASE 3 — V1's mouth  🔴 BREAKS THE SEAM. Coordinate: the bot commits hourly.
  DELETE pipeline.js:199-213 (buildAlert)  — the function ceases to exist
  DELETE pipeline.js:464-477 AS ONE BLOCK  — comment + `if (!ALERTS_ARMED)` + the ENTIRE else-body
  DELETE pipeline.js:32 and pipeline.js:9 (the lib/notify import)
  REWRITE pipeline.js:489-492 → notify(DAILY_SUMMARY, …) + standingWarning
  REWRITE pipeline.js:504    → notify(PIPELINE_FAILURE, …)
  ⇒ ORDER IS NOT STYLISTIC. Deleting :32 before :464-477 makes the buy loop UNCONDITIONAL.
    Do it in ONE commit or not at all. Push immediately after; do not leave it local overnight.

PHASE 4 — schedule (additive; V1 workflows untouched)
  config/cards.json · bin/plan.js · bin/receipt.js · .github/run-stage.sh · run-tests.sh
  unified-v2.yml (group sharp-signals-v2) · fight-day-sentinel.yml (group sharp-signals-sentinel)
  listing-watch.yml → group sharp-signals-listing   [the measurable experiment]
  send: false in BOTH workflows.
  ⇒ Dry-run only. Watch one full card land before arming.

PHASE 5 — attestation  🔴 THIS IS THE ARMING STEP. Do not reach it by accident.
  run-attest-freshness.js; git rm data/phase9-fresh-run.json IN THE SAME COMMIT
  rewrite checkArmingPrerequisites to resolve data/attestation-<card>.json
  ⇒ THE MOMENT THIS LANDS, writtenBy EXISTS AND THE SYSTEM CAN SEND A BUY INSTRUCTION.
```

**The contradiction Design 1 never resolved, resolved:** it says `checkArmingPrerequisites` *"stays as-is — reuse, do not rewrite"* **and** *"delete `data/phase9-fresh-run.json`"*. But `lib/arming.js:66` hardcodes that path and `:68` blocks when it is absent. As-is + deleted = **every non-exempt class refused forever, and nothing ever opens the new attestation**. It fails closed, so it is not dangerous — but it ships a generator with zero readers. **`checkArmingPrerequisites` must be rewritten to resolve the per-card path. Say so; drop "do not rewrite."** And it must **keep** the two refusals Design 1's replacement list drops: future-dating (`:82`) and `writtenBy` provenance (`:87`).

**Test-suite collateral Design 1 does not mention:** `test/test-arming-guards.js:24` binds `FRESH = data/phase9-fresh-run.json`. Deleting that file flips `:86-89` into an `else` branch that asserts the literal `true` — **the card-mismatch test, the most important new check, silently becomes a tautology and the suite still prints green.** That is `verify-fees.js` again. `test-arming-guards.js` must be rewritten in the same commit.

**Signature migration is safe in both directions** (a bare string into a destructure → `card` undefined → refuse; an object into positional → `fresh.card !== cardId` → refuse), but it turns ~12 positional call sites red across `test-arming-guards.js` and `test-phase9.js:358`. Budget for that; don't discover it.

---

## 10. Acceptance tests

Every one of these **fails against the current tree** unless marked ✅ (already green — keep as a regression lock). Baseline: **21 suites, all green today.** Fix `package.json` `"test"` first — it is `echo "Error: no test specified" && exit 1`, so CI cannot gate on tests at all.

**Arming / no-trading-path**
1. `assertNoTradingPath()` throws when a fake export (`k.mysteryFn`) is added. ✅ *(the old 5-name deny-list passed this)*
2. `k.request("POST","/portfolio/orders",{body:{}})` throws **synchronously** — assert the call never returns a Promise. ✅ *(an `async` regression silently defeats the probe at `arming.js:122`)*
3. `k.request("post",…)` and `k.request("Post",…)` both throw. ✅ *(the `treatment==="maker"` bug)*
4. `k.request("GET","/markets",{body:{x:1}})` throws on the body — no read in this build sends one.
5. Repo-wide scan: no file outside `test/` references `/portfolio/orders` (except the probe) and no file pairs the Kalshi host with `method: POST|PUT|DELETE|PATCH`. *(must not flag `lib/blotato.js`, `lib/claude.js`, `lib/extractor.js`, `lib/sources.js`, `lib/transcripts.js` — all legitimately POST to their own hosts. Key on the Kalshi host, not the word POST.)*
6. When `assertNoTradingPath()` throws, `permits("BUY_INSTRUCTION")` returns `allowed:false` with the message in `blockers` and **does not itself throw**.
7. `ALERTS_ARMED` is defined in exactly one file repo-wide (excl. `test/`) — **fails now: 2** (`arming.js:20` true, `pipeline.js:32` false).
8. `SHARP_DISARM=true` / `"yes"` / `"1 "` all disarm — **not** just `=== "1"`.
9. `ALERTS_ARMED=true` in `process.env` does **not** arm an otherwise-refusing tree.

**Transport authority**
10. `grep`: `pipeline.js` contains no `buildAlert` and no `require("./lib/notify")` — **fails now** (`:199`, `:9`).
11. `grep`: `pipeline.js` contains no `/flip this to true/i` — **fails now** (`:31`).
12. **`notify()` cannot be called without a sendClass** — every one of the 13 call sites supplies one; an unknown class is refused, not defaulted.
13. `sendExempt("PIPELINE_FAILURE", …)` is allowed with the attestation deleted **and** `ALERTS_ARMED:false` **and** `SHARP_DISARM` set — **fails now: V1's failure alert survives only by not consulting arming at all, which is luck, not design.**
14. 🔴 **`TM.pipelineFailure({stage:'kalshi snapshot', why:'orderbook fetch failed for KXUFCFIGHT: no price returned'})` REACHES THE TRANSPORT.** *(Verified today: it matches `BETTING_WORDS` on "price" and `assertNotABettingInstruction` **throws**. The guard must redact to a safe template, never suppress.)*
15. `permits("PIPELINE_FAILURE")` reads no files — stub `fs.readFileSync` to throw; assert `allowed:true`.

**Attestation**
16. A generated attestation hand-edited `passed:false → true` with `attestHash` untouched is refused. *(Honest framing in the comment: this detects **accident and truncation**. It is **not** tamper-proof — `sha` is an unkeyed digest over public data and re-hashing is three lines of node. Do not sell a convention as a measurement in the one file whose job is to stop a typed boolean reading as a measurement.)*
17. `passed: "yes"` (truthy non-boolean) is refused — **fails now: `!fresh.passed` accepts it.**
18. An attestation with `stages` deleted and correctly re-hashed is refused on an **exhaustive required-field sweep run first** — every gate here that truthiness-guarded its own input returned "verified" on missing data.
19. An attestation whose `stages[0].artifactSha256` no longer matches the file on disk is refused.
20. `permits("BUY_INSTRUCTION", {card, forecastHash:H})` refuses when the attestation attests a different `forecastHash`.
21. `run-attest-freshness.js` has **no** `--passed`/`--force`/`--ok` argument (source grep), and with an absent forecast exits nonzero **and writes no file**.
22. Generated `tallies.bouts` equals `fc.card.bouts.length` read independently — **fails now: the hand-written file says 13/47; disk says 12/38 (verified).**
23. `attestation.note` says what is true — *"every listed artifact was present, parseable, and content-matched at ranAt"* — not *"every stage executed"*. `existsSync` cannot observe execution. **Do not bind on mtime**: git checkout forward-stamps every file to clone time, so on the cloud a two-week-old artifact reads as seconds old. Bind on `sealHash` + `artifactSha256`.

**Identity**
24. 🔴 **The review's subject must be in the bout.** An eval bout `Usman vs Du Plessis` with `reviewItem.about = "Kevin Holland"` emits **zero** messages. *(This — not the bout↔bout compare — is what actually catches the send that went out. `lib/contracts.js:265-268` already implements it.)*
25. A review whose eval bout carries **no** `fight` is refused — **fails now: `if (f && b.fight && …)` skips the check** (`run-entertainment-alerts.js:71`).
26. `run-inject-verified.js --write` refuses a block whose fighter pair does not match the resolved bout, and one whose `about` is in neither corner.

**Schedule / seal**
27. `--seal=<job-start ISO>` + `--live` **FAILS** with `LEAKAGE in baseline` on every tier-A bout *(proves the naive cloud seal is broken)*; `--seal=auto` succeeds with 0 leakage-rejected.
28. `--seal=auto` produces `sealedAt` strictly greater than every `snapshotTimestamp` in its own output; and **REFUSES** if any observation ≥ now.
29. `--seal=auto` on a card past `firstBellUtc` refuses; a card with **no** `firstBellUtc` refuses *(never defaults to 22:00Z)*.
30. Stage-1 log never prints `1970-01-01` *(the `new Date(null)` fabricated seal)*.
31. `bin/plan.js`: `dayDelta()` is an **integer**; `d==0` is reachable; dispatcher and sentinel import the same function.
32. Sentinel on a non-fight day exits 0 in seconds, writes nothing, sends nothing; on fight day covers **00:00Z→firstBell**, not `firstBell-8h`.
33. `bin/plan.js` on an empty/all-past `config/cards.json` exits nonzero.
34. `bin/receipt.js` exits 2 on: missing, zero-byte, unparseable, wrong `card.eventId` — four separate refusals. **And on a fixed-path artifact left by a previous run** *(existsSync cannot tell "written now" from "left on disk in March"; require `sealHash` match, not mtime).*
35. Simulated partial failure: delete `evidence-eval-DATE.json` mid-chain → the Alerts step is **SKIPPED** (default `if: success()`), zero Telegram calls.
36. Grep in CI: no V2 alert step contains `if: always()`. Only `save-data` steps may.

---

## 11. What I changed from your spec and why

**1. "Price checks every 15 minutes on fight day."**
*Actually true:* `*/15` lands **~14%** of the time (measured: 96 expected → 13-14 actual). Cron cannot do this. Also, all three live workflows share `concurrency: group: sharp-signals` (`pipeline.yml:23`, `watch.yml:21`, `listing-watch.yml:28`), so a third arrival silently cancels the pending one — meaning your measured rates are throttling **plus** self-cancellation, inseparable from `gh run list`. `backfill.yml:45-47` already fixed this for itself and the lesson was never applied.
*Instead:* a fight-day sentinel that **loops inside one job** on a real 15-minute grid (`timeout-minutes: 350`, GitHub's 6h cap — `backfill.yml:55` already uses it). Cron only has to land once. Plus a one-line experiment: give `listing-watch` its own group.

**2. "Conditional source memory — does channel X have an edge on injuries?"**
*Actually true:* **not buildable from history, at any effort.** `data/predictions.json` has outcomes but **no topic field**. `data/evidence/` has a 26-topic taxonomy but **no outcome** — `corroborated` and `knownBeforeBet` are `null` on **2,199/2,199** claims. **The grading target does not exist.** Sizing it: 64 `injury_health` claims across 14 channels; **largest cell = 14**, against the repo's own `minSampleForTrust = 15`. Every cell is below the floor. And `gradeAll` already Šidák-corrects across 42 sources needing z=3.03; 50×26 = 1,300 cells needs ~z 4.2 while dividing each cell's n by ~26. **No cell could clear it.**
*Instead:* a **prospective** `claim-commitment` record written **at seal**, before any outcome exists — because half its fields (`marketAtClaim`, `bookConsensusAtClaim`, `knownBeforeBet` from `L.checkClaim`) are **unrecoverable after the fact**. This is months of collection, not a query. Start writing it now or you will be here again in six months with the same answer.

**3. "The V1 guru board / 12,597 picks, -0.4% ROI."**
*Actually true:* **that number no longer reproduces.** Real: 11,452 raw → **6,968 deduped**, +0.30% deduped / -1.77% raw. `CLAUDE.md:34` and `server.js:73` both publish the stale figure. **"0 of 50 sources survive" reproduces exactly.**
*Instead:* fix the two published numbers; keep the finding. It is the finding that matters and it is unchanged.

**4. "Kalshi lists no method/round markets" (`phase9-fresh-run.json`, stage 6).**
*Actually true:* that claim is **unfalsifiable as measured.** `lib/match.js:26` is `SERIES = { mma: "KXUFCFIGHT" }` and `:50` only ever queries it — the run reported on a board that **could not have contained** a method market. And `lib/kalshi.js:130-139` `getAll()` truncates at 2000 and **discards the cursor**, so the repo structurally cannot answer "what does Kalshi list?".
*But also:* I searched the repo for the sibling series your brief names — **`KXUFCMOF`, `KXUFCMOV`, `KXUFCVICROUND`, `KXUFCROUNDS`, `KXUFCDISTANCE`, `KXFIGHTMENTION` appear nowhere in this codebase.** The only Kalshi series strings on disk are `KXUFCFIGHT` and `KXUFCFIGHTNIGHT`. Those names came from outside the repo and **I could not verify a single one.** I am not going to build a discovery module on six identifiers I cannot see.
*Instead:* (a) make `getAll` **refuse** an unexhausted cursor — a truncated board is bit-indistinguishable from a short one; (b) one read-only probe to confirm the series actually exist; (c) *then* a registry, never a regex. Your brief's own trap is right and worth keeping: `/KO|TKO|decision|round/` over `KXUFCFIGHT` titles = 8 hits, **100% false positives** (Seok Hyun **Ko**, Danil Donchen**ko**). Never key discovery on title text.

**5. "Loosen evidence thresholds — one origin may move a speculative forecast in an EXPLORATION lane."**
*Actually true — and this is the one where I'm pushing back hardest.* Your own constraints collide. You said loosen **evidence**, do **not** loosen **leakage**. But `magnitudeRules.MINOR.minIndependentOrigins = 2` **is** the de facto leakage backstop: the leakage gate is inert (`run-forecast.js:227-229` — `adm.admitted` is **never read repo-wide**, verified by grep; `:229` forecasts from raw `be`), and core survives only because a leaked one-origin claim cannot clear an origin bar of 2. **Dropping the bar to 1 removes the accident that makes the leak harmless.** A single post-fight "he looked unmotivated" clip would then move a number through a gate that counts it and does not stop it.
It gets worse: `evidence-eval.js:84` maps `injury_health → current_condition_report`, which falls to the else at `:132` and mints `analyst:<channel>` **per channel**. Five channels repeating one staph rumour = **5 origins = MAJOR**. That is your cardinal rule — *"ten channels repeating one injury rumour is ONE origin"* — broken in the counter itself, and the exploration lane's entire safety story is that you read the printed origin count. **You'd read "5 origin(s)".**
*Instead — sequence, don't cancel:* (i) fix `evidence-eval.js:84/:132` so the counter tells the truth; (ii) make the leakage gate read `adm.admitted`; (iii) build the settlement writer — otherwise the lane is a write-only pile of permanently unresolvable hypotheses (`run-phase8-shadow.js:163` has **zero** writers, and `dashboard-data.js:396-398` hardcodes the result anyway, so building it wouldn't even change the dashboard); (iv) **then** the lane. Building it first buys months of records that can never be graded and a promotion rule with n=0 forever, on evidence counted by a broken counter, through a gate that doesn't gate.

**6. "Fill `outcomeTracking` with a later settlement pass"** (`run-phase8-shadow.js:163`).
*Actually true:* **impossible as written.** `:167` `contentHash = C.sha(record)` and `:184` `decisionHash = C.sha(record)` **both cover that field.** Filling it invalidates both hashes, and the dashboard refuses an artifact whose hash doesn't reproduce.
*Instead:* the settlement pass writes a **sidecar** keyed to `decisionHash`. Not a preference — the current plan cannot execute.

**7. "Do not delete V1 or V2."**
*I am honouring this, but I want to be explicit about what I read it to mean:* I delete V1's **mouth**, not V1. `buildAlert` (`:199-213`), the buy send (`:464-477`), the `lib/notify` import (`:9`), the flag (`:32`). Scan/extract/grade/paper-position is untouched and the cloud keeps writing the same files. **Reason: `pipeline.js:31` — "Flip this to true only when Tier-1 is fixed and verified" — is a live invitation, and the four bugs it names are fixed in V2, on V2's code.** A future reader with a green suite flips it and gets V1's `lib/match.js` surname fallback, no fight-date guard, V1's ledger, and Gemini conviction sizing. **The flag is the wrong protection because the flag is the invitation.** You cannot flag-flip your way to a function that does not exist.

**8. `data/phase9-fresh-run.json` says "13 bouts / 47 claims".** Disk says **12 and 38** (I walked it). That file describes a pipeline run that no longer exists and has authorised arming on that basis. It is not evidence of anything. `git rm` it in the same commit as its generator — never leave a hand-written and a generated candidate both on disk.

---

## 12. Decisions I cannot make for you

### 🔴 #1 — TIME-CRITICAL: the three open positions settle **tomorrow**

**Verified on disk right now.** `data/positions.json` holds 3 open rows, all `fightDate: "2026-07-18"`:

| ticker | fighter | sources | stakePct | opened |
|---|---|---|---|---|
| `KXUFCFIGHT-26JUL18HOORAM-HOO` | Chase Hooper | `["Michael Chiesa"]` | 0.7 | 2026-07-15 |
| `KXUFCFIGHT-26JUL18CANDUN-DUN` | Christian Duncan | `["Michael Chiesa"]` | 0.7 | 2026-07-15 |
| `KXUFCFIGHT-26JUL18MCMMON-MON` | Alberto Montes | `["Michael Chiesa"]` | 0.7 | 2026-07-16 |

The current gate is `pipeline.js:406`: `signals.filter(s => s.survives && !s.isFighter && (s.sourceRoiLcb||0) > 0)`. **Michael Chiesa is an active fighter previewing his own division — `isFighter` — so all three fail a clause the gate now enforces.** They were opened before it landed (one **8 seconds** before the gate commit). `recordOpen` returns null forever once a ticker exists, so **no run can re-evaluate them**. `settlePositions` will settle them from Kalshi tomorrow and their P&L will enter the daily paper summary **as though today's system produced them**. There is no `rulesVersion` field on a position (confirmed — the row has 18 fields and none of them is provenance), so nothing can attribute them to the rule that admitted them.

And note what Phase 2 does to this: today `pipeline.js:492` sends that summary with **no arming consult at all** — honestly ungated. Route it through `notify(DAILY_SUMMARY, …)` and it returns `allowed:true`. **That converts "nobody checked" into "arming approved," attaching an affirmative safety verdict to a contaminated number.** That's painting the defect green.

| Option | Cost |
|---|---|
| (a) Let them report under `standingWarning` | A false impression of a track record, in the first summary the new path sends |
| (b) Exclude pre-gate positions by `openedAt < gate-commit` | One filter; honest; loses 3 data points you never legitimately had |
| (c) Hold the summary until positions carry `rulesVersion` | Silence — the failure this whole design exists to prevent |

**My recommendation: (b), today, before 2026-07-18.** Add `rulesVersion` to `recordOpen` going forward and quarantine these three to `data/positions.quarantine.json` with the reason. This is a truthfulness decision about your own track record, not a code decision — which is exactly why it's yours. But the deadline is real and it is tomorrow.

### #2 — `data/evidence/` on a public repo
2.5M, 36 JSONs + 247 chunks, `.gitignore:31`, not in `BACKUP_MANIFEST.md`, **one laptop disk**. The cloud cannot run V2 without it and will re-pay Gemini every run and discard the result. `.gitignore:8-13` already argues *for* committing `data/transcripts/` on exactly this reasoning. **But push = publish: this is your paid extraction, public.**
**My recommendation: commit it.** ~$12–25 of Gemini and a corpus with no home is a bad trade against publishing claim extractions from public YouTube videos. If that's unacceptable, it needs a different home *before* Phase 4 — but "no home" cannot be the answer.

### #3 — Ship the attestation generator, or stay silent?
**The gate is refusing right now on a single blocker** (`writtenBy`). Shipping the generator **arms the system**. Not shipping it means silence through this weekend's card — and silence is the guard working, not an outage.
**My recommendation: do not ship it before the card.** You get nothing from arming into a card the system says NO BET on all 24 contracts for. Land Phases 0–4 dry-run, watch one full card, then Phase 5.

### #4 — Sentinel `--send`
**My recommendation: `send: false` until you've watched one full fight day dry.** The ledger suppression is fixed in the working tree (verified), so the 1→5 escalation *can* now fire — but it has never fired in production, and fight day at 15-min cadence is not where you discover that.

### #5 — Attestation max age
`lib/arming.js:45` `FRESH_RUN_MAX_AGE_H = 36` (someone else's choice, landed today). Measured cron gives ~8-10 pipeline runs/day, so 6h is achievable and 36h lets an attestation outlive a full re-collection.
**My recommendation: 12h.** It's a staleness bound, not a tuning knob, so I won't pick it silently.

### #6 — `getAll` refusing truncation changes V1 cloud behaviour
12 callers, including V1's hourly path. A series exceeding the page cap turns a silently-truncated run into a **failed** run.
**My recommendation: accept the loud failure.** Truncation there silently drops picks, which is the exact class of bug the retry logic at `lib/kalshi.js:38-41` was written to stop. If you want a hedge, `{allowTruncation:true}` for the backfill path only — but that re-legitimises a partial board in the one place the grading corpus came from.

### #7 — V1 stays degraded
`pipeline.js` and `watch.js` legitimately share `sharp-signals` because they write the **same** files. V1's `*/15` stays at ~14% forever; V2's sentinel carries the real cadence.
**My recommendation: accept it.** Also accept the unmeasured risk: two more hourly workflows roughly doubles scheduled arrivals on a repo already throttled to 14%, and GitHub deprioritises by repo load. "Leave V1 exactly as is" preserves the config, not the behaviour. Watch `pipeline.yml`'s rate for a week after Phase 4.

### #8 — `EXEMPT` stays at exactly one class?
Pressure will come from `POSITION_UPDATE`/`positionWithdrawn` — *"the system disowned your bet"* arguably must reach you even when arming refuses. But that message names a market, so exempting it puts a market-naming message outside the gate.
**My recommendation: keep `EXEMPT = [PIPELINE_FAILURE]`. Cut `HEARTBEAT`** (it has no sender, and an untestable exempt class is a permanent hole waiting for a caller). Fix `positionWithdrawn` by making it **reachable** — it drops out of `eligible` before `shouldSend` sees it — not by exempting it.

---

**One last thing, and it's the reason I'd hold Phase 5.** Every reviewer who touched Design 1 assumed the arming gate was failing open, and built a fix on top of that. It is failing **closed**, on one string, correctly. Three separate designs proposed changes that would have supplied that string as a side effect. The gate that's protecting you right now is protecting you *because* nobody has finished the work — and the most likely way this system sends its first wrong buy instruction is not a bug, it's a Tuesday where someone lands the generator to make a red test green.